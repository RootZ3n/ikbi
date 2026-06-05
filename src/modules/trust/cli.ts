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
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

export function createTrustCli(deps: TrustCliDeps = {}) {
  const trust = deps.trust ?? coreTrust;
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const defaultTrustTier = deps.defaultTrustTier ?? config.identity.workerTrustTier;
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
      case "status":
        await status(argv.slice(1));
        return;
      default:
        err("ikbi: usage: ikbi trust <grant|status> ...\n");
        setExit(1);
    }
  }

  return { grant, status, dispatch };
}

const live = createTrustCli();
registerCommand({
  name: "trust",
  summary: "Operator trust grant / status (the cold-start on-ramp)",
  usage: "ikbi trust grant <agent> <tier> | ikbi trust status <agent>",
  run: (argv) => live.dispatch(argv),
});
