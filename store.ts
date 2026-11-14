// The forge's store: one in-memory store for all four surfaces (git smart HTTP,
// REST v3, GraphQL v4, MCP). Everything the suite creates through any surface
// lives here, so a repository pushed over git reads back over REST, and an
// issue created over MCP reads back over GraphQL.
//
// Git objects are stored verbatim: an object's id is the SHA-1 of
// "<type> <size>\0" + bytes, and its bytes are never rewritten. Commits the
// forge itself creates (contents writes, squash merges) use a fixed epoch and
// a fixed identity, so two runs on the same inputs leave the same bytes.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
/** Fixed epoch (2025-01-01T00:00:00Z) for commits the forge writes itself. */
export const FORGE_EPOCH = 1735689600;
export const FORGE_AUTHOR_NAME = 'adaiversen';
export const FORGE_AUTHOR_EMAIL = 'adaiversen@example.invalid';
export const FIXED_TIME = '2025-01-01T00:00:00Z';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
}

export interface PullRequest {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  owner: string;
  name: string;
  databaseId: number;
  description: string;
  privateFlag: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueSeq: number;
  prs: PullRequest[];
  prSeq: number;
  commentSeq: number;
}

/** SHA-1 object id of "<type> <size>\0" + data. */
export function objectId(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Opaque, stable Relay-style global id. Never the plain number or databaseId. */
export function globalId(kind: string, repoDbId: number, n: number, extra = 0): string {
  return Buffer.from(`${kind}:${repoDbId}:${n}:${extra}`, 'utf8').toString('base64url');
}

export interface DecodedId {
  kind: string;
  repoDbId: number;
  n: number;
  extra: number;
}

/** Decode a global id made by globalId; null when it is not one. */
export function decodeGlobalId(id: string): DecodedId | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 4) return null;
    const repoDbId = Number(parts[1]);
    const n = Number(parts[2]);
    const extra = Number(parts[3]);
    if (!Number.isInteger(repoDbId) || !Number.isInteger(n) || !Number.isInteger(extra)) return null;
    return { kind: parts[0], repoDbId, n, extra };
  } catch {
    return null;
  }
}

function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.toString('utf8', i, sp),
      name: data.toString('utf8', sp + 1, nul),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return entries;
}

function encodeTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function treeCompare(a: string, aIsDir: boolean, b: string, bIsDir: boolean): number {
  const an = aIsDir ? `${a}/` : a;
  const bn = bIsDir ? `${b}/` : b;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export class Store {
  repos = new Map<string, Repo>();
  nextDatabaseId = 1;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, privateFlag: boolean): Repo | null {
    const key = Store.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      owner,
      name,
      databaseId: this.nextDatabaseId,
      description,
      privateFlag,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueSeq: 0,
      prs: [],
      prSeq: 0,
      commentSeq: 0,
    };
    this.nextDatabaseId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  getRepoByDbId(databaseId: number): Repo | undefined {
    for (const repo of this.repos.values()) {
      if (repo.databaseId === databaseId) return repo;
    }
    return undefined;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.databaseId - b.databaseId);
    return out;
  }

  // ---------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Store a commit object built from its parts; returns its oid. */
  makeCommit(
    repo: Repo,
    tree: string,
    parents: string[],
    message: string,
    epoch: number = FORGE_EPOCH,
  ): string {
    const lines: string[] = [`tree ${tree}`];
    for (const p of parents) lines.push(`parent ${p}`);
    const ident = `${FORGE_AUTHOR_NAME} <${FORGE_AUTHOR_EMAIL}> ${epoch} +0000`;
    lines.push(`author ${ident}`);
    lines.push(`committer ${ident}`);
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    const data = Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
    return this.putObject(repo, 'commit', data);
  }

  commitOf(repo: Repo, oid: string): { tree: string; parents: string[]; message: string } | null {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  treeEntries(repo: Repo, treeOid: string): { mode: string; name: string; oid: string }[] {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return [];
    return parseTree(obj.data);
  }

  /** Blob oid at a path in the tree, or null. */
  blobAtPath(repo: Repo, treeOid: string, path: string): string | null {
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const entries = this.treeEntries(repo, current);
      const found = entries.find((e) => e.name === parts[i]);
      if (found === undefined) return null;
      if (i === parts.length - 1) {
        return found.mode === '40000' ? null : found.oid;
      }
      if (found.mode !== '40000') return null;
      current = found.oid;
    }
    return null;
  }

  /** Entries directly under a directory path in the tree ('' = root). */
  dirEntries(repo: Repo, treeOid: string, dirPath: string): { mode: string; name: string; oid: string; path: string }[] | null {
    const parts = dirPath.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (const part of parts) {
      const entries = this.treeEntries(repo, current);
      const found = entries.find((e) => e.name === part && e.mode === '40000');
      if (found === undefined) return null;
      current = found.oid;
    }
    return this.treeEntries(repo, current).map((e) => ({
      ...e,
      path: parts.length > 0 ? `${parts.join('/')}/${e.name}` : e.name,
    }));
  }

  /**
   * Build a new root tree from a base tree with path changes applied.
   * changes: path -> blob oid (to set) or null (to delete).
   */
  applyTreeChanges(repo: Repo, baseTreeOid: string | null, changes: Map<string, string | null>): string {
    const put = (treeOid: string | null, segments: string[], oid: string | null): string => {
      const entries = treeOid === null ? [] : this.treeEntries(repo, treeOid);
      const name = segments[0];
      const rest = segments.slice(1);
      const idx = entries.findIndex((e) => e.name === name);
      if (rest.length === 0) {
        if (oid === null) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '100644', name, oid };
        } else {
          entries.push({ mode: '100644', name, oid });
        }
      } else {
        const child = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
        const newChild = put(child, rest, oid);
        const hasEntries = this.treeEntries(repo, newChild).length > 0;
        if (!hasEntries) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '40000', name, oid: newChild };
        } else {
          entries.push({ mode: '40000', name, oid: newChild });
        }
      }
      entries.sort((a, b) => treeCompare(a.name, a.mode === '40000', b.name, b.mode === '40000'));
      return this.putObject(repo, 'tree', encodeTree(entries));
    };
    let root = baseTreeOid;
    for (const [path, oid] of changes) {
      const segments = path.split('/').filter((p) => p !== '');
      if (segments.length === 0) continue;
      root = put(root, segments, oid);
    }
    return root ?? this.putObject(repo, 'tree', Buffer.alloc(0));
  }

  /** Flatten a tree to path -> blob oid (skips gitlinks). */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    for (const e of this.treeEntries(repo, treeOid)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') {
        for (const [k, v] of this.flattenTree(repo, e.oid, path)) out.set(k, v);
      } else if (e.mode !== '160000') {
        out.set(path, e.oid);
      }
    }
    return out;
  }

  // ---------------------------------------------------------- reachability

  /** All commit oids reachable from `tip` following parents (tip first). */
  ancestors(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.commitOf(repo, oid);
      if (c === null) continue;
      out.push(oid);
      for (const p of c.parents) stack.push(p);
    }
    return out;
  }

  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    return this.ancestors(repo, desc).includes(anc);
  }

  /** First common ancestor of a and b (walk b's history, then a's). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aSet = new Set(this.ancestors(repo, a));
    for (const oid of this.ancestors(repo, b)) {
      if (aSet.has(oid)) return oid;
    }
    return null;
  }

  /** Full object closure of the given commit tips (commits, trees, blobs, tags). */
  reachableObjects(repo: Repo, tips: string[]): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const visit = (oid: string): void => {
      if (out.has(oid)) return;
      const obj = repo.objects.get(oid);
      if (obj === undefined) return;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        visit(c.tree);
        for (const p of c.parents) visit(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') visit(e.oid);
        }
      } else if (obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})$/m.exec(text);
        if (m !== null) visit(m[1]);
      }
    };
    for (const tip of tips) visit(tip);
    return out;
  }

  /** Diff base tree -> head tree: added/modified/deleted paths with blob oids. */
  diffTrees(
    repo: Repo,
    baseTreeOid: string | null,
    headTreeOid: string | null,
  ): { path: string; status: 'added' | 'modified' | 'deleted'; oldOid: string | null; newOid: string | null }[] {
    const base = baseTreeOid === null ? new Map<string, string>() : this.flattenTree(repo, baseTreeOid);
    const head = headTreeOid === null ? new Map<string, string>() : this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: { path: string; status: 'added' | 'modified' | 'deleted'; oldOid: string | null; newOid: string | null }[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path) ?? null;
      const h = head.get(path) ?? null;
      if (b === null && h !== null) out.push({ path, status: 'added', oldOid: null, newOid: h });
      else if (b !== null && h === null) out.push({ path, status: 'deleted', oldOid: b, newOid: null });
      else if (b !== null && h !== null && b !== h) out.push({ path, status: 'modified', oldOid: b, newOid: h });
    }
    return out;
  }

  // ---------------------------------------------------------- issues / PRs

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    repo.issueSeq += 1;
    const issue: Issue = {
      number: repo.issueSeq,
      id: globalId('issue', repo.databaseId, repo.issueSeq),
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createPullRequest(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | null {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) return null;
    repo.prSeq += 1;
    const pr: PullRequest = {
      number: repo.prSeq,
      id: globalId('pr', repo.databaseId, repo.prSeq),
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.prs.push(pr);
    return pr;
  }

  /** Squash-merge a PR. Returns the merge commit sha, or an error string. */
  mergePullRequest(repo: Repo, pr: PullRequest): string | { error: string; status: number } {
    if (pr.merged || pr.state !== 'open') return { error: 'Pull request is already merged', status: 405 };
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
    if (baseTip === undefined || headTip === undefined) return { error: 'Not Found', status: 404 };
    const baseCommit = this.commitOf(repo, baseTip);
    const headCommit = this.commitOf(repo, headTip);
    if (baseCommit === null || headCommit === null) return { error: 'Not Found', status: 404 };
    const base = this.mergeBase(repo, baseTip, headTip);
    // Conflict: a path changed on both sides since the merge-base, to different blobs.
    if (base !== null) {
      const baseC = this.commitOf(repo, base);
      if (baseC !== null) {
        const headDiff = this.diffTrees(repo, baseC.tree, headCommit.tree);
        const baseDiff = this.diffTrees(repo, baseC.tree, baseCommit.tree);
        const headChanged = new Map(headDiff.map((d) => [d.path, d.newOid]));
        for (const d of baseDiff) {
          if (headChanged.has(d.path) && headChanged.get(d.path) !== d.newOid) {
            return { error: 'Merge conflict', status: 405 };
          }
        }
      }
    }
    const message = `Merge pull request #${pr.number}: ${pr.title}`;
    const sha = this.makeCommit(repo, headCommit.tree, [baseTip], message);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_TIME;
    pr.mergeCommitSha = sha;
    return sha;
  }
}
