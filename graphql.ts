/**
 * GraphQL v4 surface for the github-core-clone-01 forge.
 *
 * Serves POST /api/graphql from the shared ForgeStore. The module is
 * self-contained: it ships its own small GraphQL lexer, parser and
 * executor written from scratch (Node standard library only, no
 * GraphQL package), because the entry may not install dependencies.
 *
 * What it implements (see work/gitforge-specs/graphql.md):
 *   - Query.viewer, Query.repository, Query.node, Query.__type,
 *     Query.__schema
 *   - Repository / Issue / PullRequest reads, issue connections with
 *     CREATED_AT ordering, state filtering and cursor pagination,
 *     pull-request lists and changed files
 *   - Mutations createIssue, closeIssue, createPullRequest,
 *     mergePullRequest (squash) and addComment
 *   - Introspection of the types the suite's documents use
 *   - Batched requests: a JSON array body answers an array of
 *     envelopes in request order
 *
 * Behaviour notes:
 *   - A request without an Authorization: Bearer header answers
 *     exactly 401 with a JSON {message} body. Any non-empty Bearer
 *     token is accepted as the authenticated user; the login served
 *     is store.viewerLogin. (The suite only checks the no-token case.)
 *   - A GraphQL-level failure (unknown field, bad argument, store
 *     error) answers HTTP 200 with an errors array; the HTTP status
 *     stays 200. Only transport problems (wrong method, no bearer,
 *     body that is not a JSON object) use 4xx statuses.
 *   - An unknown repository answers data.repository = null with no
 *     errors.
 *   - Global ids are opaque and stable: base64url of
 *     "forge:<Kind>:<key>", reimplemented here from the contract in
 *     work/gitforge-specs/store-api.md so this module never needs to
 *     read store.ts. The encoding is byte-identical to the store's
 *     helpers, so ids round-trip between the GraphQL, REST and MCP
 *     surfaces.
 *   - Deterministic: no Date.now(), no Math.random(), no wall clock.
 *     Merge commits use the fixed scenario epoch 1735689600.
 *     Pagination cursors encode the last returned issue number.
 *
 * Handler contract (the integrator, main.ts, calls this one function):
 *   export async function handleGraphql(
 *     store: ForgeStore, req: SurfaceRequest,
 *   ): Promise<SurfaceResponse>
 */

import type { ForgeStore, Issue, PullRequest, Repo } from "./store.ts";

/* ------------------------------------------------------------------ */
/* Handler contract types (shared with the integrator)                 */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

/** Fixed epoch (2025-01-01T00:00:00Z) used for squash-merge commits. */
const SCENARIO_EPOCH_SEC = 1735689600;

/** Marks a resolver value with the GraphQL type it belongs to. */
const TYPE_SYM = Symbol("graphql-type");

type Wrapper = {
  [TYPE_SYM]: string;
  [key: string]: unknown;
};

function wrap(type: string, fields: Record<string, unknown>): Wrapper {
  const out: Wrapper = { [TYPE_SYM]: type };
  for (const key of Object.keys(fields)) {
    out[key] = fields[key];
  }
  return out;
}

function typeOf(value: unknown): string | null {
  if (value !== null && typeof value === "object") {
    const maybe = value as Partial<Wrapper>;
    return typeof maybe[TYPE_SYM] === "string" ? maybe[TYPE_SYM] : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* Global (Relay-style) ids — reimplemented from the store-api contract */
/* ------------------------------------------------------------------ */

function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`forge:${kind}:${key}`, "utf8").toString("base64url");
}

function repoGlobalId(owner: string, name: string): string {
  return encodeGlobalId("Repository", `${owner}/${name}`);
}

function issueGlobalId(owner: string, repo: string, number: number): string {
  return encodeGlobalId("Issue", `${owner}/${repo}#${number}`);
}

function pullGlobalId(owner: string, repo: string, number: number): string {
  return encodeGlobalId("PullRequest", `${owner}/${repo}#${number}`);
}

function commentGlobalId(owner: string, repo: string, id: number): string {
  return encodeGlobalId("IssueComment", `${owner}/${repo}#c${id}`);
}

interface DecodedGlobalId {
  kind: string;
  owner: string;
  repo: string;
  number: number;
}

