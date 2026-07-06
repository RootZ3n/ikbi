import assert from "node:assert/strict";
import { test } from "node:test";

import { parseScopePlan, MAX_SCOPE_STAGES } from "./index.js";

test("numbered list: each item is an ordered stage; the H1 title is ignored", () => {
  const md = [
    "# Bokahli build scope",
    "",
    "1. Core contracts and types",
    "2. Storage domain",
    "3. CPU domain",
  ].join("\n");
  const plan = parseScopePlan(md);
  assert.equal(plan.source, "scope");
  assert.equal(plan.stages.length, 3);
  assert.deepEqual(plan.stages.map((s) => s.index), [1, 2, 3]);
  assert.equal(plan.stages[0]?.title, "Core contracts and types");
  assert.equal(plan.stages[2]?.goal, "CPU domain");
  assert.ok(plan.stages.every((s) => s.verify === false), "no stage opts into verify by default");
});

test("bullets and H2/H3 headings are also stage boundaries", () => {
  assert.equal(parseScopePlan("- alpha\n- beta\n* gamma").stages.length, 3);
  assert.equal(parseScopePlan("## Stage one\n### Stage two").stages.length, 2);
});

test("body prose after a marker is folded into the stage goal", () => {
  const md = [
    "1. Core contracts",
    "   Define the Domain interface and the Finding shape.",
    "   Keep it dependency-free.",
    "2. Storage domain",
  ].join("\n");
  const plan = parseScopePlan(md);
  assert.equal(plan.stages.length, 2);
  assert.equal(plan.stages[0]?.title, "Core contracts", "the title stays the marker line");
  assert.equal(plan.stages[0]?.goal, "Core contracts — Define the Domain interface and the Finding shape. Keep it dependency-free.");
});

test("(verify) marker opts a stage into intermediate verification and is stripped from the title", () => {
  const md = "1. Core contracts (verify)\n2. Storage domain\n3. Final wiring [verify]";
  const plan = parseScopePlan(md);
  assert.equal(plan.stages[0]?.verify, true);
  assert.equal(plan.stages[0]?.title, "Core contracts", "the marker is removed from the title");
  assert.equal(plan.stages[1]?.verify, false);
  assert.equal(plan.stages[2]?.verify, true, "[verify] bracket form also works");
});

test("a files: directive becomes targetFiles and does NOT leak into the goal prose", () => {
  const md = ["1. Storage domain", "   files: src/storage.ts, src/storage.test.ts", "   Implement the SMART reader."].join("\n");
  const plan = parseScopePlan(md);
  assert.deepEqual(plan.stages[0]?.targetFiles, ["src/storage.ts", "src/storage.test.ts"]);
  assert.equal(plan.stages[0]?.goal, "Storage domain — Implement the SMART reader.", "the files directive is not prose");
});

test("empty / prose-only file yields zero stages (caller falls back — never throws, never fabricates)", () => {
  assert.equal(parseScopePlan("").stages.length, 0);
  assert.equal(parseScopePlan("Just a paragraph of description with no list markers at all.").stages.length, 0);
  assert.equal(parseScopePlan("# Title only\n\nSome preamble.").stages.length, 0);
});

test("the stage count is capped at MAX_SCOPE_STAGES (runaway-file backstop)", () => {
  const md = Array.from({ length: MAX_SCOPE_STAGES + 15 }, (_, i) => `${i + 1}. stage ${i + 1}`).join("\n");
  const plan = parseScopePlan(md);
  assert.equal(plan.stages.length, MAX_SCOPE_STAGES);
});

test("preamble before the first marker is ignored; markers after it still parse", () => {
  const md = ["Some intro prose that is not a stage.", "", "1. First real stage", "2. Second real stage"].join("\n");
  const plan = parseScopePlan(md);
  assert.equal(plan.stages.length, 2);
  assert.equal(plan.stages[0]?.title, "First real stage");
});

test("CRLF line endings parse identically to LF", () => {
  const plan = parseScopePlan("1. alpha\r\n2. beta\r\n");
  assert.equal(plan.stages.length, 2);
  assert.equal(plan.stages[1]?.title, "beta");
});
