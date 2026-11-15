// graphql.ts — the GraphQL surface gh and the GitHub MCP server speak.
//
// A small, honest GraphQL: a tokenizer and parser for the real language
// subset clients send (operations, variables, fragments, inline fragments,
// input objects, enums, lists, directives), and an executor over the same
// store the REST and git surfaces use — so an issue created over REST is
// the issue a query reads, with the same global id in both directions.
// Introspection answers the field lists gh feature-detects. An unknown
// field is a 200 with an `errors` array naming the field, as GitHub does.

import { isoOf, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { createIssueRecord, createPullRecord } from './rest.ts';
import { branchTip, diffCommits, mergePullRequest, pullConflicts } from './forge.ts';

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, ValueNode>;
  directives: Map<string, Map<string, ValueNode>>;
  selections: FieldNode[];
  fragmentRef: string | null;
  onType: string | null;
}

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  varDefaults: Map<string, ValueNode>;
  selections: FieldNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { onType: string; selections: FieldNode[] }>;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at]!;
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push('...');
      at += 3;
      continue;
    }
    if (source.startsWith('"""', at)) {
      const end = source.indexOf('"""', at + 3);
      const text = source.slice(at + 3, end === -1 ? source.length : end);
      tokens.push(`"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      at = end === -1 ? source.length : end + 3;
      continue;
    }
    if (ch === '"') {
      let end = at + 1;
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\') end += 1;
        end += 1;
      }
      tokens.push(source.slice(at, end + 1));
      at = end + 1;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push(ch);
      at += 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = at;
      while (end < source.length && /[0-9.eE+-]/.test(source[end]!)) end += 1;
      tokens.push(source.slice(at, end));
      at = end;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let end = at;
      while (end < source.length && /[_0-9A-Za-z]/.test(source[end]!)) end += 1;
      tokens.push(source.slice(at, end));
      at = end;
      continue;
    }
    at += 1;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.at];
  }

  private take(): string {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.take();
    if (got !== token) throw new Error(`expected ${token}, found ${got}`);
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { onType: string; selections: FieldNode[] }>();
    while (this.at < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ type: 'query', name: null, varDefaults: new Map(), selections: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        this.take();
        let name: string | null = null;
        if (this.peek() !== undefined && /^[_A-Za-z]/.test(this.peek()!)) name = this.take();
        const varDefaults = new Map<string, ValueNode>();
        if (this.peek() === '(') {
          this.take();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.take();
            this.expect(':');
            this.parseType();
            if (this.peek() === '=') {
              this.take();
              varDefaults.set(varName, this.parseValue());
            }
            this.parseDirectives();
          }
          this.take();
        }
        this.parseDirectives();
        operations.push({ type: head, name, varDefaults, selections: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.take();
        const fragName = this.take();
        this.expect('on');
        const onType = this.take();
        this.parseDirectives();
        fragments.set(fragName, { onType, selections: this.parseSelectionSet() });
      } else if (head === 'schema' || head === 'scalar' || head === 'type' || head === 'interface' || head === 'union' || head === 'enum' || head === 'input' || head === 'directive' || head === 'extend') {
        // Type-system definitions in a document: skip a balanced block.
        this.skipDefinition();
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipDefinition(): void {
    while (this.at < this.tokens.length && this.peek() !== '{') this.at += 1;
    if (this.peek() === '{') {
      let depth = 0;
      do {
        const token = this.take();
        if (token === '{') depth += 1;
        else if (token === '}') depth -= 1;
      } while (depth > 0 && this.at < this.tokens.length);
    }
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.take();
      this.parseType();
      this.expect(']');
    } else {
      this.take();
    }
    if (this.peek() === '!') this.take();
  }

  private parseDirectives(): Map<string, Map<string, ValueNode>> {
    const directives = new Map<string, Map<string, ValueNode>>();
    while (this.peek() === '@') {
      this.take();
      const name = this.take();
      directives.set(name, this.peek() === '(' ? this.parseArgs() : new Map());
    }
    return directives;
  }

  private parseArgs(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.take();
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.take();
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.peek()!;
    if (token === '$') {
      this.take();
      return { kind: 'var', name: this.take() };
    }
    if (token === '[') {
      this.take();
      const items: ValueNode[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.take();
      return { kind: 'list', items };
    }
    if (token === '{') {
      this.take();
      const fields = new Map<string, ValueNode>();
      while (this.peek() !== '}') {
        const name = this.take();
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.take();
      return { kind: 'object', fields };
    }
    this.take();
    if (token.startsWith('"')) return { kind: 'str', value: JSON.parse(token) as string };
    if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d/.test(token)) return { kind: 'num', value: Number(token) };
    return { kind: 'enum', value: token };
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const selections: FieldNode[] = [];
    while (this.peek() !== '}') selections.push(this.parseSelection());
    this.take();
    return selections;
  }

  private parseSelection(): FieldNode {
    if (this.peek() === '...') {
      this.take();
      if (this.peek() === 'on') {
        this.take();
        const onType = this.take();
        const directives = this.parseDirectives();
        return { name: '', alias: null, args: new Map(), directives, selections: this.parseSelectionSet(), fragmentRef: null, onType };
      }
      const ref = this.take();
      const directives = this.parseDirectives();
      return { name: '', alias: null, args: new Map(), directives, selections: [], fragmentRef: ref, onType: null };
    }
    let name = this.take();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.take();
      alias = name;
      name = this.take();
    }
    const args = this.peek() === '(' ? this.parseArgs() : new Map<string, ValueNode>();
    const directives = this.parseDirectives();
    const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { name, alias, args, directives, selections, fragmentRef: null, onType: null };
  }
}

// -------------------------------------------------------------- global ids

/** A global (Relay) id: opaque, stable, and decodable by this server only. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`v1:${type}:${key}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^v1:([A-Za-z]+):(.*)$/.exec(text);
    if (match === null) return null;
    return { type: match[1]!, key: match[2]! };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- nodes

/** A typed value the executor walks: the type name plus its payload. */
interface Node {
  type: string;
  repo?: Repo;
  issue?: Issue;
  pull?: Pull;
  login?: string;
  commentId?: number;
  commentBody?: string;
  commentAt?: number;
  name?: string;
  oid?: string;
  nodes?: Node[];
  total?: number;
  hasNext?: boolean;
  hasPrev?: boolean;
  startCursor?: string | null;
  endCursor?: string | null;
  path?: string;
  additions?: number;
  deletions?: number;
  changeType?: string;
  payload?: Node | null;
  cursor?: string;
  edges?: Node[];
  pageInfo?: Node;
}

interface ExecContext {
  store: Store;
  vars: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: { message: string }[];
}

function evalValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'var':
      return ctx.vars[node.name];
    case 'str':
    case 'num':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = evalValue(value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = evalValue(value, ctx);
  return out;
}

function repoNode(repo: Repo): Node {
  return { type: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): Node {
  return { type: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): Node {
  return { type: 'PullRequest', repo, pull };
}

function userNode(login: string): Node {
  return { type: 'User', login };
}

// ------------------------------------------------------------- connections

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  return match === null ? -1 : Number.parseInt(match[1]!, 10);
}

interface ConnectionSpec<T> {
  items: T[];
  first: unknown;
  after: unknown;
}

/** Slice a connection page and build its node (nodes, edges, pageInfo). */
function connection<T>(spec: ConnectionSpec<T>, wrap: (item: T) => Node): Node {
  const total = spec.items.length;
  const afterIndex = indexOfCursor(spec.after);
  const start = afterIndex + 1;
  const wanted = typeof spec.first === 'number' && Number.isFinite(spec.first) ? Math.max(0, Math.trunc(spec.first)) : total;
  const pageItems = spec.items.slice(start, start + wanted);
  const nodes = pageItems.map(wrap);
  const pageInfo: Node = {
    type: 'PageInfo',
    hasNext: start + pageItems.length < total,
    hasPrev: start > 0,
    startCursor: pageItems.length > 0 ? cursorOf(start) : null,
    endCursor: pageItems.length > 0 ? cursorOf(start + pageItems.length - 1) : null,
  };
  const edges = pageItems.map((item, i) => ({ type: 'Edge', payload: wrap(item), cursor: cursorOf(start + i) }) as Node);
  return { type: 'Connection', nodes, edges, pageInfo, total };
}

// -------------------------------------------------------------- schema data

/** The fields each type reports to introspection (a superset is honest). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'addLabelsToLabelable', 'removeLabelsFromLabelable'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt', 'isViewer', 'repositories', 'issues', 'pullRequests'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'isArchived',
    'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'defaultBranchRef',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'label', 'labels', 'ref', 'refs', 'object', 'url',
    'createdAt', 'updatedAt', 'pushedAt', 'stargazerCount', 'forkCount', 'primaryLanguage', 'licenseInfo',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'stateReason', 'body', 'bodyText', 'bodyHTML', 'author',
    'repository', 'labels', 'comments', 'assignees', 'milestone', 'createdAt', 'updatedAt', 'closedAt',
    'url', 'viewerDidAuthor', 'locked', 'isPinned', 'linkedPullRequests', 'participants', 'reactions',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'repository',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'headRepository', 'baseRepository',
    'mergeable', 'merged', 'mergedAt', 'mergedBy', 'mergeCommit', 'isDraft', 'files', 'commits',
    'additions', 'deletions', 'changedFiles', 'labels', 'comments', 'reviews', 'createdAt', 'updatedAt',
    'closedAt', 'url', 'viewerDidAuthor', 'locked', 'maintainerCanModify',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', 'issue', 'viewerDidAuthor'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository', 'associatedPullRequests'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'author', 'committer', 'committedDate', 'tree', 'parents', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color', 'description', 'isDefault', 'url'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  MergePullRequestMethod: ['MERGE', 'SQUASH', 'REBASE'],
  FileChangeType: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

const OBJECT_TYPES = new Set(Object.keys(TYPE_FIELDS));

// ---------------------------------------------------------------- executor

function typeOfValue(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'type' in (value as Node)) return (value as Node).type;
  return '';
}

/** Expand fragments and inline fragments into a flat field list for a type. */
function expandSelections(selections: FieldNode[], typeName: string, ctx: ExecContext): FieldNode[] {
  const out: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.fragmentRef !== null) {
      const fragment = ctx.fragments.get(selection.fragmentRef);
      if (fragment !== undefined && (fragment.onType === typeName || typeName === '')) out.push(...expandSelections(fragment.selections, typeName, ctx));
      continue;
    }
    if (selection.onType !== null) {
      if (selection.onType === typeName || typeName === '') out.push(...expandSelections(selection.selections, typeName, ctx));
      continue;
    }
    if (selection.name === '' && selection.selections.length > 0) {
      out.push(...expandSelections(selection.selections, typeName, ctx));
      continue;
    }
    out.push(selection);
  }
  return out;
}

function directiveSkips(field: FieldNode, ctx: ExecContext): boolean {
  const skip = field.directives.get('skip');
  if (skip !== undefined) {
    const flag = skip.get('if');
    if (flag !== undefined && evalValue(flag, ctx) === true) return true;
  }
  const include = field.directives.get('include');
  if (include !== undefined) {
    const flag = include.get('if');
    if (flag !== undefined && evalValue(flag, ctx) === false) return true;
  }
  return false;
}

/** Execute a selection set against a node; returns the response object. */
function executeOn(node: Node, selections: FieldNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of expandSelections(selections, node.type, ctx)) {
    if (directiveSkips(field, ctx)) continue;
    const key = field.alias ?? field.name;
    const value = resolveField(node, field, ctx);
    out[key] = completeValue(value, field, ctx);
  }
  return out;
}

