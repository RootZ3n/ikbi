/**
 * ikbi gate-wall — the policy evaluator (deterministic, fail-closed).
 *
 * Turns an `AutonomyGrant` into a `PromoteGovernance` verdict:
 *   - requiresApproval === false (operator/trusted/verified) → ALLOW, reason cites
 *     the tier + autoCommit/gateLevel.
 *   - requiresApproval === true  (probation/untrusted)        → DENY (fail-closed):
 *     the tier needs operator approval and no approval mechanism exists yet, so the
 *     promote is blocked. This is the INTENDED posture, not a bug — low-tier agents
 *     cannot promote until the (later) human-approval queue is built.
 *   - gate-wall disabled in config                            → DENY (a gate that is
 *     off cannot grant approval; never an allow-all bypass).
 *
 * A denied promote is still a SUCCESSFUL evaluation (mirrors integrator
 * decision-vs-outcome): the receipt outcome is "success" and `governance.allow`
 * carries the deny.
 */

import { randomUUID } from "node:crypto";

import { events as coreEvents } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import { commandPolicyDenyReason } from "../governed-exec/policy.js";
import { gateWallConfig, type GateWallConfig } from "./config.js";
import { gateAllowed, gateDenied, gateEvaluated, type GateEventPayload } from "./events.js";
import type { GateWall, GateWallAction, GateWallEvaluateInput, PromoteGovernance } from "./contract.js";

const GATE_ID_PREFIX = "gate";
const GATE_OPERATION = "gate.evaluate";
const EVENT_SOURCE = "gate-wall";

/** A compact, action-tagged audit descriptor — what is gated, for receipts/events. */
interface ActionAudit {
  readonly kind: GateWallAction["kind"];
  /** One-line human summary for the receipt detail. */
  readonly summary: string;
  /** Structured action fields for the receipt metadata. */
  readonly metadata: Record<string, unknown>;
  /** Correlation id for the receipt, when the action carries one. */
  readonly requestId?: string;
  /** Project scope for the receipt, when the action carries one. */
  readonly project?: string;
}

/**
 * Describe an action for the audit trail WITHOUT influencing the verdict. For exec,
 * log the command + arg COUNT + sudo flag only — never the full args verbatim (that
 * is governed-exec's own receipt concern).
 */
function auditAction(action: GateWallAction): ActionAudit {
  if (action.kind === "promote") {
    // task.goal is FREE USER TEXT (possibly sensitive) — log structural identifiers
    // only (taskId/targetRepo/resultsCount) + the goal LENGTH, never the goal text.
    // Same conservative posture as the exec branch (command + argCount, not full args).
    return {
      kind: "promote",
      summary: `promote task ${action.task.taskId} (${action.results.length} role result(s))`,
      metadata: {
        taskId: action.task.taskId,
        targetRepo: action.task.targetRepo,
        resultsCount: action.results.length,
        goalLength: action.task.goal.length,
      },
      requestId: action.task.taskId,
      project: action.task.targetRepo,
    };
  }
  return {
    kind: "exec",
    summary: `exec ${action.sudo ? "sudo " : ""}${action.command} (${action.args.length} args)`,
    metadata: {
      command: action.command,
      argCount: action.args.length,
      sudo: action.sudo,
      ...(action.purpose !== undefined ? { purpose: action.purpose } : {}),
    },
  };
}

/** Injectable dependencies (tests substitute receipts / publish / clock / id). */
export interface GateWallDeps {
  readonly config?: GateWallConfig;
  readonly receipts?: { append: (input: unknown, identity: AgentIdentity) => Promise<unknown> };
  readonly publish?: (input: EventInput<GateEventPayload>) => void;
  /** Audit-correlation id generator. Defaults to a prefixed UUID. */
  readonly newGateId?: () => string;
}

/** Build a gate-wall evaluator. The default deps wire the real frozen singletons. */
export function createGateWall(deps: GateWallDeps = {}): GateWall {
  const config = deps.config ?? gateWallConfig;
  const receipts = deps.receipts ?? coreReceipts;
  const publish = deps.publish ?? ((input: EventInput<GateEventPayload>) => void coreEvents.publish(input));
  const newGateId = deps.newGateId ?? (() => `${GATE_ID_PREFIX}-${randomUUID()}`);

  async function evaluate(input: GateWallEvaluateInput): Promise<PromoteGovernance> {
    const tier = input.grant.tier;
    const gateId = newGateId();
    const audit = auditAction(input.action);

    // DECISION: a pure function of the grant — the action does NOT influence it.
    let governance: PromoteGovernance;
    if (!config.enabled) {
      governance = { allow: false, reason: "gate-wall disabled — denying (fail-closed)", gateId };
    } else if (audit.kind === "exec") {
      const action = input.action;
      const reason = action.kind === "exec" ? commandPolicyDenyReason(action.command, action.args, action.purpose) : undefined;
      if (reason !== undefined) governance = { allow: false, reason: `${reason} — denying (fail-closed)`, gateId };
      else if (input.grant.requiresApproval) {
        governance = {
          allow: false,
          reason: `tier ${tier} requires operator approval; approval mechanism not yet available — denying (fail-closed)`,
          gateId,
        };
      } else {
        governance = {
          allow: true,
          reason: `tier ${tier} permitted (gateLevel=${input.grant.gateLevel}, autoCommit=${input.grant.autoCommit})`,
          gateId,
        };
      }
    } else if (input.grant.requiresApproval) {
      governance = {
        allow: false,
        reason: `tier ${tier} requires operator approval; approval mechanism not yet available — denying (fail-closed)`,
        gateId,
      };
    } else {
      governance = {
        allow: true,
        reason: `tier ${tier} permitted (gateLevel=${input.grant.gateLevel}, autoCommit=${input.grant.autoCommit})`,
        gateId,
      };
    }

    const payload: GateEventPayload = { tier, kind: audit.kind, allow: governance.allow, reason: governance.reason ?? "", gateId };
    const attribution = { identity: input.identity, operation: GATE_OPERATION };
    publish(gateEvaluated.create(payload, { source: EVENT_SOURCE, attribution }));
    publish((governance.allow ? gateAllowed : gateDenied).create(payload, { source: EVENT_SOURCE, attribution }));

    // The EVALUATION succeeded (status "success") regardless of allow/deny — the
    // verdict lives in governance.allow / the recorded metadata. The action descriptor
    // records WHAT was gated (compact: exec logs command/argCount/sudo, not full args).
    await receipts.append(
      {
        operation: GATE_OPERATION,
        outcome: { status: "success", detail: `${audit.summary} → ${governance.allow ? "allow" : "deny"}` },
        metadata: { tier, action: audit.kind, allow: governance.allow, reason: governance.reason, gateId, ...audit.metadata },
        ...(audit.requestId !== undefined ? { requestId: audit.requestId } : {}),
        ...(audit.project !== undefined ? { project: audit.project } : {}),
      },
      input.identity,
    );

    return governance;
  }

  return { evaluate };
}

/** The default process-wide gate-wall, wired to the real frozen singletons. */
export const gateWall: GateWall = createGateWall();
