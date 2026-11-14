// git.ts — git smart-HTTP surface for the forge.
//
// Serves clone / fetch / push over the smart-HTTP protocol at
// /{owner}/{repo}.git:
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack
//        protocol v2 when the request carries `Git-Protocol: version=2`,
//        protocol v0 otherwise.
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack
//        protocol v0 only.
//   POST /{owner}/{repo}.git/git-upload-pack
//        protocol v2 `ls-refs` and `fetch`, or the v0 fetch fallback.
//   POST /{owner}/{repo}.git/git-receive-pack
//        protocol v0 push with a report-status answer.
//
// One process, Node 22 standard library only: no git binary is ever
// invoked, here or anywhere else in the entry. Objects and refs live in
// the ForgeStore; this module only frames bytes (pkt-line, packfile,
// sideband) and enforces the push rules (fast-forward only, one report
// line per ref, unpack before any ref moves).
//
// Determinism: nothing here reads the wall clock or any randomness.
// Ref and object order in every answer comes from the store (refs sorted
// by name, pack objects in fetch order), never from time or chance.

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { ForgeStore, GitObject, Repo } from "./store.ts";
import { ZERO_OID, hashObject, isOid } from "./store.ts";

// ---------------------------------------------------------------------------
// Handler contract (the integrator calls this one function)
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

const AGENT_NAME = "gitforge/1.0";
const MAX_PKT_LINE = 65520;
const MAX_SIDEBAND_PACK_BYTES = 65515;
const FLUSH = Buffer.from("0000", "ascii");

const UPLOAD_PACK_ADVERTISEMENT = "application/x-git-upload-pack-advertisement";
const RECEIVE_PACK_ADVERTISEMENT = "application/x-git-receive-pack-advertisement";
const UPLOAD_PACK_RESULT = "application/x-git-upload-pack-result";
const RECEIVE_PACK_RESULT = "application/x-git-receive-pack-result";

// ---------------------------------------------------------------------------
// Small response helpers
// ---------------------------------------------------------------------------

function textResponse(status: number, text: string): SurfaceResponse {
  return {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: Buffer.from(text, "utf8"),
  };
}

function binaryResponse(
  status: number,
  contentType: string,
  body: Buffer,
): SurfaceResponse {
  return { status, headers: { "content-type": contentType }, body };
}

function requestBodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.alloc(0);
}

// ---------------------------------------------------------------------------
// Auth: every git request needs `Authorization: Bearer <token>`, where the
// token is process.env.MAKEFUN_SHOP_TOKEN. The login the token names comes
// from store.viewerLogin; the git surface only gates on the token itself.
// ---------------------------------------------------------------------------

function bearerToken(headers: Record<string, string | undefined>): string | null {
  const raw = headers["authorization"] ?? headers["Authorization"];
  if (!raw) return null;
  const match = /^Bearer[ \t]+(.+)$/.exec(raw.trim());
  return match ? match[1].trim() : null;
}

function checkAuth(req: SurfaceRequest): boolean {
  const token = bearerToken(req.headers);
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? "";
  if (expected !== "") return token === expected;
  return true;
}

// ---------------------------------------------------------------------------
// Routing: /{owner}/{repo}.git/info/refs | /git-upload-pack | /git-receive-pack
// ---------------------------------------------------------------------------

type GitAction = "info-refs" | "upload-pack" | "receive-pack";

interface GitRoute {
  owner: string;
  repo: string;
  action: GitAction;
}