/** Turn a resolved value into response data, walking sub-selections. */
function completeValue(value: unknown, field: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object' && 'type' in (value as Node)) {
    if (field.selections.length === 0) return null;
    return executeOn(value as Node, field.selections, ctx);
  }
  return value;
}

function unknownField(ctx: ExecContext, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Field '${fieldName}' doesn't exist on type '${typeName}'` });
  return null;
}

/** The one dispatch: a field of a node, resolved against the store. */
function resolveField(node: Node, field: FieldNode, ctx: ExecContext): unknown {
  const { store } = ctx;
  const args = argsOf(field, ctx);
  const name = field.name;
  if (name === '__typename') return node.type;
  if (name === '__type') return typeNode(args.name);
  if (name === '__schema') return schemaNode();

  if (node.type.endsWith('Connection')) {
    if (name === 'nodes') return node.nodes ?? [];
    if (name === 'edges') return node.edges ?? [];
    if (name === 'pageInfo') return node.pageInfo ?? null;
    if (name === 'totalCount') return node.total ?? 0;
    return unknownField(ctx, node.type, name);
  }
  if (node.type === '__Schema') {
    if (name === 'queryType') return { type: '__Type', name: 'Query' } as Node;
    if (name === 'mutationType') return { type: '__Type', name: 'Mutation' } as Node;
    if (name === 'types') return Object.keys(TYPE_FIELDS).map((typeName) => ({ type: '__Type', name: typeName }) as Node);
    if (name === 'directives') return [];
    return unknownField(ctx, node.type, name);
  }

  switch (node.type) {
    case 'Query':
      return resolveQuery(node, name, args, ctx);
    case 'Mutation':
      return resolveMutation(name, args, ctx);
    case 'User':
      if (name === 'login') return node.login ?? null;
      if (name === 'id') return globalId('User', node.login ?? '');
      if (name === 'name') return node.login ?? null;
      if (name === 'email') return `${node.login}@forge.invalid`;
      if (name === 'isViewer') return true;
      if (name === 'url') return `https://forge.invalid/${node.login}`;
      break;
    case 'Repository':
      return resolveRepository(node, name, args, ctx);
    case 'Issue':
      return resolveIssue(node, name, ctx);
    case 'PullRequest':
      return resolvePullRequest(node, name, args, ctx);
    case 'IssueComment':
      if (name === 'id') return globalId('IssueComment', `${node.repo!.id}:${node.issue!.number}:${node.commentId}`);
      if (name === 'body' || name === 'bodyText') return node.commentBody ?? '';
      if (name === 'author') return userNode(node.issue?.authorLogin ?? store.actorLogin());
      if (name === 'createdAt' || name === 'updatedAt') return isoOf(node.commentAt ?? 0);
      break;
    case 'Ref':
      if (name === 'name') return node.name ?? null;
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'target') return node.oid === undefined ? null : { type: 'Commit', oid: node.oid };
      break;
    case 'Commit':
      if (name === 'oid' || name === 'id') return node.oid ?? null;
      break;
    case 'Label':
      if (name === 'id') return globalId('Label', `${node.repo!.id}:${node.name}`);
      if (name === 'name') return node.name ?? null;
      if (name === 'color') return node.repo!.labels.get(node.name ?? '')?.color ?? 'ededed';
      if (name === 'description') return node.repo!.labels.get(node.name ?? '')?.description ?? null;
      if (name === 'isDefault') return false;
      break;
    case 'PageInfo':
      if (name === 'hasNextPage') return node.hasNext ?? false;
      if (name === 'hasPreviousPage') return node.hasPrev ?? false;
      if (name === 'startCursor') return node.startCursor ?? null;
      if (name === 'endCursor') return node.endCursor ?? null;
      break;
    case 'Connection':
      if (name === 'nodes') return node.nodes ?? [];
      if (name === 'edges') return node.edges ?? [];
      if (name === 'pageInfo') return node.pageInfo ?? null;
      if (name === 'totalCount') return node.total ?? 0;
      break;
    case 'Edge':
      if (name === 'node') return node.payload ?? null;
      if (name === 'cursor') return node.cursor ?? null;
      break;
    case 'PullRequestFile':
      if (name === 'path') return node.path ?? null;
      if (name === 'additions') return node.additions ?? 0;
      if (name === 'deletions') return node.deletions ?? 0;
      if (name === 'changeType') return node.changeType ?? 'MODIFIED';
      break;
    case '__Type':
      return resolveTypeField(node, name, args);
    case '__Field':
      if (name === 'name') return node.name ?? null;
      if (name === 'description') return null;
      if (name === 'args') return [];
      if (name === 'type') return { type: '__TypeRef', name: null };
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      break;
    case '__EnumValue':
      if (name === 'name') return node.name ?? null;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      break;
    case '__TypeRef':
      if (name === 'name') return node.name ?? null;
      if (name === 'kind') return 'SCALAR';
      if (name === 'ofType') return null;
      break;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (name === 'issue') return node.payload ?? null;
      if (name === 'clientMutationId') return null;
      break;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (name === 'pullRequest') return node.payload ?? null;
      if (name === 'clientMutationId') return null;
      break;
    case 'AddCommentPayload':
      if (name === 'commentEdge') return node.payload ?? null;
      if (name === 'subject') return node.issue === undefined ? null : node.payload ?? null;
      if (name === 'clientMutationId') return null;
      break;
  }
  return unknownField(ctx, node.type, name);
}

