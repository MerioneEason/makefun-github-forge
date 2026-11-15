// forge.ts — the operations every surface shares: writing files as commits
// through the contents API, reading trees back, diffing two tips for a pull
// request's file list, and merging a pull request with a real three-way
// tree merge (so a divergent edit to the same file is a conflict, exactly
// as it is on GitHub, and a clean merge lands the head's content).

import type { Pull, Repo, Store } from './store.ts';
import {
  buildTreeFromFiles,
  flattenTree,
  hashObject,
  identityLine,
  parseCommit,
  parseTree,
  putObject,
} from './gitobj.ts';
import { isAncestor, mintCommit, treeOfCommit } from './githttp.ts';

/** The identity API-made commits are authored under. */
function apiIdentity(store: Store): string {
  const login = store.actorLogin();
  return identityLine(login, `${login}@forge.invalid`, store.now());
}

/** A branch's tip commit id, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a ref-ish (branch, tag, full ref, commit id, HEAD) to a commit id. */
export function resolveCommit(store: Store, repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') {
    const target = repo.refs.get(repo.headTarget);
    return target ?? null;
  }
  const direct = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  const oid = direct ?? (store.objects.has(ref) ? ref : null);
  if (oid === null) return null;
  const object = store.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') {
    const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    return match !== null && match[1] !== undefined ? resolveCommit(store, repo, match[1]) : null;
  }
  return null;
}

/** The flat path -> blob map at a commit (empty when the commit is unknown). */
export function filesAt(store: Store, commitOid: string | null): Map<string, { mode: string; oid: string }> {
  if (commitOid === null) return new Map();
  const tree = treeOfCommit(store, commitOid);
  if (tree === null) return new Map();
  return flattenTree(store, tree);
}

export interface FileWrite {
  /** The new commit's id. */
  commitSha: string;
  /** The blob id of the written file (absent for a deletion). */
  blobSha: string | null;
}

/**
 * Commit file changes onto a branch: `changes` maps a path to its new bytes
 * (or null to delete it). A branch that does not exist yet is created from
 * the default branch's tip — or unborn, on an empty repository.
 */
export function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  changes: Map<string, Buffer | null>,
  message: string,
): FileWrite {
  let tip = branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) tip = branchTip(repo, repo.defaultBranch);
  const files = filesAt(store, tip);
  let blobSha: string | null = null;
  for (const [path, bytes] of changes) {
    if (bytes === null) {
      files.delete(path);
    } else {
      blobSha = putObject(store, 'blob', bytes);
      const existing = files.get(path);
      files.set(path, { mode: existing?.mode ?? '100644', oid: blobSha });
    }
  }
  const tree = buildTreeFromFiles(store, files);
  const identity = apiIdentity(store);
  const commitSha = mintCommit(store, {
    tree,
    parents: tip === null ? [] : [tip],
    authorLine: identity,
    committerLine: identity,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = store.now();
  return { commitSha, blobSha };
}

export interface ContentEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
  size: number;
  /** The file's bytes (files only). */
  data: Buffer | null;
}

/** Read a file or a directory listing at a ref. Null when the path is absent. */
export function readContent(store: Store, repo: Repo, path: string, ref: string | null): ContentEntry | ContentEntry[] | null {
  const commit = resolveCommit(store, repo, ref ?? repo.defaultBranch);
  if (commit === null) return null;
  const tree = treeOfCommit(store, commit);
  if (tree === null) return null;
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') return listTree(store, tree, '');
  const parts = clean.split('/');
  let current = tree;
  for (let index = 0; index < parts.length; index += 1) {
    const object = store.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === parts[index]);
    if (entry === undefined) return null;
    if (index === parts.length - 1) {
      if (entry.mode === '40000') return listTree(store, entry.oid, clean);
      const blob = store.objects.get(entry.oid);
      if (blob === undefined) return null;
      return { type: 'file', name: entry.name, path: clean, sha: entry.oid, size: blob.data.length, data: blob.data };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function listTree(store: Store, treeOid: string, prefix: string): ContentEntry[] {
  const object = store.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : store.objects.get(entry.oid);
    return {
      type: isDir ? ('dir' as const) : ('file' as const),
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: blob?.data.length ?? 0,
      data: null,
    };
  });
}

// -------------------------------------------------------------------- diff

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  /** The head-side blob id (the base-side one for a removal). */
  sha: string;
}

