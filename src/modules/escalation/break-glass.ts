/**
 * ikbi escalation — THE BREAK-GLASS APPROVAL FLOW.
 *
 * The frontier tier (gpt-5.5 / opus-4.8) is NEVER reached silently. When the engine
 * recommends a mid→frontier transition (`requiresApproval: true`), this flow:
 *   1. PRESENTS the human a full briefing — what was tried, why it failed, the score
 *      breakdown, the target model, and the estimated cost;
 *   2. WAITS for an explicit approve/deny via an INJECTED approver (so it is headless-
 *      testable; the default approver DENIES — fail-closed, zero silent escalation);
 *   3. on deny, resolves to a fallback (retry the current tier, or abort).
 *
 * This module is deliberately free of the event bus + identity: it formats + decides.
 * The caller (orchestrator hook) emits `escalation.approval.*` with proper
 * attribution and enacts the resolution. That keeps break-glass pure + unit-testable.
 */

import { formatScoreBreakdown } from "./handoff.js";
import { EscalationError } from "./contract.js";
import type { EscalationDecision } from "./contract.js";

/** What the human is being asked to approve. */
export interface BreakGlassRequest {
  /** The worker taskId (for the briefing header + correlation). */
  readonly taskId: string;
  /** The engine's decision (MUST have `requiresApproval === true`). */
  readonly decision: EscalationDecision;
  /** Estimated USD cost of the frontier retry, if known (surfaced in the briefing). */
  readonly estimatedCostUsd?: number;
}

/** What happens next after the human decides. */
export type BreakGlassFallback = "escalate" | "retry-current" | "abort";

/** The resolved break-glass outcome. */
export interface BreakGlassResolution {
  /** Whether the human approved the frontier transition. */
  readonly approved: boolean;
  /** The action the orchestrator should take. */
  readonly fallback: BreakGlassFallback;
  /** Optional human-supplied reason. */
  readonly reason?: string;
}

/** The injected approval gate. Receives the request + the rendered briefing. */
export type Approver = (request: BreakGlassRequest, briefing: string) => Promise<boolean>;

export interface BreakGlassDeps {
  /** The approval gate. Defaults to DENY (fail-closed). */
  readonly approve?: Approver;
  /** What to do on denial: retry the current tier (default) or abort the run. */
  readonly onDeny?: "retry-current" | "abort";
}

export interface BreakGlass {
  /** Render the human-facing briefing for a request (deterministic). */
  present(request: BreakGlassRequest): string;
  /** Run the approval flow: present → await the approver → resolve. */
  request(request: BreakGlassRequest): Promise<BreakGlassResolution>;
}

/** The fail-closed default approver — denies every request (zero silent escalation). */
export const DENY_BY_DEFAULT: Approver = async () => false;

/** Render the briefing the human sees. Pure + deterministic. */
export function presentBreakGlass(request: BreakGlassRequest): string {
  const { decision } = request;
  const target = decision.targetTier ?? "frontier";
  const handoff = decision.handoffContext;
  const lines: string[] = [];

  lines.push(`⚠ BREAK-GLASS: escalation to the ${target.toUpperCase()} tier requires approval.`);
  lines.push(`task: ${request.taskId}`);
  lines.push(`from: ${decision.currentTier}  →  to: ${target}${decision.targetModel ? ` (${decision.targetModel})` : ""}`);
  lines.push(`signal: ${formatScoreBreakdown(decision.score)}`);

  if (handoff !== undefined) {
    lines.push(`goal: ${handoff.goal}`);
    if (handoff.previousAttempts.length > 0) {
      lines.push("attempts:");
      for (const a of handoff.previousAttempts) {
        const reasons = a.failureReasons.length > 0 ? ` — ${a.failureReasons.join("; ")}` : "";
        lines.push(`  • [${a.tier}] ${a.model}: ${a.outcome} (score ${round2(a.score)})${reasons}`);
      }
    }
    if (handoff.verificationDetails !== undefined) lines.push(`verification: ${handoff.verificationDetails}`);
    if (handoff.criticFeedback !== undefined) lines.push(`critic: ${handoff.criticFeedback}`);
  }

  lines.push(
    request.estimatedCostUsd !== undefined
      ? `estimated cost: $${round2(request.estimatedCostUsd)}`
      : "estimated cost: unknown",
  );
  lines.push("approve to proceed; deny to hold at the current tier.");
  return lines.join("\n");
}

/** Build a break-glass flow with an injected approver (defaults to fail-closed deny). */
export function createBreakGlass(deps: BreakGlassDeps = {}): BreakGlass {
  const approve = deps.approve ?? DENY_BY_DEFAULT;
  const onDeny: BreakGlassFallback = deps.onDeny ?? "retry-current";

  function present(request: BreakGlassRequest): string {
    return presentBreakGlass(request);
  }

  async function request(req: BreakGlassRequest): Promise<BreakGlassResolution> {
    if (!req.decision.requiresApproval) {
      throw new EscalationError(
        "tier",
        `break-glass invoked for a decision that does not require approval (target "${req.decision.targetTier ?? "none"}")`,
      );
    }
    const briefing = present(req);
    const approved = await approve(req, briefing);
    return Object.freeze({
      approved,
      fallback: approved ? "escalate" : onDeny,
    });
  }

  return Object.freeze({ present, request });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
