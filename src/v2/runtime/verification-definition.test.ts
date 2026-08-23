/**
 * VERIFICATION-DEFINITION BINDING — the deterministic half (V2-019/HIGH-03).
 *
 * `verification-definition-truth.test.ts` proves the end-to-end verdict through the real CLI.
 * THIS suite pins the MECHANISM without a subprocess: which repo-local paths a resolved check
 * binds, which it deliberately does not, and what a comparison against a modified candidate says.
 *
 * The policy is conservative and EXPLICIT — every case below is a decision, not an accident.
 */

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { labTempDir as tmpdir } from "../../core/temp-root.js";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { bindVerificationDefinitionScope, definitionChanged } from "../core/verification.js";
import { createVerificationDefinitionProbe } from "./verification-checks.js";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "ikbi-defscope-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

const bind = (line: string, scripts: Readonly<Record<string, string>> = {}) => {
  const [command, ...args] = line.split(" ");
  return bindVerificationDefinitionScope({ checks: [{ command: command!, args }], scripts });
};

// ── WHAT IS BOUND ────────────────────────────────────────────────────────────

test("bind: an interpreter's repo-local program is the exam definition", () => {
  assert.deepEqual(bind("node test-policy.js").referencedPaths, ["test-policy.js"]);
  assert.deepEqual(bind("python3 scripts/check.py").referencedPaths, ["scripts/check.py"]);
  assert.deepEqual(bind("bash scripts/test.sh").referencedPaths, ["scripts/test.sh"]);
  assert.deepEqual(bind("./scripts/verify").referencedPaths, ["scripts/verify"]);
});

test("bind: PACKAGE-MANAGER INDIRECTION resolves `pnpm test` through the manifest to the file", () => {
  // THE PROMPT'S CANONICAL CASE: package.json says `"test": "node test-policy.js"`, the resolved
  // exam is `pnpm test`, and the thing that actually decides pass/fail is `test-policy.js`.
  const scope = bind("pnpm test", { test: "node test-policy.js" });
  assert.deepEqual(scope.referencedPaths, ["test-policy.js"]);
  assert.deepEqual(scope.unresolved, []);
  assert.deepEqual(bind("npm run test", { test: "node test-policy.js" }).referencedPaths, ["test-policy.js"]);
});

test("bind: a COMPOUND script binds every directly referenced repo-local program", () => {
  const scope = bind("pnpm verify", { verify: "node a.js && node build/b.js" });
  assert.deepEqual(scope.referencedPaths, ["a.js", "build/b.js"]);
  assert.deepEqual(scope.unresolved, []);
});

test("bind: nested manifest scripts are followed, with a cycle guard", () => {
  assert.deepEqual(bind("pnpm ci", { ci: "npm run lint && npm run unit", lint: "node lint.js", unit: "node unit.js" }).referencedPaths, ["lint.js", "unit.js"]);
  // A self-referential script terminates instead of recursing forever.
  assert.deepEqual(bind("pnpm loop", { loop: "pnpm loop" }).referencedPaths, []);
});

// ── WHAT IS DELIBERATELY NOT BOUND ───────────────────────────────────────────

test("bind: an INLINE program is already in the (fingerprinted) manifest — nothing else to bind", () => {
  const scope = bind("pnpm test", { test: 'node -e "process.exit(0)"' });
  assert.deepEqual(scope.referencedPaths, []);
  assert.deepEqual(scope.unresolved, [], "an inline program is fully determined, NOT ambiguous");
});

test("bind: SYSTEM binaries and absolute paths are not repository definition", () => {
  assert.deepEqual(bind("grep -q widget src/widget.ts").referencedPaths, []);
  assert.deepEqual(bind("cargo test").referencedPaths, []);
  assert.deepEqual(bind("node /usr/local/lib/harness.js").referencedPaths, []);
  assert.deepEqual(bind("node ../outside/escape.js").referencedPaths, [], "no `..` escape is ever bound");
});

test("bind: a GLOB target is check SUBJECT (the product's own tests), not definition", () => {
  // Binding these would forbid the very work a task normally asks for.
  const scope = bind('node --test test/*.test.js');
  assert.deepEqual(scope.referencedPaths, []);
  assert.deepEqual(scope.unresolved, [], "a glob is a decision, not an ambiguity");
});

// ── WHAT IS REFUSED (FAIL CLOSED) ────────────────────────────────────────────

test("bind: SUBSTITUTION / EXPANSION cannot be resolved, so the scope is reported INCOMPLETE", () => {
  for (const body of ["node $(cat which-test.txt)", "node $TEST_ENTRY", "sh -c `echo x`"]) {
    const scope = bind("pnpm test", { test: body });
    assert.equal(scope.unresolved.length, 1, `${body} must be reported unresolved`);
    assert.deepEqual(scope.referencedPaths, [], "nothing is guessed from a command we cannot read");
  }
});