function resolveQuery(_node: Node, name: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const { store } = ctx;
  if (name === 'viewer') return userNode(store.viewerLogin ?? '');
  if (name === 'repository') {
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const repoName = typeof args.name === 'string' ? args.name : '';
    store.adoptViewer(owner);
    const repo = store.findRepo(owner, repoName);
    return repo === null ? null : repoNode(repo);
  }
  if (name === 'node') {
    const parsed = typeof args.id === 'string' ? parseGlobalId(args.id) : null;
    if (parsed === null) return null;
    return nodeByGlobalId(ctx, parsed.type, parsed.key);
  }
  if (name === 'user') {
    const login = typeof args.login === 'string' ? args.login : '';
    return login === '' ? null : userNode(login);
  }
  return unknownField(ctx, 'Query', name);
}

function nodeByGlobalId(ctx: ExecContext, type: string, key: string): Node | null {
  const { store } = ctx;
  if (type === 'Repository') {
    const repo = store.repoById(Number.parseInt(key, 10));
    return repo === null ? null : repoNode(repo);
  }
  if (type === 'Issue' || type === 'PullRequest') {
    const [repoId, number] = key.split(':').map((part) => Number.parseInt(part, 10));
    const repo = repoId === undefined ? null : store.repoById(repoId);
    if (repo === null || number === undefined) return null;
    const found = type === 'Issue' ? repo.issues.get(number) : repo.pulls.get(number);
    if (found === undefined) return null;
    return type === 'Issue' ? issueNode(repo, found as Issue) : pullNode(repo, found as Pull);
  }
  if (type === 'User') return userNode(key);
  return null;
}

