import assert from "node:assert/strict";
import { test } from "node:test";

import { createJobCardsCli, renderCard } from "./job-cards.js";
import { BUILTINS, type JobCard, type JobCardRun } from "../modules/job-cards/index.js";

function card(over: Partial<JobCard> = {}): JobCard {
  return {
    id: "custom-card",
    name: "Custom Card",
    description: "does a custom thing",
    goalTemplate: "do {{thing}}",
    accessPolicy: "read-only",
    guardrails: {} as JobCard["guardrails"],
    verification: "required",
    rollback: "on-failure",
    schedule: "once",
    minTrustTier: "trusted",
    createdAt: "2026-06-23T00:00:00Z",
    updatedAt: "2026-06-23T00:00:00Z",
    ...over,
  };
}

function cli(over: Parameters<typeof createJobCardsCli>[0] = {}) {
  let out = "";
  let err = "";
  let exit: number | undefined;
  const c = createJobCardsCli({ stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, setExit: (n) => { exit = n; }, ...over });
  return { run: c.run, get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

test("list includes the built-in cards plus saved cards", () => {
  const c = cli({ listSaved: () => [card()] });
  c.run(["list"]);
  assert.match(c.out, /Job cards \(/);
  assert.match(c.out, /Custom Card/);
  if (BUILTINS.length > 0) assert.match(c.out, /built-in/);
  assert.match(c.out, /Next:/);
});

test("renderCard shows policy in plain fields", () => {
  const s = renderCard(card());
  assert.match(s, /Custom Card/);
  assert.match(s, /Access:/);
  assert.match(s, /Verification:/);
  assert.match(s, /Rollback:/);
});

test("show renders one card; unknown errors", () => {
  const c = cli({ get: (id) => (id === "custom-card" ? card() : undefined) });
  c.run(["show", "custom-card"]);
  assert.match(c.out, /Job card: Custom Card/);
  const c2 = cli({ get: () => undefined });
  c2.run(["show", "nope"]);
  assert.match(c2.err, /no card "nope"/);
  assert.equal(c2.exit, 1);
});

test("runs shows human-readable status", () => {
  const runs: JobCardRun[] = [
    { id: "run-1", cardId: "custom-card", status: "passed", startedAt: "t0", finishedAt: "t1" },
    { id: "run-2", cardId: "custom-card", status: "failed", startedAt: "t2", error: "boom" },
  ];
  const c = cli({ runs: () => runs });
  c.run(["runs", "custom-card"]);
  assert.match(c.out, /passed — completed and verified/);
  assert.match(c.out, /failed — see the error/);
  assert.match(c.out, /boom/);
});

test("runs is friendly when there is no history", () => {
  const c = cli({ runs: () => [] });
  c.run(["runs", "custom-card"]);
  assert.match(c.out, /No runs recorded/);
});
