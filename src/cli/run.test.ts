import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Provider singletons require the egress guard to be registered before CLI/config imports.
import "../modules/egress/index.js";

import { config, type IkbiConfig } from "../core/config.js";
import type { Receipt } from "../core/receipt/contract.js";
import type { ProviderPreflightReport } from "../core/provider/preflight.js";
import type { ValidatedIdentity } from "../core/identity/index.js";
import type { WorkerResult } from "../modules/worker-model/contract.js";
import { runGit } from "../core/workspace/git.js";
import {
  preflightRun,
  runCanonical,
  type RunPreflightDeps,
} from "./run.js";
import { HELP_PAGES } from "./help-pages.js";

const SECRET = "run-test-secret-token-0123456789";

function providerReport(status: "ready" | "blocked", issueMessage?: string): ProviderPreflightReport {
  const issue = issueMessage === undefined ? [] : [{
    code: "PROVIDER_CREDENTIAL_MISSING" as const,
    role: "builder",
    provider: "test-provider",
    model: "test-model",
    message: issueMessage,
    retryable: false,
    blocksBuild: true,
    recovery: `Set the provider token ${SECRET} and rerun.`,
    configurationSource: "test",
  }];
  return {
    command: "doctor.checkProviders",
    status,
    localOnly: true,
    remoteReachability: "not_checked",
    resolvedConfiguration: { sources: [], providerRosterSource: "test-roster" },
    roles: [],
    issues: issue,
    recovery: issue.length > 0 ? [issue[0]!.recovery] : [],
    wouldStartPaidInvocation: false,
  };
}

function testConfig(root: string): IkbiConfig {
  return {
    ...config,
    stateRoot: join(root, "state"),
    receipt: { ...config.receipt, dir: join(root, "receipts") },
    workspace: { ...config.workspace, root: join(root, "workspaces"), max: 2 },
    identity: {
      ...config.identity,
      operatorToken: "operator-token-for-run-tests-0123456789",
      workerToken: "worker-token-for-run-tests-0123456789",
    },
  };
}

function detection() {
  return {
    languages: [],
    primaryLanguage: undefined,
    frameworks: [],
    testRunners: [],
    buildTools: [],
    packageManager: undefined,
    hasGit: true,
    hasDocker: false,
    markers: [],
  } as const;
}

function preflightPorts() {
  return {
    envPorts: {
      nodeVersion: () => "v22.0.0",
      onPath: () => true,
      isGitRepo: () => true,
      exists: () => true,
      diskFreeBytes: () => 10 * 1024 ** 3,
      detect: () => detection(),
    },
    sandboxPorts: {
      platform: () => "linux" as const,
      osDescription: () => "Linux test",
      detectSandbox: () => ({ available: true as const, tool: "bwrap" as const, version: "test" }),
      governedExec: () => ({ mode: "auto" as const, trustedLocalOverride: false }),
      dependencyInstall: () => ({ mode: "auto" as const, allowScripts: false, trustedLocalOverride: false }),
      dirs: () => ({ stateRoot: "/tmp/ikbi-test-state", receiptsDir: "/tmp/ikbi-test-receipts" }),
      isWritable: () => true,
    },
  };
}

async function fixtureRepo(root: string): Promise<string> {
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "run-test@ikbi.local"]);
  await runGit(root, ["config", "user.name", "ikbi run test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "run-fixture", scripts: { test: "node --test" } }));
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await runGit(root, ["add", "package.json", "package-lock.json"]);
  await runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}

function readyDeps(root: string, provider: ProviderPreflightReport = providerReport("ready")): RunPreflightDeps {
  return {
    config: testConfig(root),
    workerModelEnabled: true,
    governedExecEnabled: true,
    governedExecAllowlist: ["git", "npm"],
    providerPreflight: () => provider,
    ...preflightPorts(),
    killSwitch: { status: async () => ({ killed: false, signals: [] }) },
    workspaceList: async () => [],
  };
}

function fakeReceipt(id: string, operation: string, metadata: Record<string, unknown> = {}): Receipt {
  return {
    contractVersion: "1.0.0",
    id,
    seq: 1,
    timestamp: 1,
    identity: { agentId: "test", functionalRole: "test", trustTier: "trusted" },
    operation,
    outcome: { status: "success" },
    changes: [],
    metadata,
  };
}

function fakeWorker(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    contractVersion: "1.0.0",
    taskId: "task-1",
    outcome: "success" as const,
    roles: [
      { role: "builder" as const, outcome: "success" as const, detail: { filesWritten: ["src/a.ts"] } },
      { role: "verifier" as const, outcome: "success" as const },
    ],
    workspaceId: "workspace-1",
    promoted: true,
    ...overrides,
  };
}

