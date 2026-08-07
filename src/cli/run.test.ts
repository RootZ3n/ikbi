import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { probeCreatablePath, probeExistingDirectoryWritable, probeReceiptDirectory, runSandboxChecks } from "./doctor-sandbox.js";
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

function preflightPorts(stateRoot = "/tmp/ikbi-test-state", receiptsDir = "/tmp/ikbi-test-receipts") {
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
      dirs: () => ({ stateRoot, receiptsDir }),
      isExistingDirectoryWritable: (dir: string) => probeExistingDirectoryWritable(dir),
      isCreatablePath: (path: string) => probeCreatablePath(path),
      probeReceiptDirectory: (path: string) => probeReceiptDirectory(path),
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
  const cfg = testConfig(root);
  return {
    config: cfg,
    workerModelEnabled: true,
    governedExecEnabled: true,
    governedExecAllowlist: ["git", "npm"],
    providerPreflight: () => provider,
    ...preflightPorts(cfg.stateRoot, cfg.receipt.dir),
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

test("real unwritable state directory blocks run and doctor without accepting its writable ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-state-permissions-"));
  const specRoot = await mkdtemp(join(tmpdir(), "ikbi-run-state-spec-"));
  try {
    await fixtureRepo(root);
    const cfg = testConfig(root);
    await mkdir(cfg.stateRoot, { recursive: true });
    await mkdir(cfg.receipt.dir, { recursive: true });
    const spec = join(specRoot, "task.json");
    await writeFile(spec, JSON.stringify({ taskId: "state-permission", goal: "do the task", repository: root }));
    await chmod(cfg.stateRoot, 0o555);
    try {
      assert.equal(probeExistingDirectoryWritable(cfg.stateRoot), false);
      assert.equal(probeCreatablePath(cfg.stateRoot), false);
      const deps = readyDeps(root);
      assert.ok(deps.sandboxPorts);
      const report = runSandboxChecks({ ports: deps.sandboxPorts });
      assert.equal(report.checks.find((check) => check.id === "state-dir-writable")?.ok, false);
      assert.equal(report.checks.find((check) => check.id === "receipts-dir-writable")?.ok, true);
      let invoked = false;
      let exit = -1;
      const result = await runCanonical(["--spec", spec, "--json"], {
        config: cfg,
        stdout: () => undefined,
        stderr: () => undefined,
        setExit: (code) => { exit = code; },
        preflight: (args, context) => preflightRun(args, context, deps),
        executeBuild: async () => { invoked = true; return {}; },
      });
      assert.equal(result?.code, "RUN_STATE_ROOT_UNWRITABLE");
      assert.equal(result?.status, "blocked");
      assert.equal(result?.exitCode, 10);
      assert.equal(exit, 10);
      assert.equal(result?.paidInvocationStarted, false);
      assert.equal(result?.mutationApplied, false);
      assert.equal(result?.workspace.id, null);
      assert.equal(invoked, false);
    } finally {
      await chmod(cfg.stateRoot, 0o755);
    }
  } finally {
    await rm(specRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("real unwritable receipt directory blocks run without accepting its writable ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-receipt-permissions-"));
  const specRoot = await mkdtemp(join(tmpdir(), "ikbi-run-receipt-spec-"));
  try {
    await fixtureRepo(root);
    const cfg = testConfig(root);
    await mkdir(cfg.stateRoot, { recursive: true });
    await mkdir(cfg.receipt.dir, { recursive: true });
    const spec = join(specRoot, "task.json");
    await writeFile(spec, JSON.stringify({ taskId: "receipt-permission", goal: "do the task", repository: root }));
    await chmod(cfg.receipt.dir, 0o555);
    try {
      assert.equal(probeExistingDirectoryWritable(cfg.receipt.dir), false);
      assert.equal(probeCreatablePath(cfg.receipt.dir), false);
      const deps = readyDeps(root);
      let invoked = false;
      let exit = -1;
      const result = await runCanonical(["--spec", spec, "--json"], {
        config: cfg,
        stdout: () => undefined,
        stderr: () => undefined,
        setExit: (code) => { exit = code; },
        preflight: (args, context) => preflightRun(args, context, deps),
        executeBuild: async () => { invoked = true; return {}; },
      });
      assert.equal(result?.code, "RUN_RECEIPT_STORE_UNWRITABLE");
      assert.equal(result?.status, "blocked");
      assert.equal(result?.exitCode, 10);
      assert.equal(exit, 10);
      assert.equal(result?.paidInvocationStarted, false);
      assert.equal(result?.mutationApplied, false);
      assert.equal(result?.workspace.id, null);
      assert.equal(invoked, false);
    } finally {
      await chmod(cfg.receipt.dir, 0o755);
    }
  } finally {
    await rm(specRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("real creatable-path probe accepts a not-yet-created workspace root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-workspace-parent-"));
  const specRoot = await mkdtemp(join(tmpdir(), "ikbi-run-workspace-spec-"));
  try {
    await fixtureRepo(root);
    const cfg = testConfig(root);
    await mkdir(cfg.stateRoot, { recursive: true });
    await mkdir(cfg.receipt.dir, { recursive: true });
    const spec = join(specRoot, "task.json");
    await writeFile(spec, JSON.stringify({ taskId: "workspace-creatable", goal: "do the task", repository: root }));
    assert.equal(probeExistingDirectoryWritable(cfg.workspace.root), false);
    assert.equal(probeCreatablePath(cfg.workspace.root), true);
    const outcome = await preflightRun(["--spec", spec], { runId: "run-workspace-creatable", cwd: process.cwd(), json: true }, readyDeps(root));
    assert.ok(outcome.ready, "preflight should accept a workspace root whose parent is writable");
    assert.equal(outcome.result, undefined);
  } finally {
    await rm(specRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh-install receipt directory is missing-but-creatable: doctor and run agree and preflight proceeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-fresh-receipts-"));
  const specRoot = await mkdtemp(join(tmpdir(), "ikbi-run-fresh-receipts-spec-"));
  try {
    await fixtureRepo(root);
    const deps = readyDeps(root);
    const cfg = deps.config!;
    await mkdir(cfg.stateRoot, { recursive: true });
    const spec = join(specRoot, "task.json");
    await writeFile(spec, JSON.stringify({ taskId: "fresh-receipts", goal: "do the task", repository: root }));
    assert.equal(await access(cfg.receipt.dir).then(() => true).catch(() => false), false);
    assert.ok(deps.sandboxPorts);
    const report = runSandboxChecks({ ports: deps.sandboxPorts });
    assert.equal(report.checks.find((check) => check.id === "receipts-dir-writable")?.ok, true);
    assert.match(report.checks.find((check) => check.id === "receipts-dir-writable")?.detail ?? "", /missing; creatable/);
    const outcome = await preflightRun(["--spec", spec], { runId: "run-fresh-receipts", cwd: process.cwd(), json: true }, deps);
    assert.ok(outcome.ready, "fresh documented state should proceed when the receipt directory is safely creatable");
    assert.equal(outcome.result, undefined);
  } finally {
    await rm(specRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("missing receipt directory beneath an unwritable parent blocks locally with no workspace or invocation", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-receipt-parent-"));
  const specRoot = await mkdtemp(join(tmpdir(), "ikbi-run-receipt-parent-spec-"));
  const blockedParent = join(root, "blocked");
  try {
    await fixtureRepo(root);
    await mkdir(blockedParent);
    const base = readyDeps(root);
    const cfg = { ...base.config!, receipt: { ...base.config!.receipt, dir: join(blockedParent, "receipts") } };
    const deps = { ...base, config: cfg, ...preflightPorts(cfg.stateRoot, cfg.receipt.dir) };
    await mkdir(cfg.stateRoot, { recursive: true });
    const spec = join(specRoot, "task.json");
    await writeFile(spec, JSON.stringify({ taskId: "missing-receipts-parent", goal: "do the task", repository: root }));
    await chmod(blockedParent, 0o555);
    try {
      assert.equal(probeReceiptDirectory(cfg.receipt.dir).state, "missing-uncreatable");
      const report = runSandboxChecks({ ports: deps.sandboxPorts });
      assert.equal(report.checks.find((check) => check.id === "receipts-dir-writable")?.ok, false);
      const outcome = await preflightRun(["--spec", spec], { runId: "run-missing-receipts-parent", cwd: process.cwd(), json: true }, deps);
      assert.equal(outcome.result?.code, "RUN_RECEIPT_STORE_UNWRITABLE");
      assert.equal(outcome.result?.exitCode, 10);
      assert.equal(outcome.result?.paidInvocationStarted, false);
      assert.equal(outcome.result?.mutationApplied, false);
      assert.equal(outcome.result?.workspace.id, null);
    } finally {
      await chmod(blockedParent, 0o755);
    }
  } finally {
    await rm(specRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt path that is a regular file blocks with RUN_RECEIPT_STORE_UNWRITABLE", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-run-receipt-file-"));
  const specRoot = await mkdtemp(join(tmpdir(), "ikbi-run-receipt-file-spec-"));
  try {
    await fixtureRepo(root);
    const base = readyDeps(root);
    const cfg = { ...base.config!, receipt: { ...base.config!.receipt, dir: join(specRoot, "receipt-file") } };
    const deps = { ...base, config: cfg, ...preflightPorts(cfg.stateRoot, cfg.receipt.dir) };
    await mkdir(cfg.stateRoot, { recursive: true });
    await writeFile(cfg.receipt.dir, "not a directory\n");
    const spec = join(specRoot, "task.json");
    await writeFile(spec, JSON.stringify({ taskId: "receipt-file", goal: "do the task", repository: root }));
    assert.equal(probeReceiptDirectory(cfg.receipt.dir).state, "invalid-path");
    const outcome = await preflightRun(["--spec", spec], { runId: "run-receipt-file", cwd: process.cwd(), json: true }, deps);
    assert.equal(outcome.result?.code, "RUN_RECEIPT_STORE_UNWRITABLE");
    assert.equal(outcome.result?.exitCode, 10);
    assert.equal(outcome.result?.workspace.id, null);
    assert.equal(outcome.result?.paidInvocationStarted, false);
  } finally {
    await rm(specRoot, { recursive: true, force: true });
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

test("terminal contract matrix keeps status, code, exit field, process exit, and state flags aligned", async () => {
  type TerminalCase = {
    readonly name: string;
    readonly expected: { readonly status: string; readonly code: string; readonly exitCode: number; readonly paid: boolean; readonly mutation: boolean };
    readonly worker?: WorkerResult;
    readonly processExitCode?: number;
    readonly preflightError?: boolean;
    readonly impossiblePreflight?: boolean;
  };
  const cases: readonly TerminalCase[] = [
    {
      name: "completed",
      expected: { status: "completed", code: "RUN_COMPLETED", exitCode: 0, paid: true, mutation: true },
      worker: fakeWorker(),
    },
    {
      name: "blocked preflight",
      expected: { status: "blocked", code: "RUN_SPEC_MISSING", exitCode: 10, paid: false, mutation: false },
    },
    {
      name: "promotion refused",
      expected: { status: "blocked", code: "RUN_PROMOTION_REFUSED", exitCode: 10, paid: true, mutation: true },
      worker: { ...fakeWorker(), outcome: "partial" as const, promoted: false, nonPromotion: { class: "candidate-rejected" as const, duelEligible: true } },
    },
    {
      name: "execution failure",
      expected: { status: "failed", code: "RUN_INVOCATION_FAILED", exitCode: 20, paid: false, mutation: false },
      processExitCode: 1,
    },
    {
      name: "verification failure",
      expected: { status: "failed", code: "RUN_VERIFICATION_FAILED", exitCode: 20, paid: true, mutation: true },
      worker: {
        ...fakeWorker(),
        outcome: "rejected" as const,
        promoted: false,
        roles: [
          { role: "builder" as const, outcome: "success" as const, detail: { filesWritten: ["src/a.ts"] } },
          { role: "verifier" as const, outcome: "failure" as const },
        ],
      },
    },
    {
      name: "cancelled",
      expected: { status: "cancelled", code: "RUN_CANCELLED", exitCode: 30, paid: false, mutation: false },
      processExitCode: 130,
    },
    {
      name: "internal preflight exception",
      expected: { status: "failed", code: "RUN_INTERNAL_ERROR", exitCode: 40, paid: false, mutation: false },
      preflightError: true,
    },
    {
      name: "internal impossible preflight result",
      expected: { status: "failed", code: "RUN_INTERNAL_ERROR", exitCode: 40, paid: false, mutation: false },
      impossiblePreflight: true,
    },
  ];

  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), `ikbi-run-terminal-${item.name.replaceAll(" ", "-")}-`));
    let processExit = -1;
    try {
      const identity = {} as ValidatedIdentity;
      const readyPreflight = async () => ({ ready: { spec: { taskId: `terminal-${item.name}`, goal: "do it" }, repository: root, providerPreflight: providerReport("ready"), checks: null } });
      const result = await runCanonical(item.name === "blocked preflight" ? ["--json"] : ["--spec", "task.json", "--json"], {
        config: testConfig(root),
        runId: () => `run-terminal-${item.name.replaceAll(" ", "-")}`,
        stdout: (text) => { JSON.parse(text); },
        stderr: () => undefined,
        setExit: (code) => { processExit = code; },
        ...(item.preflightError ? { preflight: async () => { throw new Error("synthetic preflight failure"); } } : {}),
        ...(item.impossiblePreflight ? { preflight: async () => ({}) } : {}),
        ...(!item.preflightError && !item.impossiblePreflight && item.name !== "blocked preflight" ? { preflight: readyPreflight } : {}),
        ...(item.name !== "blocked preflight" && !item.preflightError && !item.impossiblePreflight ? {
          executeBuild: async () => {
            if (item.worker !== undefined) return { result: item.worker };
            return item.processExitCode === undefined ? {} : { processExitCode: item.processExitCode };
          },
          resolveIdentity: () => identity,
          appendReceipt: async (input) => fakeReceipt(`terminal-${item.name}`, String(input.operation), input.metadata as Record<string, unknown>),
        } : {}),
      });
      assert.equal(result?.status, item.expected.status, item.name);
      assert.equal(result?.code, item.expected.code, item.name);
      assert.equal(result?.exitCode, item.expected.exitCode, item.name);
      assert.equal(processExit, item.expected.exitCode, item.name);
      assert.equal(result?.paidInvocationStarted, item.expected.paid, item.name);
      assert.equal(result?.mutationApplied, item.expected.mutation, item.name);
      if (item.expected.code === "RUN_INTERNAL_ERROR") {
        assert.equal(result?.retryable, false, item.name);
        assert.match(result?.recovery.join(" ") ?? "", /internal failure/i);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
