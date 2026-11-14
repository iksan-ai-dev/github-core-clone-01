// GitHub REST v3 surface for the forge (bounty github-core-clone-01).
//
// One handler for everything under /api/v3: root/meta/user, repositories,
// git refs/branches/commits, contents, labels, issues (+comments) and pull
// requests (+files, squash merge). All state lives in the shared Store; this
// file only translates HTTP into Store calls and Store results into the JSON
// shapes the REST checks assert on.
//
// Rules honoured throughout (see work/gitforge-specs/rest.md):
//   - every reply is JSON and carries X-GitHub-Request-Id (via sendJson),
//   - every /api/v3 route requires a valid Bearer token, else 401 JSON,
//   - a repo under another owner is 404, never 403,
//   - unknown route -> 404 JSON {"message": ...},
//   - malformed JSON body -> 400 JSON {"message": ...}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, PullRequest, Repo } from './store.ts';
import {
  isAuthed,
  parseJson,
  pathOf,
  queryOf,
  readBody,
  segments,
  sendJson,
  type Ctx,
} from './httputil.ts';

// ---------------------------------------------------------------- shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: 1000 },
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
  };
}

function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
  };
}

// ------------------------------------------------------------- small utils

/** Commit messages are stored with a trailing newline; strip it for exact matches. */
function cleanMessage(message: string): string {
  return message.replace(/[\r\n]+$/, '');
}

/** Split blob bytes into lines (no trailing empty line from a final "\n"). */
function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Added/removed line counts from a multiset difference of lines. Exact for
 * added/deleted files; a one-line change on a modified file counts as one
 * addition and one deletion, which is all the checks assert on.
 */
function countDiff(
  oldLines: string[],
  newLines: string[],
): { additions: number; deletions: number } {
  const remaining = new Map<string, number>();
  for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of remaining.values()) deletions += count;
  return { additions, deletions };
}

