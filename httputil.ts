// httputil.ts — small HTTP helpers shared by every surface of the forge.
//
// Covers: reading request bodies (JSON or raw), answering with JSON
// (always with a non-empty X-GitHub-Request-Id), error answers shaped
// as {"message": ...}, query parsing, pagination, and :param routing.
//
// No wall clock, no randomness: request ids come from a process-local
// monotonic counter, so two runs with the same requests behave the same.
//
// Node 22 standard library only.

import type { IncomingMessage, ServerResponse } from "node:http";

/** HTTP error a handler throws to answer with a status + JSON message. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}

let requestCounter = 0;

/** Next request id. Monotonic per process ("forge-1", "forge-2", ...);
 *  always non-empty, never derived from time or randomness. */
export function newRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter}`;
}

function setCommonHeaders(res: ServerResponse, extra?: Record<string, string>): void {
  res.setHeader("X-GitHub-Request-Id", newRequestId());
  if (extra) {
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }
}

/** Answer with a JSON body. Always sets Content-Type application/json
 *  and a non-empty X-GitHub-Request-Id. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  setCommonHeaders(res, extraHeaders);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Answer with a JSON error body {"message": ...}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Answer with no body (e.g. 204). The request-id header is still set. */
export function sendEmpty(res: ServerResponse, status = 204): void {
  setCommonHeaders(res);
  res.writeHead(status);
  res.end();
}

/** Read the whole request body as bytes. Throws HttpError 413 when the
 *  body exceeds `maxBytes` (default 1 MiB). */
export function readRawBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Read and parse a JSON request body.
 *  - An empty body returns null (no JSON was sent).
 *  - Malformed JSON throws HttpError 400 with a non-empty message.
 *  - A body over `maxBytes` throws HttpError 413. */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "malformed JSON body");
  }
}

/** Parse the query string of a request URL into URLSearchParams.
 *  Accepts a full URL string or just the "?..." part. */
export function parseQuery(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const at = url.indexOf("?");
  if (at === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(at + 1));
}

/** Query value as a string, or `fallback` when absent. */
export function queryString(query: URLSearchParams, name: string, fallback = ""): string {
  const v = query.get(name);
  return v === null ? fallback : v;
}

/** Query value as an integer, or `fallback` when absent or not numeric. */
export function queryInt(query: URLSearchParams, name: string, fallback: number): number {
  const v = query.get(name);
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Page/per_page from a query: page >= 1 (default 1), per_page clamped
 *  to 1..100 (default 30, GitHub's default). */
export function parsePagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, queryInt(query, "page", 1));
  const perPage = Math.min(100, Math.max(1, queryInt(query, "per_page", 30)));
  return { page, perPage };
}

/** Slice one page out of a full list. */
export function pageSlice<T>(items: T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

/** GitHub-style Link header value for a paginated list. `baseUrl` is
 *  the absolute URL of the current page without its query string;
 *  `extra` carries the query params to keep (other than page/per_page).
 *  Emits rel="next" when more pages exist and rel="prev" past page 1. */
export function buildLinkHeader(
  baseUrl: string,
  page: number,
  perPage: number,
  total: number,
  extra?: Record<string, string>,
): string {
  const parts: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(extra ?? {});
    q.set("page", String(p));
    q.set("per_page", String(perPage));
    return `${baseUrl}?${q.toString()}`;
  };
  if (page * perPage < total) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Match a pathname against a pattern of "/seg/:param/seg/*rest" segments.
 *  Returns the decoded params, or null when it does not match. A segment
 *  written as "*name" captures the rest of the path (slashes included),
 *  for routes like /contents/<path>. */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter((p) => p.length > 0);
  const pathParts = pathname.split("/").filter((p) => p.length > 0);
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pat = patternParts[i];
    if (pat.startsWith("*")) {
      const name = pat.slice(1);
      const rest = pathParts.slice(i).join("/");
      if (rest.length === 0) return null;
      try {
        params[name] = decodeURIComponent(rest);
      } catch {
        return null;
      }
      return params;
    }
    if (i >= pathParts.length) return null;
    if (pat.startsWith(":")) {
      try {
        params[pat.slice(1)] = decodeURIComponent(pathParts[i]);
      } catch {
        return null;
      }
    } else if (pat !== pathParts[i]) {
      return null;
    }
  }
  if (pathParts.length !== patternParts.length) return null;
  return params;
}

/** Pathname part of a request URL (before "?"), defaulting to "/". */
export function requestPathname(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const at = url.indexOf("?");
  return at === -1 ? url : url.slice(0, at);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Bearer token from `Authorization: Bearer <token>`, or null when the
 *  header is absent or is not a Bearer token. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/.exec(header);
  return m ? m[1].trim() : null;
}

/** Bearer token or HttpError 401 when there is none. */
export function requireBearerToken(req: IncomingMessage): string {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "authentication required");
  return token;
}

/** True when the request carries any Bearer token. */
export function hasBearerToken(req: IncomingMessage): boolean {
  return bearerToken(req) !== null;
}
