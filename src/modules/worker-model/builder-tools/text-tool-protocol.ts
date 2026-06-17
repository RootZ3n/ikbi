/**
 * ikbi builder tool — TEXT TOOL PROTOCOL (emulated tool-calling for no-function-API models).
 *
 * Many cheap/local models (e.g. deepseek-reasoner, llama.cpp/Ollama builds without a function-
 * calling layer) cannot emit the OpenAI structured `tool_calls` array — they only return text.
 * Without this, such a model "bare-stops" every round and grinds to max_iterations: it is
 * effectively undrivable. This module lets the builder drive those models over a plain-text
 * protocol: we describe the tools + a strict JSON envelope in the system prompt, and parse the
 * tool calls back out of the model's text.
 *
 * SECURITY: this only changes how a tool call is TRANSPORTED (text vs structured). Every parsed
 * call still flows through the SAME validation, confinement, and neutralization the structured
 * path uses — nothing here executes anything.
 */

import type { ModelTool, ToolCall } from "../../../core/provider/contract.js";

/** A loose view of a tool's JSON-schema params (ModelTool.parameters is untyped JSON). */
interface LooseSchema {
  readonly properties?: Record<string, { readonly type?: string; readonly description?: string }>;
  readonly required?: readonly string[];
}

/** Render a compact, model-readable catalogue of the tools for the text protocol. */
export function describeToolsForText(tools: readonly ModelTool[]): string {
  return tools
    .map((t) => {
      const schema = (t.parameters ?? {}) as LooseSchema;
      const required = schema.required ?? [];
      const params = Object.keys(schema.properties ?? {})
        .map((k) => (required.includes(k) ? `${k} (required)` : k))
        .join(", ");
      return `- ${t.name}(${params})${t.description ? ` — ${t.description}` : ""}`;
    })
    .join("\n");
}

/**
 * The system-prompt addendum used when the model has no native tool API. Tells the model the
 * EXACT envelope to emit so `parseTextToolCalls` can recover the call.
 */
export function textToolProtocolInstructions(tools: readonly ModelTool[]): string {
  return [
    "TOOL CALLING (IMPORTANT — your model has no native tool API):",
    "To use a tool, output ONE fenced code block and nothing else after it:",
    "```json",
    '{"tool": "<tool_name>", "args": { ... }}',
    "```",
    "Emit exactly ONE tool call per message. Wait for its result before the next call.",
    "Do NOT describe the call in prose — emit the JSON block. To finish, call the `done` tool the same way.",
    "",
    "Available tools:",
    describeToolsForText(tools),
  ].join("\n");
}

/** Pull the candidate fenced JSON payloads out of a model message (```json / ```tool / bare ```). */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```(?:json|tool|tool_call)?\s*\n?([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m[1] !== undefined) blocks.push(m[1].trim());
  }
  return blocks;
}

/** Coerce one parsed object into a ToolCall if it has the right shape, else null. */
function toToolCall(obj: unknown, index: number): ToolCall | null {
  if (typeof obj !== "object" || obj === null) return null;
  const r = obj as Record<string, unknown>;
  const name = typeof r.tool === "string" ? r.tool : typeof r.name === "string" ? r.name : undefined;
  if (name === undefined || name.length === 0) return null;
  const rawArgs = r.args ?? r.arguments ?? {};
  // Accept either an object (the norm) or an already-stringified JSON args payload.
  let argsStr: string;
  if (typeof rawArgs === "string") {
    argsStr = rawArgs;
  } else if (typeof rawArgs === "object" && rawArgs !== null) {
    argsStr = JSON.stringify(rawArgs);
  } else {
    argsStr = "{}";
  }
  return { id: `txt-${index}`, name, arguments: argsStr };
}

/**
 * Parse tool calls out of a model's TEXT output. Tries fenced blocks first (the documented
 * envelope), then falls back to the whole trimmed message being a bare JSON object. Returns the
 * calls in document order; an empty array means "no tool call in this text" (a real bare stop).
 * Tolerant of surrounding prose — only strictly-shaped `{tool|name, args|arguments}` objects match.
 */
export function parseTextToolCalls(text: string): ToolCall[] {
  if (typeof text !== "string" || text.trim().length === 0) return [];
  const calls: ToolCall[] = [];
  let idx = 0;
  for (const block of fencedBlocks(text)) {
    try {
      const parsed = JSON.parse(block) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of arr) {
        const tc = toToolCall(entry, idx);
        if (tc !== null) { calls.push(tc); idx += 1; }
      }
    } catch {
      // not JSON — ignore this block
    }
  }
  if (calls.length > 0) return calls;
  // Fallback: the entire message is a bare JSON object/array (no fence).
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of arr) {
        const tc = toToolCall(entry, idx);
        if (tc !== null) { calls.push(tc); idx += 1; }
      }
    } catch {
      /* not JSON */
    }
  }
  return calls;
}
