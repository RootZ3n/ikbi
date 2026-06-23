import assert from "node:assert/strict";
import { test } from "node:test";

// EGRESS FIRST — runCapabilities pulls in the builder/chat tool arrays, which transit the
// provider singleton; the provider resolves the egress fetch guard at construction, so
// egress (which registers it) must load first, exactly as the modules barrel orders it.
import "../modules/egress/index.js";

import type { ModelTool } from "../core/provider/contract.js";
import { runCapabilities } from "./capabilities.js";

const tool = (name: string, description = `${name} desc`): ModelTool => ({ name, description, parameters: { type: "object", properties: {}, required: [] } });

test("runCapabilities lists both tool sets and reports parity when they match", () => {
  const tools = [tool("read_file"), tool("terminal"), tool("done")];
  const r = runCapabilities({ builderTools: tools, chatTools: tools });
  assert.deepEqual(r.builder, ["read_file", "terminal", "done"]);
  assert.deepEqual(r.chat, ["read_file", "terminal", "done"]);
  assert.deepEqual(r.builderOnly, []);
  assert.deepEqual(r.chatOnly, []);
  const text = r.lines.join("\n");
  assert.match(text, /Builder tools \(3\)/);
  assert.match(text, /Chat tools \(3\)/);
  assert.match(text, /Parity: chat exposes the same 3 tools as the builder\. ✓/);
  assert.match(text, /read_file — read_file desc/);
});

test("runCapabilities surfaces a parity MISMATCH in both directions", () => {
  const builder = [tool("read_file"), tool("scout_detail")];
  const chat = [tool("read_file"), tool("vision_analyze")];
  const r = runCapabilities({ builderTools: builder, chatTools: chat });
  assert.deepEqual(r.builderOnly, ["scout_detail"]);
  assert.deepEqual(r.chatOnly, ["vision_analyze"]);
  assert.match(r.lines.join("\n"), /Parity: MISMATCH — builder-only: \[scout_detail\]; chat-only: \[vision_analyze\]\./);
});

test("the LIVE builder and chat tool sets are in parity at exactly 25 tools", () => {
  // Defaults read the real TOOLS / CHAT_TOOLS arrays — the audit's invariant, pinned.
  // 18 original (incl. glob + multi_edit) + 4 brain tools (brain_search, brain_think, brain_put,
  // brain_sync) + 3 capability tools added by the Bubbles gap-closure: lsp_diagnostic,
  // notebook_edit, ask_user.
  const r = runCapabilities();
  assert.equal(r.builder.length, 25, "builder declares 25 tools");
  assert.equal(r.chat.length, 25, "chat declares 25 tools");
  assert.deepEqual(r.builderOnly, [], "no builder-only tool (full chat parity)");
  assert.deepEqual(r.chatOnly, [], "no chat-only tool");
});