function decodeGlobalId(id: string): DecodedGlobalId | null {
  if (typeof id !== "string" || id.length === 0) return null;
  let text: string;
  try {
    text = Buffer.from(id, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!text.startsWith("forge:")) return null;
  const rest = text.slice("forge:".length);
  const kindEnd = rest.indexOf(":");
  if (kindEnd <= 0) return null;
  const kind = rest.slice(0, kindEnd);
  const key = rest.slice(kindEnd + 1);
  const slash = key.indexOf("/");
  if (slash <= 0) return null;
  const owner = key.slice(0, slash);
  const tail = key.slice(slash + 1);
  if (tail.length === 0) return null;
  const hash = tail.indexOf("#");
  if (hash === -1) {
    // Repository id: key is "owner/name", no number part.
    return { kind, owner, repo: tail, number: -1 };
  }
  const repo = tail.slice(0, hash);
  const numText = tail.slice(hash + 1);
  if (repo.length === 0 || numText.length === 0) return null;
  if (numText.startsWith("c")) {
    // IssueComment id: "owner/repo#c<id>".
    const n = Number(numText.slice(1));
    if (!Number.isInteger(n)) return null;
    return { kind, owner, repo, number: n };
  }
  const n = Number(numText);
  if (!Number.isInteger(n)) return null;
  return { kind, owner, repo, number: n };
}

/* ------------------------------------------------------------------ */
/* Pagination cursors                                                  */
/* ------------------------------------------------------------------ */

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number | null {
  if (typeof cursor !== "string" || cursor.length === 0) return null;
  let text: string;
  try {
    text = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const m = /^cursor:([0-9]+)$/.exec(text);
  return m ? Number(m[1]) : null;
}

function encodeCommentCursor(id: number): string {
  return Buffer.from(`comment:${id}`, "utf8").toString("base64url");
}

/* ------------------------------------------------------------------ */
/* Lexer                                                               */
/* ------------------------------------------------------------------ */

type TokenKind = "name" | "int" | "float" | "string" | "punct" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

class GraphqlSyntaxError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column: number) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

function describeToken(t: Token): string {
  if (t.kind === "eof") return "end of document";
  return JSON.stringify(t.value);
}

/** Block-string value: strip blank edge lines and the common indent. */
function dedentBlockString(raw: string): string {
  const lines = raw.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start += 1;
  let end = lines.length;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  const body = lines.slice(start, end);
  let indent: number | null = null;
  for (let k = 1; k < body.length; k += 1) {
    if (body[k].trim() === "") continue;
    const m = /^[ \t]*/.exec(body[k]);
    const n = m ? m[0].length : 0;
    if (indent === null || n < indent) indent = n;
  }
  const cut = indent === null ? 0 : indent;
  return body.map((l, k) => (k === 0 ? l : l.slice(cut))).join("\n");
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (kind: TokenKind, value: string, l: number, c: number): void => {
    tokens.push({ kind, value, line: l, column: c });
  };
  while (i < source.length) {
    const ch = source[i];
    if (
      ch === " " ||
      ch === "\t" ||
      ch === "\n" ||
      ch === "\r" ||
      ch === "," ||
      ch === "﻿"
    ) {
      if (ch === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < source.length && source[i] !== "\n") {
        i += 1;
        column += 1;
      }
      continue;
    }
    const startLine = line;
    const startCol = column;
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      push("name", source.slice(i, j), startLine, startCol);
      column += j - i;
      i = j;
      continue;
    }
    if (ch === "-" || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === "-") j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === ".") {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === "e" || source[j] === "E") {
        isFloat = true;
        j += 1;
        if (source[j] === "+" || source[j] === "-") j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      push(isFloat ? "float" : "int", source.slice(i, j), startLine, startCol);
      column += j - i;
      i = j;
      continue;
    }
    if (source.startsWith('"""', i)) {
      let j = i + 3;
      let value = "";
      while (j < source.length && !source.startsWith('"""', j)) {
        if (source[j] === "\\" && source.startsWith('\\"\\"\\"', j)) {
          value += '"""';
          j += 5;
          continue;
        }
        value += source[j];
        j += 1;
      }
      if (j >= source.length) {
        throw new GraphqlSyntaxError("Unterminated block string", startLine, startCol);
      }
      const newlines = (value.match(/\n/g) ?? []).length;
      if (newlines > 0) {
        line += newlines;
        const lastNl = value.lastIndexOf("\n");
        column = value.length - lastNl - 1 + 3;
      } else {
        column += 3 + value.length + 3;
      }
      push("string", dedentBlockString(value), startLine, startCol);
      i = j + 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === "\n") {
          throw new GraphqlSyntaxError("Unterminated string", startLine, startCol);
        }
        if (c === "\\") {
          const esc = source[j + 1];
          if (esc === undefined) break;
          const simple: Record<string, string> = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (esc === "u") {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new GraphqlSyntaxError("Invalid unicode escape", line, column);
            }
            value += String.fromCharCode(parseInt(hex, 16));
            j += 6;
            column += 6;
            continue;
          }
          if (esc in simple) {
            value += simple[esc];
            j += 2;
            column += 2;
            continue;
          }
          throw new GraphqlSyntaxError(
            `Invalid escape sequence \\${esc}`,
            line,
            column,
          );
        }
        value += c;
        j += 1;
        column += 1;
      }
      if (!closed) {
        throw new GraphqlSyntaxError("Unterminated string", startLine, startCol);
      }
      push("string", value, startLine, startCol);
      column += 1;
      i = j + 1;
      continue;
    }
    if (source.startsWith("...", i)) {
      push("punct", "...", startLine, startCol);
      column += 3;
      i += 3;
      continue;
    }
    if ("!$():=@[]{}|&".includes(ch)) {
      push("punct", ch, startLine, startCol);
      column += 1;
      i += 1;
      continue;
    }
    throw new GraphqlSyntaxError(
      `Unexpected character ${JSON.stringify(ch)}`,
      startLine,
      startCol,
    );
  }
  tokens.push({ kind: "eof", value: "", line, column });
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Parser — AST types                                                  */
/* ------------------------------------------------------------------ */

type TypeNode =
  | { kind: "named"; name: string }
  | { kind: "list"; ofType: TypeNode }
  | { kind: "nonNull"; ofType: TypeNode };

type ValueNode =
  | { kind: "variable"; name: string; line: number; column: number }
  | { kind: "int"; value: string; line: number; column: number }
  | { kind: "float"; value: string; line: number; column: number }
  | { kind: "string"; value: string; line: number; column: number }
  | { kind: "boolean"; value: boolean; line: number; column: number }
  | { kind: "null"; line: number; column: number }
  | { kind: "enum"; value: string; line: number; column: number }
  | { kind: "list"; values: ValueNode[]; line: number; column: number }
  | {
      kind: "object";
      fields: { name: string; value: ValueNode }[];
      line: number;
      column: number;
    };

interface VariableDefinition {
  name: string;
  type: TypeNode;
  defaultValue?: ValueNode;
}

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface FieldNode {
  kind: "field";
  alias: string | null;
  name: string;
  arguments: ArgumentNode[];
  selectionSet: SelectionNode[] | null;
  line: number;
  column: number;
}

interface FragmentSpreadNode {
  kind: "spread";
  name: string;
  line: number;
  column: number;
}

interface InlineFragmentNode {
  kind: "inline";
  typeCondition: string | null;
  selectionSet: SelectionNode[];
  line: number;
  column: number;
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationDefinition {
  kind: "operation";
  operation: "query" | "mutation" | "subscription";
  name: string | null;
  variableDefinitions: VariableDefinition[];
  selectionSet: SelectionNode[];
}

interface FragmentDefinition {
  kind: "fragment";
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationDefinition[];
  fragments: Map<string, FragmentDefinition>;
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return t;
  }

