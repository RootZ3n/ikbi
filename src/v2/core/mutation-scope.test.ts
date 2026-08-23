/**
 * The operator mutation scope's own suite.
 *
 * Two things are being pinned, and the second matters more than the first. One: the scope
 * means what it says — a file entry is that file, a tree entry is that subtree, and an
 * operation is decided per operation. Two: NOTHING WIDENS IT. Not a clever path spelling,
 * not the goal, not the model, not an empty request quietly becoming "the repository".
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  MAX_SCOPE_ENTRIES,
  MUTATION_OPERATIONS,
  buildMutationScope,
  decideMutation,
  describeScope,
  isBeneathTree,
  isWithinTree,
  mutationScopeDigest,
  normalizeScopePath,
  reviewChangedPaths,
  summarizeMutationScope,
  type MutationScope,
} from "./mutation-scope.js";

/** Build a scope, asserting it was accepted. */
function scopeOf(request: Parameters<typeof buildMutationScope>[0]): MutationScope {
  const result = buildMutationScope(request);
  assert.equal(result.ok, true, `expected an accepted scope, got ${result.ok ? "" : result.detail}`);
  return (result as { ok: true; scope: MutationScope }).scope;
}

/** Assert a request is refused, and with which code. */
function refusal(request: Parameters<typeof buildMutationScope>[0]): { code: string; detail: string } {
  const result = buildMutationScope(request);
  assert.equal(result.ok, false, "expected a refusal");
  const failed = result as { ok: false; code: string; detail: string };
  return { code: failed.code, detail: failed.detail };
}

// ---------------------------------------------------------------------------
// Fail-closed: no scope is not "everything"
// ---------------------------------------------------------------------------

test("an ABSENT scope is refused — it never becomes repository-wide authority", () => {
  assert.equal(refusal(undefined).code, "scope_absent");
  assert.equal(refusal({}).code, "scope_absent");
  assert.equal(refusal({ allowPaths: [], allowTrees: [] }).code, "scope_absent");
  assert.equal(refusal({ repoWide: false }).code, "scope_absent");
});

test("repo-wide is an EXPLICIT act and cannot be combined with narrower entries", () => {
  const wide = scopeOf({ repoWide: true });
  assert.equal(wide.kind, "repo_wide");
  assert.deepEqual(wide.entries, []);

  assert.equal(refusal({ repoWide: true, allowPaths: ["src/a.rs"] }).code, "repo_wide_with_entries");
  assert.equal(refusal({ repoWide: true, allowTrees: ["src"] }).code, "repo_wide_with_entries");
});

// ---------------------------------------------------------------------------
// Path normalization and its refusals
// ---------------------------------------------------------------------------

test("equivalent spellings normalize to ONE canonical entry, so the scope id is an identity", () => {
  for (const spelling of ["src/lib.rs", "./src/lib.rs", "src//lib.rs", "src\\lib.rs", "  src/lib.rs  ", "./src/./lib.rs"]) {
    const normalized = normalizeScopePath(spelling);
    assert.equal(normalized.ok, true, spelling);
    assert.equal((normalized as { ok: true; path: string }).path, "src/lib.rs", spelling);
  }
  assert.equal(scopeOf({ allowPaths: ["./src/lib.rs"] }).scopeId, scopeOf({ allowPaths: ["src//lib.rs"] }).scopeId);
});

test("absolute paths are refused in every form", () => {
  for (const bad of ["/etc/passwd", "/src/lib.rs", "\\\\server\\share", "C:/Windows", "c:\\windows"]) {
    const result = normalizeScopePath(bad);
    assert.equal(result.ok, false, bad);
    assert.equal((result as { ok: false; code: string }).code, "path_absolute", bad);
  }
});

test("traversal is REFUSED, never resolved away", () => {
  for (const bad of ["../outside", "src/../../etc", "src/..", "..", "a/b/../../../c"]) {
    const result = normalizeScopePath(bad);
    assert.equal(result.ok, false, bad);
    assert.equal((result as { ok: false; code: string }).code, "path_traversal", bad);
  }
  // The dangerous alternative: silently rewriting `src/../etc` to `etc` would GRANT `etc`.
  assert.equal(refusal({ allowPaths: ["src/../etc"] }).code, "path_traversal");
});

