/**
 * CHECK DISCOVERY — the neutral `modules/checks` `resolveChecks`, behind the v2 seam.
 *
 * WHAT IS ADOPTED. `modules/checks` is the neutral, deterministic check discovery in the
 * codebase (extracted from the retired v1 pipeline in V2-020 so the one production engine does not
 * depend on v1-owned code), and reimplementing it would be strictly worse. It:
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

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { resolveChecks } from "../../modules/checks/index.js";
import { VERIFICATION_DEFINITION_FILES, bindVerificationDefinitionScope, type ChecksSource, type ResolvedChecks, type VerificationDefinition, type VerificationDefinitionProbe } from "../core/verification.js";

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

/**
 * THE verification-definition probe (V2-016A/B4, extended by V2-019/HIGH-03).
 *
 * TWO BANDS are fingerprinted, because a candidate can redefine its exam in two different ways:
 *
 *   1. MANIFEST BAND — the well-known verification-definition artifacts at the workspace ROOT
 *      (package.json scripts, build/test manifests and config), by sha256 or `null` when absent.
 *      This catches a candidate rewriting `"test": "..."` itself.
 *
 *   2. REFERENCED BAND (HIGH-03) — the repo-local paths the resolved check command DIRECTLY
 *      references. A manifest may delegate the whole verdict to a file (`"test": "node
 *      test-policy.js"`); fingerprinting only the manifest would let a candidate flip that file
 *      from `exit 1` to `exit 0` and collect a PASS with the manifest untouched.
 *
 * SOURCE IS AUTHORITY. On the SOURCE capture `bindPaths` is omitted, so the probe resolves the
 * checks itself and DERIVES the bound set. On the CANDIDATE capture the caller passes the set the
 * source bound, so both sides are hashed over identical paths — a candidate cannot shrink its own
 * exam by deleting a reference, and a path it CREATES shows up as `null → hash`.
 *
 * It reads ONLY definition artifacts and directly-referenced verifier scripts, never test files.
 */
export function createVerificationDefinitionProbe(env: NodeJS.ProcessEnv = process.env): VerificationDefinitionProbe {
  const checksSource = createChecksSource(env);
  const sha = (path: string): string | null => {
    try {
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      return null; // absent (or unreadable) — recorded as null, compared exactly.
    }
  };
  return {
    async capture(workspacePath: string, bindPaths?: readonly string[]): Promise<VerificationDefinition> {
      let real: string;
      try {
        real = realpathSync(workspacePath);
      } catch {
        real = workspacePath;
      }
      const files: Record<string, string | null> = {};
      for (const name of VERIFICATION_DEFINITION_FILES) files[name] = sha(join(real, name));

      // The CANDIDATE capture: hash exactly the paths the source bound. Nothing is re-derived
      // from the candidate, so the candidate has no say in what its own exam consists of.
      if (bindPaths !== undefined) {
        const referencedPaths: Record<string, string | null> = {};
        for (const rel of bindPaths) referencedPaths[rel] = sha(join(real, rel));
        return { files, referencedPaths };
      }

      // The SOURCE capture: resolve the exam, then bind the repo-local paths that DEFINE it.
      const resolved = await checksSource.resolve(real);
      if (!resolved.ok) return { files, referencedPaths: {} };
      const scope = bindVerificationDefinitionScope({ checks: resolved.checks, scripts: manifestScripts(real) });
      const referencedPaths: Record<string, string | null> = {};
      for (const rel of scope.referencedPaths) referencedPaths[rel] = sha(join(real, rel));
      return { files, referencedPaths, ...(scope.unresolved.length > 0 ? { unresolvedDefinitions: scope.unresolved } : {}) };
    },
  };
}

/**
 * The SOURCE manifest's `scripts` map, for following `pnpm test` → `"test": "node x.js"`. Only
 * package.json is consulted: it is the one manifest in the supported set whose exam is a string
 * that can name another repository file. A missing/malformed manifest yields an empty map, which
 * simply means there is no script indirection to follow.
 */
function manifestScripts(repoRoot: string): Readonly<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}