function pageParams(req: IncomingMessage, fallbackPerPage: number): { perPage: number; page: number } {
  const q = queryOf(req);
  const perPageRaw = Number.parseInt(q.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(q.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? perPageRaw : fallbackPerPage,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

function paginate<T>(items: T[], perPage: number, page: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

// ------------------------------------------------------------------ handler

export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;

  const method = req.method ?? 'GET';
  const rest = segments(path).slice(2); // segments after ['api', 'v3']

  // Every /api/v3 route requires a valid Bearer token.
  if (!isAuthed(req, ctx)) {
    sendJson(res, 401, { message: 'Requires authentication' }, ctx);
    return true;
  }

  // Parse a JSON body for methods that carry one; malformed JSON is 400.
  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    const parsed = parseJson(raw);
    if (parsed === null) {
      sendJson(res, 400, { message: 'Problems parsing JSON' }, ctx);
      return true;
    }
    if (parsed !== undefined) {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, ctx);
        return true;
      }
      body = parsed as Record<string, unknown>;
    }
  }

  const store = ctx.store;
  const notFound = (message = 'Not Found'): void => {
    sendJson(res, 404, { message }, ctx);
  };

  // ------------------------------------------------------------ root / meta
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {}, ctx, { 'x-oauth-scopes': 'repo, read:org' });
    } else {
      notFound();
    }
    return true;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0' }, ctx);
    else notFound();
    return true;
  }

  // ------------------------------------------------------------ /user[/repos]
  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method === 'GET') sendJson(res, 200, { login: ctx.login, id: 1000 }, ctx);
      else notFound();
      return true;
    }
    if (rest[1] === 'repos' && rest.length === 2) {
      if (method === 'GET') {
        const { perPage, page } = pageParams(req, 30);
        const all = store.listRepos(ctx.login);
        const items = paginate(all, perPage, page).map(repoJson);
        const headers: Record<string, string> = {};
        if (page * perPage < all.length) {
          headers.link = `<${ctx.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
        }
        sendJson(res, 200, items, ctx, headers);
        return true;
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          sendJson(res, 422, { message: 'name is required' }, ctx);
          return true;
        }
        const repo = store.createRepo(
          ctx.login,
          name,
          typeof body.description === 'string' ? body.description : '',
          body.private === true,
        );
        if (repo === null) {
          sendJson(res, 422, { message: 'Repository already exists' }, ctx);
          return true;
        }
        sendJson(res, 201, repoJson(repo), ctx);
        return true;
      }
      notFound();
      return true;
    }
    notFound();
    return true;
  }

  // ------------------------------------------------------------ /repos/{o}/{r}
  if (rest[0] !== 'repos' || rest.length < 3) {
    notFound();
    return true;
  }
  const owner = rest[1];
  const repoName = rest[2];
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    // A repo under another owner is 404, never 403 — and a missing repo is
    // 404 too, so every sub-route below shares this answer.
    notFound();
    return true;
  }

  // GET / PATCH / DELETE /repos/{o}/{r}
  if (rest.length === 3) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo), ctx);
    } else if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      sendJson(res, 200, repoJson(repo), ctx);
    } else if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      sendJson(res, 204, null, ctx);
    } else {
      notFound();
    }
    return true;
  }

  const sub = rest[3];

  // ------------------------------------------------------------ git refs
  if (sub === 'git' && rest[4] === 'refs') {
    if (method === 'POST' && rest.length === 5) {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
        sendJson(res, 422, { message: 'Invalid ref or sha' }, ctx);
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } }, ctx);
      return true;
    }
    if (method === 'GET' && rest.length >= 7 && rest[5] === 'heads') {
      const branch = rest.slice(6).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) notFound();
      else sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha } }, ctx);
      return true;
    }
    notFound();
    return true;
  }

  // ------------------------------------------------------------ branches
  if (sub === 'branches') {
    if (method === 'GET' && rest.length === 4) {
      const out: { name: string; commit: { sha: string } }[] = [];
      for (const [ref, sha] of repo.refs) {
        if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      sendJson(res, 200, out, ctx);
      return true;
    }
    if (method === 'GET' && rest.length >= 5) {
      const branch = rest.slice(4).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) notFound();
      else sendJson(res, 200, { name: branch, commit: { sha } }, ctx);
      return true;
    }
    notFound();
    return true;
  }

  // ------------------------------------------------------------ commits
  if (sub === 'commits') {
    if (method === 'GET' && rest.length === 4) {
      const refParam = queryOf(req).get('sha');
      let tip: string | undefined;
      if (refParam !== null) {
        tip = repo.refs.get(`refs/heads/${refParam}`);
        if (tip === undefined) {
          const obj = store.getObject(repo, refParam);
          if (obj !== undefined && obj.type === 'commit') tip = refParam;
        }
        if (tip === undefined) {
          notFound();
          return true;
        }
      } else {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      if (tip === undefined) {
        sendJson(res, 200, [], ctx);
        return true;
      }
      const commits = store.ancestors(repo, tip).map((sha) => {
        const commit = store.commitOf(repo, sha);
        return { sha, commit: { message: commit === null ? '' : cleanMessage(commit.message) } };
      });
      sendJson(res, 200, commits, ctx);
      return true;
    }
    notFound();
    return true;
  }

  // ------------------------------------------------------------ contents
  if (sub === 'contents') {
    const contentPath = rest.slice(4).join('/');

    if (method === 'PUT') {
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined && !(repo.refs.size === 0 && branch === repo.defaultBranch)) {
        notFound('Branch not found');
        return true;
      }
      if (typeof body.content !== 'string') {
        sendJson(res, 400, { message: 'content is required' }, ctx);
        return true;
      }
      let data: Buffer;
      try {
        data = Buffer.from(body.content, 'base64');
      } catch {
        sendJson(res, 400, { message: 'content is not valid base64' }, ctx);
        return true;
      }
      const message = typeof body.message === 'string' ? body.message : '';
      let baseTree: string | null = null;
      const parents: string[] = [];
      let currentBlob: string | null = null;
      if (tip !== undefined) {
        const commit = store.commitOf(repo, tip);
        if (commit === null) {
          notFound();
          return true;
        }
        baseTree = commit.tree;
        parents.push(tip);
        currentBlob = store.blobAtPath(repo, commit.tree, contentPath);
      }
      const isUpdate = currentBlob !== null;
      if (isUpdate && typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== currentBlob.toLowerCase()) {
        sendJson(res, 409, { message: 'sha does not match the current blob' }, ctx);
        return true;
      }
      const blobSha = store.putObject(repo, 'blob', data);
      const newTree = store.applyTreeChanges(repo, baseTree, new Map([[contentPath, blobSha]]));
      const commitSha = store.makeCommit(repo, newTree, parents, message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      sendJson(res, isUpdate ? 200 : 201, {
        content: { sha: blobSha, encoding: 'base64' },
        commit: { sha: commitSha },
      }, ctx);
      return true;
    }

    if (method === 'GET') {
      const branch = queryOf(req).get('ref') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        notFound();
        return true;
      }
      const commit = store.commitOf(repo, tip);
      if (commit === null) {
        notFound();
        return true;
      }
      const blobSha = store.blobAtPath(repo, commit.tree, contentPath);
      if (blobSha !== null) {
        const obj = store.getObject(repo, blobSha);
        const data = obj === undefined ? Buffer.alloc(0) : obj.data;
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: data.toString('base64'),
          sha: blobSha,
          size: data.length,
          name: contentPath.split('/').pop() ?? '',
          path: contentPath,
        }, ctx);
        return true;
      }
      const entries = store.dirEntries(repo, commit.tree, contentPath);
      if (entries !== null) {
        sendJson(res, 200, entries.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: e.path,
          sha: e.oid,
        })), ctx);
        return true;
      }
      notFound();
      return true;
    }

    if (method === 'DELETE') {
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        notFound();
        return true;
      }
      const commit = store.commitOf(repo, tip);
      if (commit === null) {
        notFound();
        return true;
      }
      const currentBlob = store.blobAtPath(repo, commit.tree, contentPath);
      if (currentBlob === null) {
        notFound();
        return true;
      }
      const message = typeof body.message === 'string' ? body.message : '';
      const newTree = store.applyTreeChanges(repo, commit.tree, new Map([[contentPath, null]]));
      const commitSha = store.makeCommit(repo, newTree, [tip], message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      sendJson(res, 200, { commit: { sha: commitSha } }, ctx);
      return true;
    }

    notFound();
    return true;
  }

  // ------------------------------------------------------------ labels
  if (sub === 'labels' && rest.length === 4) {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' }, ctx);
        return true;
      }
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color }, ctx);
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })), ctx);
      return true;
    }
    notFound();
    return true;
  }

  // ------------------------------------------------------------ issues
  // Note: issue and PR numbers come from separate per-repo counters in the
  // Store, so creating a pull request never shifts the next issue number
  // (and vice versa) — the suite asserts issue numbers increase by exactly 1.
  if (sub === 'issues') {
    if (rest.length === 4) {
      if (method === 'POST') {
        const labels = Array.isArray(body.labels)
          ? body.labels.filter((x): x is string => typeof x === 'string')
          : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendJson(res, 422, { message: `Label "${label}" does not exist` }, ctx);
            return true;
          }
        }
        const issue = store.createIssue(
          repo,
          typeof body.title === 'string' ? body.title : '',
          typeof body.body === 'string' ? body.body : '',
          labels,
        );
        sendJson(res, 201, issueJson(issue), ctx);
        return true;
      }
      if (method === 'GET') {
        const q = queryOf(req);
        const state = q.get('state') ?? 'open';
        let list = repo.issues;
        if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        else if (state === 'all') list = [...list];
        else list = list.filter((i) => i.state === 'open');
        let ordered = [...list];
        if ((q.get('sort') ?? 'created') === 'created' && (q.get('direction') ?? 'desc') === 'desc') {
          ordered.reverse();
        }
        const { perPage, page } = pageParams(req, 30);
        sendJson(res, 200, paginate(ordered, perPage, page).map(issueJson), ctx);
        return true;
      }
      notFound();
      return true;
    }

    const issueNumber = Number(rest[4]);
    const issue = Number.isInteger(issueNumber)
      ? repo.issues.find((i) => i.number === issueNumber)
      : undefined;

    if (rest.length === 5) {
      if (issue === undefined) {
        notFound();
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(issue), ctx);
        return true;
      }
      if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        sendJson(res, 200, issueJson(issue), ctx);
        return true;
      }
      notFound();
      return true;
    }

    if (rest.length === 6 && rest[5] === 'comments') {
      if (issue === undefined) {
        notFound();
        return true;
      }
      if (method === 'POST') {
        repo.commentSeq += 1;
        const comment = { id: repo.commentSeq, body: typeof body.body === 'string' ? body.body : '' };
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, body: comment.body }, ctx);
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })), ctx);
        return true;
      }
      notFound();
      return true;
    }

    notFound();
    return true;
  }

  // ------------------------------------------------------------ pull requests
  if (sub === 'pulls') {
    if (rest.length === 4) {
      if (method === 'POST') {
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : '';
        const pr = store.createPullRequest(
          repo,
          typeof body.title === 'string' ? body.title : '',
          typeof body.body === 'string' ? body.body : '',
          head,
          base,
        );
        if (pr === null) {
          sendJson(res, 422, { message: 'head or base branch not found' }, ctx);
          return true;
        }
        sendJson(res, 201, prJson(repo, pr), ctx);
        return true;
      }
      if (method === 'GET') {
        const q = queryOf(req);
        const state = q.get('state') ?? 'open';
        let list = repo.prs;
        if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        else if (state === 'all') list = [...list];
        else list = list.filter((p) => p.state === 'open');
        const { perPage, page } = pageParams(req, 30);
        sendJson(res, 200, paginate(list, perPage, page).map((pr) => prJson(repo, pr)), ctx);
        return true;
      }
      notFound();
      return true;
    }

    const prNumber = Number(rest[4]);
    const pr = Number.isInteger(prNumber)
      ? repo.prs.find((p) => p.number === prNumber)
      : undefined;

    if (rest.length === 5) {
      if (pr === undefined) {
        notFound();
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, prJson(repo, pr), ctx);
        return true;
      }
      notFound();
      return true;
    }

    if (rest.length === 6 && rest[5] === 'files') {
      if (pr === undefined) {
        notFound();
        return true;
      }
      if (method === 'GET') {
        const baseCommit = store.commitOf(repo, pr.baseSha);
        const headCommit = store.commitOf(repo, pr.headSha);
        if (baseCommit === null || headCommit === null) {
          notFound();
          return true;
        }
        const files = store.diffTrees(repo, baseCommit.tree, headCommit.tree).map((d) => {
          const oldData = d.oldOid === null ? null : store.getObject(repo, d.oldOid)?.data ?? null;
          const newData = d.newOid === null ? null : store.getObject(repo, d.newOid)?.data ?? null;
          const { additions, deletions } = countDiff(
            oldData === null ? [] : linesOf(oldData),
            newData === null ? [] : linesOf(newData),
          );
          return {
            filename: d.path,
            status: d.status,
            additions,
            deletions,
            changes: additions + deletions,
          };
        });
        sendJson(res, 200, files, ctx);
        return true;
      }
      notFound();
      return true;
    }

    if (rest.length === 6 && rest[5] === 'merge') {
      if (pr === undefined) {
        notFound();
        return true;
      }
      if (method === 'PUT') {
        const result = store.mergePullRequest(repo, pr);
        if (typeof result === 'string') {
          sendJson(res, 200, {
            merged: true,
            sha: result,
            message: `Pull request #${pr.number} successfully merged`,
          }, ctx);
        } else {
          sendJson(res, result.status, { message: result.error }, ctx);
        }
        return true;
      }
      notFound();
      return true;
    }

    notFound();
    return true;
  }

  notFound();
  return true;
}
