/**
 * THE DETERMINISTIC VALIDATORS.
 *
 * The failure mode these exist to catch is not gibberish. An aggressively quantized worker's
 * characteristic mistake is a fluent, well-formatted, entirely confident answer about something it
 * was never shown — and a lenient validator passes exactly that. So every test here is a
 * plausible-looking answer that must NOT be accepted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { LOCAL_VALIDATORS } from "./local-validators.js";
import type { LocalPacketItem } from "./local-lane.js";

const PACKET: readonly LocalPacketItem[] = [
  { id: "src/widget.ts", content: "export const widget = 1;\n", source: "repo" },
  { id: "log:1", content: "FAIL src/widget.test.ts: expected 2, got 1\n", source: "tool_result" },
];

const triage = LOCAL_VALIDATORS.test_log_triage;
const summary = LOCAL_VALIDATORS.diff_summarization;
const edit = LOCAL_VALIDATORS.narrow_edit_proposal;

test("validator: a well-formed classification with a citation is accepted", () => {
  const raw = '```json\n{"category":"assertion_failure","summary":"widget is 1","citations":[{"sourceId":"log:1","quote":"expected 2, got 1"}]}\n```';
  const v = triage.validate(raw, PACKET);
  assert.equal(v.ok, true);
  assert.equal((v as { artifact: Record<string, unknown> }).artifact["category"], "assertion_failure");
});

test("validator: unfenced JSON is still read — the fence is a convention, not a trick", () => {
  const raw = 'Here is my answer: {"category":"timeout","citations":[{"sourceId":"log:1","quote":"FAIL"}]}';
  assert.equal(triage.validate(raw, PACKET).ok, true);
});

test("validator: prose with no JSON is rejected", () => {
  for (const raw of ["I think it's an assertion failure.", "", "assertion_failure"]) {
    assert.equal(triage.validate(raw, PACKET).ok, false);
  }
});

test("validator: a category OUTSIDE the closed vocabulary is rejected", () => {
  // A plausible-sounding invented label is the model answering a different question.
  const raw = '{"category":"assertion-failure","citations":[{"sourceId":"log:1","quote":"FAIL"}]}';
  const v = triage.validate(raw, PACKET);
  assert.equal(v.ok, false);
  assert.match((v as { detail: string }).detail, /not one of/);
});

test("validator: a confident classification with NO citation is rejected as an opinion", () => {
  const v = triage.validate('{"category":"flaky","summary":"probably flaky"}', PACKET);
  assert.equal(v.ok, false);
  assert.match((v as { detail: string }).detail, /unsupported classification is an opinion/);
});

test("validator: citations are EXTRACTED for the lane to resolve, never trusted here", () => {
  // This module reads the claim; `resolveCitations` decides whether it is true.
  const raw = '{"category":"flaky","citations":[{"sourceId":"log:1","quote":"invented text"}]}';
  assert.deepEqual(triage.citations!(raw), [{ sourceId: "log:1", quote: "invented text" }]);
  assert.equal(triage.validate(raw, PACKET).ok, true, "shape is this validator's job; truth is the lane's");
});

test("validator: malformed citation entries are dropped, not coerced", () => {
  const raw = '{"category":"flaky","citations":[{"sourceId":"log:1"},{"quote":"x"},{"sourceId":"log:1","quote":"FAIL"},"nope"]}';
  assert.deepEqual(triage.citations!(raw), [{ sourceId: "log:1", quote: "FAIL" }]);
});

test("validator: a summary task requires at least one citation", () => {
  assert.equal(summary.validate('{"summary":"it changed a thing"}', PACKET).ok, false);
  assert.equal(summary.validate('{"summary":"it changed a thing","citations":[{"sourceId":"src/widget.ts","quote":"widget = 1"}]}', PACKET).ok, true);
});

test("validator: an empty summary is missing, not empty", () => {
  assert.equal(summary.validate('{"summary":"   ","citations":[{"sourceId":"a","quote":"b"}]}', PACKET).ok, false);
});

// ── proposed edits ──────────────────────────────────────────────────────────

test("edit proposal: a well-anchored proposal is accepted and marked UNAPPLIED", () => {
  const raw = '{"path":"src/widget.ts","find":"widget = 1","replace":"widget = 2"}';
  const v = edit.validate(raw, PACKET);
  assert.equal(v.ok, true);
  const a = (v as { artifact: Record<string, unknown> }).artifact;
  assert.equal(a["kind"], "proposed_edit");
  assert.equal(a["applied"], false, "nothing here applies anything");
  assert.equal(a["replace"], "widget = 2");
});

test("edit proposal: an anchor the model INVENTED is rejected", () => {
  const v = edit.validate('{"path":"src/widget.ts","find":"widget = 42","replace":"widget = 2"}', PACKET);
  assert.equal(v.ok, false);
  assert.match((v as { detail: string }).detail, /does not occur/);
});

test("edit proposal: an AMBIGUOUS anchor is rejected — an ambiguous edit is a change nobody chose", () => {
  const packet = [{ id: "a.ts", content: "const x = 1;\nconst x = 1;\n", source: "repo" as const }];
  const v = edit.validate('{"path":"a.ts","find":"const x = 1;","replace":"const x = 2;"}', packet);
  assert.equal(v.ok, false);
  assert.match((v as { detail: string }).detail, /occurs 2 times/);
});

test("edit proposal: a path OUTSIDE the packet is rejected", () => {
  // The worker was given a packet. A path it was not shown is one it made up.
  const v = edit.validate('{"path":"/etc/passwd","find":"root","replace":"pwned"}', PACKET);
  assert.equal(v.ok, false);
  assert.match((v as { detail: string }).detail, /not in the packet/);
});

test("edit proposal: an edit with no anchor at all is not narrow", () => {
  assert.equal(edit.validate('{"path":"src/widget.ts","replace":"everything"}', PACKET).ok, false);
});

test("edit proposal: an EMPTY replacement is a legitimate deletion, not a missing field", () => {
  const v = edit.validate('{"path":"src/widget.ts","find":"widget = 1","replace":""}', PACKET);
  assert.equal(v.ok, true);
  assert.equal((v as { artifact: Record<string, unknown> }).artifact["replace"], "");
});

test("every eligible task class has a validator, and every validator names itself", () => {
  // The keys of this table ARE the eligible list the CLI accepts; a class with no validator here
  // is a class that cannot be offloaded, which is the correct outcome.
  for (const [name, v] of Object.entries(LOCAL_VALIDATORS)) {
    assert.equal(typeof v.validate, "function", `${name} has no validator`);
    assert.ok(v.name.length > 0);
  }
});

test("no validator calls a model — they are pure functions of text plus packet", () => {
  // Structural: a validator that needed a model could not be the thing that checks a model.
  for (const v of Object.values(LOCAL_VALIDATORS)) {
    const src = v.validate.toString();
    assert.ok(!/invoke|fetch|provider|await/.test(src), `${v.name} looks like it does I/O`);
  }
});
