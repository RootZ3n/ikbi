/**
 * Tests for the doctor PLATFORM & SANDBOX checks — the first-run "can this host run risky code
 * safely?" report. Pure over injected ports, so no real OS access / no real bwrap is needed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runSandboxChecks,
  renderSandboxChecks,
  riskyExecPrediction,
  dependencyInstallPrediction,
  type SandboxDoctorPorts,
} from "./doctor-sandbox.js";
import type { SandboxAvailability } from "../modules/governed-exec/sandbox.js";

/** A baseline healthy Linux host with a working bwrap and safe defaults. */
function ports(overrides: Partial<{
  platform: NodeJS.Platform;
  avail: SandboxAvailability;
  ge: { mode: "auto" | "off" | "required"; trustedLocalOverride: boolean };
  di: { mode: "auto" | "off" | "required"; allowScripts: boolean; trustedLocalOverride: boolean };
  writable: boolean;
}> = {}): SandboxDoctorPorts {
  const platform = overrides.platform ?? "linux";
  const avail = overrides.avail ?? { available: true, tool: "bwrap", version: "0.11.0" };
  const ge = overrides.ge ?? { mode: "auto", trustedLocalOverride: false };
  const di = overrides.di ?? { mode: "auto", allowScripts: false, trustedLocalOverride: false };
  const writable = overrides.writable ?? true;
  return {
    platform: () => platform,
    osDescription: () => "Linux 7.0.0",
    detectSandbox: () => avail,
    governedExec: () => ge,
    dependencyInstall: () => di,
    dirs: () => ({ stateRoot: "/state", receiptsDir: "/state/receipts" }),
    isWritable: () => writable,
  };
}

const byId = (checks: ReturnType<typeof runSandboxChecks>["checks"], id: string) => {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `check ${id} present`);
  return c;
};

test("healthy Linux + working bwrap: zero issues, risky code runs SANDBOXED", () => {
  const { checks, issues } = runSandboxChecks({ ports: ports() });
  assert.equal(issues, 0, "no issues on a healthy host");
  assert.equal(byId(checks, "bubblewrap").ok, true);
  assert.match(byId(checks, "risky-exec-prediction").detail ?? "", /SANDBOXED/);
  assert.equal(byId(checks, "risky-exec-prediction").ok, true);
});

test("Linux, NO bwrap, safe defaults: risky code FAILS CLOSED (required)", () => {
  const avail: SandboxAvailability = { available: false, reason: "bwrap not found or not executable" };
  const { checks, issues } = runSandboxChecks({ ports: ports({ avail }) });
  assert.ok(issues >= 1);
  const bwrap = byId(checks, "bubblewrap");
  assert.equal(bwrap.ok, false);
  assert.equal(bwrap.level, "required", "missing sandbox on Linux is a required failure");
  const risky = byId(checks, "risky-exec-prediction");
  assert.equal(risky.ok, false);
  assert.equal(risky.level, "required");
  assert.match(risky.detail ?? "", /FAILS CLOSED/);
  // scripts-off installs still proceed (no untrusted code) — not a hard failure.
  assert.match(byId(checks, "dependency-install-prediction").detail ?? "", /PROCEED with --ignore-scripts/);
});

test("Linux, bwrap present but user namespaces disabled: surfaces a userns check", () => {
  const avail: SandboxAvailability = { available: false, reason: "bwrap present (0.11.0) but a sandbox probe failed (user namespaces disabled?): ..." };
  const { checks } = runSandboxChecks({ ports: ports({ avail }) });
  const userns = byId(checks, "userns");
  assert.equal(userns.ok, false);
  assert.equal(userns.level, "required");
});

test("non-Linux: OS is a recommended warning, missing bwrap is NOT required-severity", () => {
  const avail: SandboxAvailability = { available: false, reason: "bwrap not found or not executable" };
  const { checks } = runSandboxChecks({ ports: ports({ platform: "darwin", avail }) });
  const os = byId(checks, "os");
  assert.equal(os.ok, false);
  assert.equal(os.level, "recommended");
  assert.equal(byId(checks, "bubblewrap").level, "recommended", "off-Linux, the OS check carries the warning");
});

test("trusted-local override ON is surfaced as a warning and weakens the prediction", () => {
  const avail: SandboxAvailability = { available: false, reason: "bwrap not found" };
  const { checks } = runSandboxChecks({ ports: ports({ avail, ge: { mode: "auto", trustedLocalOverride: true } }) });
  const override = byId(checks, "trusted-local-override");
  assert.equal(override.ok, false);
  assert.match(override.detail ?? "", /ON/);
  const risky = byId(checks, "risky-exec-prediction");
  assert.match(risky.detail ?? "", /UNSANDBOXED via/);
  assert.equal(risky.level, "recommended", "override downgrades fail-closed to a (dangerous) run — not a hard block");
});

test("sandbox mode 'off' reports risky code runs UNSANDBOXED (dev/tests only)", () => {
  const avail: SandboxAvailability = { available: false, reason: "n/a" };
  const { checks } = runSandboxChecks({ ports: ports({ avail, ge: { mode: "off", trustedLocalOverride: false } }) });
  assert.equal(byId(checks, "governed-exec-mode").ok, false);
  assert.match(byId(checks, "risky-exec-prediction").detail ?? "", /UNSANDBOXED/);
});

test("non-writable state/receipts dir is a required failure", () => {
  const { checks } = runSandboxChecks({ ports: ports({ writable: false }) });
  assert.equal(byId(checks, "state-dir-writable").ok, false);
  assert.equal(byId(checks, "state-dir-writable").level, "required");
  assert.equal(byId(checks, "receipts-dir-writable").ok, false);
});

test("dependency install with scripts ON + no sandbox + no override: FAILS CLOSED", () => {
  const r = dependencyInstallPrediction(
    { available: false, reason: "no bwrap" },
    { mode: "auto", allowScripts: true, trustedLocalOverride: false },
  );
  assert.equal(r.ok, false);
  assert.equal(r.level, "required");
  assert.match(r.text, /FAIL CLOSED/);
});

test("riskyExecPrediction: sandboxed when available", () => {
  const r = riskyExecPrediction({ available: true, tool: "bwrap", version: "0.11.0" }, { mode: "auto", trustedLocalOverride: false });
  assert.equal(r.ok, true);
  assert.match(r.text, /SANDBOXED/);
});

test("renderSandboxChecks prints the section header and a line per check", () => {
  const { checks } = runSandboxChecks({ ports: ports() });
  const out = renderSandboxChecks(checks);
  assert.match(out, /^PLATFORM & SANDBOX/);
  assert.match(out, /Operating system/);
  assert.match(out, /Bubblewrap sandbox/);
  assert.match(out, /Risky project code will/);
  assert.match(out, /Dependency install will/);
});
