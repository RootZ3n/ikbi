/**
 * Test helper — the `ikbi v2 build` CLI now emits a BUILD SESSION (V2-012), not a bare run
 * result. A session composes one OR MORE attempts; the great majority of the CLI truth suites
 * assert on a SINGLE attempt's internals, so this helper parses the session JSON and returns the
 * FINAL attempt's `V2RunResult` — which for an ordinary one-attempt build is the only attempt.
 *
 * Suites that assert on session/recovery structure parse `parseSession` directly.
 */

import type { V2RunResult } from "../core/result.js";
import type { V2BuildSessionResult } from "../core/session.js";

export function parseSession(json: string): V2BuildSessionResult {
  return JSON.parse(json) as V2BuildSessionResult;
}

/** The final attempt's run result — the authoritative outcome of the session. */
export function sessionFinalAttempt(json: string): V2RunResult {
  const session = parseSession(json);
  const final = session.attempts[session.attempts.length - 1];
  if (final === undefined) throw new Error("session JSON carried no attempts");
  return final;
}
