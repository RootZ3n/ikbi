import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTextToolCalls, describeToolsForText, textToolProtocolInstructions } from "./text-tool-protocol.js";

test("parseTextToolCalls: a fenced ```json block with {tool,args}", () => {
  const calls = parseTextToolCalls('Sure, I will write it.\n```json\n{"tool": "write_file", "args": {"path": "a.ts", "content": "x"}}\n```');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "write_file");
  assert.deepEqual(JSON.parse(calls[0]!.arguments), { path: "a.ts", content: "x" });
});

test("parseTextToolCalls: accepts {name, arguments} shape too", () => {
  const calls = parseTextToolCalls('```tool\n{"name": "read_file", "arguments": {"path": "b.ts"}}\n```');
  assert.equal(calls[0]?.name, "read_file");
  assert.deepEqual(JSON.parse(calls[0]!.arguments), { path: "b.ts" });
});

test("parseTextToolCalls: a bare JSON object (no fence) is parsed", () => {
  const calls = parseTextToolCalls('{"tool": "run_checks", "args": {}}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "run_checks");
});

test("parseTextToolCalls: plain prose with no tool envelope yields nothing", () => {
  assert.deepEqual(parseTextToolCalls("I think the bug is in the parser. Let me reason about it."), []);
});

test("parseTextToolCalls: a JSON code sample that is NOT a tool call is ignored", () => {
  // A fenced block without tool/name keys must not be mistaken for a call.
  assert.deepEqual(parseTextToolCalls('```json\n{"foo": 1, "bar": 2}\n```'), []);
});

test("parseTextToolCalls: empty / non-string input is safe", () => {
  assert.deepEqual(parseTextToolCalls(""), []);
  assert.deepEqual(parseTextToolCalls("   "), []);
  assert.deepEqual(parseTextToolCalls(undefined as unknown as string), []);
});

test("parseTextToolCalls: multiple blocks return calls in order", () => {
  const calls = parseTextToolCalls('```json\n{"tool":"read_file","args":{"path":"a"}}\n```\nthen\n```json\n{"tool":"done","args":{"satisfied":true}}\n```');
  assert.deepEqual(calls.map((c) => c.name), ["read_file", "done"]);
});

test("describeToolsForText / instructions: render tool names + required params", () => {
  const tools = [{ name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } }];
  const desc = describeToolsForText(tools);
  assert.match(desc, /write_file\(path \(required\), content \(required\)\)/);
  const instr = textToolProtocolInstructions(tools);
  assert.match(instr, /no native tool API/);
  assert.match(instr, /"tool": "<tool_name>"/);
  assert.match(instr, /write_file/);
});