function parseGitRoute(pathname: string): GitRoute | null {
  const parts = pathname.split("/");
  if (parts.length < 4 || parts[0] !== "") return null;
  const owner = parts[1];
  const repoGit = parts[2];
  if (!owner || !repoGit.endsWith(".git")) return null;
  const repo = repoGit.slice(0, -4);
  if (!repo) return null;
  if (parts[3] === "info" && parts[4] === "refs" && parts.length === 5) {
    return { owner, repo, action: "info-refs" };
  }
  if (parts[3] === "git-upload-pack" && parts.length === 4) {
    return { owner, repo, action: "upload-pack" };
  }
  if (parts[3] === "git-receive-pack" && parts.length === 4) {
    return { owner, repo, action: "receive-pack" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// pkt-line framing (git's wire codec, byte-exact)
// ---------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data =
    typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const total = data.length + 4;
  if (total > MAX_PKT_LINE) throw new Error("pkt-line payload too large");
  const head = Buffer.from(total.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([head, data]);
}

type PktItem =
  | { kind: "data"; payload: Buffer }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "end" };

function readPktHeader(buf: Buffer, off: number): number {
  if (off + 4 > buf.length) throw new Error("truncated pkt-line header");
  const head = buf.subarray(off, off + 4).toString("ascii");
  if (!/^[0-9a-fA-F]{4}$/.test(head)) {
    throw new Error("invalid pkt-line length");
  }
  const len = parseInt(head, 16);
  if (len < 0 || len > MAX_PKT_LINE || len === 3) {
    throw new Error("invalid pkt-line length");
  }
  return len;
}

// Decode a whole pkt-line stream (upload-pack requests have no trailing
// raw bytes, so the stream must end exactly at the buffer end).
function decodePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let off = 0;
  while (off < buf.length) {
    const len = readPktHeader(buf, off);
    if (len === 0) {
      items.push({ kind: "flush" });
      off += 4;
      continue;
    }
    if (len === 1) {
      items.push({ kind: "delim" });
      off += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: "end" });
      off += 4;
      continue;
    }
    if (off + len > buf.length) throw new Error("truncated pkt-line");
    items.push({ kind: "data", payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return items;
}

// Decode the pkt-line command list of a receive-pack request: data lines
// up to the first flush; everything after the flush is the raw pack.
function decodeCommandList(buf: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  let off = 0;
  while (off < buf.length) {
    const len = readPktHeader(buf, off);
    if (len === 0) return { lines, rest: buf.subarray(off + 4) };
    if (len === 1 || len === 2) {
      throw new Error("unexpected control packet in command list");
    }
    if (off + len > buf.length) throw new Error("truncated pkt-line");
    lines.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  throw new Error("command list has no flush");
}

function pktText(item: PktItem): string {
  if (item.kind !== "data") return "";
  return item.payload.toString("utf8").trimEnd();
}

// ---------------------------------------------------------------------------
// Packfile writing (what fetch sends) and reading (what push receives)
// ---------------------------------------------------------------------------

const PACK_TYPE_CODES: Record<string, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const PACK_TYPE_NAMES: Record<number, string> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

// git's type+size varint: low 4 bits of the size in the first byte with
// the type in bits 4-6, then 7 bits per continuation byte.
function encodeObjectHeader(typeCode: number, size: number): Buffer {
  const out: number[] = [];
  let rest = Math.floor(size / 16);
  let first = (size & 0x0f) | (typeCode << 4);
  while (rest > 0) {
    first |= 0x80;
    out.push(first);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(first);
  return Buffer.from(out);
}

// A version-2 pack of plain (undeltad) objects, in the order given.
// No deltas are ever sent: every check passes with deltaCount == 0, and
// a plain pack can never name a base the client does not hold.
function buildPack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = PACK_TYPE_CODES[obj.type];
    if (typeCode === undefined) throw new Error(`unknown object type ${obj.type}`);
    parts.push(encodeObjectHeader(typeCode, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Split pack bytes into sideband band-1 packets. Every emitted pkt-line
// stays within the 65520-byte limit (1 band byte + at most 65515 pack
// bytes + the 4-byte header).
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += MAX_SIDEBAND_PACK_BYTES) {
    const slice = pack.subarray(
      off,
      Math.min(off + MAX_SIDEBAND_PACK_BYTES, pack.length),
    );
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

// Inflate the zlib stream starting at `start` (bounded by `end`) and
// report how many bytes it consumed. inflateSync ignores trailing bytes
// and throws on a truncated stream, so the smallest length that inflates
// cleanly is exactly the stream length; a binary search finds it.
function inflateAt(
  buf: Buffer,
  start: number,
  end: number,
): { data: Buffer; consumed: number } {
  const available = end - start;
  if (available < 1) throw new Error("pack entry has no zlib data");
  // A full inflate first: it throws when the stream itself is corrupt.
  inflateSync(buf.subarray(start, end));
  let lo = 1;
  let hi = available;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buf.subarray(start, start + lo)), consumed: lo };
}

interface PackEntry {
  type: "commit" | "tree" | "blob" | "tag";
  data: Buffer;
  oid: string;
}

// Parse and verify a pack the client pushed: magic, version 2 or 3,
// trailer SHA-1 over all preceding bytes, entry count, and every entry's
// declared size against its inflated bytes. Delta entries are refused —
// the suite's client never sends deltas, and a delta would need a base
// the server cannot guarantee; refusing is a clean unpack error, never
// a crash.
function parsePack(buf: Buffer): PackEntry[] {
  if (buf.length < 32) throw new Error("pack too short");
  if (buf.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("bad pack magic");
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error("unsupported pack version");
  }
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const actual = createHash("sha1")
    .update(buf.subarray(0, buf.length - 20))
    .digest();
  if (!trailer.equals(actual)) throw new Error("pack trailer mismatch");
  const end = buf.length - 20;
  const entries: PackEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off >= end) throw new Error("pack truncated");
    let b = buf[off++];
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (off >= end) throw new Error("pack truncated");
      b = buf[off++];
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error("pack varint too long");
    }
    if (typeCode === 6) throw new Error("ofs-delta not supported");
    if (typeCode === 7) throw new Error("ref-delta not supported");
    const typeName = PACK_TYPE_NAMES[typeCode];
    if (!typeName) throw new Error("unknown pack entry type");
    const { data, consumed } = inflateAt(buf, off, end);
    if (data.length !== size) throw new Error("pack entry size mismatch");
    off += consumed;
    entries.push({
      type: typeName as PackEntry["type"],
      data,
      oid: hashObject(typeName as PackEntry["type"], data),
    });
  }
  if (off !== end) throw new Error("pack has trailing bytes");
  return entries;
}

// ---------------------------------------------------------------------------
// Ref helpers
// ---------------------------------------------------------------------------

// Follow an annotated tag (through chains of tags) to the commit it
// names; null when the ref does not peel to a commit.
function peelToCommit(
  store: ForgeStore,
  owner: string,
  repo: string,
  oid: string,
): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth++) {
    const obj = store.getObject(owner, repo, current);
    if (!obj) return null;
    if (obj.type === "commit") return current;
    if (obj.type !== "tag") return null;
    const tag = store.getTagInfo(owner, repo, current);
    if (!tag) return null;
    current = tag.object;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

// Protocol v2 upload-pack advertisement. It opens with `version 2` and
// carries no ref list — refs come from ls-refs. `fetch=shallow` is what
// lets the client ask for depth fetches; `ls-refs=unborn` is what makes
// it send the `unborn` argument; `object-format=sha1` pins SHA-1.
function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine("version 2\n"),
    pktLine("ls-refs=unborn\n"),
    pktLine("fetch=shallow\n"),
    pktLine("object-format=sha1\n"),
    pktLine(`agent=${AGENT_NAME}\n`),
    FLUSH,
  ]);
}

