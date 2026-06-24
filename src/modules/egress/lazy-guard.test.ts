/**
 * RC8 — the process-wide `guardedFetch` resolves its underlying guard LAZILY (on first use), not at
 * construction/import. Proves: (1) the guard is not built until first call, (2) it is built exactly
 * once (memoized), (3) a policy/config change applied AFTER import but BEFORE first use is honored,
 * and (4) the real default builder still fails closed (default-deny) on a non-allowlisted host.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { FetchLike } from "../../core/provider/providers/openai-compatible.js";
import { ProviderError } from "../../core/provider/contract.js";
import {
  guardedFetch,
  isGuardResolved,
  resetGuardedFetch,
  setGuardBuilder,
  restoreGuardBuilder,
} from "./guard.js";

/** A full FetchLike init (the second arg is required by the type). */
const INIT = { method: "GET", headers: {}, body: "", signal: new AbortController().signal } as const;

/** A structural OK response, optionally carrying a body string via text(). */
function okResponse(text = "ok") {
  return { ok: true, status: 200, json: async () => ({}), text: async () => text };
}

afterEach(() => {
  restoreGuardBuilder(); // restore the production builder + drop any memoized guard
});

test("RC8: the guard is NOT built until the first call", async () => {
  resetGuardedFetch();
  let builds = 0;
  setGuardBuilder((): FetchLike => { builds += 1; return async () => okResponse(); });
  // Merely registering the builder must not resolve it.
  assert.equal(builds, 0);
  assert.equal(isGuardResolved(), false);

  await guardedFetch("http://anything/", INIT);
  assert.equal(builds, 1, "built exactly once, on first use");
  assert.equal(isGuardResolved(), true);

  await guardedFetch("http://anything-else/", INIT);
  assert.equal(builds, 1, "memoized — not rebuilt on subsequent calls");
});

test("RC8: a policy change before first use is honored (resolution is deferred)", async () => {
  resetGuardedFetch();
  // The builder snapshots `policy` when it RUNS. If resolution were eager (at import/registration)
  // it would capture "import-time"; because it is lazy, it captures the value at FIRST USE.
  let policy = "import-time";
  setGuardBuilder((): FetchLike => {
    const snapshot = policy;
    return async () => okResponse(snapshot);
  });
  policy = "runtime-updated"; // changed AFTER the builder was registered, BEFORE the first request

  const res = await guardedFetch("http://x/", INIT);
  assert.equal(await res.text(), "runtime-updated");
});

test("RC8: the real default builder still fails closed on a non-allowlisted host", async () => {
  // No setGuardBuilder — exercise the PRODUCTION builder. The default allowlist does not include
  // this host, so the first (lazy) call builds the default-deny guard and blocks before any network.
  resetGuardedFetch();
  assert.equal(isGuardResolved(), false);
  await assert.rejects(
    () => guardedFetch("http://blocked.invalid.example/", INIT),
    (e: unknown) => e instanceof ProviderError && /egress blocked/.test(e.message),
  );
  assert.equal(isGuardResolved(), true, "the guard resolved on first use");
});