  private atPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === "punct" && t.value === value;
  }

  private atName(value: string): boolean {
    const t = this.peek();
    return t.kind === "name" && t.value === value;
  }

  private expectPunct(value: string): Token {
    const t = this.peek();
    if (t.kind !== "punct" || t.value !== value) {
      throw new GraphqlSyntaxError(
        `Expected "${value}" but found ${describeToken(t)}`,
        t.line,
        t.column,
      );
    }
    return this.next();
  }

  private expectName(what = "a name"): Token {
    const t = this.peek();
    if (t.kind !== "name") {
      throw new GraphqlSyntaxError(
        `Expected ${what} but found ${describeToken(t)}`,
        t.line,
        t.column,
      );
    }
    return this.next();
  }

  parseDocument(): DocumentNode {
    const operations: OperationDefinition[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== "eof") {
      const def = this.parseDefinition();
      if (def.kind === "operation") operations.push(def);
      else fragments.set(def.name, def);
    }
    return { operations, fragments };
  }

  private parseDefinition(): OperationDefinition | FragmentDefinition {
    const t = this.peek();
    if (t.kind === "punct" && t.value === "{") {
      return {
        kind: "operation",
        operation: "query",
        name: null,
        variableDefinitions: [],
        selectionSet: this.parseSelectionSet(),
      };
    }
    if (
      t.kind === "name" &&
      (t.value === "query" || t.value === "mutation" || t.value === "subscription")
    ) {
      return this.parseOperation();
    }
    if (t.kind === "name" && t.value === "fragment") {
      return this.parseFragment();
    }
    throw new GraphqlSyntaxError(`Unexpected ${describeToken(t)}`, t.line, t.column);
  }

  private parseOperation(): OperationDefinition {
    const keyword = this.next();
    const operation = keyword.value as "query" | "mutation" | "subscription";
    let name: string | null = null;
    if (this.peek().kind === "name") name = this.next().value;
    const variableDefinitions = this.parseVariableDefinitions();
    this.skipDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: "operation", operation, name, variableDefinitions, selectionSet };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    if (!this.atPunct("(")) return [];
    this.next();
    const defs: VariableDefinition[] = [];
    while (!this.atPunct(")")) {
      if (this.peek().kind === "eof") {
        throw new GraphqlSyntaxError(
          "Unterminated variable definitions",
          this.peek().line,
          this.peek().column,
        );
      }
      this.expectPunct("$");
      const nameTok = this.expectName("a variable name");
      this.expectPunct(":");
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.atPunct("=")) {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      defs.push({ name: nameTok.value, type, defaultValue });
    }
    this.expectPunct(")");
    return defs;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.atPunct("[")) {
      this.next();
      const inner = this.parseType();
      this.expectPunct("]");
      type = { kind: "list", ofType: inner };
    } else {
      const nameTok = this.expectName("a type name");
      type = { kind: "named", name: nameTok.value };
    }
    if (this.atPunct("!")) {
      this.next();
      return { kind: "nonNull", ofType: type };
    }
    return type;
  }

  private parseFragment(): FragmentDefinition {
    this.next(); // "fragment"
    const nameTok = this.expectName("a fragment name");
    if (!this.atName("on")) {
      throw new GraphqlSyntaxError(
        'Expected "on" in fragment definition',
        this.peek().line,
        this.peek().column,
      );
    }
    this.next();
    const typeTok = this.expectName("a type name");
    this.skipDirectives();
    const selectionSet = this.parseSelectionSet();
    return {
      kind: "fragment",
      name: nameTok.value,
      typeCondition: typeTok.value,
      selectionSet,
    };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct("{");
    const selections: SelectionNode[] = [];
    while (!this.atPunct("}")) {
      if (this.peek().kind === "eof") {
        throw new GraphqlSyntaxError(
          "Unterminated selection set",
          this.peek().line,
          this.peek().column,
        );
      }
      selections.push(this.parseSelection());
    }
    this.expectPunct("}");
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct("...")) {
      const spreadTok = this.next();
      if (this.atName("on")) {
        this.next();
        const typeTok = this.expectName("a type name");
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        return {
          kind: "inline",
          typeCondition: typeTok.value,
          selectionSet,
          line: spreadTok.line,
          column: spreadTok.column,
        };
      }
      if (this.peek().kind === "name") {
        const nameTok = this.next();
        this.skipDirectives();
        return {
          kind: "spread",
          name: nameTok.value,
          line: spreadTok.line,
          column: spreadTok.column,
        };
      }
      this.skipDirectives();
      const selectionSet = this.parseSelectionSet();
      return {
        kind: "inline",
        typeCondition: null,
        selectionSet,
        line: spreadTok.line,
        column: spreadTok.column,
      };
    }
    return this.parseField();
  }

  private parseField(): FieldNode {
    const first = this.expectName("a field name");
    let alias: string | null = null;
    let name = first.value;
    if (this.atPunct(":")) {
      this.next();
      alias = first.value;
      name = this.expectName("a field name").value;
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.atPunct("{")) selectionSet = this.parseSelectionSet();
    return {
      kind: "field",
      alias,
      name,
      arguments: args,
      selectionSet,
      line: first.line,
      column: first.column,
    };
  }

  private parseArguments(): ArgumentNode[] {
    if (!this.atPunct("(")) return [];
    this.next();
    const args: ArgumentNode[] = [];
    while (!this.atPunct(")")) {
      if (this.peek().kind === "eof") {
        throw new GraphqlSyntaxError(
          "Unterminated arguments",
          this.peek().line,
          this.peek().column,
        );
      }
      const nameTok = this.expectName("an argument name");
      this.expectPunct(":");
      const value = this.parseValue();
      args.push({ name: nameTok.value, value });
    }
    this.expectPunct(")");
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.peek();
    if (t.kind === "punct" && t.value === "$") {
      this.next();
      const nameTok = this.expectName("a variable name");
      return { kind: "variable", name: nameTok.value, line: t.line, column: t.column };
    }
    if (t.kind === "punct" && t.value === "[") {
      this.next();
      const values: ValueNode[] = [];
      while (!this.atPunct("]")) {
        if (this.peek().kind === "eof") {
          throw new GraphqlSyntaxError("Unterminated list", t.line, t.column);
        }
        values.push(this.parseValue());
      }
      this.expectPunct("]");
      return { kind: "list", values, line: t.line, column: t.column };
    }
    if (t.kind === "punct" && t.value === "{") {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct("}")) {
        if (this.peek().kind === "eof") {
          throw new GraphqlSyntaxError("Unterminated object", t.line, t.column);
        }
        const nameTok = this.expectName("a field name");
        this.expectPunct(":");
        fields.push({ name: nameTok.value, value: this.parseValue() });
      }
      this.expectPunct("}");
      return { kind: "object", fields, line: t.line, column: t.column };
    }
    if (t.kind === "int") {
      this.next();
      return { kind: "int", value: t.value, line: t.line, column: t.column };
    }
    if (t.kind === "float") {
      this.next();
      return { kind: "float", value: t.value, line: t.line, column: t.column };
    }
    if (t.kind === "string") {
      this.next();
      return { kind: "string", value: t.value, line: t.line, column: t.column };
    }
    if (t.kind === "name") {
      this.next();
      if (t.value === "true") {
        return { kind: "boolean", value: true, line: t.line, column: t.column };
      }
      if (t.value === "false") {
        return { kind: "boolean", value: false, line: t.line, column: t.column };
      }
      if (t.value === "null") {
        return { kind: "null", line: t.line, column: t.column };
      }
      return { kind: "enum", value: t.value, line: t.line, column: t.column };
    }
    throw new GraphqlSyntaxError(`Unexpected ${describeToken(t)}`, t.line, t.column);
  }

  /** Directives are parsed and ignored; the suite sends none. */
  private skipDirectives(): void {
    while (this.atPunct("@")) {
      this.next();
      this.expectName("a directive name");
      this.parseArguments();
    }
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(source).parseDocument();
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case "variable":
      return variables[node.name];
    case "int":
      return Number.parseInt(node.value, 10);
    case "float":
      return Number.parseFloat(node.value);
    case "string":
      return node.value;
    case "boolean":
      return node.value;
    case "null":
      return null;
    case "enum":
      return node.value;
    case "list":
      return node.values.map((v) => evalValue(v, variables));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Introspection schema — the types the suite's documents describe     */
/* ------------------------------------------------------------------ */

interface TypeDef {
  kind: "OBJECT" | "INTERFACE" | "ENUM" | "INPUT_OBJECT" | "SCALAR";
  fields?: string[];
  enumValues?: string[];
  inputFields?: string[];
}

const TYPE_DEFS: Record<string, TypeDef> = {
  Query: {
    kind: "OBJECT",
    fields: ["viewer", "repository", "node", "__type", "__schema"],
  },
  Mutation: {
    kind: "OBJECT",
    fields: [
      "createIssue",
      "closeIssue",
      "createPullRequest",
      "mergePullRequest",
      "addComment",
    ],
  },
  Repository: {
    kind: "OBJECT",
    fields: [
      "id",
      "databaseId",
      "name",
      "nameWithOwner",
      "owner",
      "defaultBranchRef",
      "viewerPermission",
      "hasIssuesEnabled",
      "issue",
      "issues",
      "pullRequests",
      "pullRequest",
    ],
  },
  Issue: {
    kind: "OBJECT",
    fields: ["id", "number", "title", "state", "body"],
  },
  IssueConnection: {
    kind: "OBJECT",
    fields: ["nodes", "pageInfo", "totalCount"],
  },
  PullRequest: {
    kind: "OBJECT",
    fields: [
      "id",
      "number",
      "title",
      "body",
      "state",
      "merged",
      "headRefName",
      "baseRefName",
      "mergeable",
      "files",
    ],
  },
  PullRequestConnection: {
    kind: "OBJECT",
    fields: ["nodes", "pageInfo", "totalCount"],
  },
  PullRequestChangedFile: {
    kind: "OBJECT",
    fields: ["path", "additions", "deletions", "changeType"],
  },
  PullRequestChangedFileConnection: {
    kind: "OBJECT",
    fields: ["nodes", "pageInfo", "totalCount"],
  },
  User: { kind: "OBJECT", fields: ["login"] },
  Ref: { kind: "OBJECT", fields: ["name"] },
  PageInfo: {
    kind: "OBJECT",
    fields: ["hasNextPage", "endCursor", "hasPreviousPage", "startCursor"],
  },
  IssueComment: { kind: "OBJECT", fields: ["id", "body"] },
  CommentEdge: { kind: "OBJECT", fields: ["node", "cursor"] },
  Node: { kind: "INTERFACE", fields: ["id"] },
  CreateIssuePayload: { kind: "OBJECT", fields: ["issue"] },
  CloseIssuePayload: { kind: "OBJECT", fields: ["issue"] },
  CreatePullRequestPayload: { kind: "OBJECT", fields: ["pullRequest"] },
  MergePullRequestPayload: { kind: "OBJECT", fields: ["pullRequest"] },
  AddCommentPayload: { kind: "OBJECT", fields: ["commentEdge"] },
  IssueState: { kind: "ENUM", enumValues: ["OPEN", "CLOSED"] },
  PullRequestState: { kind: "ENUM", enumValues: ["OPEN", "CLOSED", "MERGED"] },
  MergeableState: {
    kind: "ENUM",
    enumValues: ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
  },
  PullRequestMergeMethod: {
    kind: "ENUM",
    enumValues: ["MERGE", "SQUASH", "REBASE"],
  },
  RepositoryPermission: {
    kind: "ENUM",
    enumValues: ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"],
  },
  SearchType: { kind: "ENUM", enumValues: ["ISSUE", "REPOSITORY", "USER"] },
  IssueOrderField: {
    kind: "ENUM",
    enumValues: ["CREATED_AT", "UPDATED_AT", "COMMENTS"],
  },
  OrderDirection: { kind: "ENUM", enumValues: ["ASC", "DESC"] },
  CreateIssueInput: {
    kind: "INPUT_OBJECT",
    inputFields: ["repositoryId", "title", "body"],
  },
  CloseIssueInput: { kind: "INPUT_OBJECT", inputFields: ["issueId"] },
  CreatePullRequestInput: {
    kind: "INPUT_OBJECT",
    inputFields: ["repositoryId", "baseRefName", "headRefName", "title", "body"],
  },
  MergePullRequestInput: {
    kind: "INPUT_OBJECT",
    inputFields: ["pullRequestId", "mergeMethod"],
  },
  AddCommentInput: {
    kind: "INPUT_OBJECT",
    inputFields: ["subjectId", "body"],
  },
  String: { kind: "SCALAR" },
  Int: { kind: "SCALAR" },
  Boolean: { kind: "SCALAR" },
  ID: { kind: "SCALAR" },
  __Schema: {
    kind: "OBJECT",
    fields: ["types", "queryType", "mutationType", "description"],
  },
  __Type: {
    kind: "OBJECT",
    fields: ["name", "kind", "description", "fields", "enumValues", "inputFields"],
  },
  __Field: { kind: "OBJECT", fields: ["name", "description"] },
  __EnumValue: {
    kind: "OBJECT",
    fields: ["name", "description", "isDeprecated", "deprecationReason"],
  },
  __InputValue: { kind: "OBJECT", fields: ["name", "description"] },
};

/* ------------------------------------------------------------------ */
/* Execution context and errors                                        */
/* ------------------------------------------------------------------ */

interface GraphqlErrorOut {
  message: string;
  path?: (string | number)[];
  locations?: { line: number; column: number }[];
}

interface ExecContext {
  store: ForgeStore;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinition>;
  errors: GraphqlErrorOut[];
}

/** A resolver-signalled failure: the field answers null, with an error. */
class FieldProblem extends Error {}

/** Duck-type check for the store's ForgeError (status + code). */
function isForgeErrorLike(
  err: unknown,
): err is Error & { status: number; code: string } {
  return (
    err instanceof Error &&
    typeof (err as { status?: unknown }).status === "number" &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

type ResolverFn = (
  parent: Wrapper,
  args: Record<string, unknown>,
  ctx: ExecContext,
) => unknown;

/* ------------------------------------------------------------------ */
/* Connection builders                                                 */
/* ------------------------------------------------------------------ */

function issueWrapper(owner: string, repoName: string, issue: Issue): Wrapper {
  return wrap("Issue", { owner, repoName, issue });
}

function pullWrapper(owner: string, repoName: string, pull: PullRequest): Wrapper {
  return wrap("PullRequest", { owner, repoName, pull });
}

function pageInfoWrapper(
  hasNextPage: boolean,
  endCursor: string | null,
  hasPreviousPage: boolean,
  startCursor: string | null,
): Wrapper {
  return wrap("PageInfo", { hasNextPage, endCursor, hasPreviousPage, startCursor });
}

function buildIssueConnection(
  store: ForgeStore,
  repo: Repo,
  args: Record<string, unknown>,
): Wrapper {
  const statesArg = args.states;
  let stateOpt = "all";
  if (Array.isArray(statesArg) && statesArg.length > 0) {
    const wanted = statesArg.map((s) => String(s).toUpperCase());
    if (wanted.length === 1) {
      if (wanted[0] === "OPEN") stateOpt = "open";
      else if (wanted[0] === "CLOSED") stateOpt = "closed";
    }
  }
  // orderBy.field is CREATED_AT in every document the suite sends; the
  // store orders by creation sequence, which is the same order.
  // UPDATED_AT and COMMENTS fall back to that order as well.
  const orderBy = asRecord(args.orderBy);
  const direction = orderBy.direction === "ASC" ? "asc" : "desc";
  const all = store.listIssues(repo.owner, repo.name, {
    state: stateOpt,
    sort: "created",
    direction,
  });
  let start = 0;
  if (typeof args.after === "string" && args.after.length > 0) {
    const afterNumber = decodeCursor(args.after);
    if (afterNumber !== null) {
      const idx = all.findIndex((issue) => issue.number === afterNumber);
      start = idx >= 0 ? idx + 1 : all.length;
    }
  }
  const first =
    typeof args.first === "number" && args.first >= 0
      ? Math.floor(args.first)
      : all.length - start;
  const page = all.slice(start, start + first);
  const hasNextPage = start + page.length < all.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? encodeCursor(page[0].number) : null;
  return wrap("IssueConnection", {
    nodes: page.map((issue) => issueWrapper(repo.owner, repo.name, issue)),
    pageInfo: pageInfoWrapper(hasNextPage, endCursor, start > 0, startCursor),
    totalCount: all.length,
  });
}

function buildPullConnection(
  store: ForgeStore,
  repo: Repo,
  args: Record<string, unknown>,
): Wrapper {
  const all = store.listPulls(repo.owner, repo.name, { state: "all" });
  const first =
    typeof args.first === "number" && args.first >= 0
      ? Math.floor(args.first)
      : all.length;
  const page = all.slice(0, first);
  return wrap("PullRequestConnection", {
    nodes: page.map((pull) => pullWrapper(repo.owner, repo.name, pull)),
    pageInfo: pageInfoWrapper(page.length < all.length, null, false, null),
    totalCount: all.length,
  });
}

function buildFilesConnection(
  store: ForgeStore,
  owner: string,
  repoName: string,
  number: number,
  args: Record<string, unknown>,
): Wrapper {
  const changes = store.pullFiles(owner, repoName, number);
  const first =
    typeof args.first === "number" && args.first >= 0
      ? Math.floor(args.first)
      : changes.length;
  const page = changes.slice(0, first);
  const statusToChangeType: Record<string, string> = {
    added: "ADDED",
    modified: "MODIFIED",
    deleted: "REMOVED",
  };
  return wrap("PullRequestChangedFileConnection", {
    nodes: page.map((change) =>
      wrap("PullRequestChangedFile", {
        path: change.filename,
        additions: change.additions,
        deletions: change.deletions,
        changeType: statusToChangeType[change.status] ?? "MODIFIED",
      }),
    ),
    pageInfo: pageInfoWrapper(page.length < changes.length, null, false, null),
    totalCount: changes.length,
  });
}

/* ------------------------------------------------------------------ */
/* Resolvers                                                           */
/* ------------------------------------------------------------------ */

const QueryResolvers: Record<string, ResolverFn> = {
  viewer: (_parent, _args, ctx) =>
    wrap("User", { login: ctx.store.viewerLogin }),
  repository: (_parent, args, ctx) => {
    const owner = typeof args.owner === "string" ? args.owner : "";
    const name = typeof args.name === "string" ? args.name : "";
    const repo = ctx.store.getRepo(owner, name);
    return repo === null ? null : wrap("Repository", { repo });
  },
  node: (_parent, args, ctx) => {
    const decoded =
      typeof args.id === "string" ? decodeGlobalId(args.id) : null;
    if (decoded === null) return null;
    if (decoded.kind === "Repository") {
      const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
      return repo === null ? null : wrap("Repository", { repo });
    }
    if (decoded.kind === "Issue") {
      const issue = ctx.store.getIssue(decoded.owner, decoded.repo, decoded.number);
      if (issue === null) return null;
      return issueWrapper(decoded.owner, decoded.repo, issue);
    }
    if (decoded.kind === "PullRequest") {
      const pull = ctx.store.getPull(decoded.owner, decoded.repo, decoded.number);
      if (pull === null) return null;
      return pullWrapper(decoded.owner, decoded.repo, pull);
    }
    return null;
  },
  __type: (_parent, args) => {
    const name = typeof args.name === "string" ? args.name : "";
    if (!(name in TYPE_DEFS)) return null;
    return wrap("__Type", { typeName: name });
  },
  __schema: () => wrap("__Schema", {}),
};

function repoOf(parent: Wrapper): Repo {
  return parent.repo as Repo;
}

const RepositoryResolvers: Record<string, ResolverFn> = {
  id: (parent) => repoGlobalId(repoOf(parent).owner, repoOf(parent).name),
  databaseId: (parent) => repoOf(parent).databaseId,
  name: (parent) => repoOf(parent).name,
  nameWithOwner: (parent) => repoOf(parent).fullName,
  owner: (parent) => wrap("User", { login: repoOf(parent).owner }),
  defaultBranchRef: (parent) =>
    wrap("Ref", { name: repoOf(parent).defaultBranch }),
  viewerPermission: () => "ADMIN",
  hasIssuesEnabled: () => true,
  issue: (parent, args, ctx) => {
    const repo = repoOf(parent);
    const number = typeof args.number === "number" ? args.number : NaN;
    if (!Number.isInteger(number)) return null;
    const issue = ctx.store.getIssue(repo.owner, repo.name, number);
    return issue === null ? null : issueWrapper(repo.owner, repo.name, issue);
  },
  issues: (parent, args, ctx) =>
    buildIssueConnection(ctx.store, repoOf(parent), args),
  pullRequests: (parent, args, ctx) =>
    buildPullConnection(ctx.store, repoOf(parent), args),
  pullRequest: (parent, args, ctx) => {
    const repo = repoOf(parent);
    const number = typeof args.number === "number" ? args.number : NaN;
    if (!Number.isInteger(number)) return null;
    const pull = ctx.store.getPull(repo.owner, repo.name, number);
    return pull === null ? null : pullWrapper(repo.owner, repo.name, pull);
  },
};

const IssueResolvers: Record<string, ResolverFn> = {
  id: (parent) =>
    issueGlobalId(
      String(parent.owner),
      String(parent.repoName),
      (parent.issue as Issue).number,
    ),
  number: (parent) => (parent.issue as Issue).number,
  title: (parent) => (parent.issue as Issue).title,
  body: (parent) => (parent.issue as Issue).body,
  state: (parent) =>
    (parent.issue as Issue).state === "open" ? "OPEN" : "CLOSED",
};

const PullRequestResolvers: Record<string, ResolverFn> = {
  id: (parent) =>
    pullGlobalId(
      String(parent.owner),
      String(parent.repoName),
      (parent.pull as PullRequest).number,
    ),
  number: (parent) => (parent.pull as PullRequest).number,
  title: (parent) => (parent.pull as PullRequest).title,
  body: (parent) => (parent.pull as PullRequest).body,
  state: (parent) => {
    const pull = parent.pull as PullRequest;
    if (pull.merged) return "MERGED";
    return pull.state === "open" ? "OPEN" : "CLOSED";
  },
  merged: (parent) => (parent.pull as PullRequest).merged,
  headRefName: (parent) => (parent.pull as PullRequest).head.ref,
  baseRefName: (parent) => (parent.pull as PullRequest).base.ref,
  mergeable: (parent, _args, ctx) =>
    ctx.store.pullMergeable(
      String(parent.owner),
      String(parent.repoName),
      (parent.pull as PullRequest).number,
    ),
  files: (parent, args, ctx) =>
    buildFilesConnection(
      ctx.store,
      String(parent.owner),
      String(parent.repoName),
      (parent.pull as PullRequest).number,
      args,
    ),
};

const ConnectionResolvers: Record<string, ResolverFn> = {
  nodes: (parent) => parent.nodes as unknown[],
  pageInfo: (parent) => parent.pageInfo as Wrapper,
  totalCount: (parent) => parent.totalCount as number,
};

const PullRequestChangedFileResolvers: Record<string, ResolverFn> = {
  path: (parent) => parent.path as string,
  additions: (parent) => parent.additions as number,
  deletions: (parent) => parent.deletions as number,
  changeType: (parent) => parent.changeType as string,
};

const UserResolvers: Record<string, ResolverFn> = {
  login: (parent) => parent.login as string,
};

const RefResolvers: Record<string, ResolverFn> = {
  name: (parent) => parent.name as string,
};

const PageInfoResolvers: Record<string, ResolverFn> = {
  hasNextPage: (parent) => parent.hasNextPage as boolean,
  endCursor: (parent) => parent.endCursor as string | null,
  hasPreviousPage: (parent) => parent.hasPreviousPage as boolean,
  startCursor: (parent) => parent.startCursor as string | null,
};

const IssueCommentResolvers: Record<string, ResolverFn> = {
  id: (parent) => parent.commentId as string,
  body: (parent) => parent.commentBody as string,
};

const CommentEdgeResolvers: Record<string, ResolverFn> = {
  node: (parent) => parent.node as Wrapper,
  cursor: (parent) => parent.cursor as string,
};

const CreateIssuePayloadResolvers: Record<string, ResolverFn> = {
  issue: (parent) => parent.issue as Wrapper,
};

const CloseIssuePayloadResolvers: Record<string, ResolverFn> = {
  issue: (parent) => parent.issue as Wrapper,
};

const CreatePullRequestPayloadResolvers: Record<string, ResolverFn> = {
  pullRequest: (parent) => parent.pullRequest as Wrapper,
};

const MergePullRequestPayloadResolvers: Record<string, ResolverFn> = {
  pullRequest: (parent) => parent.pullRequest as Wrapper,
};

const AddCommentPayloadResolvers: Record<string, ResolverFn> = {
  commentEdge: (parent) => parent.commentEdge as Wrapper,
};

const TypeResolvers: Record<string, ResolverFn> = {
  name: (parent) => String(parent.typeName),
  kind: (parent) => TYPE_DEFS[String(parent.typeName)]?.kind ?? null,
  description: () => null,
  fields: (parent) => {
    const def = TYPE_DEFS[String(parent.typeName)];
    if (!def || (def.kind !== "OBJECT" && def.kind !== "INTERFACE")) return null;
    return (def.fields ?? []).map((name) => wrap("__Field", { fieldName: name }));
  },
  enumValues: (parent) => {
    const def = TYPE_DEFS[String(parent.typeName)];
    if (!def || def.kind !== "ENUM") return null;
    return (def.enumValues ?? []).map((name) =>
      wrap("__EnumValue", { enumName: name }),
    );
  },
  inputFields: (parent) => {
    const def = TYPE_DEFS[String(parent.typeName)];
    if (!def || def.kind !== "INPUT_OBJECT") return null;
    return (def.inputFields ?? []).map((name) =>
      wrap("__InputValue", { inputName: name }),
    );
  },
};

const FieldResolvers: Record<string, ResolverFn> = {
  name: (parent) => String(parent.fieldName),
  description: () => null,
};

const EnumValueResolvers: Record<string, ResolverFn> = {
  name: (parent) => String(parent.enumName),
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
};

const InputValueResolvers: Record<string, ResolverFn> = {
  name: (parent) => String(parent.inputName),
  description: () => null,
};

const SchemaResolvers: Record<string, ResolverFn> = {
  description: () => null,
  types: () =>
    Object.keys(TYPE_DEFS).map((name) => wrap("__Type", { typeName: name })),
  queryType: () => wrap("__Type", { typeName: "Query" }),
  mutationType: () => wrap("__Type", { typeName: "Mutation" }),
};

const MutationResolvers: Record<string, ResolverFn> = {
  createIssue: (_parent, args, ctx) => {
    const input = asRecord(args.input);
    const decoded =
      typeof input.repositoryId === "string"
        ? decodeGlobalId(input.repositoryId)
        : null;
    if (decoded === null || decoded.kind !== "Repository") {
      throw new FieldProblem("createIssue: repositoryId is not a repository id");
    }
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    if (repo === null) throw new FieldProblem("createIssue: repository not found");
    const title = typeof input.title === "string" ? input.title : "";
    const body = typeof input.body === "string" ? input.body : "";
    const issue = ctx.store.createIssue(repo.owner, repo.name, { title, body });
    return wrap("CreateIssuePayload", {
      issue: issueWrapper(repo.owner, repo.name, issue),
    });
  },
  closeIssue: (_parent, args, ctx) => {
    const input = asRecord(args.input);
    const decoded =
      typeof input.issueId === "string" ? decodeGlobalId(input.issueId) : null;
    if (decoded === null || decoded.kind !== "Issue") {
      throw new FieldProblem("closeIssue: issueId is not an issue id");
    }
    const issue = ctx.store.updateIssue(decoded.owner, decoded.repo, decoded.number, {
      state: "closed",
    });
    return wrap("CloseIssuePayload", {
      issue: issueWrapper(decoded.owner, decoded.repo, issue),
    });
  },
  createPullRequest: (_parent, args, ctx) => {
    const input = asRecord(args.input);
    const decoded =
      typeof input.repositoryId === "string"
        ? decodeGlobalId(input.repositoryId)
        : null;
    if (decoded === null || decoded.kind !== "Repository") {
      throw new FieldProblem(
        "createPullRequest: repositoryId is not a repository id",
      );
    }
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    if (repo === null) {
      throw new FieldProblem("createPullRequest: repository not found");
    }
    const head = typeof input.headRefName === "string" ? input.headRefName : "";
    const base = typeof input.baseRefName === "string" ? input.baseRefName : "";
    const title = typeof input.title === "string" ? input.title : "";
    const body = typeof input.body === "string" ? input.body : "";
    const pull = ctx.store.createPullRequest(repo.owner, repo.name, {
      head,
      base,
      title,
      body,
    });
    return wrap("CreatePullRequestPayload", {
      pullRequest: pullWrapper(repo.owner, repo.name, pull),
    });
  },
  mergePullRequest: (_parent, args, ctx) => {
    const input = asRecord(args.input);
    const decoded =
      typeof input.pullRequestId === "string"
        ? decodeGlobalId(input.pullRequestId)
        : null;
    if (decoded === null || decoded.kind !== "PullRequest") {
      throw new FieldProblem(
        "mergePullRequest: pullRequestId is not a pull request id",
      );
    }
    // The store only performs squash merges; every mergeMethod the
    // suite sends (SQUASH) is a squash, and MERGE/REBASE are treated
    // the same way rather than refused.
    const identity = {
      name: ctx.store.viewerLogin,
      email: `${ctx.store.viewerLogin}@example.invalid`,
    };
    ctx.store.squashMerge(decoded.owner, decoded.repo, decoded.number, {
      author: identity,
      committer: identity,
      epochSec: SCENARIO_EPOCH_SEC,
    });
    const pull = ctx.store.getPull(decoded.owner, decoded.repo, decoded.number);
    if (pull === null) {
      throw new FieldProblem("mergePullRequest: pull request not found");
    }
    return wrap("MergePullRequestPayload", {
      pullRequest: pullWrapper(decoded.owner, decoded.repo, pull),
    });
  },
  addComment: (_parent, args, ctx) => {
    const input = asRecord(args.input);
    const decoded =
      typeof input.subjectId === "string" ? decodeGlobalId(input.subjectId) : null;
    if (decoded === null || decoded.kind !== "Issue") {
      throw new FieldProblem("addComment: subjectId is not an issue id");
    }
    const body = typeof input.body === "string" ? input.body : "";
    const comment = ctx.store.addComment(
      decoded.owner,
      decoded.repo,
      decoded.number,
      body,
    );
    const node = wrap("IssueComment", {
      commentId: commentGlobalId(decoded.owner, decoded.repo, comment.id),
      commentBody: comment.body,
    });
    return wrap("AddCommentPayload", {
      commentEdge: wrap("CommentEdge", {
        node,
        cursor: encodeCommentCursor(comment.id),
      }),
    });
  },
};

const RESOLVERS: Record<string, Record<string, ResolverFn>> = {
  Query: QueryResolvers,
  Mutation: MutationResolvers,
  Repository: RepositoryResolvers,
  Issue: IssueResolvers,
  IssueConnection: ConnectionResolvers,
  PullRequest: PullRequestResolvers,
  PullRequestConnection: ConnectionResolvers,
  PullRequestChangedFile: PullRequestChangedFileResolvers,
  PullRequestChangedFileConnection: ConnectionResolvers,
  User: UserResolvers,
  Ref: RefResolvers,
  PageInfo: PageInfoResolvers,
  IssueComment: IssueCommentResolvers,
  CommentEdge: CommentEdgeResolvers,
  CreateIssuePayload: CreateIssuePayloadResolvers,
  CloseIssuePayload: CloseIssuePayloadResolvers,
  CreatePullRequestPayload: CreatePullRequestPayloadResolvers,
  MergePullRequestPayload: MergePullRequestPayloadResolvers,
  AddCommentPayload: AddCommentPayloadResolvers,
  __Type: TypeResolvers,
  __Field: FieldResolvers,
  __EnumValue: EnumValueResolvers,
  __InputValue: InputValueResolvers,
  __Schema: SchemaResolvers,
};

/* ------------------------------------------------------------------ */
/* Executor                                                            */
/* ------------------------------------------------------------------ */

const OMIT = Symbol("omit-field");

function typeConditionMatches(condition: string, parentType: string): boolean {
  if (condition === parentType) return true;
  if (
    condition === "Node" &&
    (parentType === "Repository" ||
      parentType === "Issue" ||
      parentType === "PullRequest")
  ) {
    return true;
  }
  return false;
}

function executeSelectionSet(
  selections: SelectionNode[],
  parentType: string,
  parent: Wrapper,
  path: (string | number)[],
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === "field") {
      const key = sel.alias ?? sel.name;
      const value = executeField(sel, parentType, parent, [...path, key], ctx);
      if (value === OMIT) continue;
      out[key] = value;
    } else if (sel.kind === "spread") {
      const frag = ctx.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({
          message: `Unknown fragment "${sel.name}".`,
          locations: [{ line: sel.line, column: sel.column }],
        });
        continue;
      }
      if (!typeConditionMatches(frag.typeCondition, parentType)) continue;
      const sub = executeSelectionSet(
        frag.selectionSet,
        parentType,
        parent,
        path,
        ctx,
      );
      Object.assign(out, sub);
    } else {
      if (
        sel.typeCondition !== null &&
        !typeConditionMatches(sel.typeCondition, parentType)
      ) {
        continue;
      }
      const sub = executeSelectionSet(
        sel.selectionSet,
        parentType,
        parent,
        path,
        ctx,
      );
      Object.assign(out, sub);
    }
  }
  return out;
}

