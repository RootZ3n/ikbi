/**
 * ikbi `doctor` — a read-only bootstrap config self-check.
 *
 * Reads the already-parsed config (core + the relevant module configs) and reports,
 * grouped, which bootstrap settings are SET / MISSING / INSECURE-DEFAULT — so an agent
 * or operator driving cold can run ONE command to see "here's what's configured, here's
 * what's missing for a build, here's how to fix each gap", instead of discovering gaps
 * one failed run at a time.
 *
 * SECURITY: doctor reports STATUS ONLY — never a secret VALUE. Tokens and keys are
 * shown as set/unset, never printed. It needs no identity and no network (config only),
 * so it works BEFORE tokens are configured (which is the point).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { config, type IkbiConfig } from "../core/config.js";
import type { ModelProvider } from "../core/provider/contract.js";
import { registry as defaultRegistry } from "../core/provider/index.js";
import type { ModelSpec } from "../core/provider/registry.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
import { egressConfig } from "../modules/egress/config.js";
import { governedExecConfig } from "../modules/governed-exec/config.js";
import { workerModelConfig } from "../modules/worker-model/config.js";
import {
  isExplicitLegacyRetrieval,
  isExplicitLegacyVerify,
  resolveRetrievalMode,
  resolveVerificationMode,
  safetyPosture,
} from "../modules/worker-model/modes.js";
import { writeStdout } from "./io.js";
import { postureLines, productPosture } from "./posture.js";

/** The read-only registry surface doctor needs to check role-model resolution. */
export interface DoctorRegistry {
  getModel: (id: string) => ModelSpec | undefined;
  getProvider: (id: string) => ModelProvider | undefined;
}

