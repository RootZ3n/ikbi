/**
 * CLI lock RESILIENCE (Codex blocker 2) — read-only/status commands must degrade cleanly around
 * stale and LIVE cross-process locks under the state dir, never crash with a raw lock-acquisition
 * error or a stack trace. These run the REAL built CLI against an ISOLATED HOME (a fresh temp state
 * root per case — never the user's `~/.ikbi/state`) with a lock pre-planted on the workspace-registry
 * document the command reads.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const ENTRY = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const WS_ID = "no-such-workspace-id";
const noStack = (s: string): boolean => !/\n\s+at\s+\S/.test(s);

/** The cross-process lock file the `diff <WS_ID>` read acquires under an isolated HOME's state root. */
function registryLockPath(home: string): string {
  const reg = join(home, ".ikbi", "state", "workspaces", "registry");
  mkdirSync(reg, { recursive: true });
  return join(reg, `${WS_ID}.json.lock`);
}

function runDiff(home: string): { status: number | null; combined: string } {
  const res = spawnSync(process.execPath, [ENTRY, "diff", WS_ID], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-lockres-")),
    env: { PATH: process.env.PATH ?? "", HOME: home },
    encoding: "utf8",
  });
  return { status: res.status, combined: `${res.stdout}\n${res.stderr}` };
}

test("read-only `diff`: a STALE lock is recovered and the command completes cleanly", () => {
  const home = mkdtempSync(join(tmpdir(), "ikbi-stale-home-"));
  const lock = registryLockPath(home);
  // An empty/corrupt lock file, aged well past the default stale window (30s) → the lock layer
  // recovers it. The read then proceeds normally to the graceful "no workspace" result.
  writeFileSync(lock, "");
  const old = Date.now() / 1000 - 600;
  utimesSync(lock, old, old);

  const r = runDiff(home);
  assert.match(r.combined, new RegExp(`no workspace "${WS_ID}" found`), "completed with the graceful fail-closed message");
  assert.doesNotMatch(r.combined, /timed out acquiring/, "no raw lock-acquisition error");
  assert.ok(noStack(r.combined), "no stack trace");
});

test("read-only `diff`: a LIVE lock degrades to a clean result, never a raw lock crash", () => {
  const home = mkdtempSync(join(tmpdir(), "ikbi-live-home-"));
  const lock = registryLockPath(home);
  // A LIVE, same-host holder (this test process) — the lock layer must NOT steal it. The read-only
  // path tolerates the live lock by falling back to a lockless (atomic-safe) read instead of hanging
  // for the full timeout and then surfacing a raw lock-acquisition error.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: Date.now(), nonce: "live-holder" }));

  const r = runDiff(home);
  assert.match(r.combined, new RegExp(`no workspace "${WS_ID}" found`), "degraded to the graceful fail-closed result");
  // The USER-FACING error path (a raw lock crash) must NOT appear — degradation, not failure. A
  // structured operational warn log is fine; the `ikbi diff:` error line is what a crash would print.
  assert.doesNotMatch(r.combined, /ikbi diff: could not read workspace/, "no raw lock-acquisition error surfaced to the user");
  assert.doesNotMatch(r.combined, /Refusing to start/, "no fatal config throw");
  assert.ok(noStack(r.combined), "no stack trace under a live lock");
  // The live lock was NOT stolen (we still hold it) — the file is intact.
  assert.ok(existsSync(lock), "a live lock is never victimized");
});

test("read-only `receipts`: runs cleanly under an isolated state root (no dependence on ~/.ikbi)", () => {
  const home = mkdtempSync(join(tmpdir(), "ikbi-rec-home-"));
  const res = spawnSync(process.execPath, [ENTRY, "receipts"], {
    cwd: mkdtempSync(join(tmpdir(), "ikbi-lockres-")),
    env: { PATH: process.env.PATH ?? "", HOME: home },
    encoding: "utf8",
  });
  const combined = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, `receipts exited ${res.status}\n${combined}`);
  assert.ok(noStack(combined), "no stack trace");
});
