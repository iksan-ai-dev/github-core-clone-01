// MCP surface for the github-core-clone-01 forge.
//
// Serves JSON-RPC 2.0 over Streamable HTTP (plain JSON answers, no SSE)
// at POST /mcp, on top of the shared ForgeStore. The integrator owns the
// HTTP plumbing and calls the single exported handler with an already
// routed request; this module owns the JSON-RPC framing, the protocol
// negotiation, the tool catalogue and the tool implementations.
//
// Two protocol eras are spoken:
//   - modern (2026-07-28): answered through `server/discover`, whose
//     result lists every revision this server speaks;
//   - legacy handshake (2025-11-25 and earlier): answered through
//     `initialize` plus `notifications/initialized`, no session id issued.
//
// Everything here is deterministic: no wall clock, no randomness. Merge
// commits use the fixed scenario epoch, tool lists are a frozen literal,
// and every answer is built from constants plus store state.

import type { ForgeStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Handler contract (shared with the integrator)
// ---------------------------------------------------------------------------

export interface SurfaceRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: unknown;
  params: Record<string, string>;
}

export interface SurfaceResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown | Buffer;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = "github-core-clone-forge";
const SERVER_VERSION = "1.0.0";

const MODERN_REVISION = "2026-07-28";
const SUPPORTED_VERSIONS: readonly string[] = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

// Fixed identity and epoch for squash-merge commits. The store never reads
// the wall clock; the scenario epoch keeps merges deterministic.
const MERGE_EPOCH_SEC = 1735689600;
const MERGE_AUTHOR_NAME = "Conformance";
const MERGE_AUTHOR_EMAIL = "conformance@make.fun";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerValue(req: SurfaceRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(req.headers)) {
    if (key.toLowerCase() === wanted) {
      const value = req.headers[key];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return undefined;
}

function bearerTokenOf(header: string): string | null {
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/.exec(header.trim());
  return match === null ? null : match[1];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message !== "") return err.message;
  return "tool call failed";
}

function jsonAnswer(status: number, body: unknown): SurfaceResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body,
  };
}

function rpcOk(id: unknown, result: unknown): SurfaceResponse {
  return jsonAnswer(200, { jsonrpc: "2.0", id, result });
}