function resolveRepository(node: Node, name: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const { store } = ctx;
  const repo = node.repo!;
  switch (name) {
    case 'id':
      return globalId('Repository', String(repo.id));
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner ?? store.actorLogin()}/${repo.name}`;
    case 'owner':
      return userNode(repo.owner ?? store.actorLogin());
    case 'description':
      return repo.description === '' ? null : repo.description;
    case 'isPrivate':
      return repo.isPrivate;
    case 'isFork':
    case 'isArchived':
      return false;
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
    case 'hasProjectsEnabled':
    case 'hasWikiEnabled':
      return true;
    case 'defaultBranchRef': {
      const tip = branchTip(repo, repo.defaultBranch);
      return tip === null ? null : { type: 'Ref', name: repo.defaultBranch, oid: tip, repo };
    }
    case 'createdAt':
      return isoOf(repo.createdAt);
    case 'updatedAt':
    case 'pushedAt':
      return isoOf(repo.updatedAt);
    case 'url':
      return `https://forge.invalid/${repo.owner ?? ''}/${repo.name}`;
    case 'issue': {
      const number = typeof args.number === 'number' ? args.number : Number.NaN;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueNode(repo, issue);
    }
    case 'issues': {
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? args.states : null;
      if (states !== null) {
        const wanted = states.map((s) => String(s).toLowerCase());
        issues = issues.filter((issue) => wanted.includes(issue.state));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      issues.sort((a, b) => a.number - b.number);
      if (orderBy !== null && orderBy.direction === 'DESC') issues.reverse();
      const conn = connection({ items: issues, first: args.first, after: args.after }, (issue) => issueNode(repo, issue));
      conn.type = 'IssueConnection';
      return conn;
    }
    case 'pullRequest': {
      const number = typeof args.number === 'number' ? args.number : Number.NaN;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullNode(repo, pull);
    }
    case 'pullRequests': {
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? args.states : null;
      if (states !== null) {
        pulls = pulls.filter((pull) => states.some((s) => (s === 'MERGED' ? pull.merged : s === 'OPEN' ? pull.state === 'open' : pull.state === 'closed' && !pull.merged)));
      }
      pulls.sort((a, b) => b.number - a.number);
      const conn = connection({ items: pulls, first: args.first, after: args.after }, (pull) => pullNode(repo, pull));
      conn.type = 'PullRequestConnection';
      return conn;
    }
    case 'labels': {
      const labels = [...repo.labels.values()].map((label) => ({ type: 'Label', name: label.name, repo }) as Node);
      const conn = connection({ items: labels, first: args.first, after: args.after }, (label) => label);
      conn.type = 'LabelConnection';
      return conn;
    }
    default:
      return unknownField(ctx, 'Repository', name);
  }
}

