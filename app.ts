// app.ts — the forge's HTTP server: one process, four surfaces, one store.
//
// Routing (pathname decides, the handler owns the rest):
//   GET /healthz                     the env's boot probe: 200 {"ok": true}
//   /{owner}/{repo}.git/*            git smart HTTP (handleGit, raw Buffer body)
//   /api/v3*                         REST v3 (handleRest)
//   /api/graphql                     GraphQL v4 (handleGraphql)
//   /mcp                             MCP over streamable HTTP (handleMcp)
//   anything else                    404 JSON {"message": "Not Found"}
//
// Plumbing: the raw request body is read as a Buffer first. JSON surfaces
// get the parsed value when the body parses, the raw text when it does
// not (each handler answers that with its own 400), and null when the
// body is empty. Headers — Host included, since REST builds absolute
// pagination URLs from it — are forwarded as received. No auth is checked
// here: every handler enforces its own token rule from its spec, so the
// plumbing must not change what a handler sees.
//
// Answers go out through the httputil helpers so every reply carries a
// non-empty X-GitHub-Request-Id; binary git answers are written raw with
// the handler's content type and the same request-id header.
//
// Node 22 standard library only. No wall clock, no randomness.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { ForgeStore } from "./store.ts";
import { handleGit, type SurfaceResponse } from "./git.ts";
import { handleRest } from "./rest.ts";
import { handleGraphql } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";
import {
  newRequestId,
  parseQuery,
  readRawBody,
  requestPathname,
  sendEmpty,
  sendError,
  sendJson,
} from "./httputil.ts";

/** A git pack can be far larger than a JSON body; JSON stays at the 1 MiB default. */
const GIT_BODY_MAX_BYTES = 64 * 1024 * 1024;

/** Lower-cased copy of the request headers, array values folded to one string. */
function flatHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/** Parse a JSON body, or hand the raw text back when it does not parse. */
function jsonOrRaw(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  const text = raw.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** True when the pathname names a git smart-HTTP endpoint: /{owner}/{repo}.git/... */
function isGitPath(pathname: string): boolean {
  const parts = pathname.split("/");
  // ["", owner, "repo.git", ...rest]
  return parts.length >= 4 && parts[2] !== undefined && parts[2].endsWith(".git");
}

/** Write a handler's answer: JSON through the helpers, binary git bodies raw. */
function sendSurface(res: ServerResponse, reply: SurfaceResponse): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  if (Buffer.isBuffer(reply.body)) {
    if (headers["X-GitHub-Request-Id"] === undefined) {
      headers["X-GitHub-Request-Id"] = newRequestId();
    }
    res.writeHead(reply.status, headers);
    res.end(reply.body);
    return;
  }
  if (reply.body === undefined) {
    sendEmpty(res, reply.status);
    return;
  }
  // sendJson sets Content-Type itself; keep the handler's other headers
  // (Link, X-OAuth-Scopes, and its own request id when it set one).
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-type") extra[name] = value;
  }
  sendJson(res, reply.status, reply.body, extra);
}

/** Dispatch one request to the surface that owns its pathname. */
async function dispatch(store: ForgeStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = requestPathname(req);
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "GET" && pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const headers = flatHeaders(req);
  const query = parseQuery(req.url);
  const params: Record<string, string> = {};

  if (isGitPath(pathname)) {
    const raw = await readRawBody(req, GIT_BODY_MAX_BYTES);
    const reply = await handleGit(store, { method, pathname, query, headers, body: raw, params });
    sendSurface(res, reply);
    return;
  }

  if (pathname === "/api/v3" || pathname.startsWith("/api/v3/")) {
    const raw = await readRawBody(req);
    const reply = await handleRest(store, { method, pathname, query, headers, body: jsonOrRaw(raw), params });
    sendSurface(res, reply);
    return;
  }

  if (pathname === "/api/graphql" || pathname === "/api/graphql/") {
    const raw = await readRawBody(req);
    const reply = await handleGraphql(store, { method, pathname, query, headers, body: jsonOrRaw(raw), params });
    sendSurface(res, reply);
    return;
  }

  if (pathname === "/mcp" || pathname === "/mcp/") {
    const raw = await readRawBody(req);
    const reply = await handleMcp(store, { method, pathname, query, headers, body: jsonOrRaw(raw), params });
    sendSurface(res, reply);
    return;
  }

  sendError(res, 404, "Not Found");
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(store: ForgeStore): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    dispatch(store, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        sendError(res, 500, message === "" ? "internal server error" : message);
      } else {
        res.destroy();
      }
    });
  });
}
