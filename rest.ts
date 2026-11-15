// rest.ts — the REST v3 surface: repositories, branches, refs, commits,
// contents, labels, issues, comments and pull requests, all reading and
// writing the one store the git and GraphQL surfaces share.
//
// Response objects carry the fields GitHub's carry (ids, node ids, urls,
// counts) because clients read them loosely but widely. Numbers for issues
// and pull requests come from one per-repository sequence, as GitHub's do.

import { isoOf, type Comment, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';
import { parseCommit } from './gitobj.ts';
import { branchTip, commitFiles, diffCommits, filesAt, mergePullRequest, pullConflicts, readContent, resolveCommit } from './forge.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestContext {
  store: Store;
  /** The entry's own origin, for absolute urls and Link headers. */
  base: string;
}

const SCOPES = 'repo, read:org, user, gist';
const INSTALLED_VERSION = '3.10.0-anvil';

function notFound(message = 'Not Found'): RestReply {
  return { status: 404, body: { message } };
}

function unprocessable(message: string): RestReply {
  return { status: 422, body: { message } };
}

function conflict(message: string): RestReply {
  return { status: 409, body: { message } };
}

// ------------------------------------------------------------ object views

export function userJson(store: Store, login: string): Record<string, unknown> {
  return {
    login,
    id: store.viewerId,
    node_id: `U_${store.viewerId}`,
    type: 'User',
    site_admin: false,
    name: login,
    email: `${login}@forge.invalid`,
  };
}

export function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? ctx.store.actorLogin();
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(ctx.store, owner),
    description: repo.description,
    fork: false,
    created_at: isoOf(repo.createdAt),
    updated_at: isoOf(repo.updatedAt),
    pushed_at: isoOf(repo.updatedAt),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    html_url: `${ctx.base}/${owner}/${repo.name}`,
    clone_url: `${ctx.base}/${owner}/${repo.name}.git`,
    git_url: `${ctx.base}/${owner}/${repo.name}.git`,
    ssh_url: `${ctx.base}/${owner}/${repo.name}.git`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name } : labelJson(label);
    }),
    user: userJson(ctx.store, issue.authorLogin),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : isoOf(issue.closedAt),
  };
}

function commentJson(ctx: RestContext, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(ctx.store, comment.authorLogin),
    created_at: isoOf(comment.createdAt),
    updated_at: isoOf(comment.updatedAt),
  };
}

function refSideJson(ctx: RestContext, repo: Repo, refName: string): Record<string, unknown> {
  const owner = repo.owner ?? ctx.store.actorLogin();
  const tip = branchTip(repo, refName);
  return {
    label: `${owner}:${refName}`,
    ref: refName,
    sha: tip,
    user: userJson(ctx.store, owner),
    repo: repoJson(ctx, repo),
  };
}