function resolveIssue(node: Node, name: string, ctx: ExecContext): unknown {
  const issue = node.issue!;
  const repo = node.repo!;
  switch (name) {
    case 'id':
      return globalId('Issue', `${repo.id}:${issue.number}`);
    case 'databaseId':
      return issue.id;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'stateReason':
      return issue.state === 'closed' ? 'COMPLETED' : null;
    case 'body':
    case 'bodyText':
      return issue.body;
    case 'bodyHTML':
      return `<p>${issue.body}</p>`;
    case 'author':
      return userNode(issue.authorLogin);
    case 'repository':
      return repoNode(repo);
    case 'labels': {
      const labels = issue.labels.map((labelName) => ({ type: 'Label', name: labelName, repo }) as Node);
      const conn = connection({ items: labels, first: null, after: null }, (label) => label);
      conn.type = 'LabelConnection';
      return conn;
    }
    case 'comments': {
      const comments = issue.comments.map((comment) => ({ type: 'IssueComment', repo, issue, commentId: comment.id, commentBody: comment.body, commentAt: comment.createdAt }) as Node);
      const conn = connection({ items: comments, first: null, after: null }, (comment) => comment);
      conn.type = 'IssueCommentConnection';
      return conn;
    }
    case 'createdAt':
      return isoOf(issue.createdAt);
    case 'updatedAt':
      return isoOf(issue.updatedAt);
    case 'closedAt':
      return issue.closedAt === null ? null : isoOf(issue.closedAt);
    case 'url':
      return `https://forge.invalid/${repo.owner ?? ''}/${repo.name}/issues/${issue.number}`;
    case 'locked':
    case 'isPinned':
    case 'viewerDidAuthor':
      return false;
    default:
      return unknownField(ctx, 'Issue', name);
  }
}

