/**
 * ikbi `doctor` — PLATFORM & SANDBOX checks (the "can this host run risky code safely?" half).
 *
 * `doctor.ts` reports CONFIG health and `doctor-env.ts` reports the toolchain (node/pm/git/disk).
 * This module answers the question a STRANGER on an unknown machine actually has on first run:
 *
 *   - Am I on a supported OS?
 *   - Is the bubblewrap sandbox present and DOES IT WORK on this host (user namespaces)?
 *   - What is the sandbox mode, and are any dangerous "trusted-local" overrides ON?
 *   - Concretely: when ikbi goes to run project code or install dependencies, will it run
 *     SANDBOXED, FAIL CLOSED, or run UNSANDBOXED via an override?
 *   - Are the state + receipts directories writable?
 *
 * Pure over an injectable `SandboxDoctorPorts` so it is unit-testable with no real OS access;
 * `liveSandboxDoctorPorts()` wires the production probes (the REAL `detectSandbox()` — which runs
 * a no-op under the actual policy — plus the loaded module configs and a writable probe).
 *
 * SECURITY: report-only. It never enables an override, never weakens the sandbox; it only DESCRIBES
 * the posture so an operator understands, before their first build, exactly what will and won't run.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { release, type as osType } from "node:os";

import { config } from "../core/config.js";
import { dependencyInstallConfig } from "../modules/dependency-install/config.js";
import { governedExecConfig } from "../modules/governed-exec/config.js";
import { detectSandbox, type SandboxAvailability } from "../modules/governed-exec/sandbox.js";

const OK = "✓";
const BAD = "✗";
const WARN = "⚠";

/** Severity of a platform/sandbox check. `required` failures block risky work; `recommended` warn. */
export type SandboxCheckLevel = "required" | "recommended" | "info";

export interface SandboxCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly level: SandboxCheckLevel;
  readonly detail?: string;
  /** A one-line guidance string, shown when `ok` is false OR when a dangerous override is on. */
  readonly fix?: string;
}

/** The OS/config surface the platform checks read. Injectable so tests need no real host access. */
export interface SandboxDoctorPorts {
  /** `process.platform` (e.g. "linux", "darwin", "win32"). */
  platform(): NodeJS.Platform;
  /** `os.type()` / `os.release()` for a human OS string. */
  osDescription(): string;
  /** The REAL sandbox probe — runs a no-op bwrap under the actual policy. */
  detectSandbox(): SandboxAvailability;
  /** Governed-exec sandbox posture (mode + trusted-local override). */
  governedExec(): { mode: "auto" | "off" | "required"; trustedLocalOverride: boolean };
  /** Dependency-install posture (mode + allowScripts + trusted-local override). */
  dependencyInstall(): { mode: "auto" | "off" | "required"; allowScripts: boolean; trustedLocalOverride: boolean };
  /** Directories whose writability matters (state + receipts). */
  dirs(): { stateRoot: string; receiptsDir: string };
  /** True iff `dir` is writable (or creatable) by this process. */
  isWritable(dir: string): boolean;
}

export interface SandboxDoctorInputs {
  readonly ports?: SandboxDoctorPorts;
}

/** A compact, human description of what will happen to RISKY project code on this host. */
export function riskyExecPrediction(
  avail: SandboxAvailability,
  ge: { mode: "auto" | "off" | "required"; trustedLocalOverride: boolean },
): { ok: boolean; level: SandboxCheckLevel; text: string; fix?: string } {
  if (avail.available) {
    return { ok: true, level: "info", text: `runs SANDBOXED (bwrap${avail.version ? ` ${avail.version}` : ""})` };
  }
  // No working sandbox from here on.
  if (ge.mode === "off") {
    return {
      ok: false,
      level: "recommended",
      text: "runs UNSANDBOXED — sandbox mode is 'off' (dev/tests only; NOT for real work)",
      fix: "unset IKBI_GOVERNED_EXEC_SANDBOX (back to 'auto') and install bubblewrap before running untrusted goals",
    };
  }
  if (ge.trustedLocalOverride) {
    return {
      ok: false,
      level: "recommended",
      text: "runs UNSANDBOXED via IKBI_GOVERNED_EXEC_TRUSTED_LOCAL (dangerous — every run is loudly receipted)",
      fix: "install bubblewrap and unset IKBI_GOVERNED_EXEC_TRUSTED_LOCAL — the override is only for a trusted single-operator box",
    };
  }
  // The safe default: no sandbox ⇒ refuse risky code.
  return {
    ok: false,
    level: "required",
    text: "FAILS CLOSED — risky project code is REFUSED (no OS sandbox available)",
    fix: "install bubblewrap (`sudo apt install bubblewrap` / `sudo dnf install bubblewrap`) and ensure user namespaces are enabled",
  };
}