function pullJson(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  const diffs = diffCommits(ctx.store, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef));
  return {
    id: pull.id,
    node_id: `P_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(ctx.store, pull.authorLogin),
    head: refSideJson(ctx, repo, pull.headRef),
    base: refSideJson(ctx, repo, pull.baseRef),
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.updatedAt),
    closed_at: pull.closedAt === null ? null : isoOf(pull.closedAt),
    draft: false,
    additions: diffs.reduce((sum, d) => sum + d.additions, 0),
    deletions: diffs.reduce((sum, d) => sum + d.deletions, 0),
    changed_files: diffs.length,
  };
}

function identityJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: isoOf(0) };
  return { name: match[1]!, email: match[2]!, date: isoOf(Number.parseInt(match[3]!, 10)) };
}

function commitJson(ctx: RestContext, sha: string): Record<string, unknown> {
  const object = ctx.store.objects.get(sha)!;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: `K_${sha.slice(0, 12)}`,
    commit: {
      author: identityJson(commit.authorLine),
      committer: identityJson(commit.committerLine),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
    },
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------- pagination

interface Page {
  items: unknown[];
  headers: Record<string, string>;
}

function paginate(items: unknown[], query: URLSearchParams, url: string): Page {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages || items.length > perPage) {
    const withPage = (p: number): string => {
      const next = new URL(url);
      next.searchParams.set('page', String(p));
      next.searchParams.set('per_page', String(perPage));
      return next.toString();
    };
    const links: string[] = [];
    if (page < totalPages) links.push(`<${withPage(page + 1)}>; rel="next"`);
    links.push(`<${withPage(totalPages)}>; rel="last"`);
    if (page > 1) {
      links.push(`<${withPage(page - 1)}>; rel="prev"`);
      links.push(`<${withPage(1)}>; rel="first"`);
    }
    headers.Link = links.join(', ');
  }
  return { items: slice, headers };
}

function sortByCreated<T extends { createdAt: number; number: number }>(items: T[], query: URLSearchParams): T[] {
  const direction = query.get('direction') ?? 'desc';
  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt || a.number - b.number);
  return direction === 'asc' ? sorted : sorted.reverse();
}

// ---------------------------------------------------------------- routing

export function handleRest(ctx: RestContext, method: string, segments: string[], query: URLSearchParams, body: Record<string, unknown> | null, rawUrl: string): RestReply {
  const { store } = ctx;
  const [head, ...tail] = segments;

  if (segments.length === 0 && method === 'GET') {
    return {
      status: 200,
      body: {
        current_user_url: `${ctx.base}/api/v3/user`,
        repository_url: `${ctx.base}/api/v3/repos/{owner}/{repo}`,
        issue_url: `${ctx.base}/api/v3/repos/{owner}/{repo}/issues/{number}`,
      },
      headers: { 'X-OAuth-Scopes': SCOPES },
    };
  }
  if (head === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: INSTALLED_VERSION, verifiable_password_authentication: false } };
  }
  if (head === 'user' && segments.length === 1 && method === 'GET') {
    if (store.viewerLogin === null) return notFound();
    return { status: 200, body: userJson(store, store.viewerLogin) };
  }
  if (head === 'user' && tail[0] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const mine = [...store.repos.values()]
        .filter((repo) => repo.owner === null || repo.owner === store.viewerLogin)
        .sort((a, b) => a.id - b.id)
        .map((repo) => repoJson(ctx, repo));
      const page = paginate(mine, query, rawUrl);
      return { status: 200, body: page.items, headers: page.headers };
    }
    if (method === 'POST') return createRepo(ctx, body);
  }
  if (head === 'repos' && segments.length >= 3) {
    const owner = segments[1]!;
    const name = segments[2]!;
    store.adoptViewer(owner);
    const repo = store.findRepo(owner, name);
    if (repo === null) return notFound();
    return handleRepo(ctx, method, repo, segments.slice(3), query, body, rawUrl);
  }
  return notFound();
}

function createRepo(ctx: RestContext, body: Record<string, unknown> | null): RestReply {
  const { store } = ctx;
  const name = typeof body?.name === 'string' ? body.name : '';
  if (name === '') return unprocessable('Repository creation failed: name is required.');
  if (store.repos.has(name)) {
    return {
      status: 422,
      body: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    };
  }
  const repo = store.createRepo(name, {
    isPrivate: body?.private === true,
    description: typeof body?.description === 'string' ? body.description : '',
  });
  if (body?.auto_init === true) {
    commitFiles(store, repo, repo.defaultBranch, new Map([['README.md', Buffer.from(`# ${name}\n`)]]), 'Initial commit');
  }
  return { status: 201, body: repoJson(ctx, repo) };
}

