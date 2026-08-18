/**
 * CHECK DISCOVERY — v1's deterministic `resolveChecks`, behind the v2 seam.
 *
 * WHAT IS ADOPTED. v1's `worker-model/checks.ts` is the mature, deterministic check
 * discovery in the codebase, and reimplementing it would be strictly worse. It:
 *
 *   - lets an OPERATOR declare checks via `IKBI_CHECKS` (a JSON array, never model-chosen,
 *     never read from the worktree) — the only sanctioned way to authorize commands;
 *   - otherwise detects the project type from its MANIFEST (pnpm/npm/yarn, cargo, go,
 *     pytest/unittest, dotnet, maven, gradle, godot) and emits a fixed, named command set;
 *   - FAILS CLOSED with an actionable reason when it cannot derive a runnable check — it
 *     never invents a command and never returns a vacuous "pass". Its project-root guard
 *     even refuses when the nearest manifest is an ANCESTOR (the wrong repo), so a
 *     workspace nested inside ikbi's own tree cannot accidentally run ikbi's suite.
 *
 * WHY REPOSITORY PROSE IS NOT CONSULTED. Only `IKBI_CHECKS` (operator config) or a
 * structured manifest may authorize a command. Repository text is data for the builder,
 * never execution authority — a candidate file that says "run rm -rf" is a string, not a
 * check. `resolveChecks` reflects exactly that: it reads manifests and the operator env,
 * never free-form instructions.
 *
 * The v2 shape is thinner than v1's: v2 needs only "which named commands, or a reason
 * none", so the rich v1 `ChecksResolution` (with warnings and env/default provenance) is
 * mapped down to `ResolvedChecks`.
 */

import { realpathSync } from "node:fs";

import { resolveChecks } from "../../modules/worker-model/checks.js";
import type { ChecksSource, ResolvedChecks } from "../core/verification.js";

/**
 * Build THE check discovery source.
 *
 * `env` is captured so the operator's `IKBI_CHECKS` is honoured. A workspace path is
 * realpath'd first, exactly as the donor expects, so its ANCESTOR-manifest guard compares
 * canonical paths.
 */
export function createChecksSource(env: NodeJS.ProcessEnv = process.env): ChecksSource {
  return {
    async resolve(workspacePath: string): Promise<ResolvedChecks> {
      let real: string;
      try {
        real = realpathSync(workspacePath);
      } catch (err) {
        return { ok: false, reason: `the candidate workspace is not readable: ${err instanceof Error ? err.message : String(err)}` };
      }
      const resolution = resolveChecks(real, env);
      if (!resolution.ok) return { ok: false, reason: resolution.reason };
      // Drop v1's warning/provenance richness to the v2 shape. `source` is env vs default.
      return {
        ok: true,
        source: resolution.source === "env" ? "env" : "default",
        checks: resolution.checks.map((c) => ({ name: c.name, command: c.command, args: [...c.args] })),
      };
    },
  };
}