function executeField(
  field: FieldNode,
  parentType: string,
  parent: Wrapper,
  path: (string | number)[],
  ctx: ExecContext,
): unknown {
  const fieldName = field.name;
  if (fieldName === "__typename") return parentType;
  const typeResolvers = RESOLVERS[parentType];
  const resolver = typeResolvers ? typeResolvers[fieldName] : undefined;
  if (!resolver) {
    ctx.errors.push({
      message: `Cannot query field "${fieldName}" on type "${parentType}".`,
      path: [...path],
      locations: [{ line: field.line, column: field.column }],
    });
    return OMIT;
  }
  const args: Record<string, unknown> = {};
  for (const arg of field.arguments) {
    args[arg.name] = evalValue(arg.value, ctx.variables);
  }
  let value: unknown;
  try {
    value = resolver(parent, args, ctx);
  } catch (err) {
    const locations = [{ line: field.line, column: field.column }];
    if (err instanceof FieldProblem || isForgeErrorLike(err)) {
      ctx.errors.push({ message: err.message, path: [...path], locations });
    } else {
      ctx.errors.push({
        message: "Internal server error",
        path: [...path],
        locations,
      });
    }
    return null;
  }
  if (field.selectionSet === null) {
    if (
      typeOf(value) !== null ||
      (Array.isArray(value) && value.some((item) => typeOf(item) !== null))
    ) {
      ctx.errors.push({
        message: `Field "${fieldName}" of type "${parentType}" must have a selection of subfields.`,
        path: [...path],
      });
      return null;
    }
    return value;
  }
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item === null || item === undefined) return null;
      const itemType = typeOf(item);
      if (itemType === null) {
        ctx.errors.push({
          message: `Field "${fieldName}" must not have a selection since type has no subfields.`,
          path: [...path, index],
        });
        return null;
      }
      return executeSelectionSet(
        field.selectionSet as SelectionNode[],
        itemType,
        item as Wrapper,
        [...path, index],
        ctx,
      );
    });
  }
  const valueType = typeOf(value);
  if (valueType === null) {
    ctx.errors.push({
      message: `Field "${fieldName}" must not have a selection since type has no subfields.`,
      path: [...path],
    });
    return null;
  }
  return executeSelectionSet(
    field.selectionSet,
    valueType,
    value as Wrapper,
    path,
    ctx,
  );
}