function handleRepo(ctx: RestContext, method: string, repo: Repo, rest: string[], query: URLSearchParams, body: Record<string, unknown> | null, rawUrl: string): RestReply {
  const { store } = ctx;
  const [area, ...more] = rest;

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(ctx, repo) };
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body?.default_branch === 'string' && branchTip(repo, body.default_branch) !== null) repo.defaultBranch = body.default_branch;
      repo.updatedAt = store.now();
      return { status: 200, body: repoJson(ctx, repo) };
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      return { status: 204, body: null };
    }
    return notFound();
  }

  if (area === 'branches') {
    if (more.length === 0 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) }, protected: false }));
      return { status: 200, body: branches };
    }
    if (more.length >= 1 && method === 'GET') {
      const name = more.join('/');
      const tip = branchTip(repo, name);
      if (tip === null) return notFound();
      return { status: 200, body: { name, commit: { sha: tip }, protected: false } };
    }
    return notFound();
  }

  if (area === 'commits' && more.length === 0 && method === 'GET') {
    const start = resolveCommit(store, repo, query.get('sha') ?? repo.defaultBranch);
    if (start === null) return { status: 200, body: [] };
    const seen = new Set<string>();
    const order: string[] = [];
    let frontier = [start];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        order.push(oid);
        const object = store.objects.get(oid);
        if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
      }
      frontier = next;
    }
    const page = paginate(order.map((sha) => commitJson(ctx, sha)), query, rawUrl);
    return { status: 200, body: page.items, headers: page.headers };
  }

  if (area === 'contents') return handleContents(ctx, method, repo, more.join('/'), query, body);
  if (area === 'git' && more[0] === 'refs') return handleGitRefs(ctx, method, repo, more.slice(1), body);
  if (area === 'labels') return handleLabels(ctx, method, repo, more, body);
  if (area === 'issues') return handleIssues(ctx, method, repo, more, query, body, rawUrl);
  if (area === 'pulls') return handlePulls(ctx, method, repo, more, query, body, rawUrl);
  return notFound();
}

// --------------------------------------------------------------- contents

function fileView(entry: { name: string; path: string; sha: string; size: number; data: Buffer | null }): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: entry.size,
    name: entry.name,
    path: entry.path,
    content: entry.data === null ? '' : entry.data.toString('base64'),
    sha: entry.sha,
  };
}

function handleContents(ctx: RestContext, method: string, repo: Repo, path: string, query: URLSearchParams, body: Record<string, unknown> | null): RestReply {
  const { store } = ctx;
  if (method === 'GET') {
    const found = readContent(store, repo, path, query.get('ref'));
    if (found === null) return notFound();
    if (Array.isArray(found)) {
      return {
        status: 200,
        body: found.map((entry) => ({
          type: entry.type,
          size: entry.size,
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
        })),
      };
    }
    return { status: 200, body: fileView(found) };
  }
  if (method === 'PUT') {
    const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
    const message = typeof body?.message === 'string' ? body.message : 'Update file';
    const encoded = typeof body?.content === 'string' ? body.content : '';
    const bytes = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
    const existing = readContent(store, repo, path, branch);
    const existingFile = existing !== null && !Array.isArray(existing) ? existing : null;
    if (typeof body?.sha === 'string' && existingFile !== null && body.sha !== existingFile.sha) {
      return conflict('The file has changed since it was read; its sha does not match.');
    }
    const written = commitFiles(store, repo, branch, new Map([[path, bytes]]), message);
    const after = readContent(store, repo, path, branch);
    const view = after !== null && !Array.isArray(after) ? fileView(after) : fileView({ name: path.split('/').pop()!, path, sha: written.blobSha ?? '', size: bytes.length, data: bytes });
    const commit = ctx.store.objects.get(written.commitSha);
    const parsed = commit === undefined ? null : parseCommit(commit.data);
    return {
      status: existingFile === null ? 201 : 200,
      body: {
        content: view,
        commit: {
          sha: written.commitSha,
          author: parsed === null ? null : identityJson(parsed.authorLine),
          committer: parsed === null ? null : identityJson(parsed.committerLine),
          message,
          tree: { sha: parsed?.tree },
          parents: parsed?.parents.map((sha) => ({ sha })) ?? [],
        },
      },
    };
  }
  if (method === 'DELETE') {
    const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
    const message = typeof body?.message === 'string' ? body.message : 'Delete file';
    const existing = readContent(store, repo, path, branch);
    if (existing === null || Array.isArray(existing)) return notFound();
    if (typeof body?.sha === 'string' && body.sha !== existing.sha) {
      return conflict('The file has changed since it was read; its sha does not match.');
    }
    const written = commitFiles(store, repo, branch, new Map([[path, null]]), message);
    return { status: 200, body: { content: null, commit: { sha: written.commitSha, message } } };
  }
  return notFound();
}

