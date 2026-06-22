/**
 * ikbi spec-artifact — structured spec-card parser.
 *
 * Parses a free-form "spec card" into a GOAL plus the optional structured fields
 * (PROJECT / SCOPE / RULES / OUTPUT / ON CONFLICT). The card is a sectioned text
 * block, e.g.:
 *
 *   PROJECT: payments-api
 *   GOAL: add idempotency keys to the charge endpoint
 *   SCOPE:
 *     in: src/routes/charge.ts, src/lib/idempotency.ts
 *     out: billing dashboard, refunds
 *   RULES:
 *     - no new runtime dependencies
 *     - keep all existing tests green
 *   OUTPUT: a passing build with a new idempotency test
 *   ON CONFLICT: abort and report
 *
 * Parsing is deliberately forgiving: unknown lines are ignored, headers are
 * case-insensitive, and a bare goal with no headers still yields `{ goal }`.
 */

import type { SpecCardFields } from "./contract.js";

export interface ParsedStructuredSpec extends SpecCardFields {
  /** The GOAL text (falls back to the whole input when no GOAL header is present). */
  readonly goal: string;
}

/** Split a comma- or newline-separated list into trimmed, non-empty items. */
function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.replace(/^[-*]\s*/, "").trim())
    .filter((s) => s.length > 0);
}

type Section = "project" | "goal" | "scope" | "rules" | "output" | "onConflict" | undefined;

const HEADERS: ReadonlyArray<{ re: RegExp; section: Section }> = [
  { re: /^project\s*:?\s*(.*)$/i, section: "project" },
  { re: /^goal\s*:?\s*(.*)$/i, section: "goal" },
  { re: /^scope\s*:?\s*(.*)$/i, section: "scope" },
  { re: /^rules\s*:?\s*(.*)$/i, section: "rules" },
  { re: /^output\s*:?\s*(.*)$/i, section: "output" },
  { re: /^on[\s_]?conflict\s*:?\s*(.*)$/i, section: "onConflict" },
];

function matchHeader(line: string): { section: Section; rest: string } | undefined {
  for (const h of HEADERS) {
    const m = h.re.exec(line.trim());
    if (m) return { section: h.section, rest: (m[1] ?? "").trim() };
  }
  return undefined;
}

/**
 * Parse a structured spec card. Always returns a `goal` (the GOAL section if present,
 * else the raw input trimmed). Optional fields are present only when the card supplies
 * them, so the result drops cleanly into `createSpec`'s `extra` argument.
 */
export function parseStructuredSpec(input: string): ParsedStructuredSpec {
  const lines = input.split("\n");
  const buffers: Record<NonNullable<Section>, string[]> = {
    project: [],
    goal: [],
    scope: [],
    rules: [],
    output: [],
    onConflict: [],
  };
  const scopeIn: string[] = [];
  const scopeOut: string[] = [];

  let current: Section = undefined;
  for (const line of lines) {
    const header = matchHeader(line);
    if (header && header.section !== undefined) {
      current = header.section;
      if (header.rest.length > 0) buffers[current].push(header.rest);
      continue;
    }
    if (current === undefined) continue;
    if (current === "scope") {
      const inM = /^\s*in\s*:?\s*(.*)$/i.exec(line);
      const outM = /^\s*out\s*:?\s*(.*)$/i.exec(line);
      if (inM) {
        scopeIn.push(...splitList(inM[1] ?? ""));
        continue;
      }
      if (outM) {
        scopeOut.push(...splitList(outM[1] ?? ""));
        continue;
      }
      continue;
    }
    buffers[current].push(line.trim());
  }

  const joined = (key: NonNullable<Section>): string => buffers[key].join("\n").trim();
  const goalText = joined("goal");
  const goal = goalText.length > 0 ? goalText : input.trim();

  const result: { goal: string } & Record<string, unknown> = { goal };
  const project = joined("project");
  if (project.length > 0) result.project = project;
  if (scopeIn.length > 0 || scopeOut.length > 0) result.scope = { in: scopeIn, out: scopeOut };
  const rules = splitList(buffers.rules.join("\n"));
  if (rules.length > 0) result.rules = rules;
  const output = joined("output");
  if (output.length > 0) result.outputFormat = output;
  const onConflict = joined("onConflict");
  if (onConflict.length > 0) result.onConflict = onConflict;

  return result as ParsedStructuredSpec;
}
