import assert from "node:assert/strict";
import { test } from "node:test";

import { editDistance, suggestCommand } from "./suggest.js";

const KNOWN = ["build", "fix", "doctor", "models", "providers", "capabilities", "workspace", "trust", "clean", "undo", "repl", "help"];

test("editDistance: basic edits", () => {
  assert.equal(editDistance("build", "build"), 0);
  assert.equal(editDistance("buld", "build"), 1); // one insertion
  assert.equal(editDistance("doctr", "doctor"), 1);
  assert.equal(editDistance("", "abc"), 3);
});

test("suggestCommand: a close typo maps to its command", () => {
  assert.equal(suggestCommand("buld", KNOWN, 1), "build");
  assert.equal(suggestCommand("doctr", KNOWN, 1), "doctor");
  assert.equal(suggestCommand("workspac", KNOWN, 1), "workspace");
  assert.equal(suggestCommand("capabilites", KNOWN, 2), "capabilities");
});

test("suggestCommand: distance beyond maxDist ⇒ no suggestion (avoids hijacking prose)", () => {
  // "hello" → "help" is distance 2; at the lone-token ceiling of 1 it must NOT suggest.
  assert.equal(suggestCommand("hello", KNOWN, 1), undefined);
  // with the looser flag-present ceiling it may match — but that's only used when a flag signals intent.
  assert.equal(suggestCommand("hello", KNOWN, 2), "help");
});

test("suggestCommand: the first letter must match (no cross-letter false matches)", () => {
  // "six" is edit-distance 1 from "fix" but starts with a different letter → never suggested.
  assert.equal(suggestCommand("six", KNOWN, 1), undefined);
});

test("suggestCommand: an exact command still returns itself (harmless — the dispatcher matches it first)", () => {
  assert.equal(suggestCommand("build", KNOWN, 1), "build");
});
