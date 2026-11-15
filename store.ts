// store.ts — the forge's whole world in one in-memory store.
//
// One process, one store, no disk, no network: git objects are content
// addressed in a single map, repositories carry their refs, labels, issues,
// pull requests and comments beside them. Every surface (smart HTTP, REST,
// GraphQL, MCP) reads and writes this same store, so an object created over
// one surface is the same object over all the others.
//
// Time is a logical clock: a fixed epoch plus a counter that advances on
// every mutation. Nothing here reads the wall clock, so a run replays
// byte for byte.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  authorLogin: string;
  createdAt: number;
  updatedAt: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  authorLogin: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  authorLogin: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface Repo {
  id: number;
  name: string;
  /** The owner login, latched on first addressed access; null until then. */
  owner: string | null;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref name (refs/heads/…, refs/tags/…) to the object id it names. */
  refs: Map<string, string>;
  /** The ref HEAD names; fixed at creation, as a fresh repository's is. */
  headTarget: string;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** One number sequence shared by issues and pull requests, as GitHub's is. */
  nextNumber: number;
  createdAt: number;
  updatedAt: number;
}

/** The epoch the logical clock starts from (2025-01-01T00:00:00Z). */
const CLOCK_EPOCH = 1735689600;

export class Store {
  /** Every git object the forge holds, by object id, across all repositories. */
  objects = new Map<string, GitObject>();
  /** Repositories by name. The forge is a single-user forge: one namespace. */
  repos = new Map<string, Repo>();
  /**
   * The token owner's login. The entry is never told it; it adopts the first
   * owner segment an authenticated request addresses it by, which in every
   * real session is the owner's own.
   */
  viewerLogin: string | null = null;
  /** A stable numeric id for the viewer once adopted (user objects carry one). */
  viewerId = 4242;
  private clockTicks = 0;
  private repoSeq = 1000;
  private issueSeq = 7000;
  private commentSeq = 90000;
  private labelSeq = 3000;
  requestSeq = 0;

  /** The next logical timestamp: strictly increasing, never wall-clock based. */
  now(): number {
    this.clockTicks += 1;
    return CLOCK_EPOCH + this.clockTicks;
  }

  /** Adopt `login` as the token owner when none is known yet. */
  adoptViewer(login: string): void {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
  }

  /** The login to author commits and issues under. */
  actorLogin(): string {
    return this.viewerLogin ?? 'forge';
  }

  createRepo(name: string, init: { isPrivate: boolean; description: string }): Repo {
    const at = this.now();
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner: this.viewerLogin,
      isPrivate: init.isPrivate,
      description: init.description,
      defaultBranch: 'main',
      refs: new Map(),
      headTarget: 'refs/heads/main',
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: at,
      updatedAt: at,
    };
    this.repoSeq += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * The repository addressed by (owner, name), or null. A repository whose
   * owner has not latched yet takes the addressing owner as its own; one
   * addressed under a different owner than its own does not exist.
   */
  findRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.owner === null) {
      repo.owner = owner;
      return repo;
    }
    return repo.owner === owner ? repo : null;
  }

  /** The repository with this numeric id, whatever owner addresses it. */
  repoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.findRepo(owner, name);
    if (repo === null) return false;
    this.repos.delete(name);
    return true;
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  nextLabelId(): number {
    this.labelSeq += 1;
    return this.labelSeq;
  }
}

/** An ISO-8601 timestamp for a logical-clock second. */
export function isoOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
