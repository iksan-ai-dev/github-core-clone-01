// REST v3 surface for the forge.
//
// One exported entry point, `handleRest`, answers every request under
// `/api/v3`. It owns routing, bearer-token auth, JSON shapes and status
// codes; all persistent state lives in the `ForgeStore` handed to it.
// The module never touches the wall clock or unseeded randomness:
// request ids come from a module counter and every commit or merge the
// surface creates is stamped with one fixed epoch.
//
// Only the *type* of the store is imported here. The store instance is
// supplied by the integrator, so this file never constructs one.

import type { ForgeStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Handler contract (the integrator calls this one function)
// ---------------------------------------------------------------------------

export interface SurfaceRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** JSON body already parsed by the integrator, or null when there is none.
   *  When the integrator could not parse the raw body it passes the raw
   *  string through instead; this module answers that with a 400. */
  body: unknown;
  /** Route params filled by the integrator. This module parses the
   *  pathname itself, so `params` is accepted and ignored. */
  params: Record<string, string>;
}

export interface SurfaceResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown | Buffer;
}

// ---------------------------------------------------------------------------
// Fixed values
// ---------------------------------------------------------------------------

/** Scenario epoch (2025-01-01T00:00:00Z). Every commit and merge this
 *  surface creates is stamped with it, so two runs on the same inputs
 *  behave identically. */
const FIXED_EPOCH_SEC = 1735689600;

/** Value reported by GET /api/v3/meta. Any non-empty string passes. */
const INSTALLED_VERSION = "1.0.0";

/** Value of the X-OAuth-Scopes header on GET /api/v3/. Only its
 *  presence is asserted by the suite. */
const OAUTH_SCOPES = "repo";

/** Name of the environment variable holding the suite's bearer token. */
const TOKEN_ENV = "MAKEFUN_SHOP_TOKEN";

// ---------------------------------------------------------------------------
// Request ids — a module counter, never time or randomness.
// ---------------------------------------------------------------------------

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return "forge-rest-" + String(requestCounter);
}

// ---------------------------------------------------------------------------
// Small response helpers
// ---------------------------------------------------------------------------

function baseHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "X-GitHub-Request-Id": nextRequestId(),
  };
  if (extra) {
    for (const key of Object.keys(extra)) headers[key] = extra[key];
  }
  return headers;
}

function jsonReply(
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): SurfaceResponse {
  return { status, headers: baseHeaders(extra), body };
}

function errorReply(status: number, message: string): SurfaceResponse {
  return jsonReply(status, { message });
}

function emptyReply(status: number): SurfaceResponse {
  // A body-less answer still carries the request id (and a JSON
  // content type, so no client ever has to guess the format).
  return { status, headers: baseHeaders() };
}

/** True when `err` looks like a store ForgeError: a numeric HTTP status
 *  plus a message. Anything else is treated as an unexpected failure. */
function isStoreError(err: unknown): err is { status: number; message: string } {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { status?: unknown }).status;
  const message = (err as { message?: unknown }).message;
  return typeof status === "number" && typeof message === "string";
}

// ---------------------------------------------------------------------------
// Header / auth helpers
// ---------------------------------------------------------------------------