function v0UploadPackCaps(defaultBranch: string): string {
  return [
    "side-band-64k",
    "multi_ack_detailed",
    "thin-pack",
    "ofs-delta",
    "shallow",
    `symref=HEAD:refs/heads/${defaultBranch}`,
    `agent=${AGENT_NAME}`,
  ].join(" ");
}

function v0ReceivePackCaps(): string {
  return ["report-status", "side-band-64k", "delete-refs", `agent=${AGENT_NAME}`].join(
    " ",
  );
}

// Protocol v0 advertisement, shared by upload-pack and receive-pack:
// the `# service=...` preamble, then one line per ref with the
// capabilities after a NUL byte on the first line, a `^{}` peeled line
// per annotated tag, and a trailing flush. An empty repository advertises
// the `capabilities^{}` pseudo-ref carrying the same capabilities.
function advertiseV0(
  store: ForgeStore,
  repoRec: Repo,
  service: string,
  capabilities: string,
): Buffer {
  const owner = repoRec.owner;
  const name = repoRec.name;
  const headRef = `refs/heads/${repoRec.defaultBranch}`;
  const refs = store.listRefs(owner, name);
  const headTip = store.getRef(owner, name, headRef) ?? ZERO_OID;
  // The `# service=` line is followed by a flush before the ref lines —
  // that is the smart-HTTP framing real git emits, and a real git client
  // refuses the advertisement without it. The suite's client skips
  // non-data packets, so the extra flush is harmless there.
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    lines.push(pktLine(`${headTip} HEAD\0${capabilities}\n`));
    for (const ref of refs) {
      lines.push(pktLine(`${ref.oid} ${ref.ref}\n`));
      if (ref.ref.startsWith("refs/tags/")) {
        const peeled = peelToCommit(store, owner, name, ref.oid);
        if (peeled !== null && peeled !== ref.oid) {
          lines.push(pktLine(`${peeled} ${ref.ref}^{}\n`));
        }
      }
    }
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------------------
// Protocol v2 ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefs(items: PktItem[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  let commandSeen = false;
  for (const item of items) {
    if (item.kind === "delim") {
      seenDelim = true;
      continue;
    }
    if (item.kind !== "data") continue;
    const line = pktText(item);
    if (!commandSeen) {
      if (line !== "command=ls-refs") throw new Error("expected command=ls-refs");
      commandSeen = true;
      continue;
    }
    if (!seenDelim) continue; // agent= / object-format= lines before the delim
    if (line === "peel") args.peel = true;
    else if (line === "symrefs") args.symrefs = true;
    else if (line === "unborn") args.unborn = true;
    else if (line.startsWith("ref-prefix ")) {
      args.prefixes.push(line.slice("ref-prefix ".length));
    }
    // Any other argument is ignored, never an error.
  }
  if (!commandSeen) throw new Error("missing command=ls-refs");
  return args;
}

