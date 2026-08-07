/**
 * Deterministic local self-test.
 *
 * This intentionally uses the real workspace manager, Git worktrees, mutation
 * session, receipt store, and a deterministic Node test fixture. Provider
 * access is never used by default; the optional smoke request is explicit and
 * bounded.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { pino } from "pino";

import { config } from "../core/config.js";
import { resolveIdentity } from "../core/identity/index.js";
import { invokeModel } from "../core/provider/index.js";
import { createAppendLog, createDocumentStore, LockManager } from "../core/substrate/index.js";
import { ReceiptStore } from "../core/receipt/store.js";
import type { Receipt } from "../core/receipt/contract.js";
import type { AgentIdentity } from "../core/provider/contract.js";
import { runProviderPreflight } from "./doctor.js";
import { liveDoctorEnvPorts, runEnvironmentChecks } from "./doctor-env.js";
import { liveSandboxDoctorPorts, runSandboxChecks } from "./doctor-sandbox.js";
import { createWorkspaceMutationSession, STALE_MUTATION, WorkspaceManager } from "../core/workspace/index.js";
import type { WorkspaceRecord } from "../core/workspace/contract.js";
import { listWorktrees, runGit } from "../core/workspace/git.js";
import { writeStderr, writeStdout } from "./io.js";

const execFileAsync = promisify(execFile);
const silent = pino({ level: "silent" });
const SELF_TEST_IDENTITY: AgentIdentity = { agentId: "self-test", functionalRole: "deterministic-system", trustTier: "trusted" };

export interface SelfTestResult {
  readonly command: "self-test";
  readonly status: "passed" | "failed" | "not_run";
  readonly code: "SELF_TEST_PASSED" | "SELF_TEST_FAILED" | "SELF_TEST_PROVIDER_SMOKE_PASSED" | "SELF_TEST_PROVIDER_SMOKE_FAILED" | "SELF_TEST_PROVIDER_SMOKE_NOT_RUN";
  readonly exitCode: number;
  readonly providerCalls: number;
  readonly providerPreflight: { readonly status: "ready" | "blocked" | "error"; readonly issueCodes: readonly string[]; readonly wouldStartPaidInvocation: false };
  readonly providerSmoke: { readonly requested: boolean; readonly status: "not_requested" | "passed" | "failed" | "not_run"; readonly model: string | null; readonly calls: number };
  readonly host: {
    readonly environmentRequiredFailures: readonly string[];
    readonly sandboxRequiredFailures: readonly string[];
    readonly configurationLoaded: boolean;
  };
  readonly layers: {
    readonly exercised: readonly string[];
    readonly notExercised: readonly string[];
  };
  readonly fixture: { readonly repository: string | null; readonly branch: string | null; readonly intentionalChange: string };
  readonly workspace: { readonly allocated: boolean; readonly id: string | null; readonly cleaned: boolean; readonly orphanWorktrees: number; readonly activeRecords: number };
  readonly mutation: { readonly applied: boolean; readonly staleMutationRefused: boolean; readonly receiptCreated: boolean };
  readonly verification: { readonly status: "passed" | "failed" | "not_run"; readonly command: string };
  readonly evidence: { readonly receiptPath: string | null; readonly receiptId: string | null; readonly retainedAfterCleanup: false };
  readonly cleanup: { readonly tempRootRemoved: boolean; readonly noOrphanProcess: true; readonly noOrphanLock: boolean };
  readonly recovery: readonly string[];
}

function parse(argv: readonly string[]): { readonly json: boolean; readonly providerSmoke: boolean; readonly help: boolean; readonly unknown: readonly string[] } {
  let json = false;
  let providerSmoke = false;
  let help = false;
  const unknown: string[] = [];
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--provider-smoke") providerSmoke = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else unknown.push(arg);
  }
  return { json, providerSmoke, help, unknown };
}

function initialResult(providerSmoke: boolean): SelfTestResult {
  const env = runEnvironmentChecks({ projectRoot: process.cwd(), stateDir: config.stateRoot, ports: liveDoctorEnvPorts() });
  const sandbox = runSandboxChecks({ ports: liveSandboxDoctorPorts() });
  let provider: ReturnType<typeof runProviderPreflight>;
  try {
    provider = runProviderPreflight();
  } catch {
    provider = { command: "doctor.checkProviders", status: "error", localOnly: true, remoteReachability: "not_checked", resolvedConfiguration: { sources: [], providerRosterSource: null }, roles: [], issues: [], recovery: [], wouldStartPaidInvocation: false };
  }
  return {
    command: "self-test",
    status: providerSmoke ? "not_run" : "failed",
    code: providerSmoke ? "SELF_TEST_PROVIDER_SMOKE_NOT_RUN" : "SELF_TEST_FAILED",
    exitCode: providerSmoke ? 10 : 1,
    providerCalls: 0,
    providerPreflight: { status: provider.status, issueCodes: provider.issues.map((issue) => issue.code), wouldStartPaidInvocation: false },
    providerSmoke: { requested: providerSmoke, status: providerSmoke ? "not_run" : "not_requested", model: providerSmoke ? config.provider.defaultModels.driver : null, calls: 0 },
    host: {
      environmentRequiredFailures: env.checks.filter((check) => !check.ok && check.level === "required").map((check) => check.id),
      sandboxRequiredFailures: sandbox.checks.filter((check) => !check.ok && check.level === "required").map((check) => check.id),
      configurationLoaded: true,
    },
    layers: {
      exercised: [],
      notExercised: ["paid provider invocation", "model-driven scout/builder/critic/integrator roles", "promotion into an external repository"],
    },
    fixture: { repository: null, branch: null, intentionalChange: "src/value.mjs: before -> after" },
    workspace: { allocated: false, id: null, cleaned: false, orphanWorktrees: 0, activeRecords: 0 },
    mutation: { applied: false, staleMutationRefused: false, receiptCreated: false },
    verification: { status: "not_run", command: "node --test test/value.test.mjs" },
    evidence: { receiptPath: null, receiptId: null, retainedAfterCleanup: false },
    cleanup: { tempRootRemoved: false, noOrphanProcess: true, noOrphanLock: false },
    recovery: providerSmoke
      ? ["The explicit provider smoke request will run only when local provider preflight is ready; no provider call is made while it is blocked."]
      : [],
  };
}

async function executeProviderSmoke(initial: SelfTestResult): Promise<SelfTestResult["providerSmoke"]> {
  if (!initial.providerSmoke.requested) return initial.providerSmoke;
  if (initial.providerPreflight.status !== "ready") return initial.providerSmoke;
  const token = config.identity.operatorToken;
  if (token === undefined || token.length === 0) return { ...initial.providerSmoke, status: "not_run" };
  try {
    const who = resolveIdentity({ token });
    await invokeModel({
      model: config.provider.defaultModels.driver,
      prompt: "Reply with exactly IKBI_PROVIDER_SMOKE_OK.",
      maxTokens: 16,
      identity: who.identity,
      metadata: { selfTest: "explicit-provider-smoke" },
    });
    return { ...initial.providerSmoke, status: "passed", calls: 1 };
  } catch {
    // Deliberately omit provider error text: provider failures can echo endpoint or credential
    // material. The normal doctor/run paths carry the redacted actionable detail.
    return { ...initial.providerSmoke, status: "failed", calls: 1 };
  }
}

function binding(workspaceId: string) {
  return {
    sessionId: "self-test-session",
    workspaceId,
    candidateId: "self-test-candidate",
    generationId: "self-test-generation",
    actor: "deterministic-system" as const,
    cause: "deterministic-system" as const,
    requestId: "self-test",
    attemptId: "self-test-attempt",
    role: "self-test",
    validatedIdentity: "self-test",
  };
}

function hasOnlyMainWorktree(entries: readonly { readonly path: string }[], repo: string): boolean {
  return entries.length === 1 && entries[0]?.path === repo;
}

async function countLockFiles(root: string): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".lock") || entry.name === ".lock") count += 1;
    }
  };
  try {
    await walk(root);
    return count;
  } catch {
    return 1;
  }
}

export async function executeSelfTest(providerSmoke = false): Promise<SelfTestResult> {
  let result = initialResult(providerSmoke);

  const tempRoot = await mkdtemp(join(tmpdir(), `ikbi-self-test-${randomBytes(5).toString("hex")}-`));
  const repo = join(tempRoot, "fixture");
  const workspaceRoot = join(tempRoot, "workspaces");
  const receiptDir = join(tempRoot, "receipts");
  const receiptPath = join(receiptDir, "receipts.ndjson");
  const locks = new LockManager({ logger: silent, defaultTimeoutMs: 5_000, defaultStaleMs: 30_000 });
  const store = createDocumentStore<WorkspaceRecord>({ dir: join(workspaceRoot, "registry"), locks, logger: silent, fsync: false, crossProcess: true });
  const localReceipts = new ReceiptStore({
    log: createAppendLog({ path: receiptPath, locks, logger: silent, fsync: false, crossProcess: true }),
    logFile: receiptPath,
    locks,
    logger: silent,
    retentionMs: 24 * 60 * 60 * 1000,
  });
  const manager = new WorkspaceManager({ root: workspaceRoot, max: 2, locks, store, logger: silent, receipts: localReceipts });
  let workspaceId: string | null = null;
  let allocated = false;
  let mutationApplied = false;
  let staleMutationRefused = false;
  let receipt: Receipt | undefined;
  let verification: SelfTestResult["verification"] = { status: "not_run", command: "node --test test/value.test.mjs" };
  let noOrphanWorktree = false;
  let activeRecords = 0;
  try {
    await mkdir(repo, { recursive: true });
    await runGit(repo, ["init", "-b", "main", "--quiet"]);
    await runGit(repo, ["config", "user.email", "self-test@ikbi.local"]);
    await runGit(repo, ["config", "user.name", "ikbi self-test"]);
    await mkdirFixture(repo);
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "--quiet", "-m", "self-test fixture"]);
    const handle = await manager.allocate({ targetRepo: repo, identity: SELF_TEST_IDENTITY });
    workspaceId = handle.id;
    allocated = true;
    const session = await createWorkspaceMutationSession(handle, binding(handle.id));
    await session.readText("src/value.mjs", 4_096);
    const applied = await session.replaceText("src/value.mjs", (source) => source.replace('"before"', '"after"'));
    mutationApplied = applied.mutation.after.sha256 !== applied.mutation.before.sha256;
    const staleSession = await createWorkspaceMutationSession(handle, binding(handle.id));
    await staleSession.readText("src/value.mjs", 4_096);
    await writeFile(join(handle.path, "src/value.mjs"), 'export const value = "external";\n');
    try {
      await staleSession.replaceText("src/value.mjs", (source) => source.replace('"external"', '"rejected"'));
    } catch (err) {
      staleMutationRefused = err instanceof Error && "code" in err && (err as { code?: unknown }).code === STALE_MUTATION;
    }
    await writeFile(join(handle.path, "src/value.mjs"), 'export const value = "after";\n');
    receipt = await localReceipts.append({
      operation: "self-test.mutation",
      outcome: { status: "success", code: "SELF_TEST_MUTATION_APPLIED" },
      requestId: "self-test",
      project: repo,
      changes: [{ kind: "file", target: "src/value.mjs", summary: "deterministic state-bound replacement" }],
      metadata: { workspaceId: handle.id, candidateId: "self-test-candidate", generationId: "self-test-generation" },
    }, SELF_TEST_IDENTITY);
    await execFileAsync("node", ["--test", "test/value.test.mjs"], { cwd: handle.path, maxBuffer: 2_000_000 });
    verification = { status: "passed", command: "node --test test/value.test.mjs" };
    await manager.discard(handle);
    const worktrees = await listWorktrees(repo);
    noOrphanWorktree = hasOnlyMainWorktree(worktrees, repo);
    activeRecords = (await manager.list()).filter((record) => record.state === "allocating" || record.state === "allocated" || record.state === "promoting").length;
  } catch (err) {
    verification = { status: "failed", command: "node --test test/value.test.mjs" };
    result = { ...result, recovery: [`Self-test failed: ${err instanceof Error ? err.message : String(err)}`] };
  } finally {
    if (workspaceId !== null) {
      const record = await manager.get(workspaceId);
      if (record !== undefined && record.state !== "discarded" && record.state !== "promoted" && record.state !== "failed") {
        await manager.discard(record).catch(() => undefined);
      }
    }
  }
  const noOrphanLock = await countLockFiles(tempRoot) === 0;
  await rm(tempRoot, { recursive: true, force: true });
  const tempRootRemoved = !existsSync(tempRoot);
  const localPassed = allocated && mutationApplied && staleMutationRefused && receipt !== undefined && verification.status === "passed" && noOrphanWorktree && activeRecords === 0 && tempRootRemoved;
  const smoke = await executeProviderSmoke(result);
  const passed = localPassed && (!providerSmoke || smoke.status === "passed");
  const smokeNotRun = providerSmoke && smoke.status === "not_run";
  return {
    ...result,
    status: smokeNotRun ? "not_run" : passed ? "passed" : "failed",
    code: smokeNotRun ? "SELF_TEST_PROVIDER_SMOKE_NOT_RUN" : smoke.status === "failed" ? "SELF_TEST_PROVIDER_SMOKE_FAILED" : providerSmoke ? "SELF_TEST_PROVIDER_SMOKE_PASSED" : passed ? "SELF_TEST_PASSED" : "SELF_TEST_FAILED",
    exitCode: smokeNotRun ? 10 : passed ? 0 : 1,
    layers: {
      exercised: ["local host/config read health", "temporary Git fixture", "real workspace allocation", "state-bound observation and mutation", "stale-mutation refusal", "deterministic verification", "receipt/evidence creation", "workspace and temporary-state cleanup", ...(smoke.status === "passed" || smoke.status === "failed" ? ["explicit provider smoke request"] : [])],
      notExercised: result.layers.notExercised,
    },
    providerCalls: smoke.calls,
    providerSmoke: smoke,
    fixture: { repository: repo, branch: "main", intentionalChange: "src/value.mjs: before -> after" },
    workspace: { allocated, id: workspaceId, cleaned: noOrphanWorktree && tempRootRemoved, orphanWorktrees: noOrphanWorktree ? 0 : 1, activeRecords },
    mutation: { applied: mutationApplied, staleMutationRefused, receiptCreated: receipt !== undefined },
    verification,
    evidence: { receiptPath, receiptId: receipt?.id ?? null, retainedAfterCleanup: false },
    cleanup: { tempRootRemoved, noOrphanProcess: true, noOrphanLock },
    recovery: smokeNotRun
      ? [...result.recovery, "Run ikbi doctor --check-providers --json and correct provider readiness, then rerun ikbi self-test --provider-smoke only when an explicit provider call is authorized."]
      : passed ? [] : [...result.recovery, "Review the self-test result and rerun ikbi self-test after correcting the local failure."],
  };
}

async function mkdirFixture(repo: string): Promise<void> {
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "test"), { recursive: true });
  await writeFile(join(repo, "src/value.mjs"), 'export const value = "before";\n');
  await writeFile(join(repo, "test/value.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { value } from "../src/value.mjs";',
    'test("deterministic mutation is verified", () => assert.equal(value, "after"));',
    "",
  ].join("\n"));
}

function human(result: SelfTestResult): string {
  return [
    `ikbi self-test ${result.status}: ${result.code}`,
    `  provider calls: ${result.providerCalls}; provider preflight: ${result.providerPreflight.status} (local-only); explicit smoke=${result.providerSmoke.status}`,
    `  exercised: ${result.layers.exercised.join(", ") || "none"}`,
    `  not exercised: ${result.layers.notExercised.join(", ")}`,
    `  workspace: ${result.workspace.id ?? "none"}; cleaned=${result.workspace.cleaned}; orphan worktrees=${result.workspace.orphanWorktrees}`,
    `  mutation: applied=${result.mutation.applied}; stale refusal=${result.mutation.staleMutationRefused}; receipt=${result.mutation.receiptCreated}`,
    `  verification: ${result.verification.status} (${result.verification.command})`,
    `  cleanup: temp root removed=${result.cleanup.tempRootRemoved}; orphan process=${result.cleanup.noOrphanProcess}; orphan lock=${!result.cleanup.noOrphanLock ? "yes" : "no"}`,
    ...(result.recovery.length > 0 ? [`  recovery: ${result.recovery.join(" ")}`] : []),
    "",
  ].join("\n");
}

export async function runSelfTest(argv: readonly string[], io: { readonly out?: (text: string) => void; readonly err?: (text: string) => void; readonly setExit?: (code: number) => void } = {}): Promise<SelfTestResult | undefined> {
  const out = io.out ?? writeStdout;
  const err = io.err ?? writeStderr;
  const parsed = parse(argv);
  if (parsed.help) {
    out("Usage: ikbi self-test [--json] [--provider-smoke]\n\nRun the deterministic local workspace/mutation/verification test. No provider or paid invocation is used by default.\n\n--provider-smoke explicitly permits one bounded provider request after local preflight; it may incur provider cost.\n");
    return undefined;
  }
  if (parsed.unknown.length > 0) {
    const result = initialResult(false);
    const invalid = { ...result, status: "failed" as const, code: "SELF_TEST_FAILED" as const, recovery: [`Unknown option(s): ${parsed.unknown.join(", ")}`] };
    if (parsed.json) out(`${JSON.stringify(invalid, null, 2)}\n`); else err(human(invalid));
    (io.setExit ?? ((code: number) => { process.exitCode = code; }))(1);
    return invalid;
  }
  const result = await executeSelfTest(parsed.providerSmoke);
  if (parsed.json) out(`${JSON.stringify(result, null, 2)}\n`); else out(human(result));
  if (result.status !== "passed") err(`${result.code}: ${result.recovery.join(" ")}\n`);
  (io.setExit ?? ((code: number) => { process.exitCode = code; }))(result.exitCode);
  return result;
}
