/**
 * Tests for the gbrain bridge. The exec primitive is mocked (no real `gbrain` CLI, no real
 * brain) so every test is deterministic and asserts on the EXACT args/env/timeout the bridge
 * hands to execFileSync, plus the parsing/normalization and the typed-error contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createGbrainBridge, GbrainError, DEFAULT_TIMEOUT_MS, type ExecFileSyncFn } from "./gbrain-bridge.js";

/** A recorded exec call. */
interface Call {
  file: string;
  args: readonly string[];
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; input?: string };
}

/** Build a mock exec that records calls and returns canned stdout (string or per-command fn). */
function mockExec(returns: string | ((args: readonly string[]) => string)): { fn: ExecFileSyncFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: ExecFileSyncFn = (file, args, options) => {
    calls.push({ file, args, options });
    return typeof returns === "function" ? returns(args) : returns;
  };
  return { fn, calls };
}

/** Build a mock exec that throws an error shaped like a child_process failure. */
function throwingExec(err: object): ExecFileSyncFn {
  return () => {
    throw err;
  };
}

const HOME = "/home/tester";

test("searchBrain: passes query + --json and parses an array payload", () => {
  const { fn, calls } = mockExec(JSON.stringify([{ slug: "a", title: "Alpha", score: 0.9 }]));
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });

  const res = brain.searchBrain("how does promote work");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, "gbrain");
  assert.deepEqual(calls[0]!.args, ["search", "how does promote work", "--json"]);
  assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0]!.title, "Alpha");
});

test("searchBrain: honors a limit and normalizes a {results:[]} payload", () => {
  const { fn, calls } = mockExec(JSON.stringify({ results: [{ slug: "x" }, { slug: "y" }] }));
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });

  const res = brain.searchBrain("q", { limit: 3 });

  assert.deepEqual(calls[0]!.args, ["search", "q", "--json", "--limit", "3"]);
  assert.equal(res.hits.length, 2);
});

test("searchBrain: non-JSON stdout yields zero hits but preserves raw", () => {
  const { fn } = mockExec("not json at all");
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });

  const res = brain.searchBrain("q");

  assert.equal(res.hits.length, 0);
  assert.equal(res.raw, "not json at all");
});

test("searchBrain: empty query throws GbrainError without spawning", () => {
  const { fn, calls } = mockExec("[]");
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });

  assert.throws(() => brain.searchBrain("  "), (e: unknown) => e instanceof GbrainError && e.command === "search");
  assert.equal(calls.length, 0, "must not invoke the CLI for an invalid query");
});

test("thinkBrain: extracts the answer field from JSON", () => {
  const { fn, calls } = mockExec(JSON.stringify({ answer: "Because of X.", citations: ["a"] }));
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });

  const res = brain.thinkBrain("why X?");

  assert.deepEqual(calls[0]!.args, ["think", "why X?", "--json"]);
  assert.equal(res.answer, "Because of X.");
  assert.ok(res.json !== undefined);
});

test("thinkBrain: falls back to raw text when stdout is not JSON", () => {
  const { fn } = mockExec("plain synthesized answer");
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });

  assert.equal(brain.thinkBrain("q").answer, "plain synthesized answer");
});

test("putPage: pipes content via stdin and passes the slug", () => {
  const { fn, calls } = mockExec("ok: wrote page");
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });

  const out = brain.putPage("notes/build", "# Build\n\nbody\n");

  assert.deepEqual(calls[0]!.args, ["put", "notes/build"]);
  assert.equal(calls[0]!.options.input, "# Build\n\nbody\n");
  assert.equal(out, "ok: wrote page");
});

test("putPage: empty slug throws GbrainError", () => {
  const { fn } = mockExec("ok");
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });
  assert.throws(() => brain.putPage("", "x"), GbrainError);
});

test("syncProject: runs import then embed --stale", () => {
  const { fn, calls } = mockExec((args) => (args[0] === "import" ? "imported 10" : "embedded 3"));
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });

  const res = brain.syncProject("/pehverse/repos/ecosystem/ikbi");

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.args, ["import", "/pehverse/repos/ecosystem/ikbi"]);
  assert.deepEqual(calls[1]!.args, ["embed", "--stale"]);
  assert.equal(res.imported, "imported 10");
  assert.equal(res.embedded, "embedded 3");
});

test("every call is bounded by the 30s timeout and augments PATH with ~/.bun/bin", () => {
  const { fn, calls } = mockExec("[]");
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });

  brain.searchBrain("q");

  assert.equal(calls[0]!.options.timeout, DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
  const path = String(calls[0]!.options.env.PATH ?? "");
  assert.ok(path.startsWith("/home/tester/.bun/bin"), `PATH should lead with ~/.bun/bin, got: ${path}`);
});

test("a custom timeout override is propagated", () => {
  const { fn, calls } = mockExec("[]");
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME, timeoutMs: 5_000 });
  brain.searchBrain("q");
  assert.equal(calls[0]!.options.timeout, 5_000);
});

test("ENOENT (binary missing) maps to a clear GbrainError", () => {
  const brain = createGbrainBridge({ execFileSync: throwingExec({ code: "ENOENT" }), homeDir: HOME });
  assert.throws(
    () => brain.searchBrain("q"),
    (e: unknown) => e instanceof GbrainError && /not found/i.test(e.message) && e.command === "search",
  );
});

test("a SIGTERM (timeout) maps to a timeout GbrainError", () => {
  const brain = createGbrainBridge({ execFileSync: throwingExec({ signal: "SIGTERM" }), homeDir: HOME, timeoutMs: 30_000 });
  assert.throws(
    () => brain.thinkBrain("q"),
    (e: unknown) => e instanceof GbrainError && /timed out/.test(e.message),
  );
});

test("a non-zero exit preserves the exit code and stderr", () => {
  const brain = createGbrainBridge({ execFileSync: throwingExec({ status: 2, stderr: "boom: bad slug" }), homeDir: HOME });
  assert.throws(
    () => brain.putPage("slug", "x"),
    (e: unknown) => e instanceof GbrainError && e.exitCode === 2 && e.stderr === "boom: bad slug" && /boom: bad slug/.test(e.message),
  );
});

test("projectContext: best-effort — returns undefined instead of throwing when the brain fails", () => {
  const brain = createGbrainBridge({ execFileSync: throwingExec({ signal: "SIGTERM" }), homeDir: HOME });
  assert.equal(brain.projectContext("goal text"), undefined);
});

test("projectContext: formats hits into a bounded bullet block", () => {
  const { fn } = mockExec(JSON.stringify([
    { title: "Promote flow", snippet: "promote propagates requestId" },
    { slug: "receipts", content: "receipt store keeps   failures" },
  ]));
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });

  const block = brain.projectContext("promote", { limit: 5 });

  assert.ok(block !== undefined);
  assert.match(block!, /- Promote flow: promote propagates requestId/);
  assert.match(block!, /- receipts: receipt store keeps failures/);
});

test("projectContext: undefined when there are no hits", () => {
  const { fn } = mockExec("[]");
  const brain = createGbrainBridge({ execFileSync: fn, homeDir: HOME });
  assert.equal(brain.projectContext("nothing"), undefined);
});
