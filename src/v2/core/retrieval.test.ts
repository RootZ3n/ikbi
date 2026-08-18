/**
 * THE RETRIEVAL AUTHORITY — ranking, determinism and the exclusion policy.
 *
 * Pure unit tests: no repository, no git, no I/O. The end-to-end proof that a task need
 * not name a filename lives in `src/v2/cli/retrieval-truth.test.ts`, through the real CLI.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  DEFAULT_RETRIEVAL_BUDGET,
  RETRIEVAL_ALGORITHM,
  REASON_WEIGHT,
  excludePath,
  importSpecifiers,
  looksBinary,
  normalizeQuery,
  queryDigest,
  contentWords,
  rankFiles,
  resolvesTo,
  retrievalDigest,
  type RetrievableFile,
} from "./retrieval.js";
import type { V2SnapshotDigest } from "./identity.js";

const SNAPSHOT = "snapshot_0000000000000000000000000000000000000000000000000000000000000000" as V2SnapshotDigest;

const file = (path: string, content: string): RetrievableFile => ({
  path,
  content,
  byteLength: Buffer.byteLength(content, "utf8"),
  contentSha256: createHash("sha256").update(content).digest("hex"),
});

const rank = (files: readonly RetrievableFile[], goal: string, budget = DEFAULT_RETRIEVAL_BUDGET) =>
  rankFiles(files, normalizeQuery(goal), budget);

// ── query normalization ─────────────────────────────────────────────────────

test("query: a path written in the goal is mined as a path token", () => {
  const q = normalizeQuery("update src/auth/login.ts to allow retries");
  assert.ok(q.pathTokens.includes("src/auth/login.ts"));
});

test("query: a bare filename is a path token too", () => {
  assert.ok(normalizeQuery("fix login.ts").pathTokens.includes("login.ts"));
});

test("query: prose is stopworded and case-folded, identifiers are split", () => {
  const q = normalizeQuery("The UserService should refresh the sessionToken");
  assert.equal(q.terms.includes("the"), false, "a stopword carries no signal");
  assert.ok(q.terms.includes("userservice"), "the identifier survives whole");
  assert.ok(q.identifierParts.includes("user") && q.identifierParts.includes("service"), "and is also split");
  assert.ok(q.identifierParts.includes("session") && q.identifierParts.includes("token"));
});

test("query: short tokens and bare numbers are dropped", () => {
  const q = normalizeQuery("do 42 ok");
  assert.deepEqual(q.terms, [], "nothing two characters long or purely numeric is a term");
});

test("query: normalization is order-stable — token lists are sorted", () => {
  const a = normalizeQuery("refresh the session token");
  const b = normalizeQuery("token session refresh");
  assert.deepEqual([...a.terms].sort(), a.terms, "already sorted");
  assert.deepEqual(a.terms, b.terms, "and word order in the goal does not change the query");
});

// ── ranking ─────────────────────────────────────────────────────────────────

test("ranking: a file the goal NAMES outranks a file that merely mentions the word", () => {
  const ranked = rank(
    [file("src/login.ts", "export const login = 1;\n"), file("src/other.ts", "// login login login login\n")],
    "fix src/login.ts",
  );
  assert.equal(ranked[0]?.path, "src/login.ts");
  assert.ok(ranked[0]!.reasons.some((r) => r.reason === "path-named-in-task"));
});

test("ranking: THE HEADLINE — a goal naming NO file still finds the relevant one", () => {
  const ranked = rank(
    [
      file("src/session-token.ts", "export function refreshSessionToken() { return 1; }\n"),
      file("src/unrelated.ts", "export const colours = ['red'];\n"),
      file("README.md", "# a project\n"),
    ],
    "make the session token refresh correctly",
  );
  assert.equal(ranked[0]?.path, "src/session-token.ts", "discovered without being named");
  assert.equal(
    ranked.some((c) => c.path === "src/unrelated.ts"),
    false,
    "and a file with nothing to do with the task is not offered",
  );
});

test("ranking: every score decomposes into named reasons — nothing is opaque", () => {
  const ranked = rank([file("src/session.ts", "session session\n")], "fix the session handling");
  const candidate = ranked[0]!;
  const expected = candidate.reasons.reduce((sum, r) => sum + REASON_WEIGHT[r.reason] * r.hits, 0);
  assert.equal(candidate.score, expected, "score is exactly the sum of its stated reasons");
});

test("ranking: content scores COVERAGE, not frequency — repetition buys nothing", () => {
  const spam = file("src/spam.ts", "session\n".repeat(500));
  const named = file("src/session.ts", "export const x = 1;\n");
  const ranked = rank([spam, named], "fix session");
  assert.equal(ranked[0]?.path, "src/session.ts", "the filename match wins over sheer repetition");
  const once = rank([file("src/spam.ts", "session\n")], "fix session")[0]!.score;
  assert.equal(rank([spam], "fix session")[0]!.score, once, "500 mentions score exactly what one mention scores");
});

test("ranking: a file is NOT paid twice for one relationship (test-of implies imports)", () => {
  const ranked = rank(
    [file("src/session.ts", "export const session = 1;\n"), file("src/session.test.ts", "import { session } from './session.js';\n")],
    "change session",
  );
  const test_ = ranked.find((c) => c.path === "src/session.test.ts")!;
  assert.equal(test_.reasons.some((r) => r.reason === "imports-ranked-file"), false, "being the test IS the relationship");
  assert.equal(test_.reasons.some((r) => r.reason === "filename-matches-term"), false, "and its name is its subject's name");
  assert.equal(ranked[0]?.path, "src/session.ts", "so the subject outranks the test that checks it");
});

test("ranking: a test the task NAMES outright is still found", () => {
  const ranked = rank(
    [file("src/session.ts", "export const session = 1;\n"), file("src/session.test.ts", "import { session } from './session.js';\n")],
    "fix src/session.test.ts",
  );
  assert.equal(ranked[0]?.path, "src/session.test.ts", "naming a file always beats inferring one");
});

test("ranking: a colocated test of a ranked file is pulled in with it", () => {
  const ranked = rank(
    [file("src/session.ts", "export const session = 1;\n"), file("src/session.test.ts", "import { session } from './session.js';\n")],
    "change session",
  );
  const test_ = ranked.find((c) => c.path === "src/session.test.ts");
  assert.ok(test_ !== undefined, "the test came along");
  assert.ok(test_.reasons.some((r) => r.reason === "test-of-ranked-file"));
});

test("ranking: a file that IMPORTS a ranked file is offered as a caller", () => {
  const ranked = rank(
    [
      file("src/session.ts", "export const session = 1;\n"),
      file("src/app.ts", "import { session } from './session.js';\nexport const app = session;\n"),
      file("src/nothing.ts", "export const nothing = 0;\n"),
    ],
    "change session",
  );
  const caller = ranked.find((c) => c.path === "src/app.ts");
  assert.ok(caller !== undefined, "the caller is relevant even though the goal never mentions it");
  assert.ok(caller.reasons.some((r) => r.reason === "imports-ranked-file"));
  assert.equal(ranked.some((c) => c.path === "src/nothing.ts"), false);
});

test("ranking: a directory whose name matches the task contributes, weakly", () => {
  const ranked = rank([file("src/session/helpers.ts", "export const h = 1;\n")], "work on session");
  assert.ok(ranked[0]!.reasons.some((r) => r.reason === "directory-matches-term"));
});

// ── determinism ─────────────────────────────────────────────────────────────

test("determinism: the SAME files and goal produce byte-identical rankings", () => {
  const files = [
    file("src/a-session.ts", "session\n"),
    file("src/b-session.ts", "session\n"),
    file("src/c-session.ts", "session\n"),
  ];
  const first = rank(files, "session work");
  const second = rank([...files].reverse(), "session work");
  assert.deepEqual(second, first, "input order must not change the outcome");
});

test("determinism: ties break by PATH, never by traversal order", () => {
  // Three files with identical evidence: the only stable answer is alphabetical.
  const ranked = rank(
    [file("src/zebra.ts", "session\n"), file("src/alpha.ts", "session\n"), file("src/middle.ts", "session\n")],
    "session",
  );
  assert.deepEqual(
    ranked.map((c) => c.path),
    ["src/alpha.ts", "src/middle.ts", "src/zebra.ts"],
  );
  assert.deepEqual([...new Set(ranked.map((c) => c.score))].length === 1, true, "and they really were tied");
});

test("determinism: ranks are 1..n, dense and in order", () => {
  const ranked = rank([file("src/session.ts", "session\n"), file("src/session-two.ts", "session\n")], "session");
  assert.deepEqual(ranked.map((c) => c.rank), [1, 2]);
});

test("determinism: the retrieval identity is stable across equal inputs", () => {
  const files = [file("src/session.ts", "session\n")];
  const query = normalizeQuery("session");
  const of = (input: readonly RetrievableFile[]) =>
    retrievalDigest({
      sourceSnapshotId: SNAPSHOT,
      algorithm: RETRIEVAL_ALGORITHM,
      query,
      budget: DEFAULT_RETRIEVAL_BUDGET,
      candidates: rankFiles(input, query, DEFAULT_RETRIEVAL_BUDGET),
    });
  assert.equal(of(files), of([...files]));
});

test("determinism: a DIFFERENT source snapshot yields a different retrieval identity", () => {
  const query = normalizeQuery("session");
  const candidates = rankFiles([file("src/session.ts", "session\n")], query, DEFAULT_RETRIEVAL_BUDGET);
  const a = retrievalDigest({ sourceSnapshotId: SNAPSHOT, algorithm: RETRIEVAL_ALGORITHM, query, budget: DEFAULT_RETRIEVAL_BUDGET, candidates });
  const b = retrievalDigest({
    sourceSnapshotId: ("snapshot_" + "1".repeat(64)) as V2SnapshotDigest,
    algorithm: RETRIEVAL_ALGORITHM,
    query,
    budget: DEFAULT_RETRIEVAL_BUDGET,
    candidates,
  });
  assert.notEqual(a, b, "retrieval is bound to the source state it searched");
});

test("determinism: equal queries share a query digest, different ones do not", () => {
  assert.equal(queryDigest(normalizeQuery("fix the session")), queryDigest(normalizeQuery("session fix")));
  assert.notEqual(queryDigest(normalizeQuery("fix the session")), queryDigest(normalizeQuery("fix the login")));
});

// ── budget ──────────────────────────────────────────────────────────────────

test("budget: no more than maxCandidates are ever offered", () => {
  const files = Array.from({ length: 40 }, (_, i) => file(`src/session-${String(i).padStart(2, "0")}.ts`, "session\n"));
  const ranked = rank(files, "session", { ...DEFAULT_RETRIEVAL_BUDGET, maxCandidates: 5 });
  assert.equal(ranked.length, 5);
});

test("budget: a file below minScore is not offered at all", () => {
  const ranked = rank([file("src/thing.ts", "nothing relevant here\n")], "session token refresh", {
    ...DEFAULT_RETRIEVAL_BUDGET,
    minScore: 1000,
  });
  assert.deepEqual(ranked, [], "a weak match is worse than no match");
});

// ── exclusion policy ────────────────────────────────────────────────────────

test("exclusions: lockfiles, vendored trees and non-source files are not evidence", () => {
  const b = DEFAULT_RETRIEVAL_BUDGET;
  assert.equal(excludePath("pnpm-lock.yaml", 10, b), "lockfile");
  assert.equal(excludePath("node_modules/x/index.js", 10, b), "vendored");
  assert.equal(excludePath("vendor/lib/thing.rb", 10, b), "vendored");
  assert.equal(excludePath("assets/logo.png", 10, b), "not_source_text");
  assert.equal(excludePath("Makefile", 10, b), "not_source_text", "an extensionless file is not read speculatively");
  assert.equal(excludePath("src/app.ts", 10, b), undefined);
});

test("exclusions: a file above the byte ceiling is not scored", () => {
  assert.equal(excludePath("src/huge.ts", 999_999_999, DEFAULT_RETRIEVAL_BUDGET), "too_large");
});

test("exclusions: a NUL byte means binary, whatever the extension claims", () => {
  assert.equal(looksBinary("hello\0world"), true);
  assert.equal(looksBinary("hello world"), false);
});

// ── import edges ────────────────────────────────────────────────────────────

test("imports: ESM, CJS and side-effect imports are all seen", () => {
  const specs = importSpecifiers(`import { a } from "./a.js";\nconst b = require("./b.js");\nimport "./c.js";\n`);
  assert.deepEqual(specs.sort(), ["./a.js", "./b.js", "./c.js"]);
});

test("imports: only RELATIVE specifiers resolve — a package name is not a repository file", () => {
  assert.equal(resolvesTo("src/app.ts", "./session.js", "src/session.ts"), true);
  assert.equal(resolvesTo("src/a/app.ts", "../b/thing.js", "src/b/thing.ts"), true);
  assert.equal(resolvesTo("src/app.ts", "./dir/index.js", "src/dir/index.ts"), true);
  assert.equal(resolvesTo("src/app.ts", "node:fs", "fs.ts"), false);
  assert.equal(resolvesTo("src/app.ts", "pino", "src/pino.ts"), false);
});

// ── whole-word matching ─────────────────────────────────────────────────────

test("matching: a term matches WHOLE WORDS, not substrings", () => {
  // "thing" must not match "nothing", and "art" must not match "start".
  const ranked = rank([file("src/other.ts", "export const x = 'MARKER-nothing-should-read-this';\n")], "do the thing");
  assert.deepEqual(ranked, [], "a substring coincidence is not evidence");
});

test("matching: an identifier's camelCase parts still count as words", () => {
  const words = contentWords("export function refreshSessionToken() {}");
  assert.ok(words.has("refreshsessiontoken"), "the whole identifier");
  assert.ok(words.has("session") && words.has("token") && words.has("refresh"), "and its parts");
  assert.equal(words.has("nothing"), false);
});

test("matching: snake_case parts count too", () => {
  const words = contentWords("const session_token = 1;");
  assert.ok(words.has("session") && words.has("token"));
});

test("query: naming a path does NOT mine its directories as free-floating terms", () => {
  const q = normalizeQuery("make src/widget.ts do the thing");
  assert.equal(q.terms.includes("src"), false, "otherwise every sibling under src/ scores");
  assert.ok(q.terms.includes("widget"), "but the basename stem is kept, so a near-miss path still finds the file");
  assert.deepEqual(q.pathTokens, ["src/widget.ts"]);
});

test("query: a named-but-missing path still finds the file it meant", () => {
  const ranked = rank([file("src/auth/login-handler.ts", "export const handler = 1;\n")], "fix src/login.ts");
  assert.equal(ranked[0]?.path, "src/auth/login-handler.ts", "the basename stem carries the intent");
});

test("ranking: in a module/index.ts layout the DIRECTORY is the file's name", () => {
  const ranked = rank(
    [
      file("src/modules/gate-wall/index.ts", "export const check = 1;\n"),
      file("src/notes.md", "the gate wall is described here, gate wall gate wall\n"),
    ],
    "the gate wall keeps refusing things",
  );
  assert.equal(ranked[0]?.path, "src/modules/gate-wall/index.ts", "the module itself, not a file that mentions it");
  assert.ok(ranked[0]!.reasons.some((r) => r.reason === "filename-matches-term"));
});
