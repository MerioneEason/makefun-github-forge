// app.ts — the HTTP front door: one server, four surfaces, one store.
//
// Routing is by path shape: /api/v3 is REST, /api/graphql is GraphQL,
// /mcp is the Model Context Protocol endpoint, and /{owner}/{repo}.git is
// git smart HTTP. Everything else is a JSON 404 — this forge never serves
// HTML. Every authenticated surface wants the shop token as a Bearer
// credential; without it the answer is 401, whatever the route. Every
// answer carries an X-GitHub-Request-Id, as GitHub's do.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestReply } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack, type GitReply } from './githttp.ts';

export interface Forge {
  server: Server;
  store: Store;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the forge's server. The token is the shop token from the entry env. */
export function createForge(token: string): Forge {
  const store = new Store();

  const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const text = body === null || body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-GitHub-Request-Id': `req-${(++store.requestSeq).toString(16).padStart(8, '0')}`,
      ...extra,
    });
    res.end(text);
  };

  const sendGit = (res: ServerResponse, reply: GitReply): void => {
    res.writeHead(reply.status, {
      'Content-Type': reply.contentType,
      'X-GitHub-Request-Id': `req-${(++store.requestSeq).toString(16).padStart(8, '0')}`,
    });
    res.end(reply.body);
  };

  const authorized = (req: IncomingMessage): boolean => {
    if (token === '') return true; // a developer run with no token configured
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${token}` || header === `token ${token}`;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://forge.invalid');
    const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
    const method = (req.method ?? 'GET').toUpperCase();

    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    const body = await readBody(req);
    const base = `http://${req.headers.host ?? '127.0.0.1'}`;

    // MCP: POST /mcp (DELETE closes a session this server never opens).
    if (segments.length === 1 && segments[0] === 'mcp') {
      if (method === 'DELETE') {
        sendJson(res, 204, null);
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const reply = handleMcp(store, body.toString('utf8'));
      sendJson(res, reply.status, reply.body);
      return;
    }

    // GraphQL: POST /api/graphql.
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        sendJson(res, 400, { errors: [{ message: 'The request body is not JSON' }] });
        return;
      }
      const reply = handleGraphQL(store, parsed);
      sendJson(res, reply.status, reply.body);
      return;
    }

    // REST: everything under /api/v3.
    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      let json: Record<string, unknown> | null = null;
      if (body.length > 0 && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as unknown;
          json = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
      const reply: RestReply = handleRest({ store, base }, method, segments.slice(2), url.searchParams, json, `${base}${url.pathname}${url.search}`);
      sendJson(res, reply.status, reply.body, reply.headers ?? {});
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/…
    if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
      const owner = segments[0]!;
      const repoName = segments[1]!.slice(0, -'.git'.length);
      store.adoptViewer(owner);
      const repo = store.findRepo(owner, repoName);
      if (repo === null) {
        sendGit(res, { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('not found\n') });
        return;
      }
      const tail = segments.slice(2);
      const protocol = req.headers['git-protocol'] ?? null;
      if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
        sendGit(res, infoRefs(store, repo, url.searchParams.get('service') ?? '', typeof protocol === 'string' ? protocol : null));
        return;
      }
      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
        sendGit(res, uploadPack(store, repo, body, typeof protocol === 'string' ? protocol : null));
        return;
      }
      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
        sendGit(res, receivePack(store, repo, body));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        sendJson(res, 500, { message: 'Internal error' });
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  return { server, store };
}