/** A compact, human description of what will happen to a DEPENDENCY INSTALL on this host. */
export function dependencyInstallPrediction(
  avail: SandboxAvailability,
  di: { mode: "auto" | "off" | "required"; allowScripts: boolean; trustedLocalOverride: boolean },
): { ok: boolean; level: SandboxCheckLevel; text: string; fix?: string } {
  if (avail.available) {
    return {
      ok: true,
      level: "info",
      text: `installs SANDBOXED (bwrap)${di.allowScripts ? " with lifecycle scripts ENABLED" : " (lifecycle scripts off — --ignore-scripts)"}`,
    };
  }
  // No sandbox. Scripts-OFF installs run no untrusted code, so they proceed (receipted unavailable).
  if (!di.allowScripts) {
    return {
      ok: true,
      level: "recommended",
      text: "installs PROCEED with --ignore-scripts (no untrusted code runs); receipted as sandbox=unavailable",
      fix: "install bubblewrap for OS confinement; leave IKBI_DEPENDENCY_INSTALL_ALLOW_SCRIPTS=false unless a package must compile",
    };
  }
  // Scripts ON + no sandbox ⇒ fail closed, unless overridden.
  if (di.trustedLocalOverride) {
    return {
      ok: false,
      level: "recommended",
      text: "script-enabled installs run UNSANDBOXED via IKBI_DEPENDENCY_INSTALL_TRUSTED_LOCAL (dangerous)",
      fix: "install bubblewrap and unset IKBI_DEPENDENCY_INSTALL_TRUSTED_LOCAL",
    };
  }
  return {
    ok: false,
    level: "required",
    text: "script-enabled installs FAIL CLOSED (postinstall would be arbitrary code with no sandbox)",
    fix: "install bubblewrap, or set IKBI_DEPENDENCY_INSTALL_ALLOW_SCRIPTS=false to install without lifecycle scripts",
  };
}

/**
 * Run the platform/sandbox checks. Pure over its ports — no real OS access of its own.
 * Returns the structured checks and a count of ✗ (required + recommended).
 */