test("empty, dot-only and NUL-bearing paths are refused", () => {
  assert.equal((normalizeScopePath("") as { ok: false; code: string }).code, "path_empty");
  assert.equal((normalizeScopePath("   ") as { ok: false; code: string }).code, "path_empty");
  assert.equal((normalizeScopePath(".") as { ok: false; code: string }).code, "path_dot_only");
  assert.equal((normalizeScopePath("./") as { ok: false; code: string }).code, "path_dot_only");
  assert.equal((normalizeScopePath("././.") as { ok: false; code: string }).code, "path_dot_only");
  assert.equal((normalizeScopePath("src\0/lib.rs") as { ok: false; code: string }).code, "path_nul");
});

test("git's own state is never in scope", () => {
  assert.equal((normalizeScopePath(".git") as { ok: false; code: string }).code, "path_git_internal");
  assert.equal((normalizeScopePath(".git/config") as { ok: false; code: string }).code, "path_git_internal");
  assert.equal((normalizeScopePath("./.git/hooks/pre-commit") as { ok: false; code: string }).code, "path_git_internal");
  // A path that merely starts with the same letters is fine.
  assert.equal(normalizeScopePath(".gitignore").ok, true);
});

test("an over-long path is refused rather than truncated", () => {
  assert.equal((normalizeScopePath("a".repeat(2_000)) as { ok: false; code: string }).code, "path_too_long");
});

// ---------------------------------------------------------------------------
// Canonical form: duplicates, conflicts, redundancy, minimality
// ---------------------------------------------------------------------------

test("a duplicate entry is refused", () => {
  assert.equal(refusal({ allowPaths: ["src/a.rs", "./src/a.rs"] }).code, "duplicate_entry");
  assert.equal(refusal({ allowTrees: ["src", "src/"] }).code, "duplicate_entry");
});

test("the same path as both a file and a tree is contradictory, not merged", () => {
  const r = refusal({ allowPaths: ["src"], allowTrees: ["src"] });
  assert.equal(r.code, "conflicting_entry");
  assert.match(r.detail, /exact file or a subtree/);
});

test("a redundant entry is refused so one authority has one canonical spelling", () => {
  assert.equal(refusal({ allowPaths: ["src/a.rs"], allowTrees: ["src"] }).code, "redundant_entry");
  assert.equal(refusal({ allowTrees: ["src", "src/inner"] }).code, "redundant_entry");
  // Siblings are not redundant.
  assert.equal(buildMutationScope({ allowTrees: ["src", "tests"] }).ok, true);
  // A near-miss prefix is a different directory, not a nested one.
  assert.equal(buildMutationScope({ allowTrees: ["src", "src-gen"] }).ok, true);
});

test("entries are sorted, so argument order cannot change the scope id", () => {
  const a = scopeOf({ allowPaths: ["z.rs", "a.rs"], allowTrees: ["m"] });
  const b = scopeOf({ allowPaths: ["a.rs", "z.rs"], allowTrees: ["m"] });
  assert.equal(a.scopeId, b.scopeId);
  assert.deepEqual(a.entries.map((e) => `${e.kind}:${e.path}`), ["file:a.rs", "tree:m", "file:z.rs"]);
});

test("a different authority is a different scope id", () => {
  const narrow = scopeOf({ allowPaths: ["src/a.rs"] });
  const wider = scopeOf({ allowTrees: ["src"] });
  const wide = scopeOf({ repoWide: true });
  assert.notEqual(narrow.scopeId, wider.scopeId);
  assert.notEqual(wider.scopeId, wide.scopeId);
  assert.notEqual(narrow.scopeId, wide.scopeId);
});

test("the entry ceiling is enforced", () => {
  const many = Array.from({ length: MAX_SCOPE_ENTRIES + 1 }, (_v, i) => `src/f${i}.rs`);
  assert.equal(refusal({ allowPaths: many }).code, "too_many_entries");
});

