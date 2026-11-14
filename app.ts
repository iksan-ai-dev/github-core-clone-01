// The forge's HTTP server: one process, one port, four surfaces.
//
//   GET  /healthz                 the env's boot probe (no auth)
//   /<owner>/<repo>.git/...       git smart HTTP (upload-pack v2, receive-pack v0)
//   /api/v3/...                   GitHub REST v3
//   POST /api/graphql             GitHub GraphQL v4
//   POST /mcp                     Model Context Protocol over Streamable HTTP
//   anything else                 404 {"message": "Not Found"}
//
// Every API call carries Authorization: Bearer $MAKEFUN_SHOP_TOKEN; a request
// without it is 401. The login the token names is the scenario viewer.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pathOf, sendJson, type Ctx } from './httputil.ts';

/** The login the trial token names (the scenario viewer). */
export const VIEWER_LOGIN = 'adaiversen';

const store = new Store();
let requestCounter = 0;

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(req, res).catch((err: unknown) => {
      // Never let one request take the server down: answer 500 JSON and keep serving.
      try {
        const body = `${JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' })}\n`;
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      } catch {
        try { res.destroy(); } catch { /* already gone */ }
      }
    });
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requestCounter += 1;
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? 'localhost';
  const ctx: Ctx = {
    store,
    login: VIEWER_LOGIN,
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
    requestId: `forge-${requestCounter}`,
    origin: `http://${host}`,
  };

  // The env's boot check calls this twice: 200 {"ok":true}. No auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, ctx);
    return;
  }

  if (path === '/api/graphql') {
    if (await handleGraphql(req, res, ctx)) return;
  } else if (path === '/mcp') {
    if (await handleMcp(req, res, ctx)) return;
  } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (await handleRest(req, res, ctx)) return;
  } else if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
    if (await handleGit(req, res, ctx)) return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' }, ctx);
}