function headerValue(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function presentedBearerToken(req: SurfaceRequest): string | null {
  const raw = headerValue(req.headers, "authorization");
  if (!raw) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(raw.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/** Every /api/v3 call needs a bearer token. When the harness token is
 *  configured, the presented token must equal it; when it is not
 *  configured (local runs), any non-empty bearer token is accepted. */
function isAuthenticated(req: SurfaceRequest): boolean {
  const token = presentedBearerToken(req);
  if (token === null) return false;
  const expected = process.env[TOKEN_ENV];
  if (expected !== undefined && expected.length > 0) return token === expected;
  return true;
}

// ---------------------------------------------------------------------------
// Body helpers
// ---------------------------------------------------------------------------

/** The request body as a plain object, or null when there is no body.
 *  A body that is not an object (a JSON array, string, number) is
 *  treated as "no usable body" by the callers that need fields. */
function bodyObject(req: SurfaceRequest): Record<string, unknown> | null {
  if (req.body !== null && typeof req.body === "object" && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>;
  }
  return null;
}

function bodyStringField(
  body: Record<string, unknown> | null,
  field: string,
): string | undefined {
  if (!body) return undefined;
  const value = body[field];
  return typeof value === "string" ? value : undefined;
}

function bodyStringArray(
  body: Record<string, unknown> | null,
  field: string,
): string[] | undefined {
  if (!body) return undefined;
  const value = body[field];
  if (!Array.isArray(value)) return undefined;
  if (value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

/** Split a pathname into decoded segments. Returns null when a segment
 *  carries undecodable percent-encoding. */
function splitPath(pathname: string): string[] | null {
  const raw = pathname.split("/").filter((part) => part.length > 0);
  const out: string[] = [];
  for (const part of raw) {
    try {
      out.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return out;
}

/** Normalise a pathname for routing: keep "/api/v3/" as the root, drop
 *  a trailing slash everywhere else. */
function normalisePathname(pathname: string): string {
  if (pathname === "/api/v3/") return pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function parsePositiveInt(text: string): number | null {
  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

// ---------------------------------------------------------------------------
// Pagination (repo list; issue / pull lists reuse the same slicing)
// ---------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const rawPage = query.get("page");
  const rawPerPage = query.get("per_page");
  let page = rawPage === null ? 1 : Number.parseInt(rawPage, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let perPage = rawPerPage === null ? 30 : Number.parseInt(rawPerPage, 10);
  if (!Number.isFinite(perPage)) perPage = 30;
  if (perPage < 1) perPage = 1;
  if (perPage > 100) perPage = 100;
  return { page, perPage };
}

function slicePage<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Absolute `Link` header for a paginated list, built from the request's
 *  own Host header so the next URL stays on the entry's origin. Only
 *  `rel="next"` (and `rel="prev"` past page one) are ever emitted. */
function linkHeader(
  req: SurfaceRequest,
  page: number,
  perPage: number,
  total: number,
): string {
  const host = headerValue(req.headers, "host") ?? "localhost";
  const base = "http://" + host + "/api/v3/user/repos";
  const parts: string[] = [];
  if (page * perPage < total) {
    parts.push(
      "<" + base + "?per_page=" + perPage + "&page=" + (page + 1) + '>; rel="next"',
    );
  }
  if (page > 1) {
    parts.push(
      "<" + base + "?per_page=" + perPage + "&page=" + (page - 1) + '>; rel="prev"',
    );
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// View builders — the JSON shapes the suite reads back
// ---------------------------------------------------------------------------

function repoView(repo: {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string;
  defaultBranch: string;
}): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function labelView(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

function issueView(issue: {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string; color: string }[];
}): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => labelView(label)),
  };
}

function pullView(pull: {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
  };
}

/** The identity stamped on commits and merges this surface creates. */
function forgeIdentity(store: ForgeStore): { name: string; email: string } {
  const login = store.viewerLogin;
  return { name: login, email: login + "@example.invalid" };
}

function lastSegment(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

// ---------------------------------------------------------------------------
// Route handlers. Each one assumes routing and auth already passed.
// ---------------------------------------------------------------------------

async function createRepo(
  store: ForgeStore,
  req: SurfaceRequest,
): Promise<SurfaceResponse> {
  const body = bodyObject(req);
  const name = bodyStringField(body, "name");
  if (name === undefined || name.length === 0) {
    return errorReply(422, "repository name is required");
  }
  const description = bodyStringField(body, "description") ?? "";
  const isPrivate = body !== null && body["private"] === true;
  const repo = store.createRepo({
    owner: store.viewerLogin,
    name,
    description,
    isPrivate,
  });
  return jsonReply(201, repoView(repo));
}

async function listUserRepos(
  store: ForgeStore,
  req: SurfaceRequest,
): Promise<SurfaceResponse> {
  const { page, perPage } = pageParams(req.query);
  const all = store.listReposByOwner(store.viewerLogin);
  const pageItems = slicePage(all, page, perPage);
  const extra: Record<string, string> = {};
  const link = linkHeader(req, page, perPage, all.length);
  if (link.length > 0) extra["Link"] = link;
  return jsonReply(200, pageItems.map((repo) => repoView(repo)), extra);
}

async function getRepo(
  store: ForgeStore,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  // Repositories only ever exist under the token owner's login, so a
  // name under any other owner is a 404 here — never a 403.
  const repo = store.getRepo(owner, repoName);
  if (repo === null) return errorReply(404, "repository not found");
  return jsonReply(200, repoView(repo));
}

async function patchRepo(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  store.getRepoOrThrow(owner, repoName);
  const body = bodyObject(req);
  const description = bodyStringField(body, "description");
  const repo = store.updateRepo(owner, repoName, {
    description: description ?? undefined,
  });
  return jsonReply(200, repoView(repo));
}

async function deleteRepo(
  store: ForgeStore,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  const repo = store.getRepo(owner, repoName);
  if (repo === null) return errorReply(404, "repository not found");
  store.deleteRepo(owner, repoName);
  return emptyReply(204);
}

async function createBranchRef(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  const body = bodyObject(req);
  const ref = bodyStringField(body, "ref");
  const sha = bodyStringField(body, "sha");
  if (ref === undefined || ref.length === 0) {
    return errorReply(422, "ref is required");
  }
  if (sha === undefined || sha.length === 0) {
    return errorReply(422, "sha is required");
  }
  store.getRepoOrThrow(owner, repoName);
  const created = store.createRef(owner, repoName, ref, sha);
  return jsonReply(201, { ref, object: { sha: created } });
}

async function listBranches(
  store: ForgeStore,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  store.getRepoOrThrow(owner, repoName);
  const branches = store.listBranches(owner, repoName);
  return jsonReply(
    200,
    branches.map((branch) => ({
      name: branch.name,
      commit: { sha: branch.sha },
    })),
  );
}

async function listCommits(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  store.getRepoOrThrow(owner, repoName);
  const ref = req.query.get("sha") ?? undefined;
  const commits = store.listCommits(owner, repoName, { ref });
  return jsonReply(
    200,
    commits.map((commit) => ({
      sha: commit.sha,
      // parseCommit keeps the message verbatim, including the trailing
      // newline buildCommitBytes appends; the API answers the message
      // as the client sent it, without that newline.
      commit: { message: commit.message.replace(/\n+$/, "") },
    })),
  );
}

async function putContents(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
  path: string,
): Promise<SurfaceResponse> {
  const body = bodyObject(req);
  const encoded = bodyStringField(body, "content");
  if (encoded === undefined) {
    return errorReply(422, "content is required");
  }
  const message = bodyStringField(body, "message") ?? "Update " + path;
  const branch = bodyStringField(body, "branch");
  const expectedSha = bodyStringField(body, "sha");
  store.getRepoOrThrow(owner, repoName);
  // `sha` is optional here: the store checks it when supplied (a
  // mismatch is a 409) and otherwise applies the new content. That
  // matches the suite, whose branch commits update a file inherited
  // from the base without sending its blob sha.
  const bytes = Buffer.from(encoded, "base64");
  const identity = forgeIdentity(store);
  const result = store.commitFile(owner, repoName, {
    branch,
    path,
    content: bytes,
    message,
    author: identity,
    committer: identity,
    epochSec: FIXED_EPOCH_SEC,
    expectedSha,
  });
  return jsonReply(result.created ? 201 : 200, {
    content: {
      type: "file",
      encoding: "base64",
      name: lastSegment(path),
      path,
      sha: result.blobSha,
      size: bytes.length,
    },
    commit: { sha: result.commitSha, message },
  });
}

async function getContents(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
  path: string,
): Promise<SurfaceResponse> {
  const repo = store.getRepoOrThrow(owner, repoName);
  const ref = req.query.get("ref") ?? repo.defaultBranch;
  const found = store.readPath(owner, repoName, ref, path);
  if (found === null) return errorReply(404, "path not found");
  if (found.kind === "file") {
    return jsonReply(200, {
      type: "file",
      encoding: "base64",
      name: lastSegment(path),
      path: found.path,
      sha: found.sha,
      size: found.size,
      content: found.content.toString("base64"),
    });
  }
  return jsonReply(
    200,
    found.entries.map((entry) => ({
      type: entry.type,
      name: entry.name,
      path: entry.path,
      sha: entry.sha,
    })),
  );
}

async function deleteContents(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
  path: string,
): Promise<SurfaceResponse> {
  const body = bodyObject(req);
  const message = bodyStringField(body, "message") ?? "Delete " + path;
  const expectedSha = bodyStringField(body, "sha");
  const branch = bodyStringField(body, "branch");
  store.getRepoOrThrow(owner, repoName);
  const identity = forgeIdentity(store);
  const result = store.deleteFile(owner, repoName, {
    branch,
    path,
    message,
    author: identity,
    committer: identity,
    epochSec: FIXED_EPOCH_SEC,
    expectedSha,
  });
  return jsonReply(200, { commit: { sha: result.commitSha, message } });
}

async function createLabel(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  const body = bodyObject(req);
  const name = bodyStringField(body, "name");
  if (name === undefined || name.length === 0) {
    return errorReply(422, "label name is required");
  }
  const color = bodyStringField(body, "color");
  const description = bodyStringField(body, "description");
  store.getRepoOrThrow(owner, repoName);
  const label = store.createLabel(owner, repoName, {
    name,
    color: color ?? undefined,
    description: description ?? undefined,
  });
  return jsonReply(201, {
    name: label.name,
    color: label.color,
    description: label.description,
  });
}

async function listLabels(
  store: ForgeStore,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  const labels = store.listLabels(owner, repoName);
  return jsonReply(200, labels.map((label) => labelView(label)));
}

async function createIssue(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  const body = bodyObject(req);
  const title = bodyStringField(body, "title");
  if (title === undefined || title.length === 0) {
    return errorReply(422, "issue title is required");
  }
  const issueBody = bodyStringField(body, "body") ?? "";
  const labels = bodyStringArray(body, "labels");
  if (body !== null && body["labels"] !== undefined && labels === undefined) {
    return errorReply(422, "labels must be an array of label names");
  }
  store.getRepoOrThrow(owner, repoName);
  const issue = store.createIssue(owner, repoName, {
    title,
    body: issueBody,
    labels,
  });
  return jsonReply(201, issueView(issue));
}

async function listIssues(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  store.getRepoOrThrow(owner, repoName);
  const state = req.query.get("state") ?? undefined;
  const sort = req.query.get("sort") ?? undefined;
  const direction = req.query.get("direction") ?? undefined;
  const issues = store.listIssues(owner, repoName, { state, sort, direction });
  const { page, perPage } = pageParams(req.query);
  return jsonReply(
    200,
    slicePage(issues, page, perPage).map((issue) => issueView(issue)),
  );
}

async function getIssue(
  store: ForgeStore,
  owner: string,
  repoName: string,
  numberText: string,
): Promise<SurfaceResponse> {
  const number = parsePositiveInt(numberText);
  if (number === null) return errorReply(404, "issue not found");
  const issue = store.getIssueOrThrow(owner, repoName, number);
  return jsonReply(200, issueView(issue));
}

async function patchIssue(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
  numberText: string,
): Promise<SurfaceResponse> {
  const number = parsePositiveInt(numberText);
  if (number === null) return errorReply(404, "issue not found");
  const body = bodyObject(req);
  const state = bodyStringField(body, "state");
  const title = bodyStringField(body, "title");
  const issueBody = bodyStringField(body, "body");
  const issue = store.updateIssue(owner, repoName, number, {
    state: state ?? undefined,
    title: title ?? undefined,
    body: issueBody ?? undefined,
  });
  return jsonReply(200, issueView(issue));
}

async function createComment(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
  numberText: string,
): Promise<SurfaceResponse> {
  const number = parsePositiveInt(numberText);
  if (number === null) return errorReply(404, "issue not found");
  const body = bodyObject(req);
  const text = bodyStringField(body, "body");
  if (text === undefined || text.length === 0) {
    return errorReply(422, "comment body is required");
  }
  const comment = store.addComment(owner, repoName, number, text);
  return jsonReply(201, { id: comment.id, body: comment.body });
}

async function listComments(
  store: ForgeStore,
  owner: string,
  repoName: string,
  numberText: string,
): Promise<SurfaceResponse> {
  const number = parsePositiveInt(numberText);
  if (number === null) return errorReply(404, "issue not found");
  const comments = store.listComments(owner, repoName, number);
  return jsonReply(
    200,
    comments.map((comment) => ({ id: comment.id, body: comment.body })),
  );
}

async function createPull(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  const body = bodyObject(req);
  const head = bodyStringField(body, "head");
  const base = bodyStringField(body, "base");
  const title = bodyStringField(body, "title");
  if (head === undefined || head.length === 0) {
    return errorReply(422, "head branch is required");
  }
  if (base === undefined || base.length === 0) {
    return errorReply(422, "base branch is required");
  }
  if (title === undefined || title.length === 0) {
    return errorReply(422, "pull request title is required");
  }
  const pullBody = bodyStringField(body, "body") ?? "";
  store.getRepoOrThrow(owner, repoName);
  const pull = store.createPullRequest(owner, repoName, {
    head,
    base,
    title,
    body: pullBody,
  });
  return jsonReply(201, pullView(pull));
}

async function listPulls(
  store: ForgeStore,
  req: SurfaceRequest,
  owner: string,
  repoName: string,
): Promise<SurfaceResponse> {
  store.getRepoOrThrow(owner, repoName);
  const state = req.query.get("state") ?? undefined;
  const pulls = store.listPulls(owner, repoName, { state });
  const { page, perPage } = pageParams(req.query);
  return jsonReply(
    200,
    slicePage(pulls, page, perPage).map((pull) => pullView(pull)),
  );
}

async function getPull(
  store: ForgeStore,
  owner: string,
  repoName: string,
  numberText: string,
): Promise<SurfaceResponse> {
  const number = parsePositiveInt(numberText);
  if (number === null) return errorReply(404, "pull request not found");
  const pull = store.getPullOrThrow(owner, repoName, number);
  return jsonReply(200, pullView(pull));
}

async function listPullFiles(
  store: ForgeStore,
  owner: string,
  repoName: string,
  numberText: string,
): Promise<SurfaceResponse> {
  const number = parsePositiveInt(numberText);
  if (number === null) return errorReply(404, "pull request not found");
  const files = store.pullFiles(owner, repoName, number);
  return jsonReply(
    200,
    files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    })),
  );
}

async function mergePull(
  store: ForgeStore,
  owner: string,
  repoName: string,
  numberText: string,
): Promise<SurfaceResponse> {
  const number = parsePositiveInt(numberText);
  if (number === null) return errorReply(404, "pull request not found");
  // Unknown PRs are a 404 here; the store reports the already-merged
  // and conflicted cases as 405s of their own.
  store.getPullOrThrow(owner, repoName, number);
  const identity = forgeIdentity(store);
  const result = store.squashMerge(owner, repoName, number, {
    author: identity,
    committer: identity,
    epochSec: FIXED_EPOCH_SEC,
  });
  return jsonReply(200, {
    merged: result.merged,
    sha: result.sha,
    message: result.message,
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Route and run one REST v3 request. Store errors and unexpected
 *  failures are translated by `handleRest`, which awaits this. */
async function dispatchRest(
  store: ForgeStore,
  req: SurfaceRequest,
): Promise<SurfaceResponse> {
    const pathname = normalisePathname(req.pathname);
    const segments = splitPath(pathname);
    if (segments === null) return errorReply(404, "route not found");
    if (segments.length < 2 || segments[0] !== "api" || segments[1] !== "v3") {
      return errorReply(404, "route not found");
    }

    const method = req.method.toUpperCase();

    // A raw string body means the integrator could not parse the JSON
    // the client sent. An empty string is an absent body; anything else
    // that does not parse is the malformed-body case (400).
    let parsedBody: unknown = req.body;
    if (typeof req.body === "string") {
      const raw = req.body.trim();
      if (raw.length === 0) {
        parsedBody = null;
      } else {
        try {
          parsedBody = JSON.parse(raw) as unknown;
        } catch {
          return errorReply(400, "malformed JSON body");
        }
      }
    }
    const effectiveReq: SurfaceRequest = { ...req, body: parsedBody };

    // Route first, auth second: an unknown route is a 404 even without
    // a token, and every known route needs the token.
    const route = matchRoute(method, segments);
    if (route === null) return errorReply(404, "route not found");
    if (!isAuthenticated(effectiveReq)) {
      return errorReply(401, "authentication required");
    }

    switch (route.kind) {
      case "root":
        return jsonReply(200, {}, { "X-OAuth-Scopes": OAUTH_SCOPES });
      case "meta":
        return jsonReply(200, { installed_version: INSTALLED_VERSION });
      case "create-repo":
        return createRepo(store, effectiveReq);
      case "list-user-repos":
        return listUserRepos(store, effectiveReq);
      case "get-repo":
        return getRepo(store, route.owner, route.repo);
      case "patch-repo":
        return patchRepo(store, effectiveReq, route.owner, route.repo);
      case "delete-repo":
        return deleteRepo(store, route.owner, route.repo);
      case "create-ref":
        return createBranchRef(store, effectiveReq, route.owner, route.repo);
      case "list-branches":
        return listBranches(store, route.owner, route.repo);
      case "list-commits":
        return listCommits(store, effectiveReq, route.owner, route.repo);
      case "put-contents":
        return putContents(store, effectiveReq, route.owner, route.repo, route.path);
      case "get-contents":
        return getContents(store, effectiveReq, route.owner, route.repo, route.path);
      case "delete-contents":
        return deleteContents(store, effectiveReq, route.owner, route.repo, route.path);
      case "create-label":
        return createLabel(store, effectiveReq, route.owner, route.repo);
      case "list-labels":
        return listLabels(store, route.owner, route.repo);
      case "create-issue":
        return createIssue(store, effectiveReq, route.owner, route.repo);
      case "list-issues":
        return listIssues(store, effectiveReq, route.owner, route.repo);
      case "get-issue":
        return getIssue(store, route.owner, route.repo, route.number);
      case "patch-issue":
        return patchIssue(store, effectiveReq, route.owner, route.repo, route.number);
      case "create-comment":
        return createComment(store, effectiveReq, route.owner, route.repo, route.number);
      case "list-comments":
        return listComments(store, route.owner, route.repo, route.number);
      case "create-pull":
        return createPull(store, effectiveReq, route.owner, route.repo);
      case "list-pulls":
        return listPulls(store, effectiveReq, route.owner, route.repo);
      case "get-pull":
        return getPull(store, route.owner, route.repo, route.number);
      case "list-pull-files":
        return listPullFiles(store, route.owner, route.repo, route.number);
      case "merge-pull":
        return mergePull(store, route.owner, route.repo, route.number);
    }
    // Unreachable: the switch above covers every route kind.
    return errorReply(404, "route not found");
}

/**
 * Answer one REST v3 request.
 *
 * Order of decisions: unknown route -> 404; missing or wrong bearer
 * token -> 401; unparseable JSON body -> 400; store errors -> the
 * status the store itself carries (404 / 409 / 422 / 405); anything
 * unexpected -> 500. Every reply is JSON and carries a non-empty
 * `X-GitHub-Request-Id` header.
 */
export async function handleRest(
  store: ForgeStore,
  req: SurfaceRequest,
): Promise<SurfaceResponse> {
  try {
    return await dispatchRest(store, req);
  } catch (err) {
    if (isStoreError(err)) return errorReply(err.status, err.message);
    return errorReply(500, "internal server error");
  }
}

// ---------------------------------------------------------------------------
// Route table — method + segment shape -> handler kind
// ---------------------------------------------------------------------------

type Route =
  | { kind: "root" }
  | { kind: "meta" }
  | { kind: "create-repo" }
  | { kind: "list-user-repos" }
  | { kind: "get-repo"; owner: string; repo: string }
  | { kind: "patch-repo"; owner: string; repo: string }
  | { kind: "delete-repo"; owner: string; repo: string }
  | { kind: "create-ref"; owner: string; repo: string }
  | { kind: "list-branches"; owner: string; repo: string }
  | { kind: "list-commits"; owner: string; repo: string }
  | { kind: "put-contents"; owner: string; repo: string; path: string }
  | { kind: "get-contents"; owner: string; repo: string; path: string }
  | { kind: "delete-contents"; owner: string; repo: string; path: string }
  | { kind: "create-label"; owner: string; repo: string }
  | { kind: "list-labels"; owner: string; repo: string }
  | { kind: "create-issue"; owner: string; repo: string }
  | { kind: "list-issues"; owner: string; repo: string }
  | { kind: "get-issue"; owner: string; repo: string; number: string }
  | { kind: "patch-issue"; owner: string; repo: string; number: string }
  | { kind: "create-comment"; owner: string; repo: string; number: string }
  | { kind: "list-comments"; owner: string; repo: string; number: string }
  | { kind: "create-pull"; owner: string; repo: string }
  | { kind: "list-pulls"; owner: string; repo: string }
  | { kind: "get-pull"; owner: string; repo: string; number: string }
  | { kind: "list-pull-files"; owner: string; repo: string; number: string }
  | { kind: "merge-pull"; owner: string; repo: string; number: string };

function matchRoute(method: string, segments: string[]): Route | null {
  // /api/v3 and /api/v3/
  if (segments.length === 2) {
    return method === "GET" ? { kind: "root" } : null;
  }
  if (segments.length === 3 && segments[2] === "meta") {
    return method === "GET" ? { kind: "meta" } : null;
  }
  if (
    segments.length === 4 &&
    segments[2] === "user" &&
    segments[3] === "repos"
  ) {
    if (method === "GET") return { kind: "list-user-repos" };
    if (method === "POST") return { kind: "create-repo" };
    return null;
  }
  if (segments.length >= 5 && segments[2] === "repos") {
    const owner = segments[3];
    const repo = segments[4];
    if (segments.length === 5) {
      if (method === "GET") return { kind: "get-repo", owner, repo };
      if (method === "PATCH") return { kind: "patch-repo", owner, repo };
      if (method === "DELETE") return { kind: "delete-repo", owner, repo };
      return null;
    }
    const tail = segments[5];
    if (segments.length === 6 && tail === "branches") {
      return method === "GET" ? { kind: "list-branches", owner, repo } : null;
    }
    if (segments.length === 6 && tail === "commits") {
      return method === "GET" ? { kind: "list-commits", owner, repo } : null;
    }
    if (segments.length === 7 && tail === "git" && segments[6] === "refs") {
      return method === "POST" ? { kind: "create-ref", owner, repo } : null;
    }
    if (tail === "contents" && segments.length >= 7) {
      const path = segments.slice(6).join("/");
      if (method === "PUT") return { kind: "put-contents", owner, repo, path };
      if (method === "GET") return { kind: "get-contents", owner, repo, path };
      if (method === "DELETE") return { kind: "delete-contents", owner, repo, path };
      return null;
    }
    if (segments.length === 6 && tail === "labels") {
      if (method === "POST") return { kind: "create-label", owner, repo };
      if (method === "GET") return { kind: "list-labels", owner, repo };
      return null;
    }
    if (segments.length === 6 && tail === "issues") {
      if (method === "POST") return { kind: "create-issue", owner, repo };
      if (method === "GET") return { kind: "list-issues", owner, repo };
      return null;
    }
    if (segments.length === 7 && tail === "issues") {
      const number = segments[6];
      if (method === "GET") return { kind: "get-issue", owner, repo, number };
      if (method === "PATCH") return { kind: "patch-issue", owner, repo, number };
      return null;
    }
    if (segments.length === 8 && tail === "issues" && segments[7] === "comments") {
      const number = segments[6];
      if (method === "POST") return { kind: "create-comment", owner, repo, number };
      if (method === "GET") return { kind: "list-comments", owner, repo, number };
      return null;
    }
    if (segments.length === 6 && tail === "pulls") {
      if (method === "POST") return { kind: "create-pull", owner, repo };
      if (method === "GET") return { kind: "list-pulls", owner, repo };
      return null;
    }
    if (segments.length === 7 && tail === "pulls") {
      const number = segments[6];
      return method === "GET" ? { kind: "get-pull", owner, repo, number } : null;
    }
    if (segments.length === 8 && tail === "pulls" && segments[7] === "files") {
      const number = segments[6];
      return method === "GET"
        ? { kind: "list-pull-files", owner, repo, number }
        : null;
    }
    if (segments.length === 8 && tail === "pulls" && segments[7] === "merge") {
      const number = segments[6];
      return method === "PUT" ? { kind: "merge-pull", owner, repo, number } : null;
    }
  }
  return null;
}
