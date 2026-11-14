// Git smart HTTP surface for the forge: upload-pack (protocol v2, with a v0
// fallback) and receive-pack (protocol v0 only), over the shared Store.
//
// The client is the make.fun git client only (no real git binary talks to
// this surface). Behaviour follows ~/workspace/makefun/work/gitforge-specs/git.md
// exactly: pkt-line framing (max 65520 bytes), v2 ls-refs/fetch with
// server-side prefix filtering, shallow/deepen semantics, sideband-framed
// packfiles of plain (undelted) objects, and report-status push reports
// double-framed inside sideband band 1.
//
// Objects are stored verbatim in the Store and returned verbatim; this file
// never rewrites commit/tree/blob bytes. Node standard library only.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import { ZERO_OID, objectId, type GitObject, type ObjectType, type Repo } from './store.ts';
import { isAuthed, pathOf, queryOf, readBody, segments, sendRaw, type Ctx } from './httputil.ts';

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const TEXT = 'text/plain; charset=utf-8';

const AGENT = 'gitforge/1.0';
const OID_RE = /^[0-9a-f]{40}$/;
/** Max pkt-line total size (65520); max payload is 65516, sideband chunk 65515. */
const MAX_PKT = 65520;
const MAX_SIDEBAND_CHUNK = 65515;

/** Thrown for malformed client input; answered 400, never a crash. */
class BadRequest extends Error {}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

const FLUSH_PKT = Buffer.from('0000', 'ascii');

/** One pkt-line carrying `payload` (string or bytes, payload first). */
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > MAX_PKT) throw new Error('pkt-line too large');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

type PktItem =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/**
 * Decode a whole buffer of pkt-lines. Throws BadRequest on a bad header,
 * an impossible length, or a truncated packet.
 */
function decodePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new BadRequest('truncated pkt-line');
    const head = buf.toString('ascii', i, i + 4);
    if (head === '0000') {
      items.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (head === '0001') {
      items.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (head === '0002') {
      items.push({ kind: 'end' });
      i += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new BadRequest('invalid pkt-line length');
    const len = parseInt(head, 16);
    if (len < 4 || len > MAX_PKT) throw new BadRequest('invalid pkt-line length');
    if (i + len > buf.length) throw new BadRequest('truncated pkt-line');
    items.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return items;
}

/**
 * Decode pkt-lines up to and including the first flush packet (receive-pack
 * command list). Returns the data lines as text (without trailing '\n') and
 * the offset just past the flush, where the raw pack starts.
 */
function decodeUntilFlush(buf: Buffer): { lines: string[]; restOffset: number } {
  const lines: string[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new BadRequest('truncated pkt-line');
    const head = buf.toString('ascii', i, i + 4);
    if (head === '0000') return { lines, restOffset: i + 4 };
    if (head === '0001' || head === '0002') throw new BadRequest('unexpected control packet in command list');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new BadRequest('invalid pkt-line length');
    const len = parseInt(head, 16);
    if (len < 4 || len > MAX_PKT) throw new BadRequest('invalid pkt-line length');
    if (i + len > buf.length) throw new BadRequest('truncated pkt-line');
    lines.push(buf.toString('utf8', i + 4, i + len).replace(/\n$/, ''));
    i += len;
  }
  throw new BadRequest('command list has no flush');
}

/**
 * Split pack bytes into sideband band-1 pkt-lines (each <= 65520 bytes).
 * The band byte is the raw byte value 0x01, not ASCII '1' (0x31): the kit
 * client reads the first payload byte as a number and rejects 0x31 with
 * "invalid sideband band 49". Band 1 carries packfile data.
 */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pack.length; i += MAX_SIDEBAND_CHUNK) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + MAX_SIDEBAND_CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([0x01]), chunk])));
  }
  // An empty pack still needs at least one sideband packet (its 32 bytes
  // always produce one); guard anyway so a packfile section is never empty.
  if (out.length === 0) out.push(pktLine(Buffer.from([0x01])));
  return out;
}