function resolvePullRequest(node: Node, name: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const { store } = ctx;
  const pull = node.pull!;
  const repo = node.repo!;
  switch (name) {
    case 'id':
      return globalId('PullRequest', `${repo.id}:${pull.number}`);
    case 'databaseId':
      return pull.id;
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
    case 'bodyText':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pull.merged;
    case 'mergedAt':
      return pull.mergedAt === null ? null : isoOf(pull.mergedAt);
    case 'mergeable':
      if (pull.merged) return 'MERGEABLE';
      return pullConflicts(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRef': {
      const tip = branchTip(repo, pull.headRef);
      return tip === null ? null : { type: 'Ref', name: pull.headRef, oid: tip, repo };
    }
    case 'baseRef': {
      const tip = branchTip(repo, pull.baseRef);
      return tip === null ? null : { type: 'Ref', name: pull.baseRef, oid: tip, repo };
    }
    case 'author':
      return userNode(pull.authorLogin);
    case 'repository':
      return repoNode(repo);
    case 'isDraft':
      return false;
    case 'files': {
      const diffs = diffCommits(store, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef));
      const files = diffs.map((diff) => ({
        type: 'PullRequestFile',
        path: diff.filename,
        additions: diff.additions,
        deletions: diff.deletions,
        changeType: diff.status === 'added' ? 'ADDED' : diff.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }) as Node);
      const conn = connection({ items: files, first: args.first, after: args.after }, (file) => file);
      conn.type = 'PullRequestFileConnection';
      return conn;
    }
    case 'additions':
      return diffCommits(store, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef)).reduce((sum, d) => sum + d.additions, 0);
    case 'deletions':
      return diffCommits(store, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef)).reduce((sum, d) => sum + d.deletions, 0);
    case 'changedFiles':
      return diffCommits(store, branchTip(repo, pull.baseRef), branchTip(repo, pull.headRef)).length;
    case 'mergeCommit':
      return pull.mergeCommitSha === null ? null : { type: 'Commit', oid: pull.mergeCommitSha };
    case 'createdAt':
      return isoOf(pull.createdAt);
    case 'updatedAt':
      return isoOf(pull.updatedAt);
    case 'closedAt':
      return pull.closedAt === null ? null : isoOf(pull.closedAt);
    case 'url':
      return `https://forge.invalid/${repo.owner ?? ''}/${repo.name}/pull/${pull.number}`;
    case 'locked':
    case 'viewerDidAuthor':
    case 'maintainerCanModify':
      return false;
    default:
      return unknownField(ctx, 'PullRequest', name);
  }
}

