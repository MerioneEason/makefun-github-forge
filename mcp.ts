// mcp.ts — the Model Context Protocol endpoint at /mcp.
//
// Both protocol eras are served: the modern `server/discover` (which
// answers identity, capabilities and supported versions in one call, no
// handshake, no session) and the legacy `initialize` handshake. Tools are
// github-mcp-server's core set, executed against the same store as every
// other surface, and a tool result carries the object both as JSON text
// and as structured content. Protocol errors are JSON-RPC errors with the
// standard codes; a tool that fails answers isError, never a crash.

import type { Repo, Store } from './store.ts';
import { createIssueRecord, createPullRecord, repoJson } from './rest.ts';
import { branchTip, mergePullRequest } from './forge.ts';

const SERVER_INFO = { name: 'anvil-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required };
}

const OWNER_REPO = {
  owner: { type: 'string', description: 'The repository owner login.' },
  repo: { type: 'string', description: 'The repository name.' },
};

/** The tool list: one frozen array, so two tools/list answers are identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: objectSchema({ ...OWNER_REPO }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'get_issue',
    description: 'Read one issue by its number.',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      ['owner', 'repo', 'issue_number'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an issue.',
    inputSchema: objectSchema(
      {
        ...OWNER_REPO,
        issue_number: { type: 'number', description: 'The issue number.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      ['owner', 'repo', 'issue_number', 'body'],
    ),
  },
];

export interface McpReply {
  status: number;
  body: unknown;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Split a full name argument when a caller addressed a repo that way. */
function repoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if (repo === '' && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/', 2);
    owner = o ?? owner;
    repo = r ?? repo;
  }
  return { owner, repo };
}

function findRepoForTool(store: Store, args: Record<string, unknown>): Repo | null {
  const { owner, repo } = repoArgs(args);
  if (owner !== '') store.adoptViewer(owner);
  if (repo === '') return null;
  return store.findRepo(owner === '' ? store.actorLogin() : owner, repo);
}

function issueView(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    repository: `${repo.owner ?? ''}/${repo.name}`,
  };
}

function pullView(pull: { id: number; number: number; title: string; body: string; state: string; headRef: string; baseRef: string; merged: boolean; mergeCommitSha: string | null }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef },
    base: { ref: pull.baseRef },
  };
}

/** Run one tool; returns a tool result (never throws). */
function runTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return toolError('create_repo needs a repository name');
      const existing = store.repos.get(repoName);
      if (existing !== undefined) return toolOk(repoJson({ store, base: '' }, existing));
      const repo = store.createRepo(repoName, {
        isPrivate: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return toolOk(repoJson({ store, base: '' }, repo));
    }
    case 'get_repo': {
      const repo = findRepoForTool(store, args);
      if (repo === null) return toolError('repository not found');
      return toolOk(repoJson({ store, base: '' }, repo));
    }
    case 'create_issue': {
      const repo = findRepoForTool(store, args);
      if (repo === null) return toolError('repository not found');
      const issue = createIssueRecord(store, repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      return toolOk(issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepoForTool(store, args);
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueView(repo, issue));
      return toolOk(issues);
    }
    case 'get_issue': {
      const repo = findRepoForTool(store, args);
      if (repo === null) return toolError('repository not found');
      const issue = repo.issues.get(typeof args.issue_number === 'number' ? args.issue_number : Number.NaN);
      if (issue === undefined) return toolError('issue not found');
      return toolOk(issueView(repo, issue));
    }
    case 'create_pull_request': {
      const repo = findRepoForTool(store, args);
      if (repo === null) return toolError('repository not found');
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : repo.defaultBranch;
      if (branchTip(repo, head) === null) return toolError(`the head branch "${head}" does not exist`);
      if (branchTip(repo, base) === null) return toolError(`the base branch "${base}" does not exist`);
      const pull = createPullRecord(store, repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      return toolOk(pullView(pull));
    }
    case 'list_pull_requests': {
      const repo = findRepoForTool(store, args);
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => a.number - b.number)
        .map((pull) => pullView(pull));
      return toolOk(pulls);
    }
    case 'merge_pull_request': {
      const repo = findRepoForTool(store, args);
      if (repo === null) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : Number.NaN;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError('pull request not found');
      if (!pull.merged) {
        const outcome = mergePullRequest(store, repo, pull, 'merge');
        if (!outcome.ok) return toolError('the pull request has conflicts and cannot be merged');
      }
      return toolOk(pullView(pull));
    }
    case 'add_comment': {
      const repo = findRepoForTool(store, args);
      if (repo === null) return toolError('repository not found');
      const issue = repo.issues.get(typeof args.issue_number === 'number' ? args.issue_number : Number.NaN);
      if (issue === undefined) return toolError('issue not found');
      const at = store.now();
      const comment = {
        id: store.nextCommentId(),
        body: typeof args.body === 'string' ? args.body : '',
        authorLogin: store.actorLogin(),
        createdAt: at,
        updatedAt: at,
      };
      issue.comments.push(comment);
      return toolOk({ id: comment.id, body: comment.body, issue_number: issue.number });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

/** The required arguments a tools/call is missing, per the tool's own schema. */
function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  return required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
}

/** Handle one JSON-RPC request object. */
function handleOne(store: Store, request: JsonRpcRequest): { reply: Record<string, unknown> | null; status: number } {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const answer = (reply: Record<string, unknown>): { reply: Record<string, unknown> | null; status: number } =>
    isNotification ? { reply: null, status: 202 } : { reply, status: 200 };

  switch (method) {
    case 'server/discover':
      return answer(
        rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      );
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(asked) ? asked : '2025-11-25';
      return answer(rpcResult(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO }));
    }
    case 'ping':
      return answer(rpcResult(id, {}));
    case 'tools/list':
      return answer(rpcResult(id, { tools: TOOLS }));
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((entry) => entry.name === toolName);
      if (tool === undefined) return answer(rpcError(id, -32602, `Unknown tool: ${toolName}`));
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = missingArgs(tool, args);
      if (missing.length > 0) return answer(rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`));
      return answer(rpcResult(id, runTool(store, toolName, args)));
    }
    default:
      if (method.startsWith('notifications/')) return { reply: null, status: 202 };
      return answer(rpcError(id, -32601, `Method not found: ${method}`));
  }
}

/** POST /mcp with the raw body (a parse error must be distinguishable). */
export function handleMcp(store: Store, rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed
      .map((entry) => handleOne(store, (entry ?? {}) as JsonRpcRequest))
      .map((outcome) => outcome.reply)
      .filter((reply) => reply !== null);
    return { status: 200, body: replies };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } } };
  }
  const outcome = handleOne(store, parsed as JsonRpcRequest);
  return { status: outcome.status, body: outcome.reply };
}
