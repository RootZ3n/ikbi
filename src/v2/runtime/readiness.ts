/**
 * V2 DAILY-DRIVER READINESS (V2-018).
 *
 * `ikbi doctor --v2` answers one question for an operator about to make `ikbi build` their daily
 * driver: "will a governed v2 build actually be able to run on this host, with this configuration?"
 *
 * It is READ-ONLY and spends NO money: it never invokes a provider. Route readiness is resolved
 * exactly the way a real run resolves it — offline, from the declared inventory + operator defaults
 * (the V2-016 readiness rules) — so an unselectable builder/critic route is reported HERE rather than
 * surfacing three stages into a real build. There is NO fallback: a route is selectable or it is not.
 *
 * The pure `assessV2Readiness` classifies an injected probe's facts; `liveV2ReadinessProbe` assembles
 * the real host/config probes. Splitting them keeps the classification trivially testable with no host.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { resolveChecks } from "../../modules/checks/index.js";
import { governedExecConfig } from "../../modules/governed-exec/config.js";

import { buildRuntimeModelPolicy } from "../core/config.js";
import { createConfigurationSource } from "./index.js";

export type ReadinessLevel = "required" | "recommended";

export interface V2ReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly level: ReadinessLevel;
  readonly detail: string;
}

export interface V2ReadinessReport {
  /** Ready to daily-drive iff every REQUIRED check passes. Recommended misses are advisory. */
  readonly ready: boolean;
  readonly requiredIssues: number;
  readonly checks: readonly V2ReadinessCheck[];
}

/** One resolved role route, as the offline resolver sees it (no invocation). */
export interface RouteReadiness {
  readonly modelId: string;
  readonly satisfiable: boolean;
}

/** The host + configuration facts readiness classifies. Injected so the classifier needs no host. */
export interface V2ReadinessProbe {
  /** `git` is on PATH — v2 captures a source snapshot and allocates worktrees, both of which need it. */
  git(): boolean;
  /** `bwrap` is on PATH — the governed read-only terminal + governed-exec sandbox use it when enabled. */
  bwrap(): boolean;
  /**
   * V2-020/Phase 20: does the governed-exec allowlist actually PERMIT the verification commands
   * this repository would really run? A non-empty allowlist proved nothing — a repo whose checks
   * are `cargo test` still failed at execution time while doctor reported green. This resolves the
   * checks the way verification will (no execution, no spend) and answers about THOSE commands.
   */
  governedExecChecks(repoPath: string): GovernedExecReadiness;
  /** Resolve the builder + critic routes OFFLINE (the V2-016 readiness rules). Never invokes a model. */
  routes(): Promise<
    | { readonly ok: true; readonly builder: RouteReadiness | undefined; readonly critic: RouteReadiness | undefined }
    | { readonly ok: false; readonly detail: string }
  >;
}

/**
 * What the governed-exec readiness probe answers (V2-020/Phase 20).
 *
 *   resolved   the checks verification would run were derived from the repository.
 *   permitted  every one of their command programs is on the governed-exec allowlist.
 *
 * The distinction is the whole point: `resolved: false` means this host cannot say what would run
 * (no manifest, no IKBI_CHECKS) — DEGRADED, not broken. `resolved: true, permitted: false` means we
 * know exactly what would run and it would be REFUSED at execution time — that is NOT READY, and it
 * is precisely the state the old "is the allowlist non-empty?" check reported as green.
 */
export interface GovernedExecReadiness {
  readonly resolved: boolean;
  readonly permitted: boolean;
  /** The check programs that would run (e.g. ["pnpm"]), when resolvable. */
  readonly programs: readonly string[];
  /** The subset NOT on the allowlist. */
  readonly denied: readonly string[];
  /** Why the checks could not be resolved, when they could not. */
  readonly reason?: string;
}

/**
 * Classify readiness from probed facts. Pure: no host, no network, no config load of its own.
 */