// ---------------------------------------------------------------------------
// packfiles: plain-object writer, full reader (incl. delta resolution)
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** git varint: low nibble of the first byte is size bits 0-3, bits 4-6 type. */
function packVarint(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let s = size;
  let first = (s & 0x0f) | (typeCode << 4);
  s = Math.floor(s / 16);
  if (s !== 0) first |= 0x80;
  bytes.push(first);
  while (s !== 0) {
    let b = s & 0x7f;
    s = Math.floor(s / 128);
    if (s !== 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Build a version-2 pack of plain (undelted) objects, entries sorted by oid. */
function buildPack(entries: { oid: string; obj: GitObject }[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const { obj } of sorted) {
    parts.push(packVarint(TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readPackVarint(buf: Buffer, off: number, end: number): { size: number; typeCode: number; next: number } {
  if (off >= end) throw new Error('pack truncated');
  let b = buf[off];
  const typeCode = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  let i = off + 1;
  while (b & 0x80) {
    if (i >= end) throw new Error('pack truncated');
    b = buf[i];
    i += 1;
    size += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack varint too long');
  }
  return { size, typeCode, next: i };
}

/**
 * Inflate the zlib stream starting at `off`. inflateSync ignores trailing
 * bytes but throws on truncation, so binary-search the smallest end offset
 * that inflates cleanly — that is the stream's true end.
 */
function inflateAt(buf: Buffer, off: number, end: number): { data: Buffer; next: number } {
  let lo = off;
  let hi = end;
  let found = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(off, mid));
      found = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('pack zlib error');
  return { data: inflateSync(buf.subarray(off, found)), next: found };
}

function readDeltaVarint(data: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    if (i >= data.length) throw new Error('delta truncated');
    const b = data[i];
    i += 1;
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a git delta to its base; throws on any corruption. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaVarint(delta, 0);
  if (src.value !== base.length) throw new Error('delta base size mismatch');
  const tgt = readDeltaVarint(delta, src.next);
  const out: Buffer[] = [];
  let total = 0;
  let i = tgt.next;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (i >= delta.length) throw new Error('delta truncated');
          cpOff |= delta[i] << (bit * 8);
          i += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          if (i >= delta.length) throw new Error('delta truncated');
          cpSize |= delta[i] << (bit * 8);
          i += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      if (i + op > delta.length) throw new Error('delta truncated');
      out.push(delta.subarray(i, i + op));
      i += op;
      total += op;
    } else {
      throw new Error('delta corrupt');
    }
  }
  if (total !== tgt.value) throw new Error('delta size mismatch');
  return Buffer.concat(out);
}

/**
 * Parse and verify a pack (header, entry count, trailer checksum, object
 * hashes). Returns oid -> object. Delta entries are resolved against
 * earlier entries in the same pack. Throws on any defect.
 */
function parsePack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  if (!createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest().equals(trailer)) {
    throw new Error('pack trailer mismatch');
  }
  const end = buf.length - 20;
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; type: ObjectType; data: Buffer }>();
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = off;
    const v = readPackVarint(buf, off, end);
    off = v.next;
    let baseOffset = -1;
    let baseOid: string | null = null;
    if (v.typeCode === 6) {
      // OFS_DELTA: git negative-offset varint.
      if (off >= end) throw new Error('pack truncated');
      let b = buf[off];
      off += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        if (off >= end) throw new Error('pack truncated');
        b = buf[off];
        off += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryOffset - offset;
      if (baseOffset < 0) throw new Error('invalid base offset');
    } else if (v.typeCode === 7) {
      if (off + 20 > end) throw new Error('pack truncated');
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (CODE_TYPE[v.typeCode] === undefined) {
      throw new Error('unknown type code');
    }
    const inflated = inflateAt(buf, off, end);
    if (inflated.data.length !== v.size) throw new Error('pack entry size mismatch');
    off = inflated.next;
    if (v.typeCode === 6 || v.typeCode === 7) {
      let base: { type: ObjectType; data: Buffer } | undefined;
      if (baseOffset >= 0) base = byOffset.get(baseOffset);
      else if (baseOid !== null) base = objects.get(baseOid);
      if (base === undefined) throw new Error('delta base not found');
      const data = applyDelta(base.data, inflated.data);
      const oid = objectId(base.type, data);
      const entry = { oid, type: base.type, data };
      objects.set(oid, { type: base.type, data });
      byOffset.set(entryOffset, entry);
    } else {
      const type = CODE_TYPE[v.typeCode];
      const data = inflated.data;
      const oid = objectId(type, data);
      const entry = { oid, type, data };
      objects.set(oid, { type, data });
      byOffset.set(entryOffset, entry);
    }
  }
  if (off !== end) throw new Error('pack has stray bytes before trailer');
  return objects;
}

// ---------------------------------------------------------------------------
// ref / object helpers over the Store
// ---------------------------------------------------------------------------

function parseTreeEntries(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.toString('utf8', i, sp),
      name: data.toString('utf8', sp + 1, nul),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return entries;
}

/** Parse a stored commit object (local equivalent of Store.commitOf). */
function commitOf(repo: Repo, oid: string): { tree: string; parents: string[] } | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

/** The `object` oid a tag object points at, or null. */
function tagTarget(data: Buffer): string | null {
  const m = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return m === null ? null : m[1];
}

/** Follow tag objects to the commit they point at (null when not a tag). */
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type !== 'tag') return null;
    const target = tagTarget(obj.data);
    if (target === null) return null;
    cur = target;
  }
}

