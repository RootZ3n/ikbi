/**
 * Tests for the optional Howa truthfulness rung. No network — a fake fetch is injected,
 * and configs are constructed explicitly so the suite never reads process env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  interpretHowaResponse,
  runHowaTruthfulnessCheck,
  type FetchLike,
  type HowaCheckConfig,
} from "./howa-check.js";

function cfg(over: Partial<HowaCheckConfig> = {}): HowaCheckConfig {
  return {
    enabled: true,
    url: "http://howa.test",
    path: "/api/truthfulness",
    token: undefined,
    timeoutMs: 5_000,
    failOnError: true,
    ...over,
  };
}

function fakeFetch(status: number, body: string): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

test("interpretHowaResponse reads the common truthfulness shapes", () => {
  assert.equal(interpretHowaResponse({ lie: true }).verdict, "lie");
  assert.equal(interpretHowaResponse({ lie: false }).verdict, "truthful");
  assert.equal(interpretHowaResponse({ truthful: true }).verdict, "truthful");
  assert.equal(interpretHowaResponse({ passed: false }).verdict, "lie");
  assert.equal(interpretHowaResponse({ verdict: "deceptive" }).verdict, "lie");
  assert.equal(interpretHowaResponse({ verdict: "truthful" }).verdict, "truthful");
  assert.equal(interpretHowaResponse({ nope: 1 }).verdict, "indeterminate");
  assert.equal(interpretHowaResponse(null).verdict, "indeterminate");
});

test("disabled rung is skipped (never blocks)", async () => {
  const r = await runHowaTruthfulnessCheck({ diff: "d", intent: "i" }, cfg({ enabled: false }), fakeFetch(200, "{}"));
  assert.equal(r.status, "skipped");
  assert.equal(r.lie, false);
});

test("a detected lie fails CLOSED (RED) with lie=true", async () => {
  const r = await runHowaTruthfulnessCheck({ diff: "d", intent: "i" }, cfg(), fakeFetch(200, JSON.stringify({ lie: true, reason: "claimed validation not present" })));
  assert.equal(r.status, "red");
  assert.equal(r.lie, true);
  assert.match(r.reason, /validation/);
});

test("a truthful verdict is GREEN", async () => {
  const r = await runHowaTruthfulnessCheck({ diff: "d", intent: "i" }, cfg(), fakeFetch(200, JSON.stringify({ truthful: true })));
  assert.equal(r.status, "green");
  assert.equal(r.lie, false);
});

test("an unreachable Howa fails CLOSED when failOnError (default)", async () => {
  const boom: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
  const r = await runHowaTruthfulnessCheck({ diff: "d", intent: "i" }, cfg(), boom);
  assert.equal(r.status, "red");
  assert.equal(r.lie, false);
  assert.match(r.reason, /could not complete/);
});

test("an unreachable Howa is SKIPPED (advisory) when failOnError is false", async () => {
  const boom: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
  const r = await runHowaTruthfulnessCheck({ diff: "d", intent: "i" }, cfg({ failOnError: false }), boom);
  assert.equal(r.status, "skipped");
});

test("an egress-guard denial yields actionable allowlist guidance", async () => {
  const denied: FetchLike = async () => { throw new Error("egress blocked: host not on allowlist"); };
  const r = await runHowaTruthfulnessCheck({ diff: "d", intent: "i" }, cfg(), denied);
  assert.equal(r.status, "red");
  assert.match(r.reason, /IKBI_EGRESS_ALLOWLIST/);
});

test("an indeterminate Howa body fails closed under default policy", async () => {
  const r = await runHowaTruthfulnessCheck({ diff: "d", intent: "i" }, cfg(), fakeFetch(200, JSON.stringify({ something: "else" })));
  assert.equal(r.status, "red");
});

test("a non-2xx Howa response fails closed", async () => {
  const r = await runHowaTruthfulnessCheck({ diff: "d", intent: "i" }, cfg(), fakeFetch(500, "boom"));
  assert.equal(r.status, "red");
  assert.match(r.reason, /500/);
});
