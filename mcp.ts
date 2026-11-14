// MCP surface: Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
//
//   POST /mcp   one JSON-RPC request per call, answered as plain
//               application/json (no SSE needed)
//   DELETE /mcp session end, best effort -> 204
//
// Speaks revision 2026-07-28 (modern era) via server/discover, and also the
// legacy initialize handshake. All six tools act on the same Store as REST,
// so a repo or issue created over MCP reads back over REST with unchanged ids.
//
// No shared mutable per-call state: every request is answered from its own
// locals, so concurrent tools/call requests keep their own ids and results.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthed, pathOf, readBody, sendJson, type Ctx } from './httputil.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'gitforge';
const SERVER_VERSION = '1.0.0';

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION } as const;

/** The six tools, in fixed order. Built once; never mutated per call, so two
 *  tools/list answers are byte-identical. */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'Short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: "open", "closed", or "all".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Name of the branch with the changes.' },
        base: { type: 'string', description: 'Name of the branch the changes are merged into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

const CANONICAL_TOOLS = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'] as const;

type JsonRpcId = string | number | null;

interface RpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

/** Lowercase, strip every non-alphanumeric character. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolve a tool name by normalised suffix match: an exact match, or a name
 *  ending with the canonical name (a server prefix is allowed). */
function resolveTool(name: string): string | null {
  const n = normalize(name);
  for (const canonical of CANONICAL_TOOLS) {
    const c = normalize(canonical);
    if (n === c || (n.length > c.length && n.endsWith(c))) return canonical;
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read one argument, trying the given keys in order (exact, then normalised
 *  against the argument object's keys). */
function arg(args: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in args) return args[key];
  }
  const nk = keys.map(normalize);
  for (const [k, v] of Object.entries(args)) {
    if (nk.includes(normalize(k))) return v;
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Split "owner/repo" from a full_name argument when owner/repo are absent. */
function ownerRepo(args: Record<string, unknown>): { owner?: string; repo?: string } {
  let owner = asString(arg(args, 'owner', 'owner_login', 'login', 'user', 'org'));
  let repo = asString(arg(args, 'repo', 'repository', 'repository_name', 'repo_name'));
  if ((owner === undefined || repo === undefined) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner ??= parts[0];
      repo ??= parts[1];
    }
  }
  return { owner, repo };
}

function missingArg(name: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: `Missing required argument: ${name}` }], isError: true };
}

function toolError(text: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text }], isError: true };
}

function toolResult(result: Record<string, unknown>): { content: { type: string; text: string }[]; structuredContent: Record<string, unknown> } {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function repoJson(repo: {
  databaseId: number;
  name: string;
  owner: string;
  privateFlag: boolean;
  defaultBranch: string;
  description: string;
}): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.privateFlag,
    default_branch: repo.defaultBranch,
    description: repo.description,
    owner: { login: repo.owner },
  };
}

/** Run one tool call. Returns the tool result object (with isError when the
 *  call failed at the tool level). */
