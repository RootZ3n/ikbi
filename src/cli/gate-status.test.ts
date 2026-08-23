/**
 * Tests for the gate configuration diagnostic (src/cli/gate-status.ts).
 *
 * The diagnostic must ALWAYS show the governance posture before promotion-
 * relevant commands, and must emit a HARD warning whenever either bypass flag
 * is true — so an administratively-bypassed gate can never be mistaken for a
 * governed one. These tests pin the exact stderr lines.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { labTempDir as tmpdir } from "../core/temp-root.js";

import {
  gateStatusLines,
  printGateStatus,
} from "./gate-status.js";
import { loadGateWallConfig } from "../modules/gate-wall/config.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("resting state reports bypass=false, insecure=false, no warning", () => {
  withEnv(
    { IKBI_GATE_WALL_BYPASS: undefined, IKBI_ALLOW_INSECURE_DEV_KEYS: undefined },
    () => {
      const config = loadGateWallConfig();
      const lines = gateStatusLines();
      assert.ok(lines.some((l) => l.includes("bypass: false")));
      assert.ok(lines.some((l) => l.includes("insecure dev keys: false")));
      assert.ok(!lines.some((l) => l.includes("QUARANTINE MODE ACTIVE")));
      assert.ok(config.bypass === false);
    },
  );
});

test("bypass=true emits QUARANTINE MODE ACTIVE", () => {
  withEnv({ IKBI_GATE_WALL_BYPASS: "true" }, () => {
    const lines = gateStatusLines();
    assert.ok(lines.some((l) => l.includes("bypass: true")));
    assert.ok(lines.some((l) => l.includes("QUARANTINE MODE ACTIVE")));
    assert.ok(lines.some((l) => l.includes("promotion is forbidden")));
  });
});

test("insecure dev keys=true emits QUARANTINE MODE ACTIVE", () => {
  withEnv({ IKBI_ALLOW_INSECURE_DEV_KEYS: "true" }, () => {
    const lines = gateStatusLines();
    assert.ok(lines.some((l) => l.includes("insecure dev keys: true")));
    assert.ok(lines.some((l) => l.includes("QUARANTINE MODE ACTIVE")));
  });
});

test("source line reports shell override when env differs from .env file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-gate-status-"));
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "IKBI_GATE_WALL_BYPASS=false\n");
  const savedCwd = process.cwd();
  try {
    process.chdir(dir);
    withEnv({ IKBI_GATE_WALL_BYPASS: "true" }, () => {
      const lines = gateStatusLines();
      assert.ok(lines.some((l) => l.includes("source: shell override")));
    });
    withEnv({ IKBI_GATE_WALL_BYPASS: "false" }, () => {
      const lines = gateStatusLines();
      assert.ok(lines.some((l) => l.includes("source: .env (resting state)")));
    });
  } finally {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("printGateStatus writes to stderr, not stdout", () => {
  const savedErr = process.stderr.write;
  const savedOut = process.stdout.write;
  const errChunks: string[] = [];
  const outChunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any) => { errChunks.push(String(chunk)); return true; }) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any) => { outChunks.push(String(chunk)); return true; }) as any;
  try {
    withEnv({ IKBI_GATE_WALL_BYPASS: undefined, IKBI_ALLOW_INSECURE_DEV_KEYS: undefined }, () => {
      printGateStatus();
    });
  } finally {
    process.stderr.write = savedErr;
    process.stdout.write = savedOut;
  }
  assert.ok(errChunks.length > 0, "should write to stderr");
  assert.equal(outChunks.length, 0, "must never write to stdout");
});