test("canonical run help is discoverable and parseable", () => {
  assert.match(HELP_PAGES.run!.usage, /ikbi run --spec <task-file>/);
  assert.match(HELP_PAGES.run!.flags!.map((flag) => flag.flag).join(" "), /--json/);
});

test("missing spec blocks before any build callback or workspace allocation", async () => {
  let invoked = false;
  let exit = -1;
  let stdout = "";
  const result = await runCanonical(["--json"], {
    runId: () => "run-missing",
    stdout: (text) => { stdout += text; },
    stderr: () => undefined,
    setExit: (code) => { exit = code; },
    executeBuild: async () => { invoked = true; return {}; },
  });
  assert.equal(result?.code, "RUN_SPEC_MISSING");
  assert.equal(result?.paidInvocationStarted, false);
  assert.equal(result?.workspace.id, null);
  assert.equal(invoked, false);
  assert.equal(exit, 10);
  assert.doesNotThrow(() => JSON.parse(stdout));
});

test("invalid spec refuses locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-invalid-spec-"));
  try {
    const path = join(root, "bad.json");
    await writeFile(path, "{ not-json\n");
    let invoked = false;
    const result = await runCanonical(["--spec", path], {
      runId: () => "run-invalid",
      stdout: () => undefined,
      stderr: () => undefined,
      setExit: () => undefined,
      executeBuild: async () => { invoked = true; return {}; },
    });
    assert.equal(result?.code, "RUN_SPEC_INVALID");
    assert.equal(result?.paidInvocationStarted, false);
    assert.equal(invoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid repository refuses before provider preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-invalid-repo-"));
  try {
    const path = join(root, "task.json");
    await writeFile(path, JSON.stringify({ taskId: "bad-repo", goal: "do nothing", repository: join(root, "missing") }));
    let providersChecked = false;
    const result = await runCanonical(["--spec", path], {
      runId: () => "run-invalid-repo",
      stdout: () => undefined,
      stderr: () => undefined,
      setExit: () => undefined,
      preflight: (args, context) => preflightRun(args, context, {
        providerPreflight: () => { providersChecked = true; return providerReport("ready"); },
      }),
      executeBuild: async () => { throw new Error("must not execute"); },
    });
    assert.equal(result?.code, "RUN_REPOSITORY_INVALID");
    assert.equal(providersChecked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider preflight blocks before invocation and preserves nested typed causes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-provider-"));
  try {
    await fixtureRepo(root);
    const spec = join(root, "task.json");
    await writeFile(spec, JSON.stringify({ taskId: "provider-block", goal: "do the task", repository: root }));
    let invoked = false;
    const blocked = providerReport("blocked", "provider credential is missing");
    const deps = readyDeps(root, blocked);
    const cfg = deps.config!;
    const result = await runCanonical(["--spec", spec, "--json"], {
      config: cfg,
      runId: () => "run-provider",
      stdout: () => undefined,
      stderr: () => undefined,
      setExit: () => undefined,
      preflight: (args, context) => preflightRun(args, context, deps),
      executeBuild: async () => { invoked = true; return {}; },
    });
    assert.equal(result?.code, "RUN_PROVIDER_PREFLIGHT_BLOCKED");
    assert.equal(result?.paidInvocationStarted, false);
    assert.equal(result?.workspace.id, null);
    assert.equal(result?.causes[0]?.nested?.[0]?.code, "PROVIDER_CREDENTIAL_MISSING");
    assert.equal(invoked, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON terminal output is one document and redacts provider secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-redaction-"));
  const previous = process.env.IKBI_RUN_TEST_TOKEN;
  process.env.IKBI_RUN_TEST_TOKEN = SECRET;
  try {
    await fixtureRepo(root);
    const spec = join(root, "task.json");
    await writeFile(spec, JSON.stringify({ taskId: "redaction", goal: "do the task", repository: root }));
    const blocked = providerReport("blocked", `missing credential ${SECRET}`);
    const deps = readyDeps(root, blocked);
    const cfg = deps.config!;
    let stdout = "";
    const result = await runCanonical(["--spec", spec, "--json"], {
      config: cfg,
      runId: () => "run-redaction",
      stdout: (text) => { stdout += text; },
      stderr: () => undefined,
      setExit: () => undefined,
      preflight: (args, context) => preflightRun(args, context, deps),
    });
    assert.equal(result?.status, "blocked");
    assert.equal(stdout.trim().split("\n").length > 1, true);
    const parsed = JSON.parse(stdout) as { causes: Array<{ nested?: Array<{ message: string }> }> };
    assert.equal(JSON.stringify(parsed).includes(SECRET), false);
    assert.equal(JSON.stringify(parsed).includes("[redacted]"), true);
  } finally {
    if (previous === undefined) delete process.env.IKBI_RUN_TEST_TOKEN;
    else process.env.IKBI_RUN_TEST_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("ready canonical run delegates through the authoritative result seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-success-"));
  try {
    const provider = providerReport("ready");
    const worker = fakeWorker();
    let called = false;
    let receiptCalls = 0;
    const identity = {} as ValidatedIdentity;
    const terminal = await runCanonical(["--spec", "task.json"], {
      config: testConfig(root),
      runId: () => "run-success",
      stdout: () => undefined,
      stderr: () => undefined,
      setExit: () => undefined,
      preflight: async () => ({ ready: { spec: { taskId: "task-1", goal: "do it" }, repository: root, providerPreflight: provider, checks: null } }),
      executeBuild: async (input) => { input.onDiagnostic("authoritative diagnostic\n"); called = true; return { result: worker }; },
      resolveIdentity: () => identity,
      appendReceipt: async (input) => { receiptCalls += 1; return fakeReceipt(`run-receipt-${receiptCalls}`, String(input.operation), input.metadata as Record<string, unknown>); },
    });
    assert.equal(called, true);
    assert.equal(receiptCalls, 1);
    assert.equal(terminal?.status, "completed");
    assert.equal(terminal?.verification.status, "passed");
    assert.equal(terminal?.promotion.status, "promoted");
    assert.equal(terminal?.paidInvocationStarted, true);
    assert.equal(terminal?.exitCode, 0);
    assert.match(terminal?.evidence.diagnosticBundle ?? "", /runs\/run-success\.stderr\.log$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified-but-unpromoted work is not reported as process success", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-promotion-"));
  try {
    const provider = providerReport("ready");
    const identity = {} as ValidatedIdentity;
    const terminal = await runCanonical(["--spec", "task.json"], {
      config: testConfig(root),
      runId: () => "run-promotion",
      stdout: () => undefined,
      stderr: () => undefined,
      setExit: () => undefined,
      preflight: async () => ({ ready: { spec: { taskId: "task-1", goal: "do it" }, repository: root, providerPreflight: provider, checks: null } }),
      executeBuild: async () => ({ result: { ...fakeWorker(), outcome: "partial" as const, promoted: false, nonPromotion: { class: "candidate-rejected" as const, duelEligible: true } } }),
      resolveIdentity: () => identity,
      appendReceipt: async (input) => fakeReceipt("run-promotion-receipt", String(input.operation), input.metadata as Record<string, unknown>),
    });
    assert.equal(terminal?.status, "blocked");
    assert.equal(terminal?.code, "RUN_PROMOTION_REFUSED");
    assert.equal(terminal?.verification.status, "passed");
    assert.equal(terminal?.promotion.status, "refused");
    assert.equal(terminal?.exitCode, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