/** Refs sorted by name: [name, oid]. */
function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Add a tree's closure (tree + subtrees + blobs, skipping gitlinks) to `out`. */
function addTreeClosure(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'tree') {
      for (const e of parseTreeEntries(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// fetch object selection (shared by v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Compute the exact object set for a fetch: the closure of the wants
 * (depth-limited when `deepen` is set), minus the closure of the haves.
 * A `have` listed in `shallow` is a shallow boundary: the client holds that
 * commit and its tree, but NOT its parents, so the have-closure stops there.
 */
function computeFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const shallowSet = new Set(args.shallow);

  // Expand wants into commit tips plus directly-wanted non-commit objects.
  const tipCommits: string[] = [];
  const direct = new Map<string, GitObject>();
  for (const w of args.wants) {
    const obj = repo.objects.get(w);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      tipCommits.push(w);
    } else if (obj.type === 'tag') {
      direct.set(w, obj);
      const target = tagTarget(obj.data);
      if (target !== null) {
        const tobj = repo.objects.get(target);
        if (tobj !== undefined) {
          if (tobj.type === 'commit') tipCommits.push(target);
          else direct.set(target, tobj);
        }
      }
    } else {
      direct.set(w, obj);
    }
  }

  // Commit BFS from the tips, bounded by deepen (depth < deepen included).
  const depthMap = new Map<string, number>();
  const queue: string[] = [];
  for (const t of tipCommits) {
    if (!depthMap.has(t)) {
      depthMap.set(t, 0);
      queue.push(t);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const oid = queue[qi];
    qi += 1;
    const d = depthMap.get(oid) as number;
    if (args.deepen !== null && d + 1 >= args.deepen) continue;
    const c = commitOf(repo, oid);
    if (c === null) continue;
    for (const p of c.parents) {
      if (!depthMap.has(p)) {
        depthMap.set(p, d + 1);
        queue.push(p);
      }
    }
  }

  // Want set: included commits + their tree closures + direct objects.
  const wantSet = new Map<string, GitObject>(direct);
  for (const oid of depthMap.keys()) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) wantSet.set(oid, obj);
    const c = commitOf(repo, oid);
    if (c !== null) addTreeClosure(repo, c.tree, wantSet);
  }
  for (const [oid, obj] of direct) {
    if (obj.type === 'tree') addTreeClosure(repo, oid, wantSet);
  }

  // Held set: closure of the haves, stopping at shallow boundaries.
  const held = new Map<string, GitObject>();
  const hseen = new Set<string>();
  const hq: string[] = [];
  for (const h of args.haves) {
    const obj = repo.objects.get(h);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      if (!hseen.has(h)) {
        hseen.add(h);
        hq.push(h);
      }
    } else if (obj.type === 'tag') {
      held.set(h, obj);
      const target = tagTarget(obj.data);
      if (target !== null) {
        const tobj = repo.objects.get(target);
        if (tobj !== undefined) {
          if (tobj.type === 'commit') {
            if (!hseen.has(target)) {
              hseen.add(target);
              hq.push(target);
            }
          } else {
            held.set(target, tobj);
          }
        }
      }
    } else if (obj.type === 'tree') {
      held.set(h, obj);
      addTreeClosure(repo, h, held);
    } else {
      held.set(h, obj);
    }
  }
  let hi = 0;
  while (hi < hq.length) {
    const oid = hq[hi];
    hi += 1;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) held.set(oid, obj);
    const c = commitOf(repo, oid);
    if (c === null) continue;
    addTreeClosure(repo, c.tree, held);
    if (shallowSet.has(oid)) continue; // shallow boundary: parents not held
    for (const p of c.parents) {
      if (!hseen.has(p)) {
        hseen.add(p);
        hq.push(p);
      }
    }
  }

  const deliver = new Map<string, GitObject>();
  for (const [oid, obj] of wantSet) {
    if (!held.has(oid)) deliver.set(oid, obj);
  }

  // shallow-info: new boundaries, and old boundaries that are now unshallow.
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (args.deepen !== null) {
    for (const [oid, d] of depthMap) {
      if (d === args.deepen - 1) {
        const c = commitOf(repo, oid);
        if (c !== null && c.parents.length > 0) shallowOut.push(oid);
      }
    }
    for (const s of args.shallow) {
      const d = depthMap.get(s);
      if (d !== undefined && d < args.deepen - 1) unshallowOut.push(s);
    }
  } else if (args.shallow.length > 0) {
    for (const s of args.shallow) {
      if (depthMap.has(s)) shallowOut.push(s);
    }
  }
  return { objects: deliver, shallow: shallowOut, unshallow: unshallowOut };
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    FLUSH_PKT,
  ]);
}