// --------------------------------------------------------------- git refs

function handleGitRefs(ctx: RestContext, method: string, repo: Repo, parts: string[], body: Record<string, unknown> | null): RestReply {
  const { store } = ctx;
  if (parts.length === 0) {
    if (method === 'POST') {
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      const target = store.objects.get(sha);
      if (!ref.startsWith('refs/') || target === undefined) return unprocessable('The ref or the object it names is invalid.');
      repo.refs.set(ref, sha);
      repo.updatedAt = store.now();
      return { status: 201, body: refJson(repo, ref) };
    }
    if (method === 'GET') {
      return { status: 200, body: [...repo.refs.keys()].sort().map((ref) => refJson(repo, ref)) };
    }
    return notFound();
  }
  const ref = `refs/${parts.join('/')}`;
  if (method === 'GET') {
    if (!repo.refs.has(ref)) return notFound();
    return { status: 200, body: refJson(repo, ref) };
  }
  if (method === 'DELETE') {
    if (!repo.refs.has(ref)) return notFound();
    repo.refs.delete(ref);
    return { status: 204, body: null };
  }
  return notFound();
}

function refJson(repo: Repo, ref: string): Record<string, unknown> {
  const sha = repo.refs.get(ref)!;
  return { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } };
}

// ----------------------------------------------------------------- labels

function handleLabels(ctx: RestContext, method: string, repo: Repo, more: string[], body: Record<string, unknown> | null): RestReply {
  const { store } = ctx;
  if (more.length === 0) {
    if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map(labelJson) };
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '') return unprocessable('A label needs a name.');
      const existing = repo.labels.get(name);
      if (existing !== undefined) return { status: 200, body: labelJson(existing) };
      const label: Label = {
        id: store.nextLabelId(),
        name,
        color: typeof body?.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
        description: typeof body?.description === 'string' ? body.description : null,
      };
      repo.labels.set(name, label);
      return { status: 201, body: labelJson(label) };
    }
  }
  if (more.length === 1 && method === 'GET') {
    const label = repo.labels.get(decodeURIComponent(more[0]!));
    if (label === undefined) return notFound();
    return { status: 200, body: labelJson(label) };
  }
  return notFound();
}

// ----------------------------------------------------------------- issues

export function createIssueRecord(store: Store, repo: Repo, init: { title: string; body: string; labels: string[] }): Issue {
  const at = store.now();
  const issue: Issue = {
    id: store.nextIssueId(),
    number: repo.nextNumber,
    title: init.title,
    body: init.body,
    state: 'open',
    labels: [...init.labels],
    authorLogin: store.actorLogin(),
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function handleIssues(ctx: RestContext, method: string, repo: Repo, more: string[], query: URLSearchParams, body: Record<string, unknown> | null, rawUrl: string): RestReply {
  const { store } = ctx;
  if (more.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const labelFilter = query.get('labels');
      if (labelFilter !== null && labelFilter !== '') {
        const wanted = labelFilter.split(',');
        issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
      }
      const page = paginate(sortByCreated(issues, query).map((issue) => issueJson(ctx, repo, issue)), query, rawUrl);
      return { status: 200, body: page.items, headers: page.headers };
    }
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      if (title === '') return unprocessable('An issue needs a title.');
      const labels = Array.isArray(body?.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const name of labels) {
        if (!repo.labels.has(name)) return unprocessable(`Validation Failed: the label "${name}" does not exist in this repository.`);
      }
      const issue = createIssueRecord(store, repo, { title, body: typeof body?.body === 'string' ? body.body : '', labels });
      return { status: 201, body: issueJson(ctx, repo, issue) };
    }
    return notFound();
  }
  const number = Number.parseInt(more[0]!, 10);
  const issue = repo.issues.get(number);
  if (more.length === 1) {
    if (issue === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: issueJson(ctx, repo, issue) };
    if (method === 'PATCH') {
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string') issue.body = body.body;
      if (Array.isArray(body?.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const name of labels) if (!repo.labels.has(name)) return unprocessable(`Validation Failed: the label "${name}" does not exist in this repository.`);
        issue.labels = labels;
      }
      if (body?.state === 'closed' || body?.state === 'open') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? store.now() : null;
      }
      issue.updatedAt = store.now();
      return { status: 200, body: issueJson(ctx, repo, issue) };
    }
    return notFound();
  }
  if (more.length === 2 && more[1] === 'comments') {
    if (issue === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: issue.comments.map((comment) => commentJson(ctx, comment)) };
    if (method === 'POST') {
      const text = typeof body?.body === 'string' ? body.body : '';
      if (text === '') return unprocessable('A comment needs a body.');
      const at = store.now();
      const comment: Comment = { id: store.nextCommentId(), body: text, authorLogin: store.actorLogin(), createdAt: at, updatedAt: at };
      issue.comments.push(comment);
      issue.updatedAt = at;
      return { status: 201, body: commentJson(ctx, comment) };
    }
  }
  return notFound();
}

