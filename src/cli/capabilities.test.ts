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

test("chat is a SUPERSET of the builder suite: 25 builder tools + the chat-only act/watch/body tools", () => {
  // Defaults read the real TOOLS / CHAT_TOOLS arrays. The 25 builder tools are ALL offered in chat.
  // The CHAT-ONLY tools are deliberate: launch_build (a persona can launch a governed build, the
  // builder role must never nest one), build_report (the guide watches builds), and the 8 phone_*
  // tools (Pehlichi's governed device body — the code-building role must never hold a camera/mic).
  // So: no builder-only tool, and exactly ten chat-only.
  const r = runCapabilities();
  assert.equal(r.builder.length, 25, "builder declares 25 tools");
  assert.equal(r.chat.length, 36, "chat = 25 builder tools + launch_build + build_report + 9 phone_* tools");
  assert.deepEqual(r.builderOnly, [], "chat advertises the full builder suite (no builder-only tool)");
  assert.deepEqual(
    [...r.chatOnly].sort(),
    [
      "build_report", "launch_build",
      "phone_battery", "phone_location", "phone_notify", "phone_read_sensor",
      "phone_read_text", "phone_record_audio", "phone_speak", "phone_take_photo", "phone_torch",
    ],
    "the chat-only tools: build_report (watch) + launch_build (act) + the phone_* body",
  );
});
