// store.ts — in-memory data store for the forge.
//
// One ForgeStore holds every repository, issue, pull request, label,
// comment, git object and ref the entry serves. All four surfaces
// (git smart HTTP, REST v3, GraphQL, MCP) read and write through this
// single store, so a change made over one surface is visible over the
// others immediately.
//
// Determinism rules the store follows:
//   - No wall clock, no Math.random, no unseeded randomness anywhere.
//     Creation order comes from monotonic counters, merge timestamps
//     come from an epoch value the caller supplies.
//   - Every object id is a content hash (SHA-1, git format), so the
//     same bytes always get the same id in any run.
//   - Iteration order is insertion order of Maps, never hash order.
//
// Node 22 standard library only.

import { createHash } from "node:crypto";

export const ZERO_OID = "0000000000000000000000000000000000000000";
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const OID_RE = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** Error thrown by store operations. `status` is the HTTP status the
 *  surface layer should answer with; `code` is a stable machine tag. */
export class ForgeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ForgeError";
    this.code = code;
    this.status = status;
  }
}

function notFound(what: string): ForgeError {
  return new ForgeError("not_found", 404, `${what} not found`);
}
function conflictError(message: string): ForgeError {
  return new ForgeError("conflict", 405, message);
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Repo {
  /** Numeric id; also exposed as `databaseId`. Assigned sequentially. */
  id: number;
  databaseId: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  /** GitHub field name; mirrors `isPrivate`. */
  private: boolean;
  isPrivate: boolean;
  defaultBranch: string;
  /** Monotonic creation sequence (1-based). Defines list order. */
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export type IssueState = "open" | "closed";

export interface Issue {
  /** Stable numeric id, unique across the store. */
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: Label[];
  /** Monotonic creation sequence; ordering key for CREATED_AT sorts. */
  createdSeq: number;
  updatedSeq: number;
}

export interface IssueComment {
  id: number;
  issueNumber: number;
  body: string;
  createdSeq: number;
}

export type PullState = "open" | "closed";

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  merged: boolean;
  /** ISO-8601 string once merged, else null. */
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  createdSeq: number;
  updatedSeq: number;
}

export type GitObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  oid: string;
  type: GitObjectType;
  /** Raw bytes exactly as stored (never re-encoded). */
  data: Buffer;
}

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  /** Author epoch seconds parsed from the author line, -1 if absent. */
  epochSec: number;
  message: string;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  epochSec: number;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface FileChange {
  filename: string;
  /** "added" | "modified" | "deleted". */
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface MergeResult {
  merged: true;
  sha: string;
  message: string;
}

export interface Identity {
  name: string;
  email: string;
}

export interface FileCommitResult {
  commitSha: string;
  blobSha: string;
  /** True when the file did not exist before this commit. */
  created: boolean;
}

export type PathResult =
  | { kind: "file"; path: string; sha: string; size: number; content: Buffer }
  | {
      kind: "dir";
      path: string;
      entries: { type: "file" | "dir"; name: string; path: string; sha: string }[];
    };

export interface FetchResult {
  objects: GitObject[];
  /** New shallow boundary commits (depth fetches only). */
  shallow: string[];
  /** Old shallow boundaries that are no longer boundaries. */
  unshallow: string[];
}

// ---------------------------------------------------------------------------
// Git object hashing and parsing (pure functions)
// ---------------------------------------------------------------------------

/** SHA-1 id of a git object: sha1("<type> <size>\0" + bytes). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, "utf8");
  return createHash("sha1").update(head).update(data).digest("hex");
}

function identLine(id: Identity, epochSec: number): string {
  return `${id.name} <${id.email}> ${epochSec} +0000`;
}

/** Build commit bytes in canonical git layout. The message is given a
 *  trailing newline when it lacks one. */
export function buildCommitBytes(input: {
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  epochSec: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const p of input.parents) lines.push(`parent ${p}`);
  lines.push(`author ${identLine(input.author, input.epochSec)}`);
  lines.push(`committer ${identLine(input.committer, input.epochSec)}`);
  const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join("\n")}\n\n${message}`, "utf8");
}

/** Parse commit bytes. Unknown headers are ignored; the raw message
 *  (after the first blank line) is returned verbatim. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? "" : text.slice(split + 2);
  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  const m = / (\d+) [+-]\d{4}$/.exec(author);
  return {
    sha: "",
    tree,
    parents,
    author,
    committer,
    epochSec: m ? Number(m[1]) : -1,
    message,
  };
}

export function buildTagBytes(input: {
  object: string;
  type: string;
  tag: string;
  tagger: Identity;
  epochSec: number;
  message: string;
}): Buffer {
  const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  return Buffer.from(
    `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\n` +
      `tagger ${identLine(input.tagger, input.epochSec)}\n\n${message}`,
    "utf8",
  );
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? "" : text.slice(split + 2);
  let object = "";
  let type = "";
  let tag = "";
  let tagger = "";
  for (const line of head.split("\n")) {
    if (line.startsWith("object ")) object = line.slice(7).trim();
    else if (line.startsWith("type ")) type = line.slice(5).trim();
    else if (line.startsWith("tag ")) tag = line.slice(4).trim();
    else if (line.startsWith("tagger ")) tagger = line.slice(7);
  }
  const m = / (\d+) [+-]\d{4}$/.exec(tagger);
  return { object, type, tag, tagger, epochSec: m ? Number(m[1]) : -1, message };
}

/** Parse tree bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(off, sp).toString("utf8");
    const name = data.subarray(sp + 1, nul).toString("utf8");
    const oid = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git tree sort order: a directory compares as if its name ended in "/". */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const ka = a.mode === "40000" ? `${a.name}/` : a.name;
  const kb = b.mode === "40000" ? `${b.name}/` : b.name;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function buildTreeBytes(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}

/** ISO-8601 UTC string for an epoch-seconds value, computed with pure
 *  integer arithmetic (no Date, no wall clock). Used for `merged_at`. */
export function isoFromEpochSec(epochSec: number): string {
  const days = Math.floor(epochSec / 86400);
  const secs = epochSec - days * 86400;
  const hh = Math.floor(secs / 3600);
  const mm = Math.floor((secs - hh * 3600) / 60);
  const ss = secs - hh * 3600 - mm * 60;
  // Civil-from-days (Howard Hinnant's algorithm), days since 1970-01-01.
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(year, 4)}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:${p(ss)}.000Z`;
}

