import assert from "node:assert/strict";
import { test } from "node:test";

import { HELP_PAGES, helpTopics, helpForTopic, renderHelpPage } from "./help-pages.js";

// The work order requires a detailed page for each of these commands.
const REQUIRED = ["build", "init", "models", "serve", "repl"] as const;

test("every required command has a help page", () => {
  for (const cmd of REQUIRED) {
    assert.ok(HELP_PAGES[cmd] !== undefined, `missing help page for ${cmd}`);
  }
});

test("each help page has a one-line description, usage, and examples", () => {
  for (const topic of helpTopics()) {
    const page = HELP_PAGES[topic]!;
    assert.ok(page.summary.length > 0, `${topic} has a summary`);
    assert.ok(page.usage.includes("ikbi"), `${topic} usage names ikbi`);
    assert.ok(page.examples.length >= 1, `${topic} has at least one example`);
  }
});

test("helpForTopic renders usage, flags, examples, and see-also", () => {
  const rendered = helpForTopic("build");
  assert.ok(rendered !== undefined);
  assert.match(rendered!, /^ikbi build —/m);
  assert.match(rendered!, /Usage:/);
  assert.match(rendered!, /Flags:/);
  assert.match(rendered!, /Examples:/);
  assert.match(rendered!, /See also:/);
  assert.match(rendered!, /--max-budget-usd/);
});

test("helpForTopic returns undefined for an unknown topic", () => {
  assert.equal(helpForTopic("not-a-command"), undefined);
});

test("renderHelpPage tolerates a page with no flags", () => {
  const out = renderHelpPage({ name: "x", summary: "s", usage: "ikbi x", examples: [{ cmd: "ikbi x" }] });
  assert.match(out, /Usage: ikbi x/);
  assert.ok(!out.includes("Flags:"), "no flags section when there are none");
});

test("repl page documents --fork and --quiet (session management)", () => {
  const rendered = helpForTopic("repl")!;
  assert.match(rendered, /--fork/);
  assert.match(rendered, /--quiet/);
});
