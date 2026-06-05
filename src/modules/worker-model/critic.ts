/**
 * ikbi worker-model — CRITIC role (Pass A: reviews builder output vs intent, model-driven).
 *
 * Scoped (pending 3-eyes): judge whether the builder's work satisfies the task
 * goal, producing a pass/fail verdict + feedback. READ-ONLY — critic reads the
 * goal and the builder's RoleResult from `priorResults`; it never touches the
 * workspace.
 *
 * UNTRUSTED INPUT (C4): the goal (user-supplied) and the builder summary/detail
 * (model-derived — a poisoned upstream role could embed instructions) are untrusted
 * DATA. Each enters via `ctx.engine.neutralizeUntrusted` + `toUntrustedMessage`
 * (untrusted:true), never raw-concatenated into the trusted SYSTEM verdict prompt.
 *
 * Every model call carries `identity: ctx.identity` (#10).
 */

import { toUntrustedMessage } from "../../core/injection/index.js";
import type { ModelMessage, ModelRequest } from "../../core/provider/contract.js";
import type { RoleFn } from "./contract.js";

const CRITIC_MODEL = "mimo-v2.5-pro"; // the critic/reviewer-tier logical roster id
const CRITIC_TEMPERATURE = 0.0; // deterministic judgment
const CRITIC_MAX_TOKENS = 768;

const CRITIC_SYSTEM =
  "You are the CRITIC in a build pipeline. Judge whether the builder's work " +
  "satisfies the stated goal. Respond with 'PASS' or 'FAIL' on the FIRST line, " +
  "then concise feedback on the following lines.";

/** Parse the model verdict: first line PASS/FAIL, remainder is feedback. */
function parseVerdict(content: string): { pass: boolean; feedback: string } {
  const trimmed = content.trim();
  const lines = trimmed.split("\n");
  const firstLine = (lines[0] ?? "").trim().toUpperCase();
  const pass = /\bPASS\b/.test(firstLine) && !/\bFAIL\b/.test(firstLine);
  const feedback = lines.slice(1).join("\n").trim() || trimmed;
  return { pass, feedback };
}

export const critic: RoleFn = async (ctx) => {
  const builderResult = ctx.priorResults.find((r) => r.role === "builder");

  // No builder output to judge (e.g. Pass A runs before the builder exists, or the
  // builder was short-circuited). There's nothing to critique — this is REJECTED
  // (the infra is healthy; there's simply no input), NOT a failure.
  if (builderResult === undefined) {
    return {
      role: "critic",
      outcome: "rejected",
      summary: "no builder output to critique",
      detail: { pass: false, feedback: "no builder result present in priorResults" },
    };
  }

  try {
    // C4: goal + builder summary/detail are untrusted DATA — neutralized + wrapped as
    // isolated data-role messages (untrusted:true), never raw in the system prompt.
    const untrusted = (raw: string, origin: string): ModelMessage =>
      toUntrustedMessage(ctx.engine.neutralizeUntrusted(raw, { source: "external", identity: ctx.identity, origin }), { role: "user" });

    const request: ModelRequest = {
      model: CRITIC_MODEL,
      temperature: CRITIC_TEMPERATURE,
      maxTokens: CRITIC_MAX_TOKENS,
      identity: ctx.identity, // the spawned, ceiling-clamped role identity (#10)
      messages: [
        { role: "system", content: CRITIC_SYSTEM },
        untrusted(`Goal (intent):\n${ctx.task.goal}`, "critic_goal"),
        untrusted(`Builder summary:\n${builderResult.summary ?? "(none)"}`, "critic_builder_summary"),
        untrusted(`Builder detail:\n${JSON.stringify(builderResult.detail ?? {})}`, "critic_builder_detail"),
      ],
    };

    const response = await ctx.engine.invokeModel(request);
    const { pass, feedback } = parseVerdict(response.content);

    // IMPORTANT: pass=false is a SUCCESSFUL critique that found problems. The role
    // SUCCEEDED at its job (it produced a verdict), so the OUTCOME is "success"
    // regardless of the verdict. `detail.pass` carries the judgment — outcome
    // reflects whether the critique RAN, not whether the work passed. "failure" is
    // reserved for infrastructure failure (the model call itself failing).
    return {
      role: "critic",
      outcome: "success",
      summary: pass ? "critique verdict: PASS" : "critique verdict: FAIL",
      detail: { pass, feedback },
    };
  } catch (err) {
    return {
      role: "critic",
      outcome: "failure",
      summary: `critic failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