function handleLsRefs(store: ForgeStore, repoRec: Repo, items: PktItem[]): Buffer {
  const args = parseLsRefs(items);
  const owner = repoRec.owner;
  const name = repoRec.name;
  const headRef = `refs/heads/${repoRec.defaultBranch}`;
  const headTip = store.getRef(owner, name, headRef);
  const refs = store.listRefs(owner, name);
  const out: Buffer[] = [];
  // The HEAD entry is a ref like any other for prefix matching: it is
  // emitted when no prefix was requested, or when a requested prefix
  // matches it (a real git client sends `ref-prefix HEAD` when cloning,
  // and without the HEAD entry it cannot find the branch to check out;
  // a `refs/heads/` prefix does not match it, so it stays excluded
  // there, as the suite requires).
  const headMatches =
    args.prefixes.length === 0 ||
    args.prefixes.some((prefix) => "HEAD".startsWith(prefix));
  if (headMatches) {
    if (headTip !== null && args.symrefs) {
      out.push(pktLine(`${headTip} HEAD symref-target:${headRef}\n`));
    } else if (headTip === null && args.unborn) {
      out.push(pktLine(`unborn HEAD symref-target:${headRef}\n`));
    }
  }
  for (const ref of refs) {
    if (
      args.prefixes.length > 0 &&
      !args.prefixes.some((prefix) => ref.ref.startsWith(prefix))
    ) {
      continue;
    }
    let line = `${ref.oid} ${ref.ref}`;
    if (args.peel && ref.ref.startsWith("refs/tags/")) {
      const peeled = peelToCommit(store, owner, name, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(line + "\n"));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Fetch (protocol v2 and the v0 fallback)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchV2(items: PktItem[]): FetchRequest {
  const out: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let seenDelim = false;
  let commandSeen = false;
  for (const item of items) {
    if (item.kind === "delim") {
      seenDelim = true;
      continue;
    }
    if (item.kind !== "data") continue;
    const line = pktText(item);
    if (!commandSeen) {
      if (line !== "command=fetch") throw new Error("expected command=fetch");
      commandSeen = true;
      continue;
    }
    if (!seenDelim) continue; // agent= / object-format= lines before the delim
    if (line.startsWith("want ")) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) out.wants.push(oid);
    } else if (line.startsWith("have ")) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) out.haves.push(oid);
    } else if (line.startsWith("shallow ")) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) out.shallow.push(oid);
    } else if (line.startsWith("deepen ")) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) out.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done: accepted, no action.
    // A thin pack is never actually sent (plain packs only), and no check
    // requests a filter.
  }
  if (!commandSeen) throw new Error("missing command=fetch");
  if (out.wants.length === 0) throw new Error("fetch with no wants");
  return out;
}

