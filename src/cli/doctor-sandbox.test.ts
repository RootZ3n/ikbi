/**
 * Tests for the doctor PLATFORM & SANDBOX checks — the first-run "can this host run risky code
 * safely?" report. Pure over injected ports, so no real OS access / no real bwrap is needed.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  runSandboxChecks,
  renderSandboxChecks,
  riskyExecPrediction,
  dependencyInstallPrediction,
  probeCreatablePath,
  probeExistingDirectoryWritable,
  probeReceiptDirectory,
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
    isExistingDirectoryWritable: () => writable,
    isCreatablePath: () => writable,
    probeReceiptDirectory: (path) => ({ path, state: writable ? "existing-writable" : "existing-unwritable", ready: writable }),
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

test("real probes require exact existing directories and retain creatable-parent semantics", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "ikbi-doctor-writability-"));
  const existing = join(root, "state");
  const notYetCreated = join(root, "future", "workspace");
  await mkdir(existing);
  try {
    assert.equal(probeExistingDirectoryWritable(existing), true);
    assert.equal(probeCreatablePath(existing), true);
    await chmod(existing, 0o555);
    assert.equal(probeExistingDirectoryWritable(existing), false);
    assert.equal(probeCreatablePath(existing), false, "a writable ancestor must not make an existing directory pass");
    assert.equal(probeExistingDirectoryWritable(notYetCreated), false);
    assert.equal(probeCreatablePath(notYetCreated), true, "a missing workspace root may use its writable parent");
  } finally {
    await chmod(existing, 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt probe accepts a missing exact path only when it is safely creatable, and doctor reports the same truth", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "ikbi-doctor-receipt-probe-"));
  const state = join(root, "state");
  const receipts = join(state, "receipts");
  const blockedParent = join(root, "blocked");
  const blockedReceipts = join(blockedParent, "receipts");
  const receiptFile = join(root, "receipt-file");
  await mkdir(state);
  await mkdir(blockedParent);
  await writeFile(receiptFile, "not a directory\n");
  try {
    assert.deepEqual(probeReceiptDirectory(receipts), { path: receipts, state: "missing-creatable", ready: true });
    const report = runSandboxChecks({
      ports: {
        ...ports(),
        dirs: () => ({ stateRoot: state, receiptsDir: receipts }),
        isExistingDirectoryWritable: (dir) => probeExistingDirectoryWritable(dir),
        isCreatablePath: (path) => probeCreatablePath(path),
        probeReceiptDirectory,
      },
    });
    assert.equal(byId(report.checks, "receipts-dir-writable").ok, true);
    assert.match(byId(report.checks, "receipts-dir-writable").detail ?? "", /missing; creatable/);

    await mkdir(receipts);
    assert.equal(probeReceiptDirectory(receipts).state, "existing-writable");
    await chmod(receipts, 0o555);
    try {
      const unwritable = probeReceiptDirectory(receipts);
      assert.equal(unwritable.state, "existing-unwritable", "an existing unwritable receipt directory is never rescued by its parent");
      assert.equal(unwritable.ready, false);
      assert.equal(probeReceiptDirectory(blockedReceipts).state, "missing-creatable", "the blocked-parent case is checked after its permission change");
    } finally {
      await chmod(receipts, 0o755);
    }

    await chmod(blockedParent, 0o555);
    try {
      assert.equal(probeReceiptDirectory(blockedReceipts).state, "missing-uncreatable");
      assert.equal(probeReceiptDirectory(receiptFile).state, "invalid-path");
    } finally {
      await chmod(blockedParent, 0o755);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