// ── THE PROBE + COMPARISON ───────────────────────────────────────────────────

test("HIGH-03: the SOURCE binds the referenced script; a candidate that rewrites it is CHANGED", () => {
  const source = repo({
    "package.json": JSON.stringify({ name: "fx", scripts: { test: "node test-policy.js" } }),
    "test-policy.js": "process.exit(1);\n",
  });
  const candidate = repo({
    // The manifest is byte-identical. ONLY the referenced verifier changed.
    "package.json": JSON.stringify({ name: "fx", scripts: { test: "node test-policy.js" } }),
    "test-policy.js": "process.exit(0);\n",
  });
  const probe = createVerificationDefinitionProbe({ IKBI_CHECKS: '[{"name":"test","command":"pnpm","args":["test"]}]' } as NodeJS.ProcessEnv);

  return (async () => {
    const src = await probe.capture(source);
    assert.deepEqual(Object.keys(src.referencedPaths ?? {}), ["test-policy.js"], "the source bound its verifier");
    assert.equal(src.files["package.json"] !== null, true);

    const cand = await probe.capture(candidate, Object.keys(src.referencedPaths ?? {}));
    assert.equal(src.files["package.json"], cand.files["package.json"], "the MANIFEST fingerprint is identical — the old guard saw nothing");
    const changed = definitionChanged(src, cand);
    assert.deepEqual(changed, ["test-policy.js"], "the referenced band catches what the manifest band cannot");
  })();
});

test("HIGH-03: a candidate that CREATES a bound path that did not exist is also CHANGED", async () => {
  const source = repo({ "package.json": JSON.stringify({ name: "fx", scripts: { test: "node missing.js" } }) });
  const candidate = repo({ "package.json": JSON.stringify({ name: "fx", scripts: { test: "node missing.js" } }), "missing.js": "process.exit(0);\n" });
  const probe = createVerificationDefinitionProbe({ IKBI_CHECKS: '[{"name":"test","command":"pnpm","args":["test"]}]' } as NodeJS.ProcessEnv);

  const src = await probe.capture(source);
  assert.equal(src.referencedPaths?.["missing.js"], null, "absent in source is recorded as null, not omitted");
  const cand = await probe.capture(candidate, Object.keys(src.referencedPaths ?? {}));
  assert.deepEqual(definitionChanged(src, cand), ["missing.js"], "null → hash is a change");
});

test("HIGH-03: an UNCHANGED definition compares clean — binding does not break ordinary runs", async () => {
  const files = { "package.json": JSON.stringify({ name: "fx", scripts: { test: "node test-policy.js" } }), "test-policy.js": "process.exit(0);\n" };
  const probe = createVerificationDefinitionProbe({ IKBI_CHECKS: '[{"name":"test","command":"pnpm","args":["test"]}]' } as NodeJS.ProcessEnv);
  const src = await probe.capture(repo(files));
  // A candidate that changed only PRODUCT source: the definition band is byte-identical.
  const cand = await probe.capture(repo({ ...files, "src/widget.ts": "export const widget = 2;\n" }), Object.keys(src.referencedPaths ?? {}));
  assert.deepEqual(definitionChanged(src, cand), [], "product changes are the SUBJECT, and are not policy changes");
});

test("HIGH-03: the SOURCE's bound set is authority — a candidate cannot shrink its own exam", async () => {
  const src = { files: {}, referencedPaths: { "test-policy.js": "abc" } } as const;
  // A candidate capture that simply omits the path (or reports it absent) is still a CHANGE.
  assert.deepEqual(definitionChanged(src, { files: {}, referencedPaths: {} }), ["test-policy.js"]);
  assert.deepEqual(definitionChanged(src, { files: {} }), ["test-policy.js"]);
  // And extra paths the CANDIDATE invents are ignored — it does not get to define the comparison.
  assert.deepEqual(definitionChanged(src, { files: {}, referencedPaths: { "test-policy.js": "abc", "invented.js": "zzz" } }), []);
});

// ── THE STATIC GUARD ─────────────────────────────────────────────────────────

test("HIGH-03 guard: the definition probe binds referenced paths, not just a filename list", async () => {
  const probe = createVerificationDefinitionProbe({ IKBI_CHECKS: '[{"name":"c","command":"node","args":["scripts/check.js"]}]' } as NodeJS.ProcessEnv);
  const captured = await probe.capture(repo({ "package.json": "{}", "scripts/check.js": "process.exit(0);\n" }));
  assert.ok(captured.referencedPaths !== undefined, "VerificationDefinition must carry the referenced band");
  assert.ok(Object.keys(captured.referencedPaths).includes("scripts/check.js"), "an operator check's referenced script is bound by default");
});