/** The inputs doctor reads — all default to the process-wide singletons; injectable for tests. */
export interface DoctorInputs {
  readonly config?: IkbiConfig;
  readonly workerModelEnabled?: boolean;
  readonly governedExecAllowlist?: readonly string[];
  readonly egressAllowlist?: readonly string[];
  readonly egressLocalEndpoints?: readonly string[];
  /** The model registry (read-only) — to verify the role models resolve to a provider. */
  readonly registry?: DoctorRegistry;
  /** Env source for verification/retrieval mode reporting (tests inject). Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface DoctorResult {
  readonly lines: readonly string[];
  readonly ready: boolean;
  readonly missingRequired: number;
}

const OK = "✓";
const BAD = "✗";
const WARN = "⚠";

/** The binary the verifier needs to run tsc/tests (the build's quality gate). */
const REQUIRED_EXEC = "pnpm";

/** Build the doctor report. Pure over its inputs (singletons by default). */
export function runDoctor(inp: DoctorInputs = {}): DoctorResult {
  const cfg = inp.config ?? config;
  const workerEnabled = inp.workerModelEnabled ?? workerModelConfig.enabled;
  const execAllow = inp.governedExecAllowlist ?? governedExecConfig.allowlist;
  const egressAllow = inp.egressAllowlist ?? egressConfig.allowlist;
  const egressLocal = inp.egressLocalEndpoints ?? egressConfig.localEndpoints;
  const env = inp.env ?? process.env;

  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  // --- REQUIRED FOR A BUILD ------------------------------------------------
  const operatorSet = cfg.identity.operatorToken !== undefined && cfg.identity.operatorToken.length > 0;
  const workerSet = cfg.identity.workerToken !== undefined && cfg.identity.workerToken.length > 0;
  const execHasPnpm = execAllow.includes(REQUIRED_EXEC);

  // PROVIDER readiness is the REAL question: do the role models the roles will request
  // actually RESOLVE to a registered provider? This sees roster-declared providers (the
  // MiMo keyless+api-key case), built-in keyed providers, and mixed setups — not just the
  // env-key built-ins. Read-only: getModel/getProvider, no network, no invoke.
  const reg = inp.registry ?? defaultRegistry;
  const driverId = cfg.provider.defaultModels.driver;
  const builderId = cfg.provider.defaultModels.builder;
  const criticId = cfg.provider.defaultModels.critic;
  const competitive = cfg.provider.defaultModels.competitiveModels;
  const resolves = (spec: ModelSpec | undefined): boolean =>
    spec !== undefined && spec.providers.some((route) => reg.getProvider(route.provider) !== undefined);
  // ALL configured models must resolve: scout(driver) + builder + critic + every
  // competitive-list model (the shootout — the operator needs to know if a racer isn't wired).
  const modelChecks: Array<{ label: string; id: string; ok: boolean }> = [
    { label: "driver model", id: driverId, ok: resolves(reg.getModel(driverId)) },
    { label: "builder model", id: builderId, ok: resolves(reg.getModel(builderId)) },
    { label: "critic model", id: criticId, ok: resolves(reg.getModel(criticId)) },
    ...(competitive ?? []).map((id) => ({ label: "competitive model", id, ok: resolves(reg.getModel(id)) })),
  ];
  const broken = modelChecks.filter((m) => !m.ok);
  // Structural check: do role models resolve to registered providers? (checked via `broken` above)
  const providerEntry = broken.length === 0
    ? { ok: true, label: `provider — all role models resolve (driver '${driverId}', builder '${builderId}', critic '${criticId}'${competitive ? `, competitive ${competitive.map((m) => `'${m}'`).join(", ")}` : ""})`, fix: "" }
    : (() => {
        const verb = broken.length > 1 ? "don't" : "doesn't";
        return {
          ok: false,
          label: `the ${broken.map((m) => `${m.label} '${m.id}'`).join(" and ")} ${verb} resolve to a registered provider`,
          fix: "add a provider entry in the roster (providers.json) for it, or set a provider API key",
        };
      })();

  const required: Array<{ ok: boolean; label: string; fix: string }> = [
    { ok: operatorSet, label: "IKBI_OPERATOR_TOKEN", fix: "set it — the operator identity that grants trust / runs operator commands" },
    { ok: workerSet, label: "IKBI_WORKER_TOKEN", fix: "set it — the worker identity that builds run under" },
    { ok: workerEnabled, label: "IKBI_WORKER_MODEL_ENABLED", fix: "set true — builds are DISABLED until the worker-model substrate is enabled (e.g. export IKBI_WORKER_MODEL_ENABLED=true or add IKBI_WORKER_MODEL_ENABLED=true to your service env file)" },
    { ok: execHasPnpm, label: `IKBI_GOVERNED_EXEC_ALLOWLIST (has ${REQUIRED_EXEC})`, fix: `add "${REQUIRED_EXEC}" — the verifier needs it to run tsc/tests` },
    providerEntry,
  ];

  push("REQUIRED FOR A BUILD");
  let missingRequired = 0;
  for (const r of required) {
    if (r.ok) {
      push(`  ${OK} ${r.label}`);
    } else {
      missingRequired += 1;
      push(`  ${BAD} ${r.label} — ${r.fix}`);
    }
  }

  // --- SECURITY (trust-key gate: three states) -----------------------------
  // Each key is one of: SET (✓), DEFAULTED-but-explicitly-allowed (⚠, dev), or
  // DEFAULTED-and-blocking (✗). The blocking state cannot occur in a LIVE process —
  // the startup gate in loadConfig refuses to start there first — but doctor reports
  // config state, so an unopted-in default-keys config is surfaced as the blocker it is.
  push("");
  push("SECURITY");
  let securityBlockers = 0;
  const keyState = (isDefault: boolean, name: string, builtinDesc: string): void => {
    if (!isDefault) {
      push(`  ${OK} ${name} (set)`);
    } else if (cfg.allowInsecureDevKeys) {
      push(`  ${WARN} ${name} — running with insecure dev keys (${builtinDesc}); explicitly allowed via IKBI_ALLOW_INSECURE_DEV_KEYS.`);
    } else {
      securityBlockers += 1;
      push(`  ${BAD} ${name} — INSECURE default (${builtinDesc}); ikbi will refuse to start. Set ${name} or IKBI_ALLOW_INSECURE_DEV_KEYS=true.`);
    }
  };
  keyState(cfg.trust.hmacKeyIsDefault, "IKBI_TRUST_HMAC_KEY", "trust-state MAC uses a built-in key");
  keyState(cfg.identity.tokenSaltIsDefault, "IKBI_IDENTITY_TOKEN_SALT", "token hashing uses a built-in pepper");

  // --- SAFETY POSTURE (verification + retrieval paths) ---------------------
  // `ikbi build` runs through the PRODUCTION wiring (createProductionWorker ⇒ enforceProjectRoot),
  // so the modes an operator actually gets are the production-resolved ones. Report them
  // EXPLICITLY (no operator should have to read source/env to know which path runs) and WARN
  // on any legacy / un-hardened path so the real safety posture is visible from doctor alone.
  const verificationMode = resolveVerificationMode(env, { production: true });
  const retrievalMode = resolveRetrievalMode(env, { production: true });
  const posture = safetyPosture(verificationMode, retrievalMode);
  push("");
  push("SAFETY POSTURE");
  const vHardened = verificationMode === "ladder";
  const rHardened = retrievalMode === "index";
  push(`  ${vHardened ? OK : WARN} Verification: ${verificationMode}${vHardened ? " (HARDENED — stub detection, no-vacuous-green, scope-stamped)" : " — legacy checks (no stub/vacuous-green protection)"}`);
  push(`  ${rHardened ? OK : WARN} Retrieval: ${retrievalMode}${rHardened ? " (HARDENED — index-backed, goal-relevant)" : " — legacy 40-file scan (≈first 40 files only)"}`);
  push(`  ${posture === "HARDENED" ? OK : WARN} Posture: ${posture}`);
  if (!vHardened) push(`  ${WARN} verification is LEGACY — hardened ladder protections are DISABLED${isExplicitLegacyVerify(env) ? " (IKBI_VERIFY=legacy set)" : ""}; unset IKBI_VERIFY (or set =ladder) for the hardened default.`);
  if (!rHardened) push(`  ${WARN} retrieval is LEGACY — index retrieval is DISABLED${isExplicitLegacyRetrieval(env) ? " (IKBI_RETRIEVAL=legacy set)" : ""}; unset IKBI_RETRIEVAL (or set =index) for the hardened default.`);
  if (isExplicitLegacyVerify(env) || isExplicitLegacyRetrieval(env)) {
    push(`  ${WARN} a fallback/legacy mode is configured as the DEFAULT via env — the operator has explicitly opted OUT of a hardened path.`);
  }

  // --- PRODUCT SURFACES (classification + lifecycle truth) -----------------
  // The shared posture object (same one /capabilities, /status, and the HTTP /capabilities
  // endpoint read) so doctor discloses which surfaces are core vs experimental/dormant and which
  // lifecycle guarantees each editing surface actually provides — no surface overstates the spine.
  push("");
  push("PRODUCT SURFACES");
  for (const l of postureLines(productPosture({ env }))) push(l);

  // --- EGRESS --------------------------------------------------------------
  push("");
  push("EGRESS");
  push(`  ${egressAllow.length > 0 ? OK : WARN} IKBI_EGRESS_ALLOWLIST: ${egressAllow.length > 0 ? egressAllow.join(", ") : "(none — default-deny-all)"}`);
  push(`  ${egressLocal.length > 0 ? OK : "·"} IKBI_EGRESS_ALLOW_LOCAL: ${egressLocal.length > 0 ? egressLocal.join(", ") : "(none)"}`);
  push("  note: reaching a local model (e.g. Ollama) needs the host in the allowlist AND its ip:port in ALLOW_LOCAL AND a keyless provider.");

  // --- MODEL CONFIG (the ids the roles will request) -----------------------
  push("");
  push("MODEL CONFIG (resolved role models)");
  push(`  ${OK} IKBI_MODEL_DRIVER  = ${driverId}   (scout)`);
  push(`  ${OK} IKBI_MODEL_BUILDER = ${builderId}   (builder)`);
  push(`  ${OK} IKBI_MODEL_CRITIC  = ${criticId}   (critic)`);
  if (competitive !== undefined && competitive.length > 0) {
    push(`  ${OK} IKBI_COMPETITIVE_MODELS = ${competitive.join(", ")}   (head-to-head shootout)`);
  }

  // --- STATE ---------------------------------------------------------------
  push("");
  push("STATE");
  push(`  ${OK} IKBI_STATE_ROOT    = ${cfg.stateRoot}`);
  push(`  ${OK} trust dir          = ${cfg.trust.dir}`);
  push(`  ${OK} roster file        = ${cfg.provider.rosterFile}`);

  // --- SUMMARY -------------------------------------------------------------
  // A security blocker (insecure default key, no dev opt-in) is fatal to readiness
  // even when every required-for-build setting is present — ikbi would refuse to start.
  const ready = missingRequired === 0 && securityBlockers === 0;
  push("");
  if (ready) {
    push("ready to build");
  } else {
    const parts: string[] = [];
    if (missingRequired > 0) parts.push(`${missingRequired} required setting${missingRequired === 1 ? "" : "s"} missing`);
    if (securityBlockers > 0) parts.push(`${securityBlockers} insecure default key${securityBlockers === 1 ? "" : "s"} (refuse-to-start)`);
    push(`NOT ready — ${parts.join(" + ")} (see ${BAD} above)`);
  }

  return { lines, ready, missingRequired };
}

// ═══════════════════════════════════════════════════════════════════════════
// `ikbi doctor --fix` — automatic repair of common, SAFE-to-repair gaps.
//
// `runDoctor` above is READ-ONLY (and stays that way). `--fix` is the opt-in
// side-effecting twin: for each repairable gap it PRINTS what it is about to do,
// attempts the repair, then PRINTS the result, returning a non-zero exit code if
// any attempted repair failed.
//
// SAFETY CONTRACT:
//  - `--fix` is CREATE/REPAIR ONLY — it never deletes. The single destructive
//    repair (reclaiming stale workspaces) is gated behind `--fix --force`; without
//    `--force` it only REPORTS what could be reclaimed.
//  - Every side effect goes through an injectable PORT (DoctorFixPorts) so the
//    behavior is unit-testable with no real filesystem / process / git mutation.
// ═══════════════════════════════════════════════════════════════════════════

/** A package manager `--fix` can drive to install dependencies (lockfile-detected). */
export type PackageManager = "pnpm" | "npm" | "yarn";

/**
 * The side-effecting ports `runDoctorFix` drives. Each is injectable so tests can
 * assert the repair logic without touching the real filesystem, spawning a process,
 * or mutating git worktrees. `liveFixPorts()` wires the production implementations.
 */
export interface DoctorFixPorts {
  /** True iff a file or directory exists at `path`. */
  exists(path: string): boolean;
  /** Create a directory and any missing parents (mkdir -p). */
  mkdirp(path: string): Promise<void>;
  /** Write `content` to `path` (creating the file). Must not clobber an existing file. */
  writeFile(path: string, content: string): Promise<void>;
  /** Pick the package manager to install with, from the lockfile present in `projectRoot`. */
  detectManager(projectRoot: string): PackageManager;
  /** Install dependencies with `manager` in `projectRoot`. Resolves with ok + a short detail. */
  install(manager: PackageManager, projectRoot: string): Promise<{ ok: boolean; detail: string }>;
  /** Count stale (terminal, on-disk, not-yet-reclaimed) workspaces — non-destructive. */
  countStaleWorkspaces(): Promise<number>;
  /** Reclaim stale workspaces (the destructive `--force` path). */
  cleanWorkspaces(opts: { force: boolean }): Promise<{ removed: number; skipped: number }>;
}

/** Inputs to a `--fix` run — all default to the live singletons / process. */
export interface DoctorFixInputs {
  readonly config?: IkbiConfig;
  /** The project directory whose `.env` / `node_modules` / lockfile are inspected. Default: cwd. */
  readonly projectRoot?: string;
  /** When true, also perform the one DESTRUCTIVE repair: reclaim stale workspaces. */
  readonly force?: boolean;
}

export interface DoctorFixResult {
  readonly lines: readonly string[];
  /** How many repairs were ATTEMPTED (a healthy check is not counted). */
  readonly attempted: number;
  /** How many attempted repairs FAILED. */
  readonly failures: number;
  /** 0 if every attempted repair succeeded, 1 if any failed. */
  readonly exitCode: number;
}

/** The `.env` template `--fix` writes when no `.env` exists. */
export function envTemplate(): string {
  return [
    "# ikbi environment — created by `ikbi doctor --fix`.",
    "# Fill in the placeholder values, then re-run `ikbi doctor` to verify.",
    "#",
    "# SECURITY: the trust/identity SECRETS below are intentionally COMMENTED OUT.",
    "# ikbi REFUSES to load them from a project .env (see bootstrap CWD_DOTENV_FORBIDDEN_KEYS).",
    "# Put real secret values in ~/.ikbi/env or the install-root .env instead:",
    "#   IKBI_OPERATOR_TOKEN=<the operator identity that grants trust>",
    "#   IKBI_WORKER_TOKEN=<the worker identity builds run under>",
    "#   IKBI_TRUST_HMAC_KEY=<a strong random key — trust-state integrity>",
    "#   IKBI_IDENTITY_TOKEN_SALT=<a strong random salt — token hashing>",
    "",
    "# --- required for a build (safe to keep in a project .env) -----------------",
    "IKBI_WORKER_MODEL_ENABLED=true",
    "IKBI_GOVERNED_EXEC_ALLOWLIST=git,pnpm",
    "",
    "# --- model roster (resolved role models) -----------------------------------",
    "# IKBI_MODEL_DRIVER=mimo-v2.5",
    "# IKBI_MODEL_BUILDER=mimo-v2.5",
    "# IKBI_MODEL_CRITIC=deepseek-v4-pro",
    "# IKBI_COMPETITIVE_MODELS=",
    "",
    "# --- egress (default-deny; list the hosts a build may reach) ----------------",
    "# IKBI_EGRESS_ALLOWLIST=",
    "# IKBI_EGRESS_ALLOW_LOCAL=",
    "",
  ].join("\n");
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run `ikbi doctor --fix`: attempt to repair each common, safe-to-repair gap, printing
 * what it does and the outcome of each. PURE over its ports — no real I/O unless the live
 * ports are injected. The exit code is 0 iff every attempted repair succeeded.
 */
export async function runDoctorFix(ports: DoctorFixPorts, inp: DoctorFixInputs = {}): Promise<DoctorFixResult> {
  const cfg = inp.config ?? config;
  const projectRoot = inp.projectRoot ?? process.cwd();
  const force = inp.force ?? false;

  const lines: string[] = [];
  const push = (s: string) => lines.push(s);
  let attempted = 0;
  let failures = 0;

  push("ikbi doctor --fix — repairing common gaps (create/repair only; --force also reclaims stale workspaces)");

  // --- 1. .env file --------------------------------------------------------
  push("");
  push("ENV FILE");
  const envPath = join(projectRoot, ".env");
  if (ports.exists(envPath)) {
    push(`  ${OK} .env present — ${envPath} (leaving as-is)`);
  } else {
    attempted += 1;
    push(`  … creating .env template — ${envPath}`);
    try {
      await ports.writeFile(envPath, envTemplate());
      push(`  ${OK} created .env template — fill in the placeholders (secret keys go in ~/.ikbi/env, not here)`);
    } catch (err) {
      failures += 1;
      push(`  ${BAD} failed to create .env: ${errMsg(err)}`);
    }
  }

  // --- 2. state directories ------------------------------------------------
  push("");
  push("STATE DIRECTORIES");
  const dirs: Array<{ label: string; path: string }> = [
    { label: "state root", path: cfg.stateRoot },
    { label: "trust dir", path: cfg.trust.dir },
    { label: "workspace root", path: cfg.workspace.root },
  ];
  for (const d of dirs) {
    if (ports.exists(d.path)) {
      push(`  ${OK} ${d.label} present — ${d.path}`);
    } else {
      attempted += 1;
      push(`  … creating ${d.label} (mkdir -p) — ${d.path}`);
      try {
        await ports.mkdirp(d.path);
        push(`  ${OK} created ${d.label}`);
      } catch (err) {
        failures += 1;
        push(`  ${BAD} failed to create ${d.label}: ${errMsg(err)}`);
      }
    }
  }

  // --- 3. dependencies (node_modules) --------------------------------------
  push("");
  push("DEPENDENCIES");
  const nodeModules = join(projectRoot, "node_modules");
  if (ports.exists(nodeModules)) {
    push(`  ${OK} node_modules present`);
  } else {
    attempted += 1;
    const manager = ports.detectManager(projectRoot);
    push(`  … node_modules missing — running \`${manager} install\` (lockfile-detected)…`);
    try {
      const r = await ports.install(manager, projectRoot);
      if (r.ok) {
        push(`  ${OK} ${manager} install completed`);
      } else {
        failures += 1;
        push(`  ${BAD} ${manager} install failed: ${r.detail}`);
      }
    } catch (err) {
      failures += 1;
      push(`  ${BAD} ${manager} install errored: ${errMsg(err)}`);
    }
  }

  // --- 4. stale workspaces (report-only without --force; reclaim with) -----
  push("");
  push("STALE WORKSPACES");
  if (!force) {
    // NON-DESTRUCTIVE: never delete without --force — only report what could be reclaimed.
    try {
      const n = await ports.countStaleWorkspaces();
      if (n === 0) {
        push(`  ${OK} no stale workspaces to reclaim`);
      } else {
        push(`  ${WARN} ${n} stale workspace(s) can be reclaimed — re-run \`ikbi doctor --fix --force\` to remove them (NOT removed without --force)`);
      }
    } catch (err) {
      // A failed inspection is not a failed REPAIR (nothing was attempted) — warn, don't fail.
      push(`  ${WARN} could not inspect stale workspaces: ${errMsg(err)}`);
    }
  } else {
    attempted += 1;
    push("  … --force: reclaiming stale workspaces…");
    try {
      const r = await ports.cleanWorkspaces({ force: true });
      push(`  ${OK} reclaimed ${r.removed} stale workspace(s)${r.skipped > 0 ? ` (${r.skipped} skipped)` : ""}`);
    } catch (err) {
      failures += 1;
      push(`  ${BAD} workspace reclamation failed: ${errMsg(err)}`);
    }
  }

  // --- summary -------------------------------------------------------------
  push("");
  if (failures === 0) {
    push(attempted === 0 ? `${OK} doctor --fix: nothing to repair — all checks healthy` : `${OK} doctor --fix: ${attempted} repair(s) applied, all succeeded`);
  } else {
    push(`${BAD} doctor --fix: ${failures} of ${attempted} repair(s) FAILED — see ${BAD} above`);
  }

  return { lines, attempted, failures, exitCode: failures === 0 ? 0 : 1 };
}

/** Detect the package manager from the lockfile present in `projectRoot` (defaults to pnpm). */
export function detectPackageManager(projectRoot: string, exists: (p: string) => boolean = existsSync): PackageManager {
  if (exists(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(join(projectRoot, "yarn.lock"))) return "yarn";
  if (exists(join(projectRoot, "package-lock.json"))) return "npm";
  return "pnpm"; // ikbi's own default toolchain
}

/** Spawn `<manager> install` in `cwd`, resolving with ok + a short (last-lines) detail on failure. */
function runInstall(manager: PackageManager, cwd: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(manager, ["install"], { cwd, stdio: ["ignore", "inherit", "pipe"] });
    let errTail = "";
    child.stderr?.on("data", (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-2000);
    });
    child.on("error", (e) => resolve({ ok: false, detail: e.message }));
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, detail: "" });
      else resolve({ ok: false, detail: `exit ${code ?? "?"}: ${errTail.trim().split("\n").slice(-3).join(" | ")}`.trim() });
    });
  });
}

