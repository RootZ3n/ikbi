import assert from "node:assert/strict";
import { test } from "node:test";

import { parseLenientArgs } from "./lenient-args.js";

test("parseLenientArgs: valid JSON passes through untouched (repaired=false)", () => {
  const r = parseLenientArgs('{"text":"hello world","n":3}');
  assert.deepEqual(r?.value, { text: "hello world", n: 3 });
  assert.equal(r?.repaired, false);
});

test("parseLenientArgs: single-quoted args (the deepseek-v4-flash failure) are repaired", () => {
  // This is the exact 22-char shape that stalled the first Abina build.
  const r = parseLenientArgs("{'text':'hello world'}");
  assert.deepEqual(r?.value, { text: "hello world" });
  assert.equal(r?.repaired, true);
});

test("parseLenientArgs: trailing commas are repaired", () => {
  const r = parseLenientArgs('{"a":1,"b":2,}');
  assert.deepEqual(r?.value, { a: 1, b: 2 });
  assert.equal(r?.repaired, true);
});

test("parseLenientArgs: Python literals become JSON literals", () => {
  const r = parseLenientArgs('{"ok":True,"bad":False,"maybe":None}');
  assert.deepEqual(r?.value, { ok: true, bad: false, maybe: null });
});

test("parseLenientArgs: unquoted keys are quoted", () => {
  const r = parseLenientArgs('{path: "src/x.ts", overwrite: true}');
  assert.deepEqual(r?.value, { path: "src/x.ts", overwrite: true });
});

test("parseLenientArgs: unquoted key + single-quoted value together", () => {
  const r = parseLenientArgs("{path: 'src/x.ts'}");
  assert.deepEqual(r?.value, { path: "src/x.ts" });
});

test("parseLenientArgs: strips a markdown code fence", () => {
  const r = parseLenientArgs('```json\n{"text":"hi"}\n```');
  assert.deepEqual(r?.value, { text: "hi" });
});

test("parseLenientArgs: does NOT clobber apostrophes inside a double-quoted string", () => {
  // No single-quote swap when double quotes are present — the apostrophe is preserved.
  const r = parseLenientArgs('{"msg":"it\'s fine"}');
  assert.deepEqual(r?.value, { msg: "it's fine" });
  assert.equal(r?.repaired, false);
});

test("parseLenientArgs: irreparable garbage returns undefined (caller falls back to {})", () => {
  assert.equal(parseLenientArgs("not json at all <<<"), undefined);
  assert.equal(parseLenientArgs("{{{"), undefined);
});