function v0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get('refs/heads/main') ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) parts.push(pktLine(`${oid} ${name}\n`));
    for (const [name, oid] of refs) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

const UPLOAD_V0_CAPS =
  `side-band-64k multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

// ---------------------------------------------------------------------------
// protocol v2: ls-refs / fetch
// ---------------------------------------------------------------------------

interface V2Args {
  command: string;
  args: string[];
}

function parseV2Body(body: Buffer): V2Args {
  const items = decodePktLines(body);
  const dataLines: string[] = [];
  for (const item of items) {
    if (item.kind === 'delim') continue;
    if (item.kind === 'flush') break;
    if (item.kind === 'data') {
      dataLines.push(item.data.toString('utf8').replace(/\n$/, ''));
    }
  }
  if (dataLines.length === 0) throw new BadRequest('empty v2 request');
  const commandLine = dataLines[0];
  const m = /^command=([a-z-]+)$/.exec(commandLine);
  if (m === null) throw new BadRequest('v2 request has no command');
  return { command: m[1], args: dataLines.slice(1) };
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes: string[] = [];
  for (const a of args) {
    if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  const wantHead = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (wantHead) {
    if (mainTip !== undefined) {
      parts.push(
        pktLine(symrefs ? `${mainTip} HEAD symref-target:refs/heads/main\n` : `${mainTip} HEAD\n`),
      );
    } else if (unborn) {
      parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    const obj = repo.objects.get(oid);
    if (peel && obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null };
  for (const a of args) {
    if (a.startsWith('want ')) {
      const oid = a.slice(5).trim();
      if (OID_RE.test(oid)) out.wants.push(oid);
    } else if (a.startsWith('have ')) {
      const oid = a.slice(5).trim();
      if (OID_RE.test(oid)) out.haves.push(oid);
    } else if (a.startsWith('shallow ')) {
      const oid = a.slice(8).trim();
      if (OID_RE.test(oid)) out.shallow.push(oid);
    } else if (a.startsWith('deepen ')) {
      const n = Number(a.slice(7).trim());
      if (Number.isInteger(n) && n >= 0) out.deepen = n;
    }
    // thin-pack / no-progress / ofs-delta / filter / deepen-since /
    // deepen-not / done / agent= / object-format= : accepted, no action.
  }
  return out;
}

function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH_PKT);
  }
  parts.push(pktLine('packfile\n'));
  const pack = buildPack([...plan.objects.entries()].map(([oid, obj]) => ({ oid, obj })));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// protocol v0: upload-pack fetch fallback
// ---------------------------------------------------------------------------

function parseV0FetchBody(body: Buffer): FetchArgs {
  const items = decodePktLines(body);
  const out: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null };
  let section = 0; // 0 = wants, 1 = haves
  for (const item of items) {
    if (item.kind === 'flush') {
      section += 1;
      continue;
    }
    if (item.kind !== 'data') continue;
    const line = item.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // First want may carry a space-separated feature list after the oid.
      const oid = line.slice(5).split(' ')[0];
      if (OID_RE.test(oid)) out.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (OID_RE.test(oid)) out.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (OID_RE.test(oid)) out.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n >= 0) out.deepen = n;
    }
    // done / deepen-since / deepen-not: accepted, no action.
  }
  if (out.wants.length === 0) throw new BadRequest('v0 fetch has no want');
  return out;
}

function v0FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = computeFetch(repo, args);
  const parts: Buffer[] = [];
  // ACK every have the server shares with the want closure, else NAK.
  const held = new Set<string>();
  {
    const seen = new Set<string>();
    const stack = [...args.haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      held.add(oid);
      const c = commitOf(repo, oid);
      if (c !== null) for (const p of c.parents) stack.push(p);
    }
  }
  const wantClosure = new Set<string>();
  {
    const stack = [...args.wants];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (wantClosure.has(oid)) continue;
      wantClosure.add(oid);
      const c = commitOf(repo, oid);
      if (c !== null) for (const p of c.parents) stack.push(p);
    }
  }
  const acks = args.haves.filter((h) => wantClosure.has(h));
  if (acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of acks) parts.push(pktLine(`ACK ${oid}\n`));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = buildPack([...plan.objects.entries()].map(([oid, obj]) => ({ oid, obj })));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (v0 only): push
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string;
}

function parsePushCommands(lines: string[]): PushCommand[] {
  const out: PushCommand[] = [];
  for (const line of lines) {
    if (line === '') continue;
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const caps = nul >= 0 ? line.slice(nul + 1) : '';
    const fields = head.split(' ');
    if (fields.length !== 3) throw new BadRequest('bad push command');
    const [oldOid, newOid, ref] = fields;
    if (!OID_RE.test(oldOid) || !OID_RE.test(newOid)) throw new BadRequest('bad push oid');
    if (!ref.startsWith('refs/') || ref.length > 200 || /[\s\x00-\x1f\x7f]/.test(ref)) {
      throw new BadRequest('bad push ref');
    }
    out.push({ oldOid, newOid, ref, caps });
  }
  if (out.length === 0) throw new BadRequest('push has no commands');
  return out;
}

/** Apply one push command; returns ok or a refusal reason. */
function applyPushCommand(repo: Repo, cmd: PushCommand): { ok: boolean; reason?: string } {
  const current = repo.refs.get(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
      return { ok: false, reason: 'remote ref does not match expected value' };
    }
    repo.refs.delete(cmd.ref);
    return { ok: true };
  }
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    if (!repo.objects.has(cmd.newOid)) return { ok: false, reason: 'object not found' };
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ok: true };
  }
  // Update: must be a fast-forward from the advertised old tip.
  if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
  if (cmd.oldOid !== current) {
    return { ok: false, reason: 'remote ref does not match expected value' };
  }
  if (!repo.objects.has(cmd.newOid)) return { ok: false, reason: 'object not found' };
  if (!repoIsAncestor(repo, cmd.oldOid, cmd.newOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ok: true };
}

/** Ancestor check that also accepts the new tip being a tag of a commit. */
function repoIsAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = commitOf(repo, oid);
    if (c === null) {
      // A tag tip: walk through to its target commit.
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = tagTarget(obj.data);
        if (target !== null) stack.push(target);
      }
      continue;
    }
    for (const p of c.parents) {
      if (p === anc) return true;
      stack.push(p);
    }
  }
  return false;
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  const { lines, restOffset } = decodeUntilFlush(body);
  const commands = parsePushCommands(lines);
  const useSideband = commands[0].caps.split(' ').includes('side-band-64k');

  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = '';
  if (needsPack) {
    const packBytes = body.subarray(restOffset);
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing pack';
    } else {
      try {
        const objects = parsePack(packBytes);
        for (const [oid, obj] of objects) repo.objects.set(oid, obj);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpacker error';
      }
    }
  }

  const reportLines: string[] = [
    unpackOk ? 'unpack ok' : `unpack ${unpackDetail.replace(/[\r\n]/g, ' ')}`,
  ];
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpacker error`);
      continue;
    }
    const verdict = applyPushCommand(repo, cmd);
    reportLines.push(verdict.ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${verdict.reason ?? 'failed'}`);
  }

  const inner = Buffer.concat(reportLines.map((l) => pktLine(`${l}\n`)));
  let out: Buffer;
  if (useSideband) {
    const parts: Buffer[] = [];
    for (let i = 0; i < inner.length; i += MAX_SIDEBAND_CHUNK) {
      const chunk = inner.subarray(i, Math.min(inner.length, i + MAX_SIDEBAND_CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([0x01]), chunk])));
    }
    parts.push(FLUSH_PKT);
    out = Buffer.concat(parts);
  } else {
    out = Buffer.concat([inner, FLUSH_PKT]);
  }
  sendRaw(res, 200, out, RECEIVE_RESULT, ctx);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/** Handle a git smart-HTTP request; true when the path was a git path. */
export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  const path = pathOf(req);
  const segs = segments(path);
  if (segs.length < 2 || !segs[1].endsWith('.git')) return false;
  const owner = segs[0];
  const repoName = segs[1].slice(0, -4);
  const sub = segs.slice(2).join('/');
  if (sub !== 'info/refs' && sub !== 'git-upload-pack' && sub !== 'git-receive-pack') return false;

  try {
    if (!isAuthed(req, ctx)) {
      sendRaw(res, 401, Buffer.from('Unauthorized\n', 'utf8'), TEXT, ctx);
      return true;
    }
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendRaw(res, 404, Buffer.from('Not Found\n', 'utf8'), TEXT, ctx);
      return true;
    }

    if (req.method === 'GET' && sub === 'info/refs') {
      const service = queryOf(req).get('service');
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        sendRaw(res, 200, v2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack', UPLOAD_V0_CAPS), UPLOAD_ADVERTISEMENT, ctx);
      } else if (service === 'git-receive-pack') {
        sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack', RECEIVE_V0_CAPS), RECEIVE_ADVERTISEMENT, ctx);
      } else {
        sendRaw(res, 400, Buffer.from('unknown service\n', 'utf8'), TEXT, ctx);
      }
      return true;
    }

    if (req.method === 'POST' && sub === 'git-upload-pack') {
      const body = await readBody(req);
      const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      if (v2) {
        const parsed = parseV2Body(body);
        if (parsed.command === 'ls-refs') {
          sendRaw(res, 200, handleLsRefs(repo, parsed.args), UPLOAD_RESULT, ctx);
        } else if (parsed.command === 'fetch') {
          sendRaw(res, 200, v2FetchResponse(repo, parseFetchArgs(parsed.args)), UPLOAD_RESULT, ctx);
        } else {
          throw new BadRequest(`unknown v2 command ${parsed.command}`);
        }
      } else {
        const args = parseV0FetchBody(body);
        sendRaw(res, 200, v0FetchResponse(repo, args), UPLOAD_RESULT, ctx);
      }
      return true;
    }

    if (req.method === 'POST' && sub === 'git-receive-pack') {
      await handleReceivePack(req, res, ctx, repo);
      return true;
    }

    sendRaw(res, 405, Buffer.from('Method Not Allowed\n', 'utf8'), TEXT, ctx);
    return true;
  } catch (err) {
    if (err instanceof BadRequest) {
      sendRaw(res, 400, Buffer.from(`${err.message}\n`, 'utf8'), TEXT, ctx);
      return true;
    }
    throw err;
  }
}