test("the digest is a pure function of the canonical content", () => {
  const scope = scopeOf({ allowTrees: ["src"] });
  assert.equal(scope.scopeId, mutationScopeDigest({ kind: scope.kind, entries: scope.entries }));
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

test("a FILE entry authorizes exactly that path — not a sibling, not a child", () => {
  const scope = scopeOf({ allowPaths: ["src/lib.rs"] });
  assert.equal(decideMutation(scope, { path: "src/lib.rs", operation: "modify" }).allowed, true);
  assert.equal(decideMutation(scope, { path: "src/other.rs", operation: "modify" }).allowed, false);
  assert.equal(decideMutation(scope, { path: "src/lib.rs/nested", operation: "create" }).allowed, false);
  assert.equal(decideMutation(scope, { path: "lib.rs", operation: "modify" }).allowed, false);
});

test("a TREE entry authorizes everything beneath it, at any depth", () => {
  const scope = scopeOf({ allowTrees: ["crates/core"] });
  for (const path of ["crates/core/src/lib.rs", "crates/core/Cargo.toml", "crates/core/a/b/c/d.rs"]) {
    assert.equal(decideMutation(scope, { path, operation: "modify" }).allowed, true, path);
  }
  for (const path of ["crates/other/src/lib.rs", "crates/core-extra/x.rs", "Cargo.toml"]) {
    assert.equal(decideMutation(scope, { path, operation: "modify" }).allowed, false, path);
  }
});

test("a tree entry does not authorize the directory path itself as a FILE", () => {
  const scope = scopeOf({ allowTrees: ["src"] });
  const decision = decideMutation(scope, { path: "src", operation: "delete" });
  assert.equal(decision.allowed, false, "deleting the tree root itself is not a change beneath it");
});

test("create, modify and delete are decided SEPARATELY and named in the decision", () => {
  const scope = scopeOf({ allowPaths: ["src/lib.rs"] });
  for (const operation of MUTATION_OPERATIONS) {
    const decision = decideMutation(scope, { path: "src/lib.rs", operation });
    assert.equal(decision.allowed, true);
    assert.equal(decision.operation, operation, "the decision names the operation it decided");
  }
  // And a refusal names it too, so evidence can say WHICH effect was refused.
  const denied = decideMutation(scope, { path: "src/other.rs", operation: "delete" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.operation, "delete");
});

test("an entry that grants fewer operations refuses the rest — the three are not one permission", () => {
  // The shape a future manifest intersection produces. Built directly, since the CLI grants
  // all three today; the DECISION path must already honour a narrower grant.
  const entries = [{ kind: "file" as const, path: "src/lib.rs", operations: ["modify" as const] }];
  const scope: MutationScope = { scopeId: mutationScopeDigest({ kind: "narrow", entries }), kind: "narrow", entries };

  assert.equal(decideMutation(scope, { path: "src/lib.rs", operation: "modify" }).allowed, true);
  const deleted = decideMutation(scope, { path: "src/lib.rs", operation: "delete" });
  assert.equal(deleted.allowed, false);
  assert.equal((deleted as { code: string }).code, "operation_not_authorized");
});

test("the model cannot widen a scope by how it spells a path", () => {
  const scope = scopeOf({ allowTrees: ["src"] });
  for (const attempt of ["src/../secrets.txt", "src/../../etc/passwd", "/etc/passwd", "src/./../../x"]) {
    const decision = decideMutation(scope, { path: attempt, operation: "modify" });
    assert.equal(decision.allowed, false, attempt);
    assert.equal((decision as { code: string }).code, "path_unusable", attempt);
  }
  // And the normalizing form of an in-scope path still resolves correctly.
  assert.equal(decideMutation(scope, { path: "./src/./a.rs", operation: "modify" }).allowed, true);
});

test("repo-wide allows the project but still refuses git's own state and unusable paths", () => {
  const scope = scopeOf({ repoWide: true });
  assert.equal(decideMutation(scope, { path: "anything/at/all.rs", operation: "create" }).allowed, true);
  assert.equal(decideMutation(scope, { path: ".git/config", operation: "modify" }).allowed, false);
  assert.equal(decideMutation(scope, { path: "../outside", operation: "modify" }).allowed, false);
});

test("a decision reports the entry that matched, so evidence can name the authority used", () => {
  const scope = scopeOf({ allowTrees: ["src"] });
  const decision = decideMutation(scope, { path: "src/a.rs", operation: "modify" });
  assert.equal(decision.allowed, true);
  assert.deepEqual((decision as { matched: unknown }).matched, { kind: "tree", path: "src", operations: [...MUTATION_OPERATIONS] });
  assert.equal((decideMutation(scopeOf({ repoWide: true }), { path: "x", operation: "modify" }) as { matched: unknown }).matched, "repo_wide");
});

test("neither containment relation treats a name-prefix sibling as nested", () => {
  assert.equal(isWithinTree("src/a.rs", "src"), true);
  assert.equal(isWithinTree("src", "src"), true, "inclusive: used for entry-vs-entry redundancy");
  assert.equal(isWithinTree("src-gen/a.rs", "src"), false);
  assert.equal(isWithinTree("srcx", "src"), false);

  assert.equal(isBeneathTree("src/a.rs", "src"), true);
  assert.equal(isBeneathTree("src", "src"), false, "strict: a tree grant is not a grant over its own path");
  assert.equal(isBeneathTree("src-gen/a.rs", "src"), false);
});

// ---------------------------------------------------------------------------
// Publication review
// ---------------------------------------------------------------------------

test("reviewChangedPaths finds nothing for an honest run", () => {
  const scope = scopeOf({ allowTrees: ["src"], allowPaths: ["Cargo.toml"] });
  const violations = reviewChangedPaths(scope, [
    { path: "src/lib.rs", operation: "modify" },
    { path: "src/new.rs", operation: "create" },
    { path: "Cargo.toml", operation: "modify" },
  ]);
  assert.deepEqual(violations, []);
});

test("reviewChangedPaths names every out-of-scope change and the operation that made it", () => {
  const scope = scopeOf({ allowTrees: ["src"] });
  const violations = reviewChangedPaths(scope, [
    { path: "src/lib.rs", operation: "modify" },
    { path: "README.md", operation: "modify" },
    { path: "tests/it.rs", operation: "create" },
  ]);
  assert.equal(violations.length, 2);
  assert.deepEqual(violations.map((v) => `${v.operation} ${v.path}`).sort(), ["create tests/it.rs", "modify README.md"]);
  assert.ok(violations.every((v) => v.code === "out_of_scope"));
});

test("publication review is not fooled by an unnormalized changed path", () => {
  const scope = scopeOf({ allowTrees: ["src"] });
  assert.deepEqual(reviewChangedPaths(scope, [{ path: "./src/a.rs", operation: "modify" }]), []);
  assert.equal(reviewChangedPaths(scope, [{ path: "src/../README.md", operation: "modify" }]).length, 1);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("the scope renders readably for refusals, prompts and receipts", () => {
  assert.equal(describeScope(scopeOf({ repoWide: true })), "the whole repository");
  assert.equal(describeScope(scopeOf({ allowPaths: ["Cargo.toml"], allowTrees: ["src"] })), "Cargo.toml, src/**");
});

test("the receipt view carries the id, the kind and every entry with its operations", () => {
  const scope = scopeOf({ allowPaths: ["Cargo.toml"], allowTrees: ["src"] });
  const summary = summarizeMutationScope(scope);
  assert.equal(summary.scopeId, scope.scopeId);
  assert.equal(summary.kind, "narrow");
  assert.deepEqual(summary.entries, [
    { kind: "file", path: "Cargo.toml", operations: ["create", "modify", "delete"] },
    { kind: "tree", path: "src", operations: ["create", "modify", "delete"] },
  ]);
  assert.equal(summary.description, "Cargo.toml, src/**");
});

test("a built scope is frozen — nothing downstream can widen it in place", () => {
  const scope = scopeOf({ allowTrees: ["src"] });
  assert.throws(() => {
    (scope.entries as unknown as { push: (v: unknown) => void }).push({ kind: "tree", path: "/", operations: [] });
  });
  assert.throws(() => {
    (scope as unknown as { kind: string }).kind = "repo_wide";
  });
});
