import assert from "node:assert/strict";
import { test } from "node:test";

import { runEnvironmentChecks, renderEnvironmentChecks, type DoctorEnvPorts, type EnvCheck } from "./doctor-env.js";
import { detectProject, type DetectPorts } from "../modules/project-detection/index.js";

function detectFor(files: Record<string, string>) {
  const abs = new Map<string, string>();
  for (const [rel, content] of Object.entries(files)) abs.set(`/repo/${rel}`, content);
  const ports: DetectPorts = { exists: (p) => abs.has(p), readText: (p) => abs.get(p) };
  return () => detectProject("/repo", ports);
}

/** A healthy host running a TS project, with overrides for individual ports. */
function ports(over: Partial<DoctorEnvPorts> = {}): DoctorEnvPorts {
  const detect = detectFor({
    "package.json": JSON.stringify({ devDependencies: { typescript: "5" } }),
    "tsconfig.json": "{}",
    "pnpm-lock.yaml": "",
  });
  return {
    nodeVersion: () => "v22.3.0",
    onPath: (cmd) => ["pnpm", "npm", "tsc", "git"].includes(cmd),
    isGitRepo: () => true,
    exists: () => true,
    diskFreeBytes: () => 50 * 1024 ** 3,
    detect: () => detect(),
    ...over,
  };
}

function byId(checks: readonly EnvCheck[], id: string): EnvCheck {
  const c = checks.find((x) => x.id === id);
  assert.ok(c !== undefined, `check ${id} present`);
  return c!;
}

test("a healthy host has zero issues", () => {
  const { checks, issues } = runEnvironmentChecks({ projectRoot: "/repo", ports: ports() });
  assert.equal(issues, 0);
  assert.equal(byId(checks, "node").ok, true);
  assert.equal(byId(checks, "package-manager").ok, true);
  assert.equal(byId(checks, "git").ok, true);
});

test("at least 8 checks are produced", () => {
  const { checks } = runEnvironmentChecks({ projectRoot: "/repo", ports: ports() });
  assert.ok(checks.length >= 8, `got ${checks.length} checks`);
});

test("old Node fails the required check with a fix", () => {
  const { checks } = runEnvironmentChecks({ projectRoot: "/repo", ports: ports({ nodeVersion: () => "v16.20.0" }) });
  const node = byId(checks, "node");
  assert.equal(node.ok, false);
  assert.equal(node.level, "required");
  assert.match(node.fix ?? "", /Node 18/);
});

test("no package manager is a required failure", () => {
  const { checks, issues } = runEnvironmentChecks({ projectRoot: "/repo", ports: ports({ onPath: () => false }) });
  assert.equal(byId(checks, "package-manager").ok, false);
  assert.ok(issues >= 1);
});

test("not a git repo warns (recommended), not required", () => {
  const { checks } = runEnvironmentChecks({ projectRoot: "/repo", ports: ports({ isGitRepo: () => false }) });
  const git = byId(checks, "git");
  assert.equal(git.ok, false);
  assert.equal(git.level, "recommended");
});

test("low disk warns", () => {
  const { checks } = runEnvironmentChecks({ projectRoot: "/repo", ports: ports({ diskFreeBytes: () => 100 * 1024 ** 2 }) });
  assert.equal(byId(checks, "disk").ok, false);
});

test("tsc missing is a ✗ only because TypeScript was detected", () => {
  const { checks } = runEnvironmentChecks({ projectRoot: "/repo", ports: ports({ onPath: (c) => c !== "tsc" }) });
  const tsc = byId(checks, "lsp:tsc");
  assert.equal(tsc.ok, false);
  assert.equal(tsc.level, "recommended");
  // gopls is irrelevant (no Go) → not a failure even though it's missing.
  assert.equal(byId(checks, "lsp:gopls").ok, true);
  assert.equal(byId(checks, "lsp:gopls").level, "info");
});

test("project detection appears as an info line", () => {
  const { checks, detection } = runEnvironmentChecks({ projectRoot: "/repo", ports: ports() });
  assert.equal(byId(checks, "project").level, "info");
  assert.equal(detection.primaryLanguage, "TypeScript");
});

test("renderEnvironmentChecks marks ✗ for failed required checks and prints fixes", () => {
  const { checks } = runEnvironmentChecks({ projectRoot: "/repo", ports: ports({ nodeVersion: () => "v16.0.0" }) });
  const out = renderEnvironmentChecks(checks);
  assert.match(out, /ENVIRONMENT/);
  assert.match(out, /✗ Node\.js/);
  assert.match(out, /→ ikbi needs Node 18/);
});