/** Count stale workspaces: terminal records whose worktree dir still exists and is not yet reclaimed. */
async function countLiveStaleWorkspaces(exists: (p: string) => boolean = existsSync): Promise<number> {
  const records = await coreWorkspaces.list();
  return records.filter((r) => (r.state === "promoted" || r.state === "discarded" || r.state === "failed") && r.cleanedAt === undefined && exists(r.path)).length;
}

/** Wire the production side-effecting ports (real filesystem, child process, workspace manager). */
export function liveFixPorts(): DoctorFixPorts {
  return {
    exists: (p) => existsSync(p),
    mkdirp: async (p) => {
      await mkdir(p, { recursive: true });
    },
    // `flag: "wx"` — fail rather than clobber an existing .env (belt-and-suspenders over the exists() guard).
    writeFile: async (p, content) => {
      await writeFile(p, content, { encoding: "utf8", flag: "wx" });
    },
    detectManager: (root) => detectPackageManager(root),
    install: (manager, root) => runInstall(manager, root),
    countStaleWorkspaces: () => countLiveStaleWorkspaces(),
    cleanWorkspaces: async (opts) => {
      const r = await coreWorkspaces.cleanOrphans(opts);
      return { removed: r.removed, skipped: r.skipped };
    },
  };
}

/**
 * CLI driver for `ikbi doctor --fix [--force]`: build the live ports (unless injected),
 * run the repairs, print the report, and return the process exit code. Any unexpected
 * top-level error is converted to a one-line message + exit 1 (never a raw stack).
 */
export async function runDoctorFixCli(argv: readonly string[], deps: { ports?: DoctorFixPorts; out?: (s: string) => void } = {}): Promise<number> {
  const out = deps.out ?? writeStdout;
  const force = argv.includes("--force") || argv.includes("-f");
  try {
    const ports = deps.ports ?? liveFixPorts();
    const r = await runDoctorFix(ports, { force });
    out(`${r.lines.join("\n")}\n`);
    return r.exitCode;
  } catch (err) {
    out(`${BAD} doctor --fix: ${errMsg(err)}\n`);
    return 1;
  }
}