export function runSandboxChecks(inp: SandboxDoctorInputs = {}): {
  readonly checks: readonly SandboxCheck[];
  readonly issues: number;
} {
  const ports = inp.ports ?? liveSandboxDoctorPorts();
  const checks: SandboxCheck[] = [];

  // 1. Operating system
  const platform = ports.platform();
  const isLinux = platform === "linux";
  checks.push({
    id: "os",
    label: "Operating system",
    detail: `${ports.osDescription()} (${platform})`,
    ok: isLinux,
    level: isLinux ? "info" : "recommended",
    fix: "ikbi's OS sandbox (bubblewrap) is Linux-only; on macOS/Windows/WSL-without-userns risky code FAILS CLOSED — treat non-Linux as unsupported for risky execution",
  });

  // 2. Bubblewrap sandbox availability (the REAL probe — runs a no-op under the actual policy)
  const avail = ports.detectSandbox();
  checks.push({
    id: "bubblewrap",
    label: "Bubblewrap sandbox",
    detail: avail.available ? `working (${avail.tool} ${avail.version ?? "?"})` : (avail.reason ?? "unavailable"),
    ok: avail.available,
    // On Linux a missing sandbox is required-severity (risky code will fail closed); off-Linux it's
    // expected, so the OS check above already carries the warning and this stays recommended.
    level: avail.available ? "info" : isLinux ? "required" : "recommended",
    fix: isLinux
      ? "install bubblewrap and enable user namespaces (`sysctl kernel.unprivileged_userns_clone=1` on some distros)"
      : "bubblewrap is Linux-only — run ikbi's risky builds on Linux",
  });

  // 3. User namespaces — only meaningful when the binary is present but the no-op probe failed.
  const bwrapBinaryButProbeFailed = !avail.available && avail.reason !== undefined && /sandbox probe failed|namespaces/i.test(avail.reason);
  if (bwrapBinaryButProbeFailed) {
    checks.push({
      id: "userns",
      label: "User namespaces",
      detail: "bwrap present but the sandbox probe failed — user namespaces appear disabled",
      ok: false,
      level: "required",
      fix: "enable unprivileged user namespaces (distro-specific; e.g. `sudo sysctl -w kernel.unprivileged_userns_clone=1`)",
    });
  }

  // 4. Governed-exec sandbox mode + the concrete prediction for risky project code.
  const ge = ports.governedExec();
  checks.push({
    id: "governed-exec-mode",
    label: "Governed-exec sandbox mode",
    detail: ge.mode,
    ok: ge.mode !== "off",
    level: ge.mode === "off" ? "recommended" : "info",
    fix: "IKBI_GOVERNED_EXEC_SANDBOX=off disables OS confinement — for unit tests / non-Linux dev only, never real work",
  });
  const riskPred = riskyExecPrediction(avail, ge);
  checks.push({
    id: "risky-exec-prediction",
    label: "Risky project code will",
    detail: riskPred.text,
    ok: riskPred.ok,
    level: riskPred.level,
    ...(riskPred.fix ? { fix: riskPred.fix } : {}),
  });

  // 5. Dependency-install posture + prediction.
  const di = ports.dependencyInstall();
  const diPred = dependencyInstallPrediction(avail, di);
  checks.push({
    id: "dependency-install-prediction",
    label: "Dependency install will",
    detail: diPred.text,
    ok: diPred.ok,
    level: diPred.level,
    ...(diPred.fix ? { fix: diPred.fix } : {}),
  });

  // 6. Trusted-local overrides — DANGEROUS when on; surfaced loudly even though they're "ok" config.
  const overridesOn = ge.trustedLocalOverride || di.trustedLocalOverride;
  checks.push({
    id: "trusted-local-override",
    label: "Trusted-local override",
    detail: overridesOn
      ? `ON — ${[ge.trustedLocalOverride ? "governed-exec" : null, di.trustedLocalOverride ? "dependency-install" : null].filter(Boolean).join(" + ")} run UNSANDBOXED when no bwrap`
      : "off (safe default — risky work needs the sandbox)",
    ok: !overridesOn,
    level: overridesOn ? "recommended" : "info",
    fix: "unset IKBI_GOVERNED_EXEC_TRUSTED_LOCAL / IKBI_DEPENDENCY_INSTALL_TRUSTED_LOCAL unless this is a trusted single-operator box you fully control",
  });

  // 7. Writable state + receipts directories.
  const { stateRoot, receiptsDir } = ports.dirs();
  for (const [id, label, dir] of [
    ["state-dir-writable", "State directory writable", stateRoot],
    ["receipts-dir-writable", "Receipts directory writable", receiptsDir],
  ] as const) {
    const writable = ports.isWritable(dir);
    checks.push({
      id,
      label,
      detail: dir,
      ok: writable,
      level: writable ? "info" : "required",
      fix: `ensure ${dir} is writable (set IKBI_STATE_ROOT to a writable location), or run \`ikbi doctor --fix\``,
    });
  }

  const issues = checks.filter((c) => !c.ok && c.level !== "info").length;
  return { checks, issues };
}

/** Render the platform/sandbox checks as a printable section (no trailing newline). */
export function renderSandboxChecks(checks: readonly SandboxCheck[]): string {
  const lines: string[] = ["PLATFORM & SANDBOX"];
  for (const c of checks) {
    const mark = c.ok ? (c.level === "info" ? "·" : OK) : c.level === "required" ? BAD : WARN;
    const detail = c.detail !== undefined ? ` — ${c.detail}` : "";
    const fix = !c.ok && c.fix !== undefined ? `  → ${c.fix}` : "";
    lines.push(`  ${mark} ${c.label}${detail}${fix}`);
  }
  return lines.join("\n");
}

/** True iff `dir` (or its nearest existing ancestor) is writable by this process. */
function probeWritable(dir: string): boolean {
  let d = dir;
  for (let i = 0; i < 24; i++) {
    try {
      accessSync(d, fsConstants.W_OK);
      return true;
    } catch {
      const parent = d.replace(/\/[^/]+\/?$/, "");
      if (parent === d || parent === "") return false;
      d = parent;
    }
  }
  return false;
}

/** Wire the production ports (real platform, the real sandbox probe, loaded module configs). */
export function liveSandboxDoctorPorts(): SandboxDoctorPorts {
  return {
    platform: () => process.platform,
    osDescription: () => `${osType()} ${release()}`,
    detectSandbox: () => detectSandbox(),
    governedExec: () => ({
      mode: governedExecConfig.sandbox.mode,
      trustedLocalOverride: governedExecConfig.sandbox.trustedLocalOverride,
    }),
    dependencyInstall: () => ({
      mode: dependencyInstallConfig.sandboxMode,
      allowScripts: dependencyInstallConfig.allowScripts,
      trustedLocalOverride: dependencyInstallConfig.sandboxTrustedLocalOverride,
    }),
    dirs: () => ({ stateRoot: config.stateRoot, receiptsDir: config.receipt.dir }),
    isWritable: (dir) => probeWritable(dir),
  };
}