function rpcFail(id: unknown, code: number, message: string): SurfaceResponse {
  return jsonAnswer(200, { jsonrpc: "2.0", id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Tool catalogue (one frozen literal: two tools/list calls stringify equal)
// ---------------------------------------------------------------------------

interface ToolSchemaProperty {
  type: string;
  description: string;
  enum?: string[];
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, ToolSchemaProperty>;
    required: string[];
  };
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: "create_repo",
    description: "Create a repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Login that will own the repository. Defaults to the authenticated user.",
        },
        name: { type: "string", description: "Repository name." },
        description: { type: "string", description: "Short description of the repository." },
        private: { type: "boolean", description: "Whether the repository is private." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get one repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Login that owns the repository." },
        repo: { type: "string", description: "Repository name." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Login that owns the repository." },
        repo: { type: "string", description: "Repository name." },
        title: { type: "string", description: "Issue title." },
        body: { type: "string", description: "Issue body text." },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List the issues of a repository, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Login that owns the repository." },
        repo: { type: "string", description: "Repository name." },
        state: {
          type: "string",
          description: "Issue state filter: open, closed, or all.",
          enum: ["open", "closed", "all"],
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pull_request",
    description: "Open a pull request from a head branch onto a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Login that owns the repository." },
        repo: { type: "string", description: "Repository name." },
        title: { type: "string", description: "Pull request title." },
        body: { type: "string", description: "Pull request body text." },
        head: { type: "string", description: "Head branch name." },
        base: { type: "string", description: "Base branch name." },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Squash-merge an open pull request onto its base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Login that owns the repository." },
        repo: { type: "string", description: "Repository name." },
        pull_number: { type: "integer", description: "Pull request number." },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

const TOOL_NAMES = [
  "create_repo",
  "get_repo",
  "create_issue",
  "list_issues",
  "create_pull_request",
  "merge_pull_request",
] as const;

type ToolName = (typeof TOOL_NAMES)[number];

// A name matches when it is the canonical name, or ends with it after
// normalisation (lowercase, non-alphanumerics removed), so a server prefix
// such as `github__create_issue` still resolves.
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveToolName(raw: string): ToolName | null {
  const wanted = normalizeToolName(raw);
  for (const canonical of TOOL_NAMES) {
    const plain = normalizeToolName(canonical);
    if (wanted === plain) return canonical;
    if (wanted.length > plain.length && wanted.endsWith(plain)) return canonical;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

// Raised when a tools/call is missing a required argument or carries one
// of the wrong shape. The dispatcher turns it into JSON-RPC -32602.
class InvalidParamsError extends Error {}

function requiredString(args: JsonRecord, key: string): string {
  const value = args[key];
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new InvalidParamsError(`missing required argument: ${key}`);
}

function optionalString(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new InvalidParamsError(`argument ${key} must be a string`);
}

function optionalBoolean(args: JsonRecord, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  throw new InvalidParamsError(`argument ${key} must be a boolean`);
}

function requiredInt(args: JsonRecord, key: string): number {
  const value = args[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  throw new InvalidParamsError(`missing required argument: ${key}`);
}

// ---------------------------------------------------------------------------
// Result shapes (what the suite reads back)
// ---------------------------------------------------------------------------

interface RepoLike {
  id: number;
  databaseId: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  isPrivate: boolean;
  defaultBranch: string;
}

interface IssueLike {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string; color: string; description: string }[];
}

interface PullLike {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

function repoShape(repo: RepoLike): JsonRecord {
  return {
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: repo.fullName,
    fullName: repo.fullName,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    isPrivate: repo.isPrivate,
    default_branch: repo.defaultBranch,
    defaultBranch: repo.defaultBranch,
  };
}

function issueShape(owner: string, repo: string, issue: IssueLike): JsonRecord {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    full_name: `${owner}/${repo}`,
  };
}

function pullShape(owner: string, repo: string, pull: PullLike): JsonRecord {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      label: `${owner}:${pull.head.ref}`,
    },
    base: {
      ref: pull.base.ref,
      sha: pull.base.sha,
      label: `${owner}:${pull.base.ref}`,
    },
    full_name: `${owner}/${repo}`,
  };
}

// A successful tool result: machine-readable structuredContent plus the
// same JSON as text, so clients that only read text see it too.
function toolResult(value: unknown): JsonRecord {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

// A tool execution failure (repo missing, branch missing, merge conflict,
// already merged, ...). This is a tool-level error, not a JSON-RPC error,
// so the HTTP status stays 200 and the JSON-RPC id stays intact.
function toolFailure(message: string): JsonRecord {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Tool implementations (all act on the same store the REST surface uses)
// ---------------------------------------------------------------------------

function callCreateRepo(store: ForgeStore, args: JsonRecord): JsonRecord {
  const name = requiredString(args, "name");
  const owner = optionalString(args, "owner") ?? store.viewerLogin;
  const description = optionalString(args, "description") ?? "";
  const isPrivate = optionalBoolean(args, "private") ?? false;
  const repo = store.createRepo({ owner, name, description, isPrivate });
  return toolResult(repoShape(repo));
}

function callGetRepo(store: ForgeStore, args: JsonRecord): JsonRecord {
  const owner = requiredString(args, "owner");
  const name = requiredString(args, "repo");
  const repo = store.getRepo(owner, name);
  if (repo === null) throw new Error(`repository not found: ${owner}/${name}`);
  return toolResult(repoShape(repo));
}

function callCreateIssue(store: ForgeStore, args: JsonRecord): JsonRecord {
  const owner = requiredString(args, "owner");
  const name = requiredString(args, "repo");
  const title = requiredString(args, "title");
  const body = optionalString(args, "body") ?? "";
  if (store.getRepo(owner, name) === null) {
    throw new Error(`repository not found: ${owner}/${name}`);
  }
  const issue = store.createIssue(owner, name, { title, body });
  return toolResult(issueShape(owner, name, issue));
}

function callListIssues(store: ForgeStore, args: JsonRecord): JsonRecord {
  const owner = requiredString(args, "owner");
  const name = requiredString(args, "repo");
  const rawState = optionalString(args, "state");
  const state = rawState === "closed" || rawState === "all" ? rawState : "open";
  if (store.getRepo(owner, name) === null) {
    throw new Error(`repository not found: ${owner}/${name}`);
  }
  const issues = store.listIssues(owner, name, { state });
  const items = issues.map((issue) => issueShape(owner, name, issue));
  return toolResult({ issues: items });
}

function callCreatePullRequest(store: ForgeStore, args: JsonRecord): JsonRecord {
  const owner = requiredString(args, "owner");
  const name = requiredString(args, "repo");
  const title = requiredString(args, "title");
  const head = requiredString(args, "head");
  const base = requiredString(args, "base");
  const body = optionalString(args, "body") ?? "";
  if (store.getRepo(owner, name) === null) {
    throw new Error(`repository not found: ${owner}/${name}`);
  }
  const pull = store.createPullRequest(owner, name, { head, base, title, body });
  return toolResult(pullShape(owner, name, pull));
}

function callMergePullRequest(store: ForgeStore, args: JsonRecord): JsonRecord {
  const owner = requiredString(args, "owner");
  const name = requiredString(args, "repo");
  const pullNumber = requiredInt(args, "pull_number");
  if (store.getPull(owner, name, pullNumber) === null) {
    throw new Error(`pull request not found: ${owner}/${name}#${pullNumber}`);
  }
  const identity = { name: MERGE_AUTHOR_NAME, email: MERGE_AUTHOR_EMAIL };
  const merged = store.squashMerge(owner, name, pullNumber, {
    author: identity,
    committer: identity,
    epochSec: MERGE_EPOCH_SEC,
  });
  return toolResult({
    merged: true,
    sha: merged.sha,
    message: merged.message,
    number: pullNumber,
  });
}

function callTool(store: ForgeStore, rawName: string, args: JsonRecord): JsonRecord {
  const tool = resolveToolName(rawName);
  if (tool === null) throw new InvalidParamsError(`unknown tool: ${rawName}`);
  switch (tool) {
    case "create_repo":
      return callCreateRepo(store, args);
    case "get_repo":
      return callGetRepo(store, args);
    case "create_issue":
      return callCreateIssue(store, args);
    case "list_issues":
      return callListIssues(store, args);
    case "create_pull_request":
      return callCreatePullRequest(store, args);
    case "merge_pull_request":
      return callMergePullRequest(store, args);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

function discoverResult(): JsonRecord {
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    instructions:
      "GitHub-compatible forge tools: create and read repositories, issues and pull requests.",
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    _meta: {
      "io.modelcontextprotocol/serverInfo": {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    },
  };
}

function handleToolsCall(
  store: ForgeStore,
  id: unknown,
  params: JsonRecord | null,
): SurfaceResponse {
  if (params === null) {
    return rpcFail(id, -32602, "tools/call requires params");
  }
  const name = params.name;
  if (typeof name !== "string" || name === "") {
    return rpcFail(id, -32602, "tools/call requires a tool name");
  }
  let args: JsonRecord = {};
  if (params.arguments !== undefined) {
    if (!isRecord(params.arguments)) {
      return rpcFail(id, -32602, "tools/call arguments must be an object");
    }
    args = params.arguments;
  }
  try {
    return rpcOk(id, callTool(store, name, args));
  } catch (err) {
    if (err instanceof InvalidParamsError) {
      return rpcFail(id, -32602, err.message);
    }
    return rpcOk(id, toolFailure(errorMessage(err)));
  }
}

// Answers one JSON-RPC message. Returns null when no reply is owed (a
// notification), so the handler can answer 202 with no body.
function handleMessage(store: ForgeStore, message: unknown): SurfaceResponse | null {
  if (!isRecord(message)) {
    return rpcFail(null, -32600, "invalid request: expected a JSON-RPC object");
  }
  const id = "id" in message ? message.id : undefined;
  const method = message.method;
  if (typeof method !== "string" || method === "") {
    if (id === undefined) return null;
    return rpcFail(id, -32600, "invalid request: method must be a string");
  }
  if (method.startsWith("notifications/")) return null;
  if (id === undefined) return null;

  if (method === "server/discover") {
    return rpcOk(id, discoverResult());
  }
  if (method === "initialize") {
    const params = isRecord(message.params) ? message.params : {};
    const offered = params.protocolVersion;
    if (typeof offered !== "string" || !SUPPORTED_VERSIONS.includes(offered)) {
      return rpcFail(id, -32602, `unsupported protocol version: ${String(offered ?? "")}`);
    }
    return rpcOk(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "ping") {
    return rpcOk(id, {});
  }
  if (method === "tools/list") {
    return rpcOk(id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const params = isRecord(message.params) ? message.params : null;
    return handleToolsCall(store, id, params);
  }
  return rpcFail(id, -32601, `method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleMcp(
  store: ForgeStore,
  req: SurfaceRequest,
): Promise<SurfaceResponse> {
  if (req.pathname !== "/mcp" && req.pathname !== "/mcp/") {
    return jsonAnswer(404, { message: "not found" });
  }
  // Session teardown (legacy close): best effort, never an error to the caller.
  if (req.method === "DELETE") {
    return jsonAnswer(405, { message: "method not allowed" });
  }
  if (req.method !== "POST") {
    return jsonAnswer(405, { message: "method not allowed" });
  }

  // The body arrives already parsed, or as raw text when parsing failed,
  // or null when there was no body at all. A body that is not JSON is a
  // JSON-RPC parse error: HTTP 400 with -32700 (the 2026-07-28 answer).
  let payload: unknown = req.body;
  if (typeof payload === "string" || Buffer.isBuffer(payload)) {
    const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return jsonAnswer(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error: request body is not valid JSON" },
      });
    }
  }
  if (payload === null || payload === undefined) {
    return jsonAnswer(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error: request body is not valid JSON" },
    });
  }

  // Auth: every call needs a Bearer token. When the trial token is set in
  // MAKEFUN_SHOP_TOKEN the presented token must equal it; when it is unset
  // any non-empty Bearer token is accepted. The login is the store's
  // viewerLogin, never derived from the token here.
  const presented = bearerTokenOf(headerValue(req, "authorization") ?? "");
  const expected = (process.env.MAKEFUN_SHOP_TOKEN ?? "").trim();
  if (presented === null || (expected !== "" && presented !== expected)) {
    let id: unknown = null;
    if (isRecord(payload) && "id" in payload) id = payload.id;
    return jsonAnswer(401, {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "authentication required" },
    });
  }

  // A batch answers with an array; a lone notification answers 202 empty.
  if (Array.isArray(payload)) {
    const answers: unknown[] = [];
    for (const item of payload) {
      const answer = handleMessage(store, item);
      if (answer !== null) answers.push(answer.body);
    }
    if (answers.length === 0) return { status: 202 };
    return jsonAnswer(200, answers);
  }
  const answer = handleMessage(store, payload);
  if (answer === null) return { status: 202 };
  return answer;
}
