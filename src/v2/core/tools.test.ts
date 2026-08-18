/**
 * THE BUILDER TOOL CONTRACT — schemas, parsing, and the truth of a tool result.
 *
 * Pure: no workspace, no authority, no I/O. The load-bearing assertions are that NO WRITE
 * CAN BE EXPRESSED WITHOUT AN OBSERVATION, that a malformed call is a structured rejection
 * rather than a crash, and that no rendering of a refusal can be read as a success.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILDER_TOOLS,
  BUILDER_TOOL_NAMES,
  TOOL_CREATE_FILE,
  TOOL_DELETE_FILE,
  TOOL_FINISH_CANDIDATE,
  TOOL_READ_FILE,
  TOOL_REPLACE_FILE,
  isBuilderToolName,
  isToolFailure,
  parseToolCall,
  renderToolOutcome,
} from "./tools.js";

const call = (name: string, args: unknown) => ({ id: "c1", name, arguments: JSON.stringify(args) });

// ── the tool set ────────────────────────────────────────────────────────────

test("tools: the builder has exactly five tools, and no shell among them", () => {
  assert.deepEqual([...BUILDER_TOOL_NAMES], ["read_file", "replace_file", "create_file", "delete_file", "finish_candidate"]);
  for (const forbidden of ["terminal", "bash", "exec", "run_command", "patch", "multi_edit", "delegate_task", "git_commit"]) {
    assert.equal(isBuilderToolName(forbidden), false, `${forbidden} must not be reachable in this slice`);
  }
});

test("tools: every write schema REQUIRES an observationId", () => {
  for (const name of [TOOL_REPLACE_FILE, TOOL_CREATE_FILE, TOOL_DELETE_FILE]) {
    const tool = BUILDER_TOOLS.find((t) => t.name === name)!;
    const required = (tool.parameters as { required: string[] }).required;
    assert.ok(required.includes("observationId"), `${name} must require an observationId`);
    assert.ok(required.includes("path"));
  }
});

test("tools: create_file has NO path-only escape hatch", () => {
  // The most tempting exception and the most damaging: a path-only create against a path
  // that already has content is a silent truncation.
  const created = BUILDER_TOOLS.find((t) => t.name === TOOL_CREATE_FILE)!;
  assert.ok((created.parameters as { required: string[] }).required.includes("observationId"));
  assert.match(created.description, /read_file that reported the path as MISSING/);
});

test("tools: finish_candidate cannot be read as a verification verdict", () => {
  const finish = BUILDER_TOOLS.find((t) => t.name === TOOL_FINISH_CANDIDATE)!;
  assert.match(finish.description, /Do not claim the work is tested, verified or correct/);
  const believes = (finish.parameters as { properties: Record<string, { description: string }> }).properties["believesComplete"]!;
  assert.match(believes.description, /Your belief, not a verdict/);
});

// ── parsing ─────────────────────────────────────────────────────────────────

test("parse: a well-formed read is accepted", () => {
  const parsed = parseToolCall(call(TOOL_READ_FILE, { path: "src/a.ts" }));
  assert.ok(parsed.ok);
  assert.equal(parsed.name, TOOL_READ_FILE);
  assert.equal(parsed.path, "src/a.ts");
});

test("parse: a write WITHOUT an observationId is refused, and says why", () => {
  for (const name of [TOOL_REPLACE_FILE, TOOL_CREATE_FILE, TOOL_DELETE_FILE]) {
    const parsed = parseToolCall(call(name, { path: "src/a.ts", content: "x" }));
    assert.ok(!parsed.ok, `${name} must not parse without an observation`);
    assert.equal(parsed.reason, "missing_argument");
    assert.match(parsed.detail, /every write must name the state it is replacing/);
  }
});

test("parse: an UNKNOWN tool is rejected structurally, and the model is told what it has", () => {
  const parsed = parseToolCall(call("terminal", { command: "rm -rf /" }));
  assert.ok(!parsed.ok);
  assert.equal(parsed.reason, "unknown_tool");
  assert.match(parsed.detail, /available: read_file, replace_file/);
});

test("parse: MALFORMED JSON is a rejection, never a throw", () => {
  const parsed = parseToolCall({ id: "c1", name: TOOL_READ_FILE, arguments: "{not json" });
  assert.ok(!parsed.ok);
  assert.equal(parsed.reason, "malformed_arguments");
});

test("parse: a JSON ARRAY of arguments is a rejection", () => {
  const parsed = parseToolCall({ id: "c1", name: TOOL_READ_FILE, arguments: "[1,2]" });
  assert.ok(!parsed.ok);
  assert.equal(parsed.reason, "malformed_arguments");
});

test("parse: a wrong-typed argument is named precisely", () => {
  const parsed = parseToolCall(call(TOOL_FINISH_CANDIDATE, { summary: "done", believesComplete: "yes" }));
  assert.ok(!parsed.ok);
  assert.equal(parsed.reason, "wrong_argument_type");
  assert.match(parsed.detail, /boolean `believesComplete`/);
});

test("parse: an empty path is refused rather than resolved to the workspace root", () => {
  const parsed = parseToolCall(call(TOOL_READ_FILE, { path: "" }));
  assert.ok(!parsed.ok);
  assert.equal(parsed.reason, "missing_argument");
});

test("parse: a replace with everything present is accepted", () => {
  const parsed = parseToolCall(call(TOOL_REPLACE_FILE, { path: "a.ts", observationId: "obs1", content: "new" }));
  assert.ok(parsed.ok);
  assert.equal(parsed.name, TOOL_REPLACE_FILE);
  assert.equal(parsed.observationId, "obs1");
  assert.equal(parsed.content, "new");
});

test("parse: an empty-string content is legitimate — truncating to empty is a real edit", () => {
  const parsed = parseToolCall(call(TOOL_REPLACE_FILE, { path: "a.ts", observationId: "obs1", content: "" }));
  assert.ok(parsed.ok);
  assert.equal(parsed.name === TOOL_REPLACE_FILE && parsed.content, "");
});

// ── result truth ────────────────────────────────────────────────────────────

test("result: a REFUSAL can never be read as an applied edit", () => {
  const rendered = renderToolOutcome({
    kind: "refused",
    path: "src/a.ts",
    code: "mutation.stale_observation",
    detail: "the file changed since you read it",
    expectedSha256: "aaa",
    actualSha256: "bbb",
  });
  assert.match(rendered, /^REFUSED: src\/a\.ts was NOT modified\./);
  assert.match(rendered, /expected sha256: aaa/);
  assert.match(rendered, /actual sha256: bbb/);
  assert.match(rendered, /Nothing was written/);
  assert.equal(/APPLIED/.test(rendered), false, "no wording a model could take as success");
});

test("result: an APPLIED edit states both hashes and whether anything changed", () => {
  const rendered = renderToolOutcome({
    kind: "applied",
    path: "src/a.ts",
    operation: "replace_file",
    mutationId: "m1",
    changed: true,
    beforeSha256: "aaa",
    afterSha256: "bbb",
  });
  assert.match(rendered, /replace_file: APPLIED to src\/a\.ts/);
  assert.match(rendered, /changed: true/);
  assert.match(rendered, /mutationId: m1/);
});

test("result: a byte-identical replace says so rather than implying a change", () => {
  const rendered = renderToolOutcome({
    kind: "applied",
    path: "a.ts",
    operation: "replace_file",
    mutationId: "m1",
    changed: false,
    beforeSha256: "aaa",
    afterSha256: "aaa",
  });
  assert.match(rendered, /changed: false/);
  assert.match(rendered, /byte-identical/);
});

test("result: an observation hands back the id on its OWN line, for verbatim reuse", () => {
  const rendered = renderToolOutcome({
    kind: "observed",
    path: "src/a.ts",
    observationId: "obs-abc",
    state: "regular",
    contentSha256: "aaa",
    byteLength: 3,
    content: "abc",
  });
  assert.ok(rendered.split("\n").includes("observationId: obs-abc"), "a value on its own line is hard to mangle");
  assert.match(rendered, /--- content ---\nabc/);
});

test("result: a MISSING path still yields an id, and tells the model what it is for", () => {
  const rendered = renderToolOutcome({
    kind: "observed",
    path: "src/new.ts",
    observationId: "obs-missing",
    state: "missing",
    contentSha256: null,
    byteLength: null,
  });
  assert.match(rendered, /There is nothing at this path/);
  assert.match(rendered, /create_file/);
  assert.equal(/--- content ---/.test(rendered), false);
});

test("result: truncation is DISCLOSED, with the consequence spelled out", () => {
  const rendered = renderToolOutcome({
    kind: "observed",
    path: "big.ts",
    observationId: "o",
    state: "regular",
    contentSha256: "a",
    byteLength: 999_999,
    content: "head",
    truncated: true,
  });
  assert.match(rendered, /TRUNCATED/);
  assert.match(rendered, /would still need the COMPLETE file/);
});

test("result: refusals and rejections both count as tool failures; reads and writes do not", () => {
  assert.equal(isToolFailure({ kind: "refused", path: "a", code: "c", detail: "d" }), true);
  assert.equal(isToolFailure({ kind: "rejected", reason: "unknown_tool", detail: "d" }), true);
  assert.equal(
    isToolFailure({ kind: "applied", path: "a", operation: "replace_file", mutationId: "m", changed: true, beforeSha256: null, afterSha256: null }),
    false,
  );
  assert.equal(isToolFailure({ kind: "observed", path: "a", observationId: "o", state: "regular", contentSha256: null, byteLength: 0 }), false);
});
