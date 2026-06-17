import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSseBuffer, SSE_DONE } from "./sse-parse.js";

test("extracts complete data: payloads and ignores blank/comment lines", () => {
  const buf = `: keep-alive\ndata: {"a":1}\n\ndata: {"b":2}\n\n`;
  const { events, rest } = parseSseBuffer(buf);
  assert.deepEqual(events, [`{"a":1}`, `{"b":2}`]);
  assert.equal(rest, "");
});

test("returns the trailing partial line as rest (frame split across chunks)", () => {
  // The second frame has no terminating newline yet — it must be carried forward, not lost.
  const { events, rest } = parseSseBuffer(`data: {"a":1}\ndata: {"b":`);
  assert.deepEqual(events, [`{"a":1}`]);
  assert.equal(rest, `data: {"b":`);

  // Feeding the rest + the remainder yields the complete second frame.
  const next = parseSseBuffer(`${rest}2}\n`);
  assert.deepEqual(next.events, [`{"b":2}`]);
  assert.equal(next.rest, "");
});

test("handles CRLF line endings", () => {
  const { events } = parseSseBuffer(`data: {"a":1}\r\n\r\n`);
  assert.deepEqual(events, [`{"a":1}`]);
});

test("surfaces the [DONE] sentinel verbatim", () => {
  const { events } = parseSseBuffer(`data: [DONE]\n\n`);
  assert.deepEqual(events, [SSE_DONE]);
});

test("ignores non-data SSE fields (event:/id:/retry:)", () => {
  const { events } = parseSseBuffer(`event: message\nid: 1\nretry: 100\ndata: {"x":1}\n\n`);
  assert.deepEqual(events, [`{"x":1}`]);
});