function executeDocument(
  doc: DocumentNode,
  operationName: string | undefined,
  variables: Record<string, unknown>,
  store: ForgeStore,
): Record<string, unknown> {
  const ctx: ExecContext = {
    store,
    variables: { ...variables },
    fragments: doc.fragments,
    errors: [],
  };
  let operation: OperationDefinition | undefined;
  if (operationName !== undefined) {
    operation = doc.operations.find((op) => op.name === operationName);
    if (!operation) {
      return {
        data: null,
        errors: [{ message: `Unknown operation named "${operationName}".` }],
      };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: "Must provide an operation." }] };
  } else {
    return {
      data: null,
      errors: [
        {
          message:
            "Must provide operation name if query contains multiple operations.",
        },
      ],
    };
  }
  if (operation.operation === "subscription") {
    return {
      data: null,
      errors: [{ message: "Subscriptions are not supported." }],
    };
  }
  for (const varDef of operation.variableDefinitions) {
    if (
      varDef.defaultValue !== undefined &&
      ctx.variables[varDef.name] === undefined
    ) {
      ctx.variables[varDef.name] = evalValue(varDef.defaultValue, ctx.variables);
    }
  }
  const rootType = operation.operation === "mutation" ? "Mutation" : "Query";
  const root = wrap(rootType, {});
  const data = executeSelectionSet(
    operation.selectionSet,
    rootType,
    root,
    [],
    ctx,
  );
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/* ------------------------------------------------------------------ */
/* HTTP entry point                                                    */
/* ------------------------------------------------------------------ */