export async function assessV2Readiness(probe: V2ReadinessProbe, repoPath: string = process.cwd()): Promise<V2ReadinessReport> {
  const checks: V2ReadinessCheck[] = [];

  const git = probe.git();
  checks.push({
    name: "git",
    ok: git,
    level: "required",
    detail: git ? "git is available" : "git not found on PATH — v2 source snapshots + isolated worktrees require it",
  });

  const bwrap = probe.bwrap();
  checks.push({
    name: "bwrap",
    ok: bwrap,
    level: "recommended",
    detail: bwrap
      ? "bubblewrap is available — the governed read-only terminal + governed-exec sandbox can confine execution"
      : "bubblewrap (bwrap) not found — governed execution falls closed where a sandbox is required (a build with no terminal/exec can still run)",
  });

  // V2-020/Phase 20: prove the REAL check commands are permitted, not merely that a list exists.
  const gx = probe.governedExecChecks(repoPath);
  checks.push({
    name: "governed-exec",
    // Unresolvable checks are DEGRADED (recommended), not a hard stop: this host simply cannot say
    // what would run here. A KNOWN-and-DENIED command is a hard stop, because the build would fail.
    ok: gx.resolved ? gx.permitted : true,
    level: gx.resolved && !gx.permitted ? "required" : "recommended",
    detail: !gx.resolved
      ? `DEGRADED — cannot derive this project's checks (${gx.reason ?? "no manifest and no IKBI_CHECKS"}), so allowlist coverage is unproven`
      : gx.permitted
        ? `the checks that would run (${gx.programs.join(", ")}) are all permitted by governed-exec`
        : `NOT READY — verification would run ${gx.denied.join(", ")}, which governed-exec would REFUSE; add to IKBI_GOVERNED_EXEC_ALLOWLIST`,
  });

  const routes = await probe.routes();
  if (!routes.ok) {
    checks.push({ name: "builder route", ok: false, level: "required", detail: `configuration could not be resolved: ${routes.detail}` });
    checks.push({ name: "critic route", ok: false, level: "required", detail: `configuration could not be resolved: ${routes.detail}` });
  } else {
    for (const [role, route] of [["builder", routes.builder], ["critic", routes.critic]] as const) {
      if (route === undefined) {
        checks.push({ name: `${role} route`, ok: false, level: "required", detail: `no ${role} model is configured (set the ${role} tier / profile role)` });
      } else {
        checks.push({
          name: `${role} route`,
          ok: route.satisfiable,
          level: "required",
          detail: route.satisfiable
            ? `${role} model '${route.modelId}' is selectable`
            : `${role} model '${route.modelId}' is NOT selectable (no registered/ready provider route) — fix the roster; there is NO fallback`,
        });
      }
    }
  }

  const requiredIssues = checks.filter((c) => c.level === "required" && !c.ok).length;
  return { ready: requiredIssues === 0, requiredIssues, checks };
}

/** Render the readiness report as a doctor section. Additive, human-first; `--json` is handled by the caller. */
export function renderV2Readiness(report: V2ReadinessReport): string {
  const lines = ["V2 DAILY-DRIVER READINESS (`ikbi build` — governed v2 engine)"];
  for (const c of report.checks) {
    const mark = c.ok ? "✓" : c.level === "required" ? "✗" : "•";
    lines.push(`  ${mark} ${c.name.padEnd(14)} ${c.detail}`);
  }
  lines.push(
    report.ready
      ? "  → READY — `ikbi build \"<goal>\"` can run on this host/config."
      : `  → NOT READY — ${report.requiredIssues} required check(s) failing; fix the ✗ items above.`,
  );
  lines.push("  note: v2 emits its session receipt to stdout (`--json` for the full record); durable session-resume is not implemented (see the audit manifest).");
  return lines.join("\n");
}

/** Assemble the REAL host + configuration probes. Reads config offline; invokes no provider. */
export function liveV2ReadinessProbe(): V2ReadinessProbe {
  const onPath = (program: string, arg: string): boolean => {
    try {
      const r = spawnSync(program, [arg], { stdio: "ignore" });
      return r.status === 0 || (r.error === undefined && r.status !== null);
    } catch {
      return false;
    }
  };
  return {
    git: () => onPath("git", "--version"),
    bwrap: () => onPath("bwrap", "--version"),
    governedExecChecks: (repoPath: string): GovernedExecReadiness => {
      // Resolve the checks EXACTLY as verification will — same neutral discovery module, same
      // operator precedence — then compare their programs against the live allowlist. Nothing is
      // executed and no provider is contacted: this is a policy question, answered offline.
      let real: string;
      try {
        real = realpathSync(repoPath);
      } catch {
        return { resolved: false, permitted: false, programs: [], denied: [], reason: "the repository path is not readable" };
      }
      const resolution = resolveChecks(real, process.env);
      if (!resolution.ok) {
        return { resolved: false, permitted: false, programs: [], denied: [], reason: resolution.reason };
      }
      const programs = [...new Set(resolution.checks.map((c) => c.command))];
      const allowed = new Set(governedExecConfig.allowlist);
      const denied = programs.filter((p) => !allowed.has(p));
      return { resolved: true, permitted: denied.length === 0, programs, denied };
    },
    routes: async () => {
      try {
        const inputs = await createConfigurationSource().load({});
        const built = buildRuntimeModelPolicy(inputs);
        if (!built.ok) return { ok: false as const, detail: built.failure.message };
        const find = (role: string): RouteReadiness | undefined => {
          const pref = built.policy.rolePreferences.find((p) => p.role === role);
          return pref === undefined ? undefined : { modelId: pref.modelId, satisfiable: pref.satisfiable };
        };
        return { ok: true as const, builder: find("builder"), critic: find("critic") };
      } catch (err) {
        return { ok: false as const, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** `ikbi doctor --v2` — print the readiness report; exit non-zero when a required check fails. */
export async function runV2ReadinessCli(
  argv: readonly string[],
  io: { readonly stdout?: (s: string) => void; readonly probe?: V2ReadinessProbe } = {},
): Promise<number> {
  const out = io.stdout ?? ((s: string) => process.stdout.write(s));
  const report = await assessV2Readiness(io.probe ?? liveV2ReadinessProbe());
  if (argv.includes("--json")) {
    out(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    out(`${renderV2Readiness(report)}\n`);
  }
  return report.ready ? 0 : 1;
}
