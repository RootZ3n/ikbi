/**
 * ikbi capability-recovery — the `ikbi recover <capability>` operator CLI command.
 *
 * A DIAGNOSTIC, NOT A REPAIR. The command resolves the operator identity, calls
 * `assess()`, and PRINTS the resulting CapabilityRecoveryPlan — "what broke, the likely
 * cause class, and which module should repair it". It NEVER executes the repair: the
 * module's recommends-never-invokes design holds at the command layer too (this file
 * imports no worker-model / governed-exec / dependency-install / gate-wall — the same
 * import-surface boundary the module enforces).
 *
 * Registers at module-import time (the modules barrel imports capability-recovery, which
 * imports this file). No built-in collision (version/models/providers/help).
 *
 * Fail-closed + friendly: a missing operator token prints a clear, actionable message and
 * exits non-zero BEFORE any assessment; never a raw stack.
 *
 * REAL INVOCATION (side-effecting — needs an operator token + model creds): `assess()`
 * makes one classification model call.
 *   IKBI_OPERATOR_TOKEN=<32+> IKBI_MIMO_API_KEY=<key> \
 *     pnpm build && node dist/cli/index.js recover test-execution --project demo
 *   Without a token/key it fails closed (a missing-history capability returns "unknown"
 *   with no model call).
 */

import { registerCommand } from "../../cli/registry.js";
import { config } from "../../core/config.js";
import { beginOperation, resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { IdentityClaim, ValidatedIdentity } from "../../core/identity/index.js";
import { capabilityRecovery as coreCapabilityRecovery } from "./recovery.js";
import type { CapabilityRecovery, CapabilityRecoveryPlan } from "./contract.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Parse `--project <p>` / `--project=<p>`; the rest is the capability name. */
export function parseRecoverArgs(argv: readonly string[]): { project?: string; rest: string[] } {
  const rest: string[] = [];
  let project: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--project") {
      project = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--project=")) {
      project = a.slice("--project=".length);
    } else {
      rest.push(a);
    }
  }
  return { ...(project !== undefined && project.length > 0 ? { project } : {}), rest };
}

/** A readable, non-leaky diagnosis summary (the cause CLASS + which module should repair). */
function summarize(plan: CapabilityRecoveryPlan): string {
  return `${JSON.stringify(
    {
      capability: plan.capability,
      status: plan.status,
      likelyCause: plan.likelyCause,
      causeConfidence: plan.causeConfidence,
      ...(plan.lastKnownGood !== undefined ? { lastKnownGood: plan.lastKnownGood } : {}),
      evidenceOfBreakage: plan.evidenceOfBreakage,
      rationale: plan.rationale,
      // The repair RECOMMENDATION — module + action only (a suggestion, never dispatched here).
      ...(plan.recommendedRepair !== undefined ? { recommendedRepair: { module: plan.recommendedRepair.module, action: plan.recommendedRepair.action } } : {}),
    },
    null,
    2,
  )}\n`;
}

/** Injectable surfaces so the command is testable without a live model/identity. */
export interface RecoverCliDeps {
  /** The assess surface. Default: the live capability-recovery planner. */
  readonly capabilityRecovery?: CapabilityRecovery;
  readonly resolveIdentity?: (claim: IdentityClaim) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  readonly now?: () => number;
}

/** Build the `recover` command handler. Defaults wire the live planner + identity. */
export function createRecoverCli(deps: RecoverCliDeps = {}) {
  const recovery = deps.capabilityRecovery ?? coreCapabilityRecovery;
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const now = deps.now ?? Date.now;

  async function recover(argv: readonly string[]): Promise<void> {
    const { project, rest } = parseRecoverArgs(argv);
    const capability = rest.join(" ").trim();
    if (capability.length === 0) {
      err("ikbi: recover needs a capability — usage: ikbi recover <capability> [--project <p>]\n");
      setExit(1);
      return;
    }
    // Fail-closed credential check BEFORE any assessment (assess makes a model call).
    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi: no operator identity — set IKBI_OPERATOR_TOKEN\n");
      setExit(1);
      return;
    }

    let who: ValidatedIdentity;
    try {
      who = resolveIdentity({ token: operatorToken });
    } catch (e) {
      err(`ikbi: operator identity resolution failed: ${errMsg(e)} — check IKBI_OPERATOR_TOKEN / the agents registry\n`);
      setExit(1);
      return;
    }

    const ctx = beginOperation(who, { requestId: `recover-${now()}` });
    try {
      // DIAGNOSE ONLY — assess() reads + classifies; the command prints the plan and STOPS.
      // It does NOT dispatch recommendedRepair (recommends-never-invokes).
      const plan = await recovery.assess({ parentCtx: ctx, capability, ...(project !== undefined ? { project } : {}) });
      out(summarize(plan));
    } catch (e) {
      err(`ikbi: recover failed: ${errMsg(e)} — check IKBI_MIMO_API_KEY / providers.json / network\n`);
      setExit(1);
    }
  }

  return { recover };
}

// Register the LIVE command at import time (the modules barrel triggers this).
const live = createRecoverCli();
registerCommand({
  name: "recover",
  summary: "Diagnose a broken capability and recommend which module should repair it (operator; non-executing)",
  usage: "ikbi recover <capability> [--project <p>]",
  run: (argv) => live.recover(argv),
});