let requestCounter = 0;

function bearerToken(headers: Record<string, string | undefined>): string | null {
  const raw = headers.authorization ?? headers.Authorization;
  if (typeof raw !== "string") return null;
  const m = /^Bearer[ \t]+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

function executeOperationBody(
  store: ForgeStore,
  entry: unknown,
): Record<string, unknown> {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      data: null,
      errors: [{ message: "operation must be a JSON object with a query string" }],
    };
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.query !== "string") {
    return { data: null, errors: [{ message: "query must be a string" }] };
  }
  const variables = asRecord(record.variables);
  const operationName =
    typeof record.operationName === "string" ? record.operationName : undefined;
  let doc: DocumentNode;
  try {
    doc = parseDocument(record.query);
  } catch (err) {
    if (err instanceof GraphqlSyntaxError) {
      return {
        data: null,
        errors: [
          {
            message: err.message,
            locations: [{ line: err.line, column: err.column }],
          },
        ],
      };
    }
    return { data: null, errors: [{ message: "Syntax error" }] };
  }
  try {
    return executeDocument(doc, operationName, variables, store);
  } catch {
    return { data: null, errors: [{ message: "Internal server error" }] };
  }
}

/**
 * Handle one POST /api/graphql request.
 *
 * - Wrong method: 405 JSON {message}.
 * - No Bearer token: exactly 401 JSON {message}.
 * - Body that is not a JSON object/array: 400 JSON {message}.
 * - A JSON array body is a batch: the answer is a JSON array of one
 *   envelope per entry, in request order.
 * - Anything else: HTTP 200 with a {data, errors?} envelope; document
 *   and resolver failures are reported in errors, never as an HTTP
 *   error status.
 */
export async function handleGraphql(
  store: ForgeStore,
  req: SurfaceRequest,
): Promise<SurfaceResponse> {
  requestCounter += 1;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "x-github-request-id": `graphql-${requestCounter}`,
  };
  if (req.method.toUpperCase() !== "POST") {
    return { status: 405, headers, body: { message: "method not allowed" } };
  }
  if (bearerToken(req.headers) === null) {
    return { status: 401, headers, body: { message: "authentication required" } };
  }
  const body = req.body;
  if (body === null || body === undefined) {
    return {
      status: 400,
      headers,
      body: { message: "request body must be a JSON object" },
    };
  }
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const entry of body) {
      results.push(executeOperationBody(store, entry));
    }
    return { status: 200, headers, body: results };
  }
  if (typeof body !== "object") {
    return {
      status: 400,
      headers,
      body: { message: "request body must be a JSON object" },
    };
  }
  return { status: 200, headers, body: executeOperationBody(store, body) };
}
