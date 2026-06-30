/**
 * ikbi consult — frontier prompt rendering.
 *
 * Turns a ConsultPacket into the exact system + user messages the frontier model sees.
 * This is where the evidence-vs-hints discipline is made explicit to the model:
 *   - the code SLICES are verbatim ground truth — reason over them,
 *   - the cheap-model POINTERS are hints that may be wrong — verify against the slices,
 *   - a deterministic verifier (not the model) decides truth, so be correct, not plausible.
 *
 * No model calls here — pure string assembly, fully testable.
 */

import type { ConsultPacket, ConsultMode } from "./contract.js";

const SYSTEM_COMMON =
  "You are a frontier engineering consultant for ikbi. You are called in ONLY when cheaper " +
  "models are stuck, so your time is expensive and your answer must be worth it. You are given " +
  "an evidence-dense packet assembled by a cheap pre-pass: verbatim code slices, the exact " +
  "failing-check output, and a trail of what was already tried and why it failed.\n\n" +
  "GROUND RULES:\n" +
  "- The code SLICES are verbatim and authoritative. Reason over them directly.\n" +
  "- The cheap-model POINTERS are hints — they may be wrong, incomplete, or misleading. " +
  "Never take a pointer as fact; confirm it against the slices.\n" +
  "- A deterministic verifier (the ladder), not you, decides whether your answer is correct. " +
  "Be precise and correct, not merely plausible.\n" +
  "- Do not ask for more files or invent code you cannot see; work from the evidence given, " +
  "and if the evidence is insufficient, say exactly what is missing.";

const SYSTEM_ADVISE =
  `${SYSTEM_COMMON}\n\nMODE: ADVISE. Identify the ROOT CAUSE, then give a minimal, concrete ` +
  "do-this-not-that plan a cheaper model can execute: name the files, the lines, and the exact " +
  "change. Do NOT restate the code back. Keep it tight — root cause, then numbered steps.";

const SYSTEM_PATCH =
  `${SYSTEM_COMMON}\n\nMODE: PATCH. Output a SINGLE unified diff (git-apply-able) limited to the ` +
  "hunks the evidence identifies. Touch only files listed in allowedFiles. No prose outside the " +
  "diff except, at most, one leading comment line stating the root cause. Do not include files " +
  "you were not shown.";

export function consultSystemPrompt(mode: ConsultMode): string {
  return mode === "patch" ? SYSTEM_PATCH : SYSTEM_ADVISE;
}

function fence(body: string): string {
  // Avoid collisions with backtick fences inside the slice text.
  return `~~~\n${body}\n~~~`;
}

/** Render the packet as the user message: question + evidence, slices clearly primary. */
export function renderConsultPrompt(packet: ConsultPacket): string {
  const lines: string[] = [];
  lines.push(`# Consult request (mode: ${packet.mode})`);
  lines.push("");
  lines.push("## Question");
  lines.push(packet.question);

  if (packet.goal !== undefined) {
    lines.push("");
    lines.push("## Originating goal");
    lines.push(packet.goal);
  }

  if (packet.evidence.failingChecks !== undefined) {
    lines.push("");
    lines.push("## Failing checks (verbatim)");
    lines.push(fence(packet.evidence.failingChecks));
  }

  if (packet.evidence.triedAndFailed.length > 0) {
    lines.push("");
    lines.push("## Already tried (and why it failed)");
    for (const attempt of packet.evidence.triedAndFailed) {
      const who = attempt.role !== undefined ? `[${attempt.role}] ` : "";
      lines.push(`- ${who}${attempt.summary} → ${attempt.outcome}`);
    }
  }

  lines.push("");
  lines.push("## Code evidence — VERBATIM SLICES (authoritative)");
  if (packet.evidence.slices.length === 0) {
    lines.push("_(no slices were available within budget — say what you would need)_");
  }
  for (const slice of packet.evidence.slices) {
    const trunc = slice.truncated ? " (truncated)" : "";
    lines.push("");
    lines.push(`### ${slice.path}:${slice.startLine}-${slice.endLine}${trunc}`);
    lines.push(fence(slice.text));
  }

  if (packet.evidence.scoutPointers.length > 0) {
    lines.push("");
    lines.push("## Cheap-model pointers — HINTS ONLY (may be wrong; verify against the slices)");
    for (const pointer of packet.evidence.scoutPointers) {
      const sev = pointer.severity !== undefined ? `[${pointer.severity}] ` : "";
      const loc =
        pointer.path !== undefined
          ? ` — ${pointer.path}${pointer.lines !== undefined ? `:${pointer.lines[0]}-${pointer.lines[1]}` : ""}`
          : "";
      lines.push(`- ${sev}${pointer.title}${loc}`);
    }
  }

  lines.push("");
  lines.push("## Constraints");
  if (packet.constraints.allowedFiles.length > 0) {
    lines.push(`- allowedFiles: ${packet.constraints.allowedFiles.join(", ")}`);
  }
  if (packet.constraints.forbiddenFiles.length > 0) {
    lines.push(`- forbiddenFiles: ${packet.constraints.forbiddenFiles.join(", ")}`);
  }
  lines.push("- The verifier, not you, determines truth; your output will be checked by the ladder.");

  if (packet.truncation.droppedSlices > 0 || packet.truncation.packetTruncated) {
    lines.push("");
    lines.push(
      `_Note: evidence was budget-trimmed (droppedSlices=${packet.truncation.droppedSlices}, ` +
        `packetTruncated=${packet.truncation.packetTruncated}). Flag if you need something that was cut._`
    );
  }

  return lines.join("\n");
}
