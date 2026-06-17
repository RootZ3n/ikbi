/**
 * ikbi trust — operator CLI: `ikbi trust grant <agent> <tier>` / `ikbi trust status <agent>`.
 *
 * `grant` is the COLD-START ON-RAMP (Blocker 1): a fresh worker resolves to the
 * untrusted floor (deliberate fail-closed) and untrusted/probation require approval,
 * so a never-seen worker is rejected on its first invocation. `grant` is an
 * OPERATOR-AUTHORIZED, durable, MAC-protected, logged override of that floor — it
 * sets a worker's initial tier so the next build resolves it as trusted (the grant
 * is SEEN because the CLI preloads trust state at startup; see `cli/index.ts`).
 *
 * `grant` is OPERATOR-GATED (resolve IKBI_OPERATOR_TOKEN → operator identity; the
 * trust system rejects a non-operator grant) and CEILING-CAPPED (cannot grant the
 * operator apex). `status` is a read-only tier lookup (helps the operator confirm a
 * grant landed). Registers at module-import time via the modules barrel.
 */

import { registerCommand } from "../../cli/registry.js";
import { config } from "../../core/config.js";
import { isTrustTier, type TrustTier } from "../../core/identity/contract.js";
import { resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { IdentityClaim, ValidatedIdentity } from "../../core/identity/index.js";
import { AGENT_CEILING, tierRank } from "../../core/trust/index.js";
import { trust as coreTrust } from "../../core/trust/index.js";
import type { TrustSystem } from "../../core/trust/index.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface TrustCliDeps {
  readonly trust?: TrustSystem;
  readonly resolveIdentity?: (claim: IdentityClaim) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  readonly defaultTrustTier?: string;
  /** The worker agent id `promote` targets by default. Default: config.identity.workerAgentId. */
  readonly workerAgentId?: string;
  /** Operator confirmation seam (`promote`). Default: prompt on a TTY; in a non-TTY fail closed
   *  (require `--yes`) — a durable promotion is never auto-confirmed by automation. */
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

export function createTrustCli(deps: TrustCliDeps = {}) {
  const trust = deps.trust ?? coreTrust;
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const defaultTrustTier = deps.defaultTrustTier ?? config.identity.workerTrustTier;
  const workerAgentId = deps.workerAgentId ?? config.identity.workerAgentId;
  const confirm = deps.confirm ?? defaultConfirm;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  function operator(): ValidatedIdentity | undefined {
    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi: no operator identity — set IKBI_OPERATOR_TOKEN\n");
      setExit(1);
      return undefined;
    }
    try {
      return resolveIdentity({ token: operatorToken });
    } catch (e) {
      err(`ikbi: operator identity resolution failed: ${errMsg(e)}\n`);
      setExit(1);
      return undefined;
    }
  }

  async function grant(argv: readonly string[]): Promise<void> {
    const agentId = argv[0];
    const tierArg = argv[1];
    if (agentId === undefined || agentId.length === 0 || tierArg === undefined) {
      err("ikbi: usage: ikbi trust grant <agentId> <tier>\n");
      setExit(1);
      return;
    }
    if (!isTrustTier(tierArg)) {
      err(`ikbi: "${tierArg}" is not a valid trust tier (trusted|verified|probation|untrusted)\n`);
      setExit(1);
      return;
    }
    // Ceiling cap (mirrors the trust system's gate) — reject the operator apex up front
    // with a clear message (lower rank = MORE trust; above the ceiling is not grantable).
    if (tierRank(tierArg) < tierRank(AGENT_CEILING)) {
      err(`ikbi: cannot grant tier "${tierArg}" — the operator apex is not grantable (ceiling is "${AGENT_CEILING}")\n`);
      setExit(1);
      return;
    }
    const who = operator();
    if (who === undefined) return;
    try {
      const state = await trust.grantTier({ agentId, kind: "agent", tier: tierArg as TrustTier, defaultTrustTier }, who);
      out(`trust granted: ${agentId} -> ${state.tier} (durable, MAC-protected)\n`);
    } catch (e) {
      err(`ikbi: trust grant rejected: ${errMsg(e)}\n`);
      setExit(1);
    }
  }

  /**
   * `ikbi trust promote [<agentId>] [--yes]` — the OPERATOR shortcut for the cold-start on-ramp
   * (Gap M18). A fresh worker resolves to the untrusted floor (fail-closed) and is rejected on its
   * first build ("approval required — refusing to write"); there was no friendly path off the floor
   * except `trust grant <agent> trusted`. `promote` is exactly that grant with the worker as the
   * default target and the agent ceiling ("trusted") as the tier — operator-gated (the operator
   * token IS the authorization), confirmed, durable, and MAC-protected (delegates to `grantTier`).
   */
  async function promote(argv: readonly string[]): Promise<void> {
    const auto = argv.includes("--yes") || argv.includes("-y");
    const positional = argv.find((a) => !a.startsWith("-"));
    const agentId = positional ?? workerAgentId;
    if (agentId === undefined || agentId.length === 0) {
      err("ikbi: usage: ikbi trust promote [<agentId>] [--yes]  (defaults to the configured worker)\n");
      setExit(1);
      return;
    }
    // Ceiling check (Codex C2): `promote` targets the agent ceiling ("trusted"), but an operator may
    // have LOWERED the effective ceiling for this worker (IKBI_WORKER_TRUST_TIER). Never promote
    // ABOVE the configured ceiling — fail closed with a clear message (lower rank = MORE trust).
    if (isTrustTier(defaultTrustTier) && tierRank(AGENT_CEILING) < tierRank(defaultTrustTier)) {
      err(`ikbi: cannot promote to "${AGENT_CEILING}" — ceiling is "${defaultTrustTier}"\n`);
      setExit(1);
      return;
    }
    const who = operator();
    if (who === undefined) return;
    if (!auto) {
      const ok = await confirm(`Promote "${agentId}" to "${AGENT_CEILING}" (durable, operator-authorized)? [y/N] `);
      if (!ok) {
        out(`trust promote: aborted (no change to ${agentId})\n`);
        return;
      }
    }
    try {
      const state = await trust.grantTier({ agentId, kind: "agent", tier: AGENT_CEILING, defaultTrustTier }, who);
      out(`trust promoted: ${agentId} -> ${state.tier} (durable, MAC-protected)\n`);
    } catch (e) {
      err(`ikbi: trust promote rejected: ${errMsg(e)}\n`);
      setExit(1);
    }
  }

  async function status(argv: readonly string[]): Promise<void> {
    const agentId = argv[0];
    if (agentId === undefined || agentId.length === 0) {
      err("ikbi: usage: ikbi trust status <agentId>\n");
      setExit(1);
      return;
    }
    const state = (await trust.loadState(agentId)) ?? trust.getState(agentId);
    if (state === undefined) {
      out(`${agentId}: no durable trust state (resolves to the cold floor until granted/earned)\n`);
      return;
    }
    out(`${agentId}: tier=${state.tier} (default=${state.defaultTrustTier}, injectionFlagged=${state.injectionFlagged})\n`);
  }

  async function dispatch(argv: readonly string[]): Promise<void> {
    const sub = argv[0];
    switch (sub) {
      case "grant":
        await grant(argv.slice(1));
        return;
      case "promote":
        await promote(argv.slice(1));
        return;
      case "status":
        await status(argv.slice(1));
        return;
      default:
        err("ikbi: usage: ikbi trust <grant|promote|status> ...\n");
        setExit(1);
    }
  }

  return { grant, promote, status, dispatch };
}

/** Default operator-confirmation prompt: ask on an interactive TTY. In a NON-TTY (automation, CI)
 *  we FAIL CLOSED — a durable trust promotion is never auto-confirmed; the caller must pass `--yes`
 *  to authorize it non-interactively (Codex C3). This keeps fail-closed as the default. */
async function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

const live = createTrustCli();
registerCommand({
  name: "trust",
  summary: "Operator trust grant / promote / status (the cold-start on-ramp)",
  usage: "ikbi trust grant <agent> <tier> | ikbi trust promote [<agent>] [--yes] | ikbi trust status <agent>",
  run: (argv) => live.dispatch(argv),
});