/** Line counts of a change between two texts, by longest common subsequence. */
function lineDelta(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // A trailing newline makes a phantom empty last line; drop matching ones.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const rows = a.length;
  const cols = b.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: cols - common, deletions: rows - common };
}

/** The changed files between two commits, with line counts. */
export function diffCommits(store: Store, baseCommit: string | null, headCommit: string | null): FileDiff[] {
  const baseFiles = filesAt(store, baseCommit);
  const headFiles = filesAt(store, headCommit);
  const diffs: FileDiff[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const beforeText = before === undefined ? '' : (store.objects.get(before.oid)?.data.toString('utf8') ?? '');
    const afterText = after === undefined ? '' : (store.objects.get(after.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDelta(beforeText, afterText);
    diffs.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: (after ?? before)!.oid,
    });
  }
  return diffs;
}

// ------------------------------------------------------------------- merge

/** The best common ancestor of two commits (breadth-first from both). */
export function mergeBase(store: Store, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const seen = new Map<string, number>();
    let frontier = [tip];
    let depth = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.set(oid, depth);
        const object = store.objects.get(oid);
        if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
      }
      frontier = next;
      depth += 1;
    }
    return seen;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthA] of fromA) {
    const depthB = fromB.get(oid);
    if (depthB === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

export interface MergeOutcome {
  ok: boolean;
  /** The merge (or squash) commit id, when the merge landed. */
  sha: string | null;
  conflict: boolean;
}

/**
 * Merge a pull request into its base branch. Squash lands one commit with
 * the merged tree; merge lands a two-parent commit. A path both sides
 * changed differently from the merge base is a conflict and nothing moves.
 */
export function mergePullRequest(store: Store, repo: Repo, pull: Pull, method: 'merge' | 'squash' | 'rebase'): MergeOutcome {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, sha: null, conflict: true };
  if (isAncestor(store, headTip, baseTip)) {
    // Already up to date: the head is contained in the base.
    return { ok: true, sha: baseTip, conflict: false };
  }
  const base = mergeBase(store, baseTip, headTip) ?? baseTip;
  const baseFiles = filesAt(store, base);
  const oursFiles = filesAt(store, baseTip);
  const theirsFiles = filesAt(store, headTip);
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path);
    const atOurs = oursFiles.get(path);
    const atTheirs = theirsFiles.get(path);
    const sameBlob = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
    if (sameBlob(atTheirs, atBase)) {
      if (atOurs !== undefined) merged.set(path, atOurs);
    } else if (sameBlob(atOurs, atBase)) {
      if (atTheirs !== undefined) merged.set(path, atTheirs);
    } else if (sameBlob(atOurs, atTheirs)) {
      if (atOurs !== undefined) merged.set(path, atOurs);
    } else {
      return { ok: false, sha: null, conflict: true };
    }
  }
  const tree = buildTreeFromFiles(store, merged);
  const identity = apiIdentity(store);
  let sha: string;
  if (method === 'merge') {
    sha = mintCommit(store, {
      tree,
      parents: [baseTip, headTip],
      authorLine: identity,
      committerLine: identity,
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
    });
  } else {
    const body = pull.body === '' ? '' : `\n\n${pull.body}`;
    sha = mintCommit(store, {
      tree,
      parents: [baseTip],
      authorLine: identity,
      committerLine: identity,
      message: `${pull.title} (#${pull.number})${body}\n`,
    });
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const at = store.now();
  pull.merged = true;
  pull.mergedAt = at;
  pull.mergeCommitSha = sha;
  pull.state = 'closed';
  pull.closedAt = at;
  pull.updatedAt = at;
  repo.updatedAt = at;
  return { ok: true, sha, conflict: false };
}

/** Whether a pull request's head still merges cleanly into its base. */
export function pullConflicts(store: Store, repo: Repo, pull: Pull): boolean {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return true;
  if (isAncestor(store, headTip, baseTip)) return false;
  const base = mergeBase(store, baseTip, headTip) ?? baseTip;
  const baseFiles = filesAt(store, base);
  const oursFiles = filesAt(store, baseTip);
  const theirsFiles = filesAt(store, headTip);
  const paths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path)?.oid;
    const atOurs = oursFiles.get(path)?.oid;
    const atTheirs = theirsFiles.get(path)?.oid;
    if (atTheirs === atBase || atOurs === atBase || atOurs === atTheirs) continue;
    return true;
  }
  return false;
}

/** hashObject, re-exported for layers that mint blobs directly. */
export { hashObject };