/** Count lines the way a diff summary does: non-empty trailing-newline
 *  terminated lines; a file ending without "\n" still counts its last line. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) n++;
  if (data[data.length - 1] !== 0x0a) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Global (Relay-style) ids — opaque, stable, deterministic
// ---------------------------------------------------------------------------

export function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`forge:${kind}:${key}`, "utf8").toString("base64url");
}

export function repoGlobalId(repo: Repo): string {
  return encodeGlobalId("Repository", `${repo.owner}/${repo.name}`);
}
export function issueGlobalId(owner: string, repo: string, number: number): string {
  return encodeGlobalId("Issue", `${owner}/${repo}#${number}`);
}
export function pullGlobalId(owner: string, repo: string, number: number): string {
  return encodeGlobalId("PullRequest", `${owner}/${repo}#${number}`);
}
export function commentGlobalId(owner: string, repo: string, id: number): string {
  return encodeGlobalId("IssueComment", `${owner}/${repo}#c${id}`);
}

/** Decode a global id produced by the helpers above. Returns null for
 *  anything that is not one of ours. */
export function decodeGlobalId(
  id: string,
): { kind: string; owner: string; repo: string; number: number } | null {
  let raw: string;
  try {
    raw = Buffer.from(id, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!raw.startsWith("forge:")) return null;
  const rest = raw.slice("forge:".length);
  const colon = rest.indexOf(":");
  if (colon === -1) return null;
  const kind = rest.slice(0, colon);
  const key = rest.slice(colon + 1);
  const hash = key.indexOf("#");
  if (hash === -1) {
    const slash = key.indexOf("/");
    if (slash === -1) return null;
    return { kind, owner: key.slice(0, slash), repo: key.slice(slash + 1), number: -1 };
  }
  const ownerRepo = key.slice(0, hash);
  const slash = ownerRepo.indexOf("/");
  if (slash === -1) return null;
  const numPart = key.slice(hash + 1).replace(/^c/, "");
  const number = Number(numPart);
  if (!Number.isInteger(number)) return null;
  return { kind, owner: ownerRepo.slice(0, slash), repo: ownerRepo.slice(slash + 1), number };
}

// ---------------------------------------------------------------------------
// ForgeStore
// ---------------------------------------------------------------------------

function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export interface CreateRepoInput {
  owner: string;
  name: string;
  description?: string;
  isPrivate?: boolean;
  defaultBranch?: string;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

export interface CreatePullInput {
  head: string;
  base: string;
  title: string;
  body?: string;
}

export interface ListIssuesOptions {
  state?: string;
  sort?: string;
  direction?: string;
}

export interface ListPullsOptions {
  state?: string;
}

export class ForgeStore {
  private viewerLoginValue: string;
  private seq = 0;
  private nextRepoId = 1;
  private nextEntityId = 1;
  private reposByKey = new Map<string, Repo>();
  private reposByOwner = new Map<string, Repo[]>();
  private labelsByRepo = new Map<string, Map<string, Label>>();
  private issuesByRepo = new Map<string, Map<number, Issue>>();
  private pullsByRepo = new Map<string, Map<number, PullRequest>>();
  private commentsByRepo = new Map<string, Map<number, IssueComment[]>>();
  private nextNumberByRepo = new Map<string, number>();
  private objectsByRepo = new Map<string, Map<string, GitObject>>();
  private refsByRepo = new Map<string, Map<string, string>>();

  constructor(opts?: { viewerLogin?: string }) {
    // The scenario viewer; the surface layer may override it from the
    // bearer token's login once that is known.
    this.viewerLoginValue = opts?.viewerLogin ?? "adaiversen";
  }

  get viewerLogin(): string {
    return this.viewerLoginValue;
  }
  setViewerLogin(login: string): void {
    this.viewerLoginValue = login;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private requireRepo(owner: string, name: string): Repo {
    const repo = this.reposByKey.get(repoKey(owner, name));
    if (!repo) throw notFound(`repository ${owner}/${name}`);
    return repo;
  }

  private repoMaps(key: string): {
    labels: Map<string, Label>;
    issues: Map<number, Issue>;
    pulls: Map<number, PullRequest>;
    comments: Map<number, IssueComment[]>;
    objects: Map<string, GitObject>;
    refs: Map<string, string>;
  } {
    let labels = this.labelsByRepo.get(key);
    if (!labels) {
      labels = new Map();
      this.labelsByRepo.set(key, labels);
    }
    let issues = this.issuesByRepo.get(key);
    if (!issues) {
      issues = new Map();
      this.issuesByRepo.set(key, issues);
    }
    let pulls = this.pullsByRepo.get(key);
    if (!pulls) {
      pulls = new Map();
      this.pullsByRepo.set(key, pulls);
    }
    let comments = this.commentsByRepo.get(key);
    if (!comments) {
      comments = new Map();
      this.commentsByRepo.set(key, comments);
    }
    let objects = this.objectsByRepo.get(key);
    if (!objects) {
      objects = new Map();
      this.objectsByRepo.set(key, objects);
    }
    let refs = this.refsByRepo.get(key);
    if (!refs) {
      refs = new Map();
      this.refsByRepo.set(key, refs);
    }
    return { labels, issues, pulls, comments, objects, refs };
  }

  // -- repositories -------------------------------------------------------

  createRepo(input: CreateRepoInput): Repo {
    const key = repoKey(input.owner, input.name);
    const existing = this.reposByKey.get(key);
    if (existing) {
      throw new ForgeError("already_exists", 422, `repository ${input.owner}/${input.name} already exists`);
    }
    const id = this.nextRepoId++;
    const repo: Repo = {
      id,
      databaseId: id,
      owner: input.owner,
      name: input.name,
      fullName: `${input.owner}/${input.name}`,
      description: input.description ?? "",
      private: input.isPrivate ?? false,
      isPrivate: input.isPrivate ?? false,
      defaultBranch: input.defaultBranch ?? "main",
      createdSeq: this.nextSeq(),
    };
    this.reposByKey.set(key, repo);
    const list = this.reposByOwner.get(input.owner.toLowerCase()) ?? [];
    list.push(repo);
    this.reposByOwner.set(input.owner.toLowerCase(), list);
    this.nextNumberByRepo.set(key, 1);
    this.repoMaps(key);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.reposByKey.get(repoKey(owner, name)) ?? null;
  }

  getRepoOrThrow(owner: string, name: string): Repo {
    return this.requireRepo(owner, name);
  }

  /** Repos owned by `owner`, in creation order (stable, no duplicates). */
  listReposByOwner(owner: string): Repo[] {
    return [...(this.reposByOwner.get(owner.toLowerCase()) ?? [])];
  }

  updateRepo(owner: string, name: string, patch: { description?: string }): Repo {
    const repo = this.requireRepo(owner, name);
    if (patch.description !== undefined) repo.description = patch.description;
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = repoKey(owner, name);
    const repo = this.reposByKey.get(key);
    if (!repo) return false;
    this.reposByKey.delete(key);
    const list = this.reposByOwner.get(owner.toLowerCase()) ?? [];
    const at = list.indexOf(repo);
    if (at !== -1) list.splice(at, 1);
    this.labelsByRepo.delete(key);
    this.issuesByRepo.delete(key);
    this.pullsByRepo.delete(key);
    this.commentsByRepo.delete(key);
    this.nextNumberByRepo.delete(key);
    this.objectsByRepo.delete(key);
    this.refsByRepo.delete(key);
    return true;
  }

  /** Shared issue+PR numbering for one repo (real GitHub behaviour):
   *  the next number, then increments it. */
  private takeNumber(key: string): number {
    const n = this.nextNumberByRepo.get(key) ?? 1;
    this.nextNumberByRepo.set(key, n + 1);
    return n;
  }

  // -- labels ---------------------------------------------------------------

  createLabel(
    owner: string,
    name: string,
    input: { name: string; color?: string; description?: string },
  ): Label {
    const repo = this.requireRepo(owner, name);
    const key = repoKey(repo.owner, repo.name);
    const labels = this.repoMaps(key).labels;
    const at = labels.get(input.name.toLowerCase());
    if (at) return at;
    const label: Label = {
      name: input.name,
      color: input.color ?? "ededed",
      description: input.description ?? "",
    };
    labels.set(input.name.toLowerCase(), label);
    return label;
  }

  getLabel(owner: string, repo: string, name: string): Label | null {
    const found = this.getRepo(owner, repo);
    if (!found) return null;
    return this.repoMaps(repoKey(owner, repo)).labels.get(name.toLowerCase()) ?? null;
  }

  listLabels(owner: string, repo: string): Label[] {
    if (!this.getRepo(owner, repo)) throw notFound(`repository ${owner}/${repo}`);
    return [...this.repoMaps(repoKey(owner, repo)).labels.values()];
  }

  // -- issues ---------------------------------------------------------------

  createIssue(owner: string, repo: string, input: CreateIssueInput): Issue {
    const found = this.requireRepo(owner, repo);
    const key = repoKey(found.owner, found.name);
    const maps = this.repoMaps(key);
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = maps.labels.get(name.toLowerCase());
      if (!label) {
        throw new ForgeError("unknown_label", 422, `label "${name}" does not exist in ${found.fullName}`);
      }
      labels.push(label);
    }
    const seq = this.nextSeq();
    const issue: Issue = {
      id: this.nextEntityId++,
      number: this.takeNumber(key),
      title: input.title,
      body: input.body ?? "",
      state: "open",
      labels,
      createdSeq: seq,
      updatedSeq: seq,
    };
    maps.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(owner: string, repo: string, number: number): Issue | null {
    if (!this.getRepo(owner, repo)) return null;
    return this.repoMaps(repoKey(owner, repo)).issues.get(number) ?? null;
  }

  getIssueOrThrow(owner: string, repo: string, number: number): Issue {
    const issue = this.getIssue(owner, repo, number);
    if (!issue) throw notFound(`issue ${owner}/${repo}#${number}`);
    return issue;
  }

  /** Issues in CREATED_AT order; `direction` "asc" (oldest first) or
   *  "desc" (newest first, the default). Ties break by number in the
   *  same direction. `state` filters "open" / "closed" / "all". */
  listIssues(owner: string, repo: string, opts: ListIssuesOptions = {}): Issue[] {
    if (!this.getRepo(owner, repo)) throw notFound(`repository ${owner}/${repo}`);
    const all = [...this.repoMaps(repoKey(owner, repo)).issues.values()];
    const state = (opts.state ?? "open").toLowerCase();
    const filtered =
      state === "all" ? all : all.filter((i) => i.state === state);
    const dir = (opts.direction ?? "desc").toLowerCase() === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      if (a.createdSeq !== b.createdSeq) return (a.createdSeq - b.createdSeq) * dir;
      return (a.number - b.number) * dir;
    });
    return filtered;
  }

  updateIssue(
    owner: string,
    repo: string,
    number: number,
    patch: { state?: string; title?: string; body?: string },
  ): Issue {
    const issue = this.getIssueOrThrow(owner, repo, number);
    if (patch.state !== undefined) {
      if (patch.state !== "open" && patch.state !== "closed") {
        throw new ForgeError("validation", 422, `invalid issue state "${patch.state}"`);
      }
      issue.state = patch.state;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    issue.updatedSeq = this.nextSeq();
    return issue;
  }

  addComment(owner: string, repo: string, number: number, body: string): IssueComment {
    this.getIssueOrThrow(owner, repo, number);
    const key = repoKey(owner, repo);
    const maps = this.repoMaps(key);
    const comment: IssueComment = {
      id: this.nextEntityId++,
      issueNumber: number,
      body,
      createdSeq: this.nextSeq(),
    };
    const list = maps.comments.get(number) ?? [];
    list.push(comment);
    maps.comments.set(number, list);
    return comment;
  }

  listComments(owner: string, repo: string, number: number): IssueComment[] {
    this.getIssueOrThrow(owner, repo, number);
    const list = this.repoMaps(repoKey(owner, repo)).comments.get(number) ?? [];
    return [...list].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -- git objects ----------------------------------------------------------

  /** Store an object, computing its id from its bytes. Idempotent:
   *  storing the same bytes twice returns the same oid. */
  putObject(owner: string, repo: string, type: GitObjectType, data: Buffer): string {
    const found = this.requireRepo(owner, repo);
    const oid = hashObject(type, data);
    this.repoMaps(repoKey(found.owner, found.name)).objects.set(oid, {
      oid,
      type,
      data: Buffer.from(data),
    });
    return oid;
  }

  getObject(owner: string, repo: string, oid: string): GitObject | null {
    if (!this.getRepo(owner, repo)) return null;
    return this.repoMaps(repoKey(owner, repo)).objects.get(oid.toLowerCase()) ?? null;
  }

  hasObject(owner: string, repo: string, oid: string): boolean {
    return this.getObject(owner, repo, oid) !== null;
  }

  objectCount(owner: string, repo: string): number {
    if (!this.getRepo(owner, repo)) return 0;
    return this.repoMaps(repoKey(owner, repo)).objects.size;
  }

  createCommit(
    owner: string,
    repo: string,
    input: {
      tree: string;
      parents: string[];
      author: Identity;
      committer: Identity;
      epochSec: number;
      message: string;
    },
  ): string {
    return this.putObject(owner, repo, "commit", buildCommitBytes(input));
  }

  getCommitInfo(owner: string, repo: string, sha: string): CommitInfo | null {
    const obj = this.getObject(owner, repo, sha);
    if (!obj || obj.type !== "commit") return null;
    const info = parseCommit(obj.data);
    info.sha = obj.oid;
    return info;
  }

  getCommitInfoOrThrow(owner: string, repo: string, sha: string): CommitInfo {
    const info = this.getCommitInfo(owner, repo, sha);
    if (!info) throw notFound(`commit ${sha} in ${owner}/${repo}`);
    return info;
  }

  createTag(
    owner: string,
    repo: string,
    input: {
      object: string;
      type: string;
      tag: string;
      tagger: Identity;
      epochSec: number;
      message: string;
    },
  ): string {
    return this.putObject(owner, repo, "tag", buildTagBytes(input));
  }

  getTagInfo(owner: string, repo: string, oid: string): TagInfo | null {
    const obj = this.getObject(owner, repo, oid);
    if (!obj || obj.type !== "tag") return null;
    return parseTag(obj.data);
  }

  buildTree(owner: string, repo: string, entries: TreeEntry[]): string {
    return this.putObject(owner, repo, "tree", buildTreeBytes(entries));
  }

  treeEntries(owner: string, repo: string, treeOid: string): TreeEntry[] {
    const obj = this.getObject(owner, repo, treeOid);
    if (!obj || obj.type !== "tree") return [];
    return parseTree(obj.data);
  }

  /** Flat map of path -> {oid, mode} for a tree, walking subdirectories.
   *  Gitlink entries (mode 160000) are skipped, as git reachability does. */
  flattenTree(owner: string, repo: string, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (tree: string, prefix: string): void => {
      for (const e of this.treeEntries(owner, repo, tree)) {
        if (e.mode === "160000") continue;
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === "40000") walk(e.oid, path);
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, "");
    return out;
  }

  /** New tree oid after setting (blobOid given) or deleting (null) one
   *  path in `treeOid`. Intermediate trees are created as needed; a
   *  subtree left empty by a delete is removed. `treeOid` may be the
   *  empty-tree oid or "" for an empty tree. */
  setPathInTree(
    owner: string,
    repo: string,
    treeOid: string,
    path: string,
    blobOid: string | null,
    mode = "100644",
  ): string {
    const parts = path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) throw new ForgeError("validation", 422, "empty path");
    const base = treeOid && treeOid !== ZERO_OID ? treeOid : EMPTY_TREE_OID;
    const rewrite = (tree: string, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      for (const e of this.treeEntries(owner, repo, tree)) entries.set(e.name, e);
      const name = parts[depth];
      if (depth === parts.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode, name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childTree = child && child.mode === "40000" ? child.oid : EMPTY_TREE_OID;
        const next = rewrite(childTree, depth + 1);
        const nextEntries = this.treeEntries(owner, repo, next);
        if (nextEntries.length === 0) entries.delete(name);
        else entries.set(name, { mode: "40000", name, oid: next });
      }
      return this.buildTree(owner, repo, [...entries.values()]);
    };
    return rewrite(base, 0);
  }

  /** Blob oid at `path` in the tree of `treeOid`, or null. */
  pathBlobOid(owner: string, repo: string, treeOid: string, path: string): string | null {
    const hit = this.flattenTree(owner, repo, treeOid).get(path);
    return hit ? hit.oid : null;
  }

  // -- refs / branches ------------------------------------------------------

  /** Full ref name, e.g. "refs/heads/main". */
  getRef(owner: string, repo: string, ref: string): string | null {
    if (!this.getRepo(owner, repo)) return null;
    return this.repoMaps(repoKey(owner, repo)).refs.get(ref) ?? null;
  }

  setRef(owner: string, repo: string, ref: string, oid: string): void {
    this.requireRepo(owner, repo);
    this.repoMaps(repoKey(owner, repo)).refs.set(ref, oid.toLowerCase());
  }

  createRef(owner: string, repo: string, ref: string, sha: string): string {
    const found = this.requireRepo(owner, repo);
    const key = repoKey(found.owner, found.name);
    const refs = this.repoMaps(key).refs;
    if (refs.has(ref)) {
      throw new ForgeError("already_exists", 422, `ref ${ref} already exists`);
    }
    if (!this.hasObject(owner, repo, sha)) throw notFound(`object ${sha}`);
    refs.set(ref, sha.toLowerCase());
    return sha.toLowerCase();
  }

  deleteRef(owner: string, repo: string, ref: string): boolean {
    if (!this.getRepo(owner, repo)) return false;
    return this.repoMaps(repoKey(owner, repo)).refs.delete(ref);
  }

  listRefs(owner: string, repo: string): { ref: string; oid: string }[] {
    if (!this.getRepo(owner, repo)) throw notFound(`repository ${owner}/${repo}`);
    return [...this.repoMaps(repoKey(owner, repo)).refs.entries()]
      .map(([ref, oid]) => ({ ref, oid }))
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  }

  listBranches(owner: string, repo: string): { name: string; sha: string }[] {
    return this.listRefs(owner, repo)
      .filter((r) => r.ref.startsWith("refs/heads/"))
      .map((r) => ({ name: r.ref.slice("refs/heads/".length), sha: r.oid }));
  }

  branchTip(owner: string, repo: string, branch: string): string | null {
    return this.getRef(owner, repo, `refs/heads/${branch}`);
  }

  defaultBranchTip(owner: string, repo: string): string | null {
    const found = this.requireRepo(owner, repo);
    return this.branchTip(owner, repo, found.defaultBranch);
  }

  /** Resolve a branch name, full ref, "HEAD", or raw oid to an oid. */
  resolveRef(owner: string, repo: string, refOrName: string): string | null {
    const found = this.getRepo(owner, repo);
    if (!found) return null;
    if (refOrName === "HEAD") return this.defaultBranchTip(owner, repo);
    if (refOrName.startsWith("refs/")) return this.getRef(owner, repo, refOrName);
    const asBranch = this.getRef(owner, repo, `refs/heads/${refOrName}`);
    if (asBranch) return asBranch;
    const asTag = this.getRef(owner, repo, `refs/tags/${refOrName}`);
    if (asTag) return asTag;
    if (isOid(refOrName) && this.hasObject(owner, repo, refOrName)) return refOrName.toLowerCase();
    return null;
  }

  /** Commits reachable from `ref` by first-parent walk, tip first.
   *  A commit made only on another branch never appears here. */
  listCommits(
    owner: string,
    repo: string,
    opts: { ref?: string; limit?: number } = {},
  ): CommitInfo[] {
    const found = this.requireRepo(owner, repo);
    const start = opts.ref
      ? this.resolveRef(owner, repo, opts.ref)
      : this.defaultBranchTip(owner, repo);
    if (!start || start === ZERO_OID) return [];
    const limit = opts.limit ?? 100;
    const out: CommitInfo[] = [];
    const seen = new Set<string>();
    let cur: string | null = start;
    while (cur && cur !== ZERO_OID && out.length < limit && !seen.has(cur)) {
      seen.add(cur);
      const info = this.getCommitInfo(owner, repo, cur);
      if (!info) break;
      out.push(info);
      cur = info.parents[0] ?? null;
    }
    return out;
  }

  // -- reachability ---------------------------------------------------------

  /** Full closure of `roots`: commit -> tree + parents, tag -> target,
   *  tree -> entries (gitlinks skipped), blob -> nothing. */
  collectReachable(owner: string, repo: string, roots: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const obj = this.getObject(owner, repo, oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === "commit") {
        const info = parseCommit(obj.data);
        stack.push(info.tree);
        for (const p of info.parents) stack.push(p);
      } else if (obj.type === "tag") {
        stack.push(parseTag(obj.data).object);
      } else if (obj.type === "tree") {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== "160000") stack.push(e.oid);
        }
      }
    }
    return seen;
  }

  collectReachableObjects(owner: string, repo: string, roots: string[]): GitObject[] {
    const ids = this.collectReachable(owner, repo, roots);
    const out: GitObject[] = [];
    for (const oid of ids) {
      const obj = this.getObject(owner, repo, oid);
      if (obj) out.push(obj);
    }
    return out;
  }

  /** True when `ancestor` is `descendant` itself or one of its ancestors
   *  (any parent chain). The zero oid counts as an ancestor of nothing
   *  except itself, which callers handle as the create case. */
  isAncestor(owner: string, repo: string, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur) || cur === ZERO_OID) continue;
      seen.add(cur);
      const info = this.getCommitInfo(owner, repo, cur);
      if (!info) continue;
      for (const p of info.parents) {
        if (p === ancestor) return true;
        stack.push(p);
      }
    }
    return false;
  }

  /** Nearest common ancestor of two commits (first hit walking from
   *  `b` over the ancestor set of `a`), or null. */
  mergeBase(owner: string, repo: string, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const cur = stackA.pop()!;
      if (ancestorsA.has(cur) || cur === ZERO_OID) continue;
      ancestorsA.add(cur);
      const info = this.getCommitInfo(owner, repo, cur);
      if (info) for (const p of info.parents) stackA.push(p);
    }
    const seen = new Set<string>();
    const stackB = [b];
    while (stackB.length > 0) {
      const cur = stackB.pop()!;
      if (seen.has(cur) || cur === ZERO_OID) continue;
      seen.add(cur);
      if (ancestorsA.has(cur)) return cur;
      const info = this.getCommitInfo(owner, repo, cur);
      if (info) for (const p of info.parents) stackB.push(p);
    }
    return null;
  }

  /** Objects a fetch must deliver for `wants`, minus what the client
   *  already has, honouring `depth` (shallow) when given.
   *  depth 1 delivers only each wanted tip commit + its tree/blobs;
   *  depth n delivers commits up to n-1 generations back. */
  fetchObjects(
    owner: string,
    repo: string,
    opts: { wants: string[]; haves?: string[]; depth?: number; shallow?: string[] },
  ): FetchResult {
    const haves = opts.haves ?? [];
    const haveClosure = this.collectReachable(owner, repo, haves);
    const objects = new Map<string, GitObject>();
    const add = (oid: string): void => {
      if (haveClosure.has(oid)) return;
      const obj = this.getObject(owner, repo, oid);
      if (obj) objects.set(oid, obj);
    };
    let shallow: string[] = [];
    let unshallow: string[] = [];
    if (opts.depth === undefined) {
      for (const oid of this.collectReachable(owner, repo, opts.wants)) add(oid);
    } else {
      const depth = opts.depth;
      const included = new Map<string, number>();
      const queue: { oid: string; dist: number }[] = opts.wants.map((oid) => ({ oid, dist: 0 }));
      while (queue.length > 0) {
        const { oid, dist } = queue.shift()!;
        if (included.has(oid) || oid === ZERO_OID) continue;
        const info = this.getCommitInfo(owner, repo, oid);
        if (!info) continue;
        included.set(oid, dist);
        if (dist < depth - 1) {
          for (const p of info.parents) queue.push({ oid: p, dist: dist + 1 });
        }
      }
      const boundary = new Set<string>();
      for (const [oid, dist] of included) {
        if (dist === depth - 1) boundary.add(oid);
        add(oid);
        const info = this.getCommitInfo(owner, repo, oid);
        if (!info) continue;
        for (const t of this.collectReachable(owner, repo, [info.tree])) add(t);
      }
      shallow = [...boundary].sort();
      for (const old of opts.shallow ?? []) {
        if (!included.has(old)) continue;
        const info = this.getCommitInfo(owner, repo, old);
        const parentsIncluded =
          !info || info.parents.length === 0 || info.parents.every((p) => included.has(p));
        if (parentsIncluded) unshallow.push(old);
      }
      unshallow.sort();
    }
    return { objects: [...objects.values()], shallow, unshallow };
  }

  // -- contents ---------------------------------------------------------------

  /** Read a file or directory as of a ref (branch name, full ref, or
   *  oid). Returns null when the ref or the path does not exist. */
  readPath(owner: string, repo: string, ref: string, path: string): PathResult | null {
    const tip = this.resolveRef(owner, repo, ref);
    if (!tip || tip === ZERO_OID) return null;
    const info = this.getCommitInfo(owner, repo, tip);
    if (!info) return null;
    const clean = path.split("/").filter((p) => p.length > 0).join("/");
    if (clean === "") {
      const entries = this.treeEntries(owner, repo, info.tree).map((e) => ({
        type: (e.mode === "40000" ? "dir" : "file") as "file" | "dir",
        name: e.name,
        path: e.name,
        sha: e.oid,
      }));
      return { kind: "dir", path: "", entries };
    }
    const flat = this.flattenTree(owner, repo, info.tree);
    const file = flat.get(clean);
    if (file) {
      const obj = this.getObject(owner, repo, file.oid);
      if (!obj) return null;
      return { kind: "file", path: clean, sha: file.oid, size: obj.data.length, content: obj.data };
    }
    // Directory: entries directly under `clean/`.
    const prefix = `${clean}/`;
    const entries: { type: "file" | "dir"; name: string; path: string; sha: string }[] = [];
    const seenDirs = new Map<string, string>();
    for (const [p, v] of flat) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        entries.push({ type: "file", name: rest, path: p, sha: v.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!seenDirs.has(dir)) {
          // Find the subtree oid by walking the tree.
          seenDirs.set(dir, this.subtreeOid(owner, repo, info.tree, `${clean}/${dir}`));
        }
      }
    }
    for (const [name, sha] of seenDirs) {
      entries.push({ type: "dir", name, path: `${clean}/${name}`, sha });
    }
    if (entries.length === 0) return null;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: "dir", path: clean, entries };
  }

  private subtreeOid(owner: string, repo: string, treeOid: string, path: string): string {
    const parts = path.split("/").filter((p) => p.length > 0);
    let cur = treeOid;
    for (const part of parts) {
      const next = this.treeEntries(owner, repo, cur).find(
        (e) => e.name === part && e.mode === "40000",
      );
      if (!next) return EMPTY_TREE_OID;
      cur = next.oid;
    }
    return cur;
  }

  /** Commit a file create/update on `branch` (default branch when
   *  omitted). A branch that does not exist yet starts from the default
   *  branch tip (or from an empty tree on an unborn repo). Throws
   *  ForgeError("stale_sha", 409) when `expectedSha` is given and the
   *  file's current blob sha differs. */
  commitFile(
    owner: string,
    repo: string,
    input: {
      branch?: string;
      path: string;
      content: Buffer;
      message: string;
      author: Identity;
      committer: Identity;
      epochSec: number;
      expectedSha?: string;
    },
  ): FileCommitResult {
    const found = this.requireRepo(owner, repo);
    const branch = input.branch ?? found.defaultBranch;
    const refName = `refs/heads/${branch}`;
    let tip = this.getRef(owner, repo, refName);
    if (!tip) {
      tip = branch === found.defaultBranch ? null : this.defaultBranchTip(owner, repo);
    }
    const baseTree = tip ? this.getCommitInfoOrThrow(owner, repo, tip).tree : EMPTY_TREE_OID;
    const current = tip ? this.pathBlobOid(owner, repo, baseTree, input.path) : null;
    if (input.expectedSha !== undefined) {
      if (current === null) {
        throw new ForgeError("validation", 422, `sha does not match: file ${input.path} does not exist`);
      }
      if (current.toLowerCase() !== input.expectedSha.toLowerCase()) {
        throw new ForgeError("stale_sha", 409, `sha ${input.expectedSha} is stale for ${input.path}`);
      }
    }
    const blobSha = this.putObject(owner, repo, "blob", input.content);
    const tree = this.setPathInTree(owner, repo, baseTree, input.path, blobSha);
    const commitSha = this.createCommit(owner, repo, {
      tree,
      parents: tip ? [tip] : [],
      author: input.author,
      committer: input.committer,
      epochSec: input.epochSec,
      message: input.message,
    });
    this.setRef(owner, repo, refName, commitSha);
    return { commitSha, blobSha, created: current === null };
  }

  /** Commit a file deletion on `branch`. Throws not_found when the file
   *  does not exist, stale_sha (409) when `expectedSha` mismatches. */
  deleteFile(
    owner: string,
    repo: string,
    input: {
      branch?: string;
      path: string;
      message: string;
      author: Identity;
      committer: Identity;
      epochSec: number;
      expectedSha?: string;
    },
  ): { commitSha: string } {
    const found = this.requireRepo(owner, repo);
    const branch = input.branch ?? found.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = this.getRef(owner, repo, refName);
    if (!tip) throw notFound(`branch ${branch} in ${found.fullName}`);
    const baseTree = this.getCommitInfoOrThrow(owner, repo, tip).tree;
    const current = this.pathBlobOid(owner, repo, baseTree, input.path);
    if (current === null) throw notFound(`file ${input.path} in ${found.fullName}`);
    if (input.expectedSha !== undefined && current.toLowerCase() !== input.expectedSha.toLowerCase()) {
      throw new ForgeError("stale_sha", 409, `sha ${input.expectedSha} is stale for ${input.path}`);
    }
    const tree = this.setPathInTree(owner, repo, baseTree, input.path, null);
    const commitSha = this.createCommit(owner, repo, {
      tree,
      parents: [tip],
      author: input.author,
      committer: input.committer,
      epochSec: input.epochSec,
      message: input.message,
    });
    this.setRef(owner, repo, refName, commitSha);
    return { commitSha };
  }

  // -- pull requests ----------------------------------------------------------

  createPullRequest(owner: string, repo: string, input: CreatePullInput): PullRequest {
    const found = this.requireRepo(owner, repo);
    const key = repoKey(found.owner, found.name);
    const headSha = this.branchTip(owner, repo, input.head);
    if (!headSha) {
      throw new ForgeError("invalid_branch", 422, `head branch "${input.head}" does not exist`);
    }
    const baseSha = this.branchTip(owner, repo, input.base);
    if (!baseSha) {
      throw new ForgeError("invalid_branch", 422, `base branch "${input.base}" does not exist`);
    }
    const seq = this.nextSeq();
    const pr: PullRequest = {
      id: this.nextEntityId++,
      number: this.takeNumber(key),
      title: input.title,
      body: input.body ?? "",
      state: "open",
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: input.head, sha: headSha },
      base: { ref: input.base, sha: baseSha },
      createdSeq: seq,
      updatedSeq: seq,
    };
    this.repoMaps(key).pulls.set(pr.number, pr);
    return pr;
  }

  getPull(owner: string, repo: string, number: number): PullRequest | null {
    if (!this.getRepo(owner, repo)) return null;
    return this.repoMaps(repoKey(owner, repo)).pulls.get(number) ?? null;
  }

  getPullOrThrow(owner: string, repo: string, number: number): PullRequest {
    const pr = this.getPull(owner, repo, number);
    if (!pr) throw notFound(`pull request ${owner}/${repo}#${number}`);
    return pr;
  }

  /** Default (no `state`) lists open PRs only; "all" lists open and
   *  merged/closed; "closed" lists closed and merged. Newest first. */
  listPulls(owner: string, repo: string, opts: ListPullsOptions = {}): PullRequest[] {
    if (!this.getRepo(owner, repo)) throw notFound(`repository ${owner}/${repo}`);
    const all = [...this.repoMaps(repoKey(owner, repo)).pulls.values()];
    const state = (opts.state ?? "open").toLowerCase();
    const filtered =
      state === "all"
        ? all
        : state === "closed"
          ? all.filter((p) => p.state === "closed")
          : all.filter((p) => p.state === "open");
    filtered.sort((a, b) => b.number - a.number);
    return filtered;
  }

  /** Three-way tree diff. Line counts are approximate for modified
   *  files (new-file line count / old-file line count); added files
   *  always report additions >= 1 when non-empty. */
  diffTrees(owner: string, repo: string, baseTree: string, headTree: string): FileChange[] {
    const base = this.flattenTree(owner, repo, baseTree);
    const head = this.flattenTree(owner, repo, headTree);
    const names = new Set([...base.keys(), ...head.keys()]);
    const out: FileChange[] = [];
    for (const name of [...names].sort()) {
      const b = base.get(name);
      const h = head.get(name);
      if (b && !h) {
        const oldLines = countLines(this.getObject(owner, repo, b.oid)?.data ?? Buffer.alloc(0));
        out.push({ filename: name, status: "deleted", additions: 0, deletions: oldLines, changes: oldLines });
      } else if (!b && h) {
        const newLines = countLines(this.getObject(owner, repo, h.oid)?.data ?? Buffer.alloc(0));
        out.push({ filename: name, status: "added", additions: newLines, deletions: 0, changes: newLines });
      } else if (b && h && b.oid !== h.oid) {
        const oldLines = countLines(this.getObject(owner, repo, b.oid)?.data ?? Buffer.alloc(0));
        const newLines = countLines(this.getObject(owner, repo, h.oid)?.data ?? Buffer.alloc(0));
        out.push({
          filename: name,
          status: "modified",
          additions: newLines,
          deletions: oldLines,
          changes: newLines + oldLines,
        });
      }
    }
    return out;
  }

  /** Files changed by a PR: head tip tree vs the tree of the base sha
   *  recorded when the PR was created. */
  pullFiles(owner: string, repo: string, number: number): FileChange[] {
    const pr = this.getPullOrThrow(owner, repo, number);
    const headTip = this.branchTip(owner, repo, pr.head.ref) ?? pr.head.sha;
    const headInfo = this.getCommitInfoOrThrow(owner, repo, headTip);
    const baseInfo = this.getCommitInfoOrThrow(owner, repo, pr.base.sha);
    return this.diffTrees(owner, repo, baseInfo.tree, headInfo.tree);
  }

  /** "MERGEABLE" when a squash onto the current base tip applies
   *  cleanly, "CONFLICTING" when it does not, "UNKNOWN" when a tip
   *  is missing. A path counts as conflicting when it changed on both
   *  sides of the PR's recorded base with different results. */
  pullMergeable(owner: string, repo: string, number: number): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
    const pr = this.getPull(owner, repo, number);
    if (!pr) return "UNKNOWN";
    if (pr.merged) return "UNKNOWN";
    const baseTip = this.branchTip(owner, repo, pr.base.ref);
    const headTip = this.branchTip(owner, repo, pr.head.ref);
    if (!baseTip || !headTip) return "UNKNOWN";
    return this.findMergeConflict(owner, repo, pr, baseTip, headTip) ? "CONFLICTING" : "MERGEABLE";
  }

  private findMergeConflict(
    owner: string,
    repo: string,
    pr: PullRequest,
    baseTip: string,
    headTip: string,
  ): string | null {
    const baseInfo = this.getCommitInfo(owner, repo, pr.base.sha);
    const headInfo = this.getCommitInfo(owner, repo, headTip);
    const currentInfo = this.getCommitInfo(owner, repo, baseTip);
    if (!baseInfo || !headInfo || !currentInfo) return null;
    const orig = this.flattenTree(owner, repo, baseInfo.tree);
    const head = this.flattenTree(owner, repo, headInfo.tree);
    const current = this.flattenTree(owner, repo, currentInfo.tree);
    const names = new Set([...orig.keys(), ...head.keys(), ...current.keys()]);
    for (const name of names) {
      const o = orig.get(name)?.oid ?? null;
      const h = head.get(name)?.oid ?? null;
      const c = current.get(name)?.oid ?? null;
      const headChanged = h !== o;
      const baseChanged = c !== o;
      if (headChanged && baseChanged && h !== c) return name;
    }
    return null;
  }

  /** Squash-merge a PR onto its base branch: one new commit on the base
   *  tip whose tree is the base tree with the PR head's changes applied,
   *  parented on the base tip. Throws ForgeError("conflict", 405) when
   *  the same file changed differently on both sides since the PR's
   *  recorded base, and ForgeError("already_merged", 405) when the PR
   *  is already merged. `mergedAt` defaults to the ISO form of
   *  `epochSec`; pass it explicitly for any other fixed string. */
  squashMerge(
    owner: string,
    repo: string,
    number: number,
    input: {
      message?: string;
      author: Identity;
      committer: Identity;
      epochSec: number;
      mergedAt?: string;
    },
  ): MergeResult {
    this.requireRepo(owner, repo);
    const pr = this.getPullOrThrow(owner, repo, number);
    if (pr.merged || pr.state === "closed") {
      throw new ForgeError("already_merged", 405, `pull request #${number} is already merged`);
    }
    const baseTip = this.branchTip(owner, repo, pr.base.ref);
    const headTip = this.branchTip(owner, repo, pr.head.ref);
    if (!baseTip || !headTip) throw notFound(`branch for pull request #${number}`);
    const conflict = this.findMergeConflict(owner, repo, pr, baseTip, headTip);
    if (conflict) {
      throw conflictError(`merge conflict in ${conflict}`);
    }
    const baseInfo = this.getCommitInfoOrThrow(owner, repo, pr.base.sha);
    const headInfo = this.getCommitInfoOrThrow(owner, repo, headTip);
    const currentInfo = this.getCommitInfoOrThrow(owner, repo, baseTip);
    // Apply the head's changes onto the current base tree.
    let tree = currentInfo.tree;
    const orig = this.flattenTree(owner, repo, baseInfo.tree);
    const head = this.flattenTree(owner, repo, headInfo.tree);
    const names = new Set([...orig.keys(), ...head.keys()]);
    for (const name of names) {
      const o = orig.get(name)?.oid ?? null;
      const h = head.get(name)?.oid ?? null;
      if (h === o) continue;
      tree = this.setPathInTree(owner, repo, tree, name, h);
    }
    const message = input.message ?? `Merge pull request #${number}: ${pr.title}`;
    const commitSha = this.createCommit(owner, repo, {
      tree,
      parents: [baseTip],
      author: input.author,
      committer: input.committer,
      epochSec: input.epochSec,
      message,
    });
    this.setRef(owner, repo, `refs/heads/${pr.base.ref}`, commitSha);
    pr.state = "closed";
    pr.merged = true;
    pr.mergedAt = input.mergedAt ?? isoFromEpochSec(input.epochSec);
    pr.mergeCommitSha = commitSha;
    pr.updatedSeq = this.nextSeq();
    return { merged: true, sha: commitSha, message };
  }
}