// --------------------------------------------------------------- mutations

function resolveMutation(name: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const { store } = ctx;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repoFromId = (raw: unknown): Repo | null => {
    const parsed = typeof raw === 'string' ? parseGlobalId(raw) : null;
    if (parsed === null || parsed.type !== 'Repository') return null;
    return store.repoById(Number.parseInt(parsed.key, 10));
  };
  const issueFromId = (raw: unknown): { repo: Repo; issue: Issue } | null => {
    const parsed = typeof raw === 'string' ? parseGlobalId(raw) : null;
    if (parsed === null || parsed.type !== 'Issue') return null;
    const [repoId, number] = parsed.key.split(':').map((part) => Number.parseInt(part, 10));
    const repo = repoId === undefined ? null : store.repoById(repoId);
    const issue = repo?.issues.get(number ?? Number.NaN);
    return repo !== null && repo !== undefined && issue !== undefined ? { repo, issue } : null;
  };
  const pullFromId = (raw: unknown): { repo: Repo; pull: Pull } | null => {
    const parsed = typeof raw === 'string' ? parseGlobalId(raw) : null;
    if (parsed === null || parsed.type !== 'PullRequest') return null;
    const [repoId, number] = parsed.key.split(':').map((part) => Number.parseInt(part, 10));
    const repo = repoId === undefined ? null : store.repoById(repoId);
    const pull = repo?.pulls.get(number ?? Number.NaN);
    return repo !== null && repo !== undefined && pull !== undefined ? { repo, pull } : null;
  };

  switch (name) {
    case 'createIssue': {
      const repo = repoFromId(input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'createIssue: the repository id does not name a repository' });
        return null;
      }
      const issue = createIssueRecord(store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      return { type: 'CreateIssuePayload', payload: issueNode(repo, issue) } as Node;
    }
    case 'closeIssue': {
      const found = issueFromId(input.issueId);
      if (found === null) {
        ctx.errors.push({ message: 'closeIssue: the issue id does not name an issue' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.closedAt = store.now();
      found.issue.updatedAt = store.now();
      return { type: 'CloseIssuePayload', payload: issueNode(found.repo, found.issue) } as Node;
    }
    case 'createPullRequest': {
      const repo = repoFromId(input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'createPullRequest: the repository id does not name a repository' });
        return null;
      }
      const pull = createPullRecord(store, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
      });
      return { type: 'CreatePullRequestPayload', payload: pullNode(repo, pull) } as Node;
    }
    case 'mergePullRequest': {
      const found = pullFromId(input.pullRequestId);
      if (found === null) {
        ctx.errors.push({ message: 'mergePullRequest: the pull request id does not name a pull request' });
        return null;
      }
      if (!found.pull.merged) {
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
        const outcome = mergePullRequest(store, found.repo, found.pull, method === 'SQUASH' ? 'squash' : method === 'REBASE' ? 'rebase' : 'merge');
        if (!outcome.ok) ctx.errors.push({ message: 'mergePullRequest: the pull request has conflicts and cannot be merged' });
      }
      return { type: 'MergePullRequestPayload', payload: pullNode(found.repo, found.pull) } as Node;
    }
    case 'addComment': {
      const found = issueFromId(input.subjectId);
      if (found === null) {
        ctx.errors.push({ message: 'addComment: the subject id does not name an issue' });
        return null;
      }
      const at = store.now();
      const comment = {
        id: store.nextCommentId(),
        body: typeof input.body === 'string' ? input.body : '',
        authorLogin: store.actorLogin(),
        createdAt: at,
        updatedAt: at,
      };
      found.issue.comments.push(comment);
      const commentNode: Node = {
        type: 'IssueComment',
        repo: found.repo,
        issue: found.issue,
        commentId: comment.id,
        commentBody: comment.body,
        commentAt: at,
      };
      const edge: Node = { type: 'Edge', payload: commentNode, cursor: cursorOf(found.issue.comments.length - 1) };
      return { type: 'AddCommentPayload', payload: edge, issue: found.issue } as Node;
    }
    default:
      return unknownField(ctx, 'Mutation', name);
  }
}

