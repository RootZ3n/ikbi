import assert from "node:assert/strict";
import { test } from "node:test";

import { whatNext, renderWhatNext, whatNextFooter } from "./what-next.js";

test("every action returns at least one non-empty suggestion", () => {
  for (const action of ["init", "evaluate", "review", "agents", "mcp-auth", "doctor", "detect", "build", "spec", "job-cards", "totally-unknown"]) {
    const s = whatNext(action);
    assert.ok(s.length >= 1, `${action} has a suggestion`);
    assert.ok(s.every((line) => line.length > 0), `${action} suggestions are non-empty`);
  }
});

test("doctor branches on issue count", () => {
  assert.match(whatNext("doctor", { issues: 3 }).join("\n"), /3 ✗ item/);
  assert.match(whatNext("doctor", { issues: 0 }).join("\n"), /healthy/);
});

test("review branches on issue count", () => {
  assert.match(whatNext("review", { issues: 2 }).join("\n"), /ikbi fix/);
  assert.match(whatNext("review", { issues: 0 }).join("\n"), /clear to commit/);
});

test("agents branches on count", () => {
  assert.match(whatNext("agents", { count: 3 }).join("\n"), /3 agent/);
  assert.match(whatNext("agents", { count: 0 }).join("\n"), /No custom agents/);
});

test("evaluate names the winner when present", () => {
  assert.match(whatNext("evaluate", { winner: "claude-sonnet-4" }).join("\n"), /claude-sonnet-4/);
});

test("init points at models --recommend", () => {
  assert.match(whatNext("init").join("\n"), /models --recommend/);
});

test("mcp-auth suggests verifying status", () => {
  assert.match(whatNext("mcp-auth").join("\n"), /mcp status/);
});

test("renderWhatNext formats a Next: footer with arrows", () => {
  const out = renderWhatNext(["do a thing", "do another"]);
  assert.match(out, /Next:/);
  assert.match(out, /→ do a thing/);
  assert.match(out, /→ do another/);
});

test("renderWhatNext is empty for no suggestions", () => {
  assert.equal(renderWhatNext([]), "");
});

test("whatNextFooter composes compute + render", () => {
  assert.match(whatNextFooter("init"), /Next:/);
  assert.match(whatNextFooter("init"), /models --recommend/);
});