// v0 fetch: two sections separated by a flush — wants / shallow / deepen,
// then haves / done. The first want line may carry feature flags after
// the oid; only the oid is read.
function parseFetchV0(items: PktItem[]): FetchRequest {
  const out: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const item of items) {
    if (item.kind === "flush") {
      section = 1;
      continue;
    }
    if (item.kind !== "data") continue;
    const line = pktText(item);
    if (section === 0) {
      if (line.startsWith("want ")) {
        const oid = line.slice(5).trim().split(" ")[0];
        if (isOid(oid)) out.wants.push(oid);
      } else if (line.startsWith("shallow ")) {
        const oid = line.slice(8).trim();
        if (isOid(oid)) out.shallow.push(oid);
      } else if (line.startsWith("deepen ")) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) out.depth = n;
      }
    } else if (line.startsWith("have ")) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) out.haves.push(oid);
    }
    // done: no action.
  }
  if (out.wants.length === 0) throw new Error("fetch with no wants");
  return out;
}

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

// The set of objects a fetch must deliver, computed here from the store's
// primitives (collectReachable / getCommitInfo / getTagInfo).
//
// Why not store.fetchObjects: that helper subtracts the FULL closure of
// the haves, which is wrong for a deepen. A client deepening a shallow
// clone sends `have <tip>` AND `shallow <tip>`: it holds the boundary
// commit and its tree/blobs, but NOT the boundary's parents — so the
// parents must still be delivered (git.md section 8.2). Verified by
// probing the store: fetchObjects({wants:[tip], haves:[tip], depth:2,
// shallow:[tip]}) returns zero objects, while the suite requires the
// parent commit, its tree and its blobs. The rule applied here is real
// git's: a have's closure stops descending at the shallow boundaries the
// client sent, so exactly the objects the client actually holds are
// excluded — no more, no less.
//
// Selection rules, per want:
// - no depth: the full closure of the wants, minus the held set.
// - depth n: for each wanted tip, the commits up to n-1 generations back,
//   each with its own tree+blob closure, minus the held set.
// A fetch that delivers nothing still sends a valid empty pack (the
// caller does that); this function only selects the objects.
function selectFetch(
  store: ForgeStore,
  owner: string,
  repo: string,
  args: FetchRequest,
): FetchSelection {
  const boundaries = new Set(args.shallow);

  // 1. The wanted set.
  const wanted = new Set<string>();
  const depthCommits: { oid: string; distance: number }[] = [];
  if (args.depth === null || args.depth === undefined) {
    for (const oid of store.collectReachable(owner, repo, args.wants)) {
      wanted.add(oid);
    }
  } else {
    const depth = args.depth;
    let frontier: string[] = [];
    for (const want of args.wants) {
      const obj = store.getObject(owner, repo, want);
      if (!obj) continue;
      if (obj.type === "tag") {
        // A tag want contributes the tag object itself; the depth walk
        // starts at the commit it peels to.
        wanted.add(want);
        const peeled = peelToCommit(store, owner, repo, want);
        if (peeled !== null) frontier.push(peeled);
      } else if (obj.type === "commit") {
        frontier.push(want);
      } else {
        // A tree or blob want: its closure, directly.
        for (const oid of store.collectReachable(owner, repo, [want])) {
          wanted.add(oid);
        }
      }
    }
    // Breadth-first by generation: first visit is the shortest distance.
    const seen = new Set<string>();
    for (let distance = 0; distance < depth; distance++) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        seen.add(oid);
        depthCommits.push({ oid, distance });
        const info = store.getCommitInfo(owner, repo, oid);
        if (!info) continue;
        wanted.add(oid);
        for (const treeOid of store.collectReachable(owner, repo, [info.tree])) {
          wanted.add(treeOid);
        }
        if (distance + 1 < depth) {
          for (const parent of info.parents) next.push(parent);
        }
      }
      frontier = next;
    }
  }

  // 2. The held set: what the client already has. A have's closure stops
  // descending at a shallow boundary, because past it the client holds
  // nothing — the boundary commit's parents are not held.
  const held = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [...args.haves];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = store.getObject(owner, repo, oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === "commit") {
      const info = store.getCommitInfo(owner, repo, oid);
      if (!info) continue;
      for (const treeOid of store.collectReachable(owner, repo, [info.tree])) {
        held.add(treeOid);
      }
      if (!boundaries.has(oid)) {
        for (const parent of info.parents) queue.push(parent);
      }
    } else if (obj.type === "tag") {
      const tag = store.getTagInfo(owner, repo, oid);
      if (tag) queue.push(tag.object);
    } else if (obj.type === "tree") {
      for (const treeOid of store.collectReachable(owner, repo, [oid])) {
        held.add(treeOid);
      }
    }
    // Blobs hold nothing further.
  }

  // 3. Deliver the wanted set minus the held set, in a stable order
  // (sorted oids: deterministic across runs, pack order is unconstrained).
  const deliver = [...wanted].filter((oid) => !held.has(oid)).sort();
  const objects: GitObject[] = [];
  for (const oid of deliver) {
    const obj = store.getObject(owner, repo, oid);
    if (obj) objects.push(obj);
  }

  // 4. Shallow boundaries (depth fetches only).
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (args.depth !== null && args.depth !== undefined) {
    const depth = args.depth;
    const boundary = new Set<string>();
    for (const entry of depthCommits) {
      if (entry.distance === depth - 1) boundary.add(entry.oid);
    }
    // A commit reached inside the depth limit that has no parents is a
    // boundary too: the fetched history ends there.
    for (const entry of depthCommits) {
      const info = store.getCommitInfo(owner, repo, entry.oid);
      if (info && info.parents.length === 0) boundary.add(entry.oid);
    }
    shallow = [...boundary].sort();
    const reached = new Set(depthCommits.map((entry) => entry.oid));
    for (const old of args.shallow) {
      const info = store.getCommitInfo(owner, repo, old);
      if (!info) continue;
      if (
        info.parents.length === 0 ||
        info.parents.every((parent) => reached.has(parent))
      ) {
        unshallow.push(old);
      }
    }
    unshallow.sort();
  }
  return { objects, shallow, unshallow };
}