// ------------------------------------------------------------------ pulls

export function createPullRecord(store: Store, repo: Repo, init: { title: string; body: string; head: string; base: string }): Pull {
  const at = store.now();
  const pull: Pull = {
    id: store.nextIssueId(),
    number: repo.nextNumber,
    title: init.title,
    body: init.body,
    state: 'open',
    headRef: init.head,
    baseRef: init.base,
    authorLogin: store.actorLogin(),
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

function handlePulls(ctx: RestContext, method: string, repo: Repo, more: string[], query: URLSearchParams, body: Record<string, unknown> | null, rawUrl: string): RestReply {
  const { store } = ctx;
  if (more.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      const page = paginate(sortByCreated(pulls, query).map((pull) => pullJson(ctx, repo, pull)), query, rawUrl);
      return { status: 200, body: page.items, headers: page.headers };
    }
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      const head = typeof body?.head === 'string' ? body.head : '';
      const base = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '' || head === '') return unprocessable('A pull request needs a title and a head branch.');
      const headTip = branchTip(repo, head);
      const baseTipValue = branchTip(repo, base);
      if (headTip === null) return unprocessable(`The head branch "${head}" does not exist.`);
      if (baseTipValue === null) return unprocessable(`The base branch "${base}" does not exist.`);
      if (head === base) return unprocessable('The head and base branches are the same.');
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing !== undefined) return unprocessable(`A pull request already exists for ${head} into ${base}.`);
      const pull = createPullRecord(store, repo, { title, body: typeof body?.body === 'string' ? body.body : '', head, base });
      return { status: 201, body: pullJson(ctx, repo, pull) };
    }
    return notFound();
  }
  const number = Number.parseInt(more[0]!, 10);
  const pull = repo.pulls.get(number);
  if (more.length === 1 && method === 'GET') {
    if (pull === undefined) return notFound();
    return { status: 200, body: pullJson(ctx, repo, pull) };
  }
  if (more.length === 2 && more[1] === 'files' && method === 'GET') {
    if (pull === undefined) return notFound();
    const diffs = diffCommits(store, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef));
    return {
      status: 200,
      body: diffs.map((diff) => ({
        sha: diff.sha,
        filename: diff.filename,
        status: diff.status,
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.changes,
      })),
    };
  }
  if (more.length === 2 && more[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return notFound();
    if (pull.merged) return { status: 405, body: { message: 'Pull Request has already been merged' } };
    if (pull.state !== 'open') return { status: 405, body: { message: 'Pull Request is not open' } };
    const methodName = typeof body?.merge_method === 'string' ? body.merge_method : 'merge';
    const outcome = mergePullRequest(store, repo, pull, methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge');
    if (!outcome.ok || outcome.sha === null) {
      return { status: 405, body: { message: 'Pull Request is not mergeable: the head and base changed the same content differently.' } };
    }
    return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}

/** Whether a pull request conflicts (used by the GraphQL mergeable field). */
export function pullMergeable(store: Store, repo: Repo, pull: Pull): boolean {
  return !pullConflicts(store, repo, pull);
}

/** filesAt re-exported for the GraphQL layer's convenience. */
export { filesAt };
