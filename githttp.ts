// githttp.ts — git smart HTTP: info/refs, upload-pack, receive-pack.
//
// Both protocol eras are served: the version 0 ref advertisement and, when
// the client asks with `Git-Protocol: version=2`, the version 2 capability
// advertisement plus the ls-refs and fetch commands. Fetches never send
// deltas and never send thin packs (the base objects are simply included),
// which the protocol allows a server to choose. Pushes accept plain and
// delta-compressed packs, apply ref updates one by one (a refused ref never
// blocks its neighbours), and answer report-status in the era the client
// negotiated.

import type { Repo, Store } from './store.ts';
import {
  PKT_FLUSH,
  ZERO_OID,
  buildCommit,
  hashObject,
  objectClosure,
  parseCommit,
  parseTree,
  peelTargetOf,
  peelToCommit,
  pktLine,
  putObject,
  readPack,
  readPktLines,
  writePack,
} from './gitobj.ts';
import type { GitObject } from './store.ts';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'anvil-forge/1.0';
const UPLOAD_CAPS_V2 = ['version 2', `agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
const UPLOAD_CAPS_V0 = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not shallow agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

function notFound(): GitReply {
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('not found\n') };
}

/** Refs in advertisement order: HEAD first, then the rest sorted by name. */
function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The v0 ref advertisement body for one service. */
function advertiseV0(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:${repo.headTarget}` : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  let first = true;
  const emit = (oid: string, name: string): void => {
    if (first) {
      parts.push(pktLine(`${oid} ${name}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pktLine(`${oid} ${name}\n`));
    }
  };
  const headOid = repo.refs.get(repo.headTarget);
  if (headOid !== undefined) emit(headOid, 'HEAD');
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    emit(oid, name);
    const peeled = peelToCommit(store, oid);
    if (peeled !== null && peeled !== oid) emit(peeled, `${name}^{}`);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** GET info/refs for either service, in the era the client asked for. */
export function infoRefs(store: Store, repo: Repo, service: string, protocol: string | null): GitReply {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
  if (service === 'git-upload-pack' && protocol === 'version=2') {
    const body = Buffer.concat([...UPLOAD_CAPS_V2.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: advertiseV0(store, repo, service),
  };
}

// -------------------------------------------------------------------- refs

interface RefLine {
  oid: string;
  name: string;
  extra: string;
}

/** The ref lines an ls-refs command answers, after ref-prefix filtering. */
function lsRefsLines(store: Store, repo: Repo, args: string[]): RefLine[] {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: RefLine[] = [];
  if (matches('HEAD')) {
    const target = repo.headTarget;
    const oid = repo.refs.get(target);
    if (oid !== undefined) {
      lines.push({ oid, name: 'HEAD', extra: wantSymrefs ? ` symref-target:${target}` : '' });
    } else if (wantUnborn) {
      lines.push({ oid: 'unborn', name: 'HEAD', extra: wantSymrefs ? ` symref-target:${target}` : '' });
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let extra = '';
    if (wantPeel) {
      const peeled = peelToCommit(store, oid);
      if (peeled !== null && peeled !== oid) extra = ` peeled:${peeled}`;
    }
    lines.push({ oid, name, extra });
  }
  return lines;
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenRelative: boolean;
  depth: number | null;
  done: boolean;
}

/** Parse the argument lines of a v2 fetch command (after the delimiter). */
function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(/[\0 ]/)[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7), 10);
    else if (line === 'deepen-relative') args.deepenRelative = true;
    else if (line === 'done') args.done = true;
  }
  return args;
}

interface FetchPlan {
  /** Object ids to pack, in a stable order (commits first). */
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

/**
 * What the client already holds: the full closure of its haves, but only
 * the shallow-truncated content of its boundary commits — a boundary
 * commit's ancestors are exactly what the client does NOT have.
 */
function heldByClient(store: Store, haves: string[], shallow: string[]): Set<string> {
  const shallowSet = new Set(shallow);
  const held = new Set<string>();
  for (const oid of shallow) {
    const object = store.objects.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') treeContents(store, parseCommit(object.data).tree, held);
    else if (object.type === 'tag') {
      const target = peelTargetOf(object.data);
      if (target !== null) held.add(target);
    }
  }
  // A have that is also a shallow boundary is held only shallowly (above);
  // any other have is held with its whole history.
  for (const oid of objectClosure(store, haves.filter((have) => !shallowSet.has(have)))) held.add(oid);
  return held;
}

/** Tree and blob ids under one tree (not the tree's ancestors, not commits). */
function treeContents(store: Store, treeOid: string, into: Set<string>): void {
  const object = store.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  if (into.has(treeOid)) return;
  into.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000') treeContents(store, entry.oid, into);
    else into.add(entry.oid);
  }
}

/** The commits within `generations` parent-steps of the tips, plus the boundary. */
function commitsWithin(store: Store, tips: string[], generations: number): { commits: Set<string>; boundary: Set<string> } {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  let frontier = tips.filter((oid) => store.objects.get(oid)?.type === 'commit');
  for (let gen = 1; gen <= generations; gen += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (commits.has(oid)) continue;
      commits.add(oid);
      const commit = parseCommit(store.objects.get(oid)!.data);
      if (gen === generations) {
        if (commit.parents.length > 0) boundary.add(oid);
      } else {
        next.push(...commit.parents);
      }
    }
    frontier = next;
  }
  return { commits, boundary };
}

/**
 * Choose the objects a fetch sends. Three shapes: a fresh shallow fetch
 * (deepen N in v0 terms / depth from the tips), a deepen of an existing
 * shallow boundary, and a plain incremental fetch (everything reachable
 * from the wants that the haves and the shallow boundary do not cover).
 */
function planFetch(store: Store, args: FetchArgs): FetchPlan {
  // Resolve wants that name tag objects: the tag ships, and its commit is
  // the traversal root.
  const tagOids: string[] = [];
  const roots: string[] = [];
  for (const want of args.wants) {
    const object = store.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagOids.push(want);
      const commit = peelToCommit(store, want);
      if (commit !== null) roots.push(commit);
    } else if (object.type === 'commit') {
      roots.push(want);
    } else {
      tagOids.push(want); // a tree or blob wanted directly: ship it as-is
    }
  }

  if (args.deepen !== null || args.depth !== null) {
    // A shallow fetch: `deepen N` (the only spelling protocol v2 has, used
    // both for a fresh shallow clone and for deepening an existing one)
    // names the total depth in generations from the wants. The client
    // already holds its haves and its shallow boundary's closure; the new
    // boundary is the deepest generation reached, and a boundary commit
    // that stops being the boundary is reported unshallowed.
    let depth = args.deepen ?? args.depth!;
    if (args.deepenRelative && args.shallow.length > 0) {
      // Relative deepening counts from the client's current boundary:
      // find the generation at which a shallow commit sits below a want.
      const shallowSet = new Set(args.shallow);
      let frontier = roots;
      for (let gen = 1; gen <= 64; gen += 1) {
        if (frontier.some((oid) => shallowSet.has(oid))) {
          depth += gen;
          break;
        }
        const next: string[] = [];
        for (const oid of frontier) {
          const object = store.objects.get(oid);
          if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
    }
    const { commits, boundary } = commitsWithin(store, roots, depth);
    const have = heldByClient(store, args.haves, args.shallow);
    const oids = new Set<string>(tagOids);
    for (const oid of commits) if (!have.has(oid)) oids.add(oid);
    for (const oid of [...oids]) {
      const object = store.objects.get(oid);
      if (object !== undefined && object.type === 'commit') treeContents(store, parseCommit(object.data).tree, oids);
    }
    for (const oid of have) oids.delete(oid);
    const unshallow = args.shallow.filter((oid) => commits.has(oid) && !boundary.has(oid));
    return { oids: [...oids], shallow: [...boundary].filter((oid) => !have.has(oid)), unshallow };
  }

  const excluded = heldByClient(store, args.haves, args.shallow);
  const included = objectClosure(store, args.wants);
  const oids: string[] = [];
  const shallowEcho = new Set<string>();
  for (const oid of included) {
    if (excluded.has(oid)) continue;
    oids.push(oid);
    const object = store.objects.get(oid)!;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) {
        if (args.shallow.includes(parent)) shallowEcho.add(parent);
      }
    }
  }
  // Commits first, then the rest, each in id order: a stable pack layout.
  const commits = oids.filter((oid) => store.objects.get(oid)!.type === 'commit').sort();
  const others = oids.filter((oid) => store.objects.get(oid)!.type !== 'commit').sort();
  return { oids: [...commits, ...others], shallow: [...shallowEcho], unshallow: [] };
}

/** Chunk a pack into sideband-1 packets, each within the pkt-line limit. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  // A pkt-line's length counts itself and must stay ≤ 65520: 65515 bytes of
  // pack data plus the band byte plus the 4 length digits is exactly that.
  const CHUNK = 65515;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, at + CHUNK);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return packets;
}

/** A v2 fetch response: acknowledgments, shallow-info, then the packfile. */
function fetchReplyV2(store: Store, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  if (!args.done) {
    // Negotiation is still open: this response is the acknowledgments alone
    // (the transport ends it at the body's end); the pack follows `done`.
    parts.push(pktLine('acknowledgments\n'));
    const acked = args.haves.filter((oid) => store.objects.get(oid)?.type === 'commit');
    if (acked.length === 0) parts.push(pktLine('NAK\n'));
    else for (const oid of acked) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const plan = planFetch(store, args);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  const objects = plan.oids.map((oid) => store.objects.get(oid)!).filter((o) => o !== undefined);
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(writePack(objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v0 fetch response: shallow lines, a NAK, then the pack in sidebands. */
function fetchReplyV0(store: Store, args: FetchArgs): Buffer {
  const plan = planFetch(store, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  const objects = plan.oids.map((oid) => store.objects.get(oid)!).filter((o) => o !== undefined);
  parts.push(...sidebandPackets(writePack(objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST git-upload-pack: a v2 command (ls-refs / fetch) or a v0 fetch. */
export function uploadPack(store: Store, repo: Repo, body: Buffer, protocol: string | null): GitReply {
  const contentType = 'application/x-git-upload-pack-result';
  try {
    if (protocol === 'version=2') {
      const { lines } = readPktLines(body);
      const texts = lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
      const command = texts.find((line) => line.startsWith('command='));
      const delimAt = lines.findIndex((line) => line.length === 1 && line[0] === 1);
      const argLines = (delimAt === -1 ? texts.slice(1) : texts.slice(delimAt + 1)).filter((line) => line !== '');
      if (command === 'command=ls-refs') {
        const out = lsRefsLines(store, repo, argLines).map((line) => pktLine(`${line.oid} ${line.name}${line.extra}\n`));
        out.push(PKT_FLUSH);
        return { status: 200, contentType, body: Buffer.concat(out) };
      }
      if (command === 'command=fetch') {
        return { status: 200, contentType, body: fetchReplyV2(store, parseFetchArgs(argLines)) };
      }
      return { status: 200, contentType, body: Buffer.concat([pktLine('error: unknown command\n'), PKT_FLUSH]) };
    }
    // Version 0: want lines (the first carries the capabilities), a flush,
    // have lines, `done`, a flush.
    const texts: string[] = [];
    let at = 0;
    for (;;) {
      const { lines, next, flushed } = readPktLines(body, at);
      for (const line of lines) texts.push(line.toString('utf8').replace(/\n$/, ''));
      at = next;
      if (!flushed || at >= body.length) break;
    }
    const args = parseFetchArgs(texts);
    return { status: 200, contentType, body: fetchReplyV0(store, args) };
  } catch {
    // A malformed body must never take the server down with it.
    return { status: 200, contentType, body: Buffer.concat([pktLine('NAK\n'), PKT_FLUSH]) };
  }
}

// ------------------------------------------------------------ receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Whether `descendant` descends from `ancestor` (parent walk, cycle-safe). */
export function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** Apply one ref update; answers null on success or the refusal reason. */
function applyRefUpdate(store: Store, repo: Repo, command: RefCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    if (current !== command.oldOid && command.oldOid !== ZERO_OID) return 'non-fast-forward';
    repo.refs.delete(command.ref);
    return null;
  }
  if (store.objects.get(command.newOid) === undefined) return 'missing object';
  if (current !== command.oldOid) return 'non-fast-forward';
  if (command.oldOid !== ZERO_OID && !isAncestor(store, command.oldOid, command.newOid)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newOid);
  return null;
}

/** POST git-receive-pack: ref commands plus a pack, then report-status. */
export function receivePack(store: Store, repo: Repo, body: Buffer): GitReply {
  const contentType = 'application/x-git-receive-pack-result';
  const report = (lines: string[], sideband: boolean): GitReply => {
    const plain = lines.map((line) => pktLine(`${line}\n`));
    plain.push(PKT_FLUSH);
    if (!sideband) return { status: 200, contentType, body: Buffer.concat(plain) };
    const wrapped = plain.map((packet) => pktLine(Buffer.concat([Buffer.from([1]), packet])));
    wrapped.push(PKT_FLUSH);
    return { status: 200, contentType, body: Buffer.concat(wrapped) };
  };
  let sideband = false;
  try {
    const { lines, next, flushed } = readPktLines(body);
    if (!flushed && lines.length === 0) return report(['unpack error: no ref commands'], false);
    const commands: RefCommand[] = [];
    let capabilities = '';
    lines.forEach((raw, index) => {
      let text = raw.toString('utf8').replace(/\n$/, '');
      if (index === 0) {
        const nul = text.indexOf('\0');
        if (nul !== -1) {
          capabilities = text.slice(nul + 1);
          text = text.slice(0, nul);
        }
      }
      const parts = text.split(' ');
      if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0]!) && /^[0-9a-f]{40}$/.test(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      }
    });
    sideband = capabilities.split(' ').includes('side-band-64k');
    const wantsReport = capabilities.split(' ').includes('report-status');
    const pack = body.subarray(next);
    let unpackLine = 'unpack ok';
    if (pack.length > 0) {
      try {
        const read = readPack(store, pack);
        for (const object of read.objects) putObject(store, object.type, object.data);
        if (!read.checksumOk) unpackLine = 'unpack error: pack checksum mismatch';
      } catch (err) {
        unpackLine = `unpack error: ${err instanceof Error ? err.message : 'bad pack'}`;
      }
    }
    const results: string[] = [];
    if (unpackLine === 'unpack ok') {
      for (const command of commands) {
        const refusal = applyRefUpdate(store, repo, command);
        results.push(refusal === null ? `ok ${command.ref}` : `ng ${command.ref} ${refusal}`);
      }
    } else {
      for (const command of commands) results.push(`ng ${command.ref} unpacker error`);
    }
    if (!wantsReport) return { status: 200, contentType, body: Buffer.alloc(0) };
    return report([unpackLine, ...results], sideband);
  } catch {
    return report(['unpack error: malformed request'], sideband);
  }
}

// ------------------------------------------------------- shared git helpers

/** The tree at a ref (or a raw commit id), for the REST and merge layers. */
export function treeOfCommit(store: Store, commitOid: string): string | null {
  const object = store.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Mint a commit object from a tree, parents and message; answers its id. */
export function mintCommit(
  store: Store,
  init: { tree: string; parents: string[]; authorLine: string; committerLine: string; message: string },
): string {
  return putObject(store, 'commit', buildCommit(init));
}

/** The object a tag names, for advertisement helpers. */
export function tagTarget(store: Store, oid: string): string | null {
  const object = store.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelTargetOf(object.data);
}

/** hashObject re-exported for the layers that mint blobs. */
export { hashObject };