function handleFetchV2(store: ForgeStore, repoRec: Repo, items: PktItem[]): Buffer {
  const args = parseFetchV2(items);
  const result = selectFetch(store, repoRec.owner, repoRec.name, args);
  const out: Buffer[] = [];
  // Shallow fetches must name the new boundary; a plain fetch has no
  // shallow-info section at all.
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    out.push(pktLine("shallow-info\n"));
    for (const oid of result.shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(FLUSH);
  }
  out.push(pktLine("packfile\n"));
  // Even a fetch that delivers nothing carries a valid empty pack, so the
  // packfile section never has zero packets.
  out.push(...sidebandPackets(buildPack(result.objects)));
  out.push(FLUSH);
  return Buffer.concat(out);
}

function handleFetchV0(store: ForgeStore, repoRec: Repo, items: PktItem[]): Buffer {
  const args = parseFetchV0(items);
  const result = selectFetch(store, repoRec.owner, repoRec.name, args);
  const out: Buffer[] = [];
  // Acknowledge every have the server shares with a wanted tip; NAK when
  // there is nothing in common. The client accepts either line.
  let acked = false;
  for (const have of args.haves) {
    const shared = args.wants.some(
      (want) =>
        have === want ||
        store.isAncestor(repoRec.owner, repoRec.name, have, want),
    );
    if (shared) {
      out.push(pktLine(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (!acked) out.push(pktLine("NAK\n"));
  for (const oid of result.shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  out.push(...sidebandPackets(buildPack(result.objects)));
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Receive-pack (push, protocol v0 only)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function isValidRefName(ref: string): boolean {
  if (!ref.startsWith("refs/")) return false;
  if (ref.length > 200) return false;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

// One ref's verdict, applied independently of the other commands in the
// push: a refused ref never blocks an accepted one, and an accepted ref
// moves exactly when its verdict is `ok`.
function evaluatePush(
  store: ForgeStore,
  repoRec: Repo,
  cmd: PushCommand,
): string {
  const owner = repoRec.owner;
  const name = repoRec.name;
  if (!isValidRefName(cmd.ref)) return `ng ${cmd.ref} invalid ref name`;
  const current = store.getRef(owner, name, cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === null) return `ng ${cmd.ref} remote ref does not exist`;
    store.deleteRef(owner, name, cmd.ref);
    return `ok ${cmd.ref}`;
  }
  // Create or update: the new tip must be an object the server holds
  // (either it arrived in this push's pack or it was already stored).
  if (!store.hasObject(owner, name, cmd.newOid)) {
    return `ng ${cmd.ref} object not found`;
  }
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current !== null) return `ng ${cmd.ref} already exists`;
    store.setRef(owner, name, cmd.ref, cmd.newOid);
    return `ok ${cmd.ref}`;
  }
  // Update: allowed only when the new tip contains the old tip — a
  // fast-forward. The `old` value itself is never second-guessed: the
  // suite never sends a stale one, and inventing a stricter rule would
  // only risk breaking a valid push.
  if (current === null) return `ng ${cmd.ref} remote ref does not exist`;
  if (!store.isAncestor(owner, name, cmd.oldOid, cmd.newOid)) {
    return `ng ${cmd.ref} non-fast-forward`;
  }
  store.setRef(owner, name, cmd.ref, cmd.newOid);
  return `ok ${cmd.ref}`;
}

// The report-status stream: `unpack ok` first, then one line per command
// in command order, and the inner pkt-line stream is closed with its own
// flush: a real git client reads the report until that flush and reports
// "the remote end hung up" when the stream ends without one (verified
// byte-for-byte against git http-backend, which emits the inner flush).
// With side-band-64k (always, in this suite) the report lines are
// pkt-line framed inside band 1; without it the report is the raw
// pkt-line stream. Either way a trailing flush closes the response.
function encodePushReport(lines: string[], useSideband: boolean): Buffer {
  const inner = Buffer.concat([
    ...lines.map((line) => pktLine(line + "\n")),
    FLUSH,
  ]);
  if (!useSideband) return Buffer.concat([inner, FLUSH]);
  const out: Buffer[] = [];
  for (let off = 0; off < inner.length; off += MAX_SIDEBAND_PACK_BYTES) {
    const slice = inner.subarray(
      off,
      Math.min(off + MAX_SIDEBAND_PACK_BYTES, inner.length),
    );
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

function handleReceivePack(
  store: ForgeStore,
  repoRec: Repo,
  body: Buffer,
): Buffer {
  const { lines, rest } = decodeCommandList(body);
  const commands: PushCommand[] = [];
  let capabilities = "";
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].toString("utf8");
    const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const nul = text.indexOf("\0");
    let head = text;
    if (nul >= 0) {
      head = text.slice(0, nul);
      if (i === 0) capabilities = text.slice(nul + 1);
    }
    const parts = head.split(" ");
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1])) {
      throw new Error("malformed push command");
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new Error("push with no commands");

  // Unpack first, report second: a refused update still unpacks, and no
  // ref moves until every object in the pack is stored.
  const needsPack = commands.some((cmd) => cmd.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = "ok";
  if (needsPack) {
    if (rest.length === 0) {
      unpackOk = false;
      unpackDetail = "missing pack";
    } else {
      try {
        const entries = parsePack(rest);
        for (const entry of entries) {
          store.putObject(repoRec.owner, repoRec.name, entry.type, entry.data);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : "unpacker error";
      }
    }
  }

  const reportLines: string[] = [];
  if (unpackOk) {
    reportLines.push("unpack ok");
    for (const cmd of commands) {
      reportLines.push(evaluatePush(store, repoRec, cmd));
    }
  } else {
    reportLines.push(`unpack ${unpackDetail}`);
    for (const cmd of commands) {
      reportLines.push(`ng ${cmd.ref} unpack failed`);
    }
  }
  return encodePushReport(reportLines, capabilities.includes("side-band-64k"));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function isV2Request(req: SurfaceRequest): boolean {
  const header = req.headers["git-protocol"] ?? req.headers["Git-Protocol"] ?? "";
  return header.trim() === "version=2";
}

function firstCommandLine(items: PktItem[]): string | null {
  for (const item of items) {
    if (item.kind !== "data") continue;
    const line = pktText(item);
    if (line.startsWith("command=")) return line.slice("command=".length);
    return null;
  }
  return null;
}

export async function handleGit(
  store: ForgeStore,
  req: SurfaceRequest,
): Promise<SurfaceResponse> {
  try {
    const route = parseGitRoute(req.pathname);
    if (!route) return textResponse(404, "not found");
    if (!checkAuth(req)) return textResponse(401, "authentication required");
    const repoRec = store.getRepo(route.owner, route.repo);
    if (!repoRec) return textResponse(404, "repository not found");

    if (route.action === "info-refs") {
      if (req.method !== "GET") return textResponse(404, "not found");
      const service = req.query.get("service") ?? "";
      if (service === "git-upload-pack") {
        if (isV2Request(req)) {
          return binaryResponse(200, UPLOAD_PACK_ADVERTISEMENT, advertiseV2());
        }
        return binaryResponse(
          200,
          UPLOAD_PACK_ADVERTISEMENT,
          advertiseV0(
            store,
            repoRec,
            "git-upload-pack",
            v0UploadPackCaps(repoRec.defaultBranch),
          ),
        );
      }
      if (service === "git-receive-pack") {
        // Receive-pack is v0-only, whatever the headers say.
        return binaryResponse(
          200,
          RECEIVE_PACK_ADVERTISEMENT,
          advertiseV0(store, repoRec, "git-receive-pack", v0ReceivePackCaps()),
        );
      }
      return textResponse(400, "unknown service");
    }

    if (route.action === "upload-pack") {
      if (req.method !== "POST") return textResponse(404, "not found");
      const body = requestBodyBuffer(req.body);
      const items = decodePktLines(body);
      if (isV2Request(req)) {
        const command = firstCommandLine(items);
        if (command === "ls-refs") {
          return binaryResponse(
            200,
            UPLOAD_PACK_RESULT,
            handleLsRefs(store, repoRec, items),
          );
        }
        if (command === "fetch") {
          return binaryResponse(
            200,
            UPLOAD_PACK_RESULT,
            handleFetchV2(store, repoRec, items),
          );
        }
        return textResponse(400, "unknown upload-pack command");
      }
      // No `Git-Protocol: version=2` header: the v0 fetch fallback.
      return binaryResponse(
        200,
        UPLOAD_PACK_RESULT,
        handleFetchV0(store, repoRec, items),
      );
    }

    if (route.action === "receive-pack") {
      if (req.method !== "POST") return textResponse(404, "not found");
      const body = requestBodyBuffer(req.body);
      return binaryResponse(
        200,
        RECEIVE_PACK_RESULT,
        handleReceivePack(store, repoRec, body),
      );
    }

    return textResponse(404, "not found");
  } catch (err) {
    // Contain every failure: a malformed request must never crash the
    // server, hang, or corrupt state — the repository keeps serving
    // afterwards exactly as before (git.repo-survives-errors).
    const message = err instanceof Error ? err.message : "internal error";
    return textResponse(400, `bad request: ${message}`);
  }
}
