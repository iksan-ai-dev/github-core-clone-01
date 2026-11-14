// Shared HTTP helpers for the forge's surfaces: JSON answers, body reads,
// auth against the trial token, and the per-request id every reply carries.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface Ctx {
  store: Store;
  /** Login the trial token names (the scenario viewer). */
  login: string;
  /** Expected bearer token; '' means any non-empty bearer is accepted. */
  token: string;
  /** Non-empty id for this request's X-GitHub-Request-Id header. */
  requestId: string;
  /** Absolute origin of this request (scheme://host), for pagination links. */
  origin: string;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body; `headers` go beside the JSON ones. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  ctx: Ctx,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  res.end(text);
}

/** Answer with a raw body (used by the git surface). */
export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  ctx: Ctx,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
  });
  res.end(body);
}

/** Read the whole request body (cap 64 MiB). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; null when it is not parseable JSON. */
export function parseJson(buf: Buffer): unknown {
  try {
    if (buf.length === 0) return undefined;
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/** True when the request carries the trial's bearer token. */
export function isAuthed(req: IncomingMessage, ctx: Ctx): boolean {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  if (m === null) return false;
  if (ctx.token === '') return m[1].length > 0;
  return m[1] === ctx.token;
}

/** The request's path, or '/' when it does not parse. */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The request's query parameters. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Split a path into its '/'-separated segments, percent-decoded. */
export function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}