// ------------------------------------------------------------ introspection

function typeNode(nameArg: unknown): Node | null {
  if (typeof nameArg !== 'string') return null;
  if (OBJECT_TYPES.has(nameArg)) return { type: '__Type', name: nameArg };
  if (ENUM_VALUES[nameArg] !== undefined) return { type: '__Type', name: nameArg };
  if (nameArg === 'String' || nameArg === 'Int' || nameArg === 'Boolean' || nameArg === 'ID' || nameArg === 'Float') return { type: '__Type', name: nameArg };
  return null;
}

function schemaNode(): Node {
  return { type: '__Schema' };
}

function resolveTypeField(node: Node, name: string, args: Record<string, unknown>): unknown {
  const typeName = node.name ?? '';
  switch (name) {
    case 'name':
      return typeName;
    case 'kind':
      return ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT';
    case 'description':
      return null;
    case 'fields': {
      const fields = TYPE_FIELDS[typeName] ?? [];
      return fields.map((fieldName) => ({ type: '__Field', name: fieldName }) as Node);
    }
    case 'enumValues': {
      const values = ENUM_VALUES[typeName] ?? [];
      return values.map((valueName) => ({ type: '__EnumValue', name: valueName }) as Node);
    }
    case 'inputFields':
      return null;
    case 'interfaces':
      return [];
    case 'possibleTypes':
      return null;
    case 'specifiedByURL':
      return null;
    default:
      return null;
  }
}

// ------------------------------------------------------------------- entry

export interface GraphQLReply {
  status: number;
  body: unknown;
}

interface OperationRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

/** Execute one operation document against the store. */
function executeOne(store: Store, request: OperationRequest): Record<string, unknown> {
  const queryText = typeof request.query === 'string' ? request.query : '';
  let document: DocumentNode;
  try {
    document = new Parser(queryText).parseDocument();
  } catch (err) {
    return { errors: [{ message: `Syntax error: ${err instanceof Error ? err.message : 'unparseable document'}` }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in the document' }] };
  const vars: Record<string, unknown> = {};
  for (const [key, value] of operation.varDefaults) {
    const ctx0: ExecContext = { store, vars: {}, fragments: document.fragments, errors: [] };
    vars[key] = evalValue(value, ctx0);
  }
  if (request.variables !== null && typeof request.variables === 'object') {
    for (const [key, value] of Object.entries(request.variables as Record<string, unknown>)) vars[key] = value;
  }
  const ctx: ExecContext = { store, vars, fragments: document.fragments, errors: [] };
  const root: Node = { type: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeOn(root, operation.selections, ctx);
  const reply: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) reply.errors = ctx.errors;
  return reply;
}

/** POST /api/graphql: one document, or an array of them (operation batching). */
export function handleGraphQL(store: Store, body: unknown): GraphQLReply {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(store, (entry ?? {}) as OperationRequest)) };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 200, body: { errors: [{ message: 'The request body is not a GraphQL operation' }] } };
  }
  return { status: 200, body: executeOne(store, body as OperationRequest) };
}
