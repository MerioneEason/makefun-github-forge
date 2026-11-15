// gitobj.ts — git's object model and wire encodings, from the formats up.
//
// Object ids are SHA-1 over "<type> <length>\0<bytes>", exactly as git
// computes them, so an object the forge mints (a contents-API commit, a
// squash merge) hashes to the id any git client computes for the same
// bytes. Trees and commits are built and parsed as raw bytes; packs are
// written plain (no deltas — a reader must accept them, and the format
// allows it) and read with full ofs-delta / ref-delta support, because a
// pushing client may delta-compress against objects it already sent.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Store } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, GitObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

/** The object id of a typed payload. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object and answer its id (idempotent: the id is the content). */
export function putObject(store: Store, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.objects.has(oid)) store.objects.set(oid, { type, data });
  return oid;
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  /** Octal mode as written in the tree: '100644', '100755', '120000', '40000'. */
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree order: by name, with directories sorting as if suffixed '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries to raw tree bytes (sorted as git sorts them). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse raw tree bytes back into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', at, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
}

/** Parse a commit object: its tree, parents, identity lines and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

/** An identity line ("Name <email> ts +0000") from its parts. */
export function identityLine(name: string, email: string, epochSeconds: number): string {
  return `${name} <${email}> ${epochSeconds} +0000`;
}

/** Serialize a commit object. */
export function buildCommit(info: { tree: string; parents: string[]; authorLine: string; committerLine: string; message: string }): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.authorLine}`);
  lines.push(`committer ${info.committerLine}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** The commit a tag object points at, following nested tags. */
export function peelToCommit(store: Store, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    if (match === null || match[1] === undefined) return null;
    current = match[1];
  }
  return null;
}

/** Every object reachable from a set of root ids (commits walk to trees and parents). */
export function objectClosure(store: Store, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = peelTargetOf(object.data);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

/** The `object` header of a tag object's bytes. */
export function peelTargetOf(tagData: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})/m.exec(tagData.toString('utf8'));
  return match === null || match[1] === undefined ? null : match[1];
}

/** A commit's full tree flattened to path -> {mode, oid} (recursive). */
export function flattenTree(store: Store, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const object = store.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build nested tree objects from a flat path -> blob map; answers the root tree id. */
export function buildTreeFromFiles(store: Store, files: Map<string, { mode: string; oid: string }>): string {
  interface Dir {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1]!, file);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: emit(sub) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return emit(root);
}

// -------------------------------------------------------------- pkt-lines

/** One pkt-line: a 4-hex length prefix (counting itself) plus the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Split a buffer into pkt-line payloads; stops at the flush packet. */
export function readPktLines(buf: Buffer, startAt = 0): { lines: Buffer[]; next: number; flushed: boolean } {
  const lines: Buffer[] = [];
  let at = startAt;
  while (at + 4 <= buf.length) {
    const hex = buf.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) return { lines, next: at + 4, flushed: true };
    if (length === 1) {
      lines.push(Buffer.from([1])); // the delimiter, kept as a marker line
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buf.length) break;
    lines.push(buf.subarray(at + 4, at + length));
    at += length;
  }
  return { lines, next: at, flushed: false };
}

// ------------------------------------------------------------------ packs

/** One pack entry's header: the type/size variable-length encoding. */
function packEntryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (size & 0x0f) | (type << 4);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialize objects into a pack (version 2, plain entries, SHA-1 trailer). */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(TYPE_IDS[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `offset`; also answers its byte length. */
function inflateOne(buf: Buffer, offset: number): { data: Buffer; length: number } {
  // inflateSync tolerates (ignores) bytes past the stream's end, and a
  // truncated stream throws — so the stream's true length is the shortest
  // prefix that inflates. Binary-search for it.
  const rest = buf.subarray(offset);
  const full = inflateSync(rest);
  let lo = 1;
  let hi = rest.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const probe = inflateSync(rest.subarray(0, mid));
      if (probe.length === full.length && probe.equals(full)) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: full, length: lo };
}

/** Apply a git delta (copy/insert program) to its base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at]!;
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // the base size; the caller verifies the result size instead
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  while (at < delta.length) {
    const op = delta[at]!;
    at += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) { offset = delta[at]!; at += 1; }
      if ((op & 0x02) !== 0) { offset += delta[at]! * 256; at += 1; }
      if ((op & 0x04) !== 0) { offset += delta[at]! * 65536; at += 1; }
      if ((op & 0x08) !== 0) { offset += delta[at]! * 16777216; at += 1; }
      if ((op & 0x10) !== 0) { size = delta[at]!; at += 1; }
      if ((op & 0x20) !== 0) { size += delta[at]! * 256; at += 1; }
      if ((op & 0x40) !== 0) { size += delta[at]! * 65536; at += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      parts.push(delta.subarray(at, at + op));
      at += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== targetSize) throw new Error('delta result has the wrong size');
  return result;
}

export interface PackRead {
  /** Every object the pack carried, fully reconstructed. */
  objects: GitObject[];
  /** The trailer check: the pack's own checksum against its bytes. */
  checksumOk: boolean;
}

/** Parse a pack, resolving deltas against the pack itself and the store. */
export function readPack(store: Store, pack: Buffer): PackRead {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  const checksumOk = trailer.equals(digest);
  let at = 12;
  const byOffset = new Map<number, GitObject>();
  const objects: GitObject[] = [];
  const resolve = (oid: string): GitObject => {
    const found = store.objects.get(oid);
    if (found === undefined) throw new Error(`delta base ${oid} is not held`);
    return found;
  };
  for (let index = 0; index < count; index += 1) {
    const entryAt = at;
    let byte = pack[at]!;
    at += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[at]!;
      at += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const kind = ID_TYPES[typeId];
    if (kind === undefined) throw new Error(`pack entry type ${typeId} is unknown`);
    let base: GitObject | null = null;
    if (kind === 'ofs-delta') {
      let back = pack[at]!;
      at += 1;
      let offset = back & 0x7f;
      while ((back & 0x80) !== 0) {
        back = pack[at]!;
        at += 1;
        offset = (offset + 1) * 128 + (back & 0x7f);
      }
      base = byOffset.get(entryAt - offset) ?? null;
      if (base === null) throw new Error('ofs-delta base is not in the pack');
    } else if (kind === 'ref-delta') {
      const baseOid = pack.toString('hex', at, at + 20);
      at += 20;
      base = resolve(baseOid);
    }
    const inflated = inflateOne(pack, at);
    at += inflated.length;
    if (inflated.data.length !== size) throw new Error('pack entry inflated to the wrong size');
    const object: GitObject = base === null ? { type: kind as GitObjectType, data: inflated.data } : { type: base.type, data: applyDelta(base.data, inflated.data) };
    byOffset.set(entryAt, object);
    objects.push(object);
  }
  return { objects, checksumOk };
}