function callTool(tool: string, args: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  switch (tool) {
    case 'create_repo': {
      const name = asString(arg(args, 'name', 'repo', 'repository'));
      if (name === undefined || name === '') return missingArg('name');
      const description = asString(arg(args, 'description', 'about', 'summary', 'body')) ?? '';
      const priv = arg(args, 'private', 'is_private');
      const repo = ctx.store.createRepo(ctx.login, name, description, priv === true);
      if (repo === null) return toolError(`already exists: ${ctx.login}/${name}`);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const { owner, repo: repoName } = ownerRepo(args);
      if (owner === undefined || owner === '') return missingArg('owner');
      if (repoName === undefined || repoName === '') return missingArg('repo');
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Not Found: ${owner}/${repoName}`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = ownerRepo(args);
      if (owner === undefined || owner === '') return missingArg('owner');
      if (repoName === undefined || repoName === '') return missingArg('repo');
      const title = asString(arg(args, 'title', 'issue_title', 'subject'));
      if (title === undefined || title === '') return missingArg('title');
      const body = asString(arg(args, 'body', 'issue_body', 'description', 'content', 'text')) ?? '';
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Not Found: ${owner}/${repoName}`);
      const issue = ctx.store.createIssue(repo, title, body, []);
      return toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
    }
    case 'list_issues': {
      const { owner, repo: repoName } = ownerRepo(args);
      if (owner === undefined || owner === '') return missingArg('owner');
      if (repoName === undefined || repoName === '') return missingArg('repo');
      const state = asString(arg(args, 'state', 'status')) ?? 'open';
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Not Found: ${owner}/${repoName}`);
      const issues = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return toolResult({ issues });
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = ownerRepo(args);
      if (owner === undefined || owner === '') return missingArg('owner');
      if (repoName === undefined || repoName === '') return missingArg('repo');
      const title = asString(arg(args, 'title', 'pr_title', 'pull_request_title', 'subject'));
      if (title === undefined || title === '') return missingArg('title');
      const head = asString(arg(args, 'head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch'));
      if (head === undefined || head === '') return missingArg('head');
      const base = asString(arg(args, 'base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch'));
      if (base === undefined || base === '') return missingArg('base');
      const body = asString(arg(args, 'body', 'description', 'content', 'text')) ?? '';
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Not Found: ${owner}/${repoName}`);
      const pr = ctx.store.createPullRequest(repo, title, body, head, base);
      if (pr === null) return toolError(`Not Found: branch ${head} or ${base} does not exist in ${owner}/${repoName}`);
      return toolResult({
        id: pr.id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        head: { ref: pr.headRef, sha: pr.headSha },
        base: { ref: pr.baseRef, sha: pr.baseSha },
      });
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = ownerRepo(args);
      if (owner === undefined || owner === '') return missingArg('owner');
      if (repoName === undefined || repoName === '') return missingArg('repo');
      const raw = arg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
      const pullNumber = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(pullNumber)) return missingArg('pull_number');
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Not Found: ${owner}/${repoName}`);
      const pr = repo.prs.find((p) => p.number === pullNumber);
      if (pr === undefined) return toolError(`Not Found: pull request #${pullNumber} in ${owner}/${repoName}`);
      const merged = ctx.store.mergePullRequest(repo, pr);
      if (typeof merged === 'object') return toolError(merged.error);
      return toolResult({ id: pr.id, number: pr.number, merged: true, state: pr.state });
    }
    default:
      return toolError('Unknown tool');
  }
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Handle POST /mcp (and DELETE /mcp). Returns true when the path is /mcp
 *  and the request was answered here, false otherwise. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  const method = req.method ?? 'GET';

  // Session end, best effort.
  if (method === 'DELETE') {
    sendJson(res, 204, null, ctx);
    return true;
  }
  if (method !== 'POST') return false;

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'), ctx);
    return true;
  }

  // Non-JSON body -> HTTP 400 + JSON-RPC -32700 (modern era).
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'), ctx);
    return true;
  }

  // A JSON body that is not a valid JSON-RPC request object -> -32600.
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(res, 200, rpcError(isRecord(parsed) && ('id' in parsed) ? (parsed.id as JsonRpcId) ?? null : null, -32600, 'Invalid Request'), ctx);
    return true;
  }
  const request = parsed as RpcRequest;
  const id: JsonRpcId = 'id' in request ? (request.id as JsonRpcId) ?? null : null;
  const isNotification = !('id' in request);

  // Auth: every POST needs the trial bearer token (also for server/discover,
  // initialize and tools/list; the suite always sends it for those).
  if (!isAuthed(req, ctx)) {
    sendJson(res, 401, { message: 'Unauthorized' }, ctx);
    return true;
  }

  // Notifications carry no id and expect no JSON-RPC response.
  if (isNotification) {
    res.writeHead(202, { 'content-length': 0, 'x-github-request-id': ctx.requestId });
    res.end();
    return true;
  }

  const params = isRecord(request.params) ? request.params : {};

  switch (request.method) {
    case 'server/discover': {
      sendJson(res, 200, rpcResult(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      }), ctx);
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
        ? params.protocolVersion
        : PROTOCOL_VERSION;
      sendJson(res, 200, rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      }), ctx);
      return true;
    }
    case 'tools/list': {
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }), ctx);
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = resolveTool(name);
      if (tool === null) {
        sendJson(res, 200, rpcError(id, -32601, `Method not found: ${name}`), ctx);
        return true;
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const result = callTool(tool, args, ctx);
      sendJson(res, 200, rpcResult(id, result), ctx);
      return true;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${request.method}`), ctx);
      return true;
    }
  }
}
