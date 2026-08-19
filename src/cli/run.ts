/**
 * External-agent run workflow — the LEGACY v1 delegate (V2-020/Phase 5).
 *
 * This file is intentionally an adapter, not another build engine. It owns the
 * task-file boundary, non-billable preflight, a bounded terminal result, and
 * evidence pointers. A ready run delegates to createWorkerCli(), whose
 * production default is createProductionWorker() -> createOrchestrator().
 *
 * ENGINE STATUS. That delegate is the RETIRED v1 five-role pipeline. `ikbi build` is the one
 * canonical production engine (v2), and `ikbi legacy build` was removed in V2-020. `run` is kept —
 * explicitly labelled in help and on stderr at every invocation — because what it actually provides
 * is the external-agent CONTRACT that v2 does not yet expose: a readable JSON task spec in, local
 * preflight that refuses before any spend, and exactly one terminal JSON document out with stable
 * RUN_* codes and exit codes that external agents already depend on.
 *
 * Migrating that contract onto a v2 BuildSession is the next convergence step, and it is a real
 * mapping job (WorkerResult role/promotion/cost shape → V2 session result), not a relabel. Doing it
 * inside the retirement slice would have meant writing a second build adapter without review, so it
 * is deferred deliberately and recorded in docs/IKBI-POST-V1-ARCHITECTURE.md.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

import { config, type IkbiConfig } from "../core/config.js";
import { resolveIdentity as coreResolveIdentity, type ValidatedIdentity } from "../core/identity/index.js";
import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { Receipt } from "../core/receipt/contract.js";
import { loadRepoRegistry } from "../core/repo-registry.js";
import { isGitRepo, runGit } from "../core/workspace/git.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
import type { WorkspaceRecord } from "../core/workspace/contract.js";
import { runEnvironmentChecks, liveDoctorEnvPorts, type DoctorEnvPorts } from "./doctor-env.js";
import { runSandboxChecks, liveSandboxDoctorPorts, type SandboxDoctorPorts } from "./doctor-sandbox.js";
import {
  runProviderPreflight,
  type ProviderCheckInputs,
} from "./doctor.js";
import type { ProviderPreflightReport } from "../core/provider/preflight.js";
import { killSwitch as coreKillSwitch } from "../modules/kill-switch/killswitch.js";
import type { KillStatus, KillSwitch } from "../modules/kill-switch/contract.js";
import { governedExecConfig } from "../modules/governed-exec/config.js";
import { workerModelConfig } from "../modules/worker-model/config.js";
import { PROJECT_MANIFESTS, resolveChecks, type ChecksResolution } from "../modules/worker-model/checks.js";
import {
  checkToIkbiChecksJson,
  createWorkerCli,
  type WorkerCliDeps,
} from "../modules/worker-model/cli.js";
import type { WorkerResult } from "../modules/worker-model/contract.js";
import { writeStderr, writeStdout } from "./io.js";

export const RUN_EXIT_CODES = Object.freeze({
  completed: 0,
  blocked: 10,
  failed: 20,
  cancelled: 30,
  internal: 40,
});

export const RUN_CODES = Object.freeze([
  "RUN_COMPLETED",
  "RUN_SPEC_MISSING",
  "RUN_SPEC_INVALID",
  "RUN_REPOSITORY_INVALID",
  "RUN_REPOSITORY_STATE_UNSUPPORTED",
  "RUN_CONFIGURATION_INVALID",
  "RUN_HOST_CAPABILITY_MISSING",
  "RUN_STATE_ROOT_UNWRITABLE",
  "RUN_RECEIPT_STORE_UNWRITABLE",
  "RUN_RECOVERY_REQUIRED",
  "RUN_PROVIDER_PREFLIGHT_BLOCKED",
  "RUN_WORKSPACE_ALLOCATION_FAILED",
  "RUN_INVOCATION_FAILED",
  "RUN_VERIFICATION_FAILED",
  "RUN_PROMOTION_REFUSED",
  "RUN_CANCELLED",
  "RUN_INTERNAL_ERROR",
] as const);

export type RunCode = (typeof RUN_CODES)[number];
export type RunStatus = "completed" | "blocked" | "failed" | "cancelled";
export type VerificationStatus = "not_started" | "passed" | "failed";
export type PromotionStatus = "not_attempted" | "promoted" | "refused";
type BlockedRunCode = Exclude<RunCode, "RUN_COMPLETED" | "RUN_INTERNAL_ERROR" | "RUN_CANCELLED" | "RUN_INVOCATION_FAILED" | "RUN_VERIFICATION_FAILED">;

export interface RunSpec {
  readonly taskId: string;
  readonly goal: string;
  readonly repository?: string;
  readonly branch?: string;
  /** One or more operator-declared verification command strings. */
  readonly checks?: readonly string[];
  readonly maxCostUsd?: number;
  readonly noTestsPolicy?: boolean;
  readonly rules?: readonly string[];
}

export interface RunCause {
  readonly code: string;
  readonly subsystem: string;
  readonly message: string;
  readonly paidInvocationStarted: boolean;
  readonly candidateStateChanged: boolean;
  readonly retryable: boolean;
  readonly recovery: readonly string[];
  readonly nested?: readonly { readonly code: string; readonly role?: string; readonly message: string; readonly recovery: string }[];
}

export interface RunEvidence {
  readonly receipts: readonly string[];
  readonly logs: readonly string[];
  readonly diagnosticBundle: string | null;
  readonly invocationLedger: readonly string[];
  readonly mutation: readonly string[];
  readonly verification: readonly string[];
  readonly promotion: readonly string[];
}

export interface RunTerminalResult {
  readonly command: "run";
  readonly status: RunStatus;
  readonly code: RunCode;
  readonly exitCode: number;
  readonly runId: string;
  readonly taskId: string | null;
  readonly repository: string | null;
  readonly phase: string;
  readonly providerPreflight: ProviderPreflightReport | null;
  readonly workspace: { readonly id: string | null; readonly path: string | null };
  readonly candidate: { readonly id: string | null; readonly generationId: string | null };
  readonly verification: { readonly status: VerificationStatus };
  readonly promotion: { readonly status: PromotionStatus };
  readonly mutationApplied: boolean;
  readonly partialMutation: boolean;
  readonly paidInvocationStarted: boolean;
  readonly retryable: boolean;
  readonly recovery: readonly string[];
  readonly causes: readonly RunCause[];
  readonly evidence: RunEvidence;
}

export interface ParsedRunArgs {
  readonly specPath?: string;
  readonly repository?: string;
  readonly json: boolean;
  readonly help: boolean;
  readonly unknownFlags: readonly string[];
}

export interface AuthoritativeBuildInput {
  readonly taskId: string;
  readonly goal: string;
  readonly repository: string;
  readonly branch?: string;
  readonly checks?: string;
  readonly maxCostUsd?: number;
  readonly noTestsPolicy?: boolean;
  readonly onDiagnostic: (text: string) => void;
}

export interface AuthoritativeBuildOutput {
  readonly result?: WorkerResult;
  readonly processExitCode?: number;
}

export interface RunPreflightReady {
  readonly spec: RunSpec;
  readonly repository: string;
  readonly providerPreflight: ProviderPreflightReport;
  readonly checks: ChecksResolution | null;
}

export interface RunPreflightOutcome {
  readonly result?: RunTerminalResult;
  readonly ready?: RunPreflightReady;
}

export interface RunCliDeps {
  readonly config?: IkbiConfig;
  readonly now?: () => number;
  readonly runId?: () => string;
  readonly cwd?: () => string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly setExit?: (code: number) => void;
  readonly preflight?: (args: readonly string[], context: { readonly runId: string; readonly cwd: string; readonly json: boolean }) => Promise<RunPreflightOutcome>;
  readonly executeBuild?: (input: AuthoritativeBuildInput) => Promise<AuthoritativeBuildOutput>;
  readonly resolveIdentity?: (token: string) => ValidatedIdentity;
  readonly appendReceipt?: (input: Parameters<typeof coreReceipts.append>[0], identity: Parameters<typeof coreReceipts.append>[1]) => Promise<Receipt>;
}

export interface RunPreflightDeps {
  readonly config?: IkbiConfig;
  /** Explicit configuration posture for deterministic conformance tests; production uses loaded module config. */
  readonly workerModelEnabled?: boolean;
  readonly governedExecEnabled?: boolean;
  readonly governedExecAllowlist?: readonly string[];
  readonly provider?: ProviderCheckInputs["registry"];
  readonly providerPreflight?: (input: ProviderCheckInputs) => ProviderPreflightReport;
  readonly envPorts?: DoctorEnvPorts;
  readonly sandboxPorts?: SandboxDoctorPorts;
  readonly workspaceList?: () => Promise<WorkspaceRecord[]>;
  readonly killSwitch?: Pick<KillSwitch, "status">;
  readonly cwd?: () => string;
}

function text(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function redact(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const secrets = new Set<string>();
  for (const [key, raw] of Object.entries(env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key) && raw !== undefined && raw.length >= 4) secrets.add(raw);
  }
  for (const raw of [config.identity.operatorToken, config.identity.workerToken, config.identity.tokenSalt, config.trust.hmacKey]) {
    if (raw !== undefined && raw.length >= 4) secrets.add(raw);
  }
  return [...secrets].sort((a, b) => b.length - a.length).reduce((safe, secret) => safe.split(secret).join("[redacted]"), value);
}

export function parseRunArgs(argv: readonly string[]): ParsedRunArgs {
  let specPath: string | undefined;
  let repository: string | undefined;
  let json = false;
  let help = false;
  const unknownFlags: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--json") json = true;
    else if (arg === "--spec") {
      specPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--spec=")) specPath = arg.slice("--spec=".length);
    else if (arg === "--repo") {
      repository = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--repo=")) repository = arg.slice("--repo=".length);
    else if (arg.startsWith("-")) unknownFlags.push(arg);
  }
  return {
    ...(specPath !== undefined ? { specPath } : {}),
    ...(repository !== undefined ? { repository } : {}),
    json,
    help,
    unknownFlags,
  };
}

function makeRunId(now: () => number = Date.now): string {
  return `run-${now().toString(36)}-${randomBytes(5).toString("hex")}`;
}

function emptyEvidence(): RunEvidence {
  return {
    receipts: [],
    logs: ["stderr (process stream; no durable log configured)"],
    diagnosticBundle: null,
    invocationLedger: [],
    mutation: [],
    verification: [],
    promotion: [],
  };
}

function baseResult(
  runId: string,
  taskId: string | null,
  repository: string | null,
  providerPreflight: ProviderPreflightReport | null,
): RunTerminalResult {
  return {
    command: "run",
    status: "blocked",
    code: "RUN_INTERNAL_ERROR",
    exitCode: RUN_EXIT_CODES.internal,
    runId,
    taskId,
    repository,
    phase: "preflight",
    providerPreflight,
    workspace: { id: null, path: null },
    candidate: { id: null, generationId: null },
    verification: { status: "not_started" },
    promotion: { status: "not_attempted" },
    mutationApplied: false,
    partialMutation: false,
    paidInvocationStarted: false,
    retryable: false,
    recovery: [],
    causes: [],
    evidence: emptyEvidence(),
  };
}

function blockedResult(
  base: RunTerminalResult,
  code: BlockedRunCode,
  subsystem: string,
  message: string,
  recovery: readonly string[],
  opts: { readonly retryable?: boolean; readonly candidateStateChanged?: boolean; readonly nested?: RunCause["nested"] } = {},
): RunTerminalResult {
  const cause: RunCause = {
    code,
    subsystem,
    message: redact(message),
    paidInvocationStarted: false,
    candidateStateChanged: opts.candidateStateChanged === true,
    retryable: opts.retryable ?? true,
    recovery: recovery.map((item) => redact(item)),
    ...(opts.nested !== undefined ? { nested: opts.nested } : {}),
  };
  return {
    ...base,
    status: "blocked",
    code,
    exitCode: RUN_EXIT_CODES.blocked,
    phase: subsystem,
    retryable: cause.retryable,
    recovery: cause.recovery,
    causes: [cause],
  };
}

function internalResult(
  base: RunTerminalResult,
  subsystem: string,
  message: string,
  recovery: readonly string[] = ["Inspect the run diagnostics and report this internal failure with the run ID; do not retry configuration changes blindly."],
  opts: { readonly paidInvocationStarted?: boolean; readonly mutationApplied?: boolean; readonly partialMutation?: boolean } = {},
): RunTerminalResult {
  const safeMessage = redact(message).slice(0, 2_000);
  const paidInvocationStarted = opts.paidInvocationStarted ?? base.paidInvocationStarted;
  const mutationApplied = opts.mutationApplied ?? base.mutationApplied;
  const partialMutation = opts.partialMutation ?? base.partialMutation;
  const candidateStateChanged = mutationApplied || partialMutation;
  const cause: RunCause = {
    code: "RUN_INTERNAL_ERROR",
    subsystem,
    message: safeMessage,
    paidInvocationStarted,
    candidateStateChanged,
    retryable: false,
    recovery: recovery.map((item) => redact(item)),
  };
  return {
    ...base,
    status: "failed",
    code: "RUN_INTERNAL_ERROR",
    exitCode: RUN_EXIT_CODES.internal,
    phase: subsystem,
    paidInvocationStarted,
    mutationApplied,
    partialMutation,
    retryable: false,
    recovery: cause.recovery,
    causes: [cause],
  };
}

function parseSpecValue(raw: unknown, sourcePath: string): RunSpec {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("spec must contain a JSON object");
  const obj = raw as Record<string, unknown>;
  const goal = typeof obj.goal === "string" ? obj.goal.trim() : "";
  if (goal.length === 0) throw new Error("spec.goal is required and must be a non-empty string");
  if (goal.length > 32_000) throw new Error("spec.goal exceeds the 32,000-character bound");

  const rawTaskId = obj.taskId ?? obj.id;
  const fallback = basename(sourcePath, extname(sourcePath)).replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  const taskId = typeof rawTaskId === "string" && rawTaskId.trim().length > 0 ? rawTaskId.trim() : fallback || "task";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(taskId)) {
    throw new Error("spec.taskId must match [A-Za-z0-9][A-Za-z0-9_.:-]{0,127}");
  }

  const repository = obj.repository;
  if (repository !== undefined && (typeof repository !== "string" || repository.trim().length === 0)) {
    throw new Error("spec.repository must be a non-empty path or registered repository name");
  }
  const branch = obj.branch;
  if (branch !== undefined && (typeof branch !== "string" || branch.trim().length === 0 || branch.length > 256)) {
    throw new Error("spec.branch must be a non-empty branch name");
  }

  let checks: string[] | undefined;
  if (obj.checks !== undefined) {
    const values = typeof obj.checks === "string" ? [obj.checks] : Array.isArray(obj.checks) ? obj.checks : undefined;
    if (values === undefined || values.length === 0 || values.length > 8 || !values.every((v) => typeof v === "string" && v.trim().length > 0 && v.length <= 2_000)) {
      throw new Error("spec.checks must be a non-empty string or an array of at most eight command strings");
    }
    checks = values.map((v) => String(v).trim());
  }

  const maxCostUsd = obj.maxCostUsd;
  if (maxCostUsd !== undefined && (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) {
    throw new Error("spec.maxCostUsd must be a positive number");
  }
  const noTestsPolicy = obj.noTestsPolicy;
  if (noTestsPolicy !== undefined && typeof noTestsPolicy !== "boolean") throw new Error("spec.noTestsPolicy must be boolean");

  let rules: string[] | undefined;
  if (obj.rules !== undefined) {
    if (!Array.isArray(obj.rules) || obj.rules.length > 16 || !obj.rules.every((v) => typeof v === "string" && v.trim().length > 0 && v.length <= 2_000)) {
      throw new Error("spec.rules must be an array of at most sixteen non-empty strings");
    }
    rules = obj.rules.map((v) => String(v).trim());
  }
  return {
    taskId,
    goal,
    ...(typeof repository === "string" ? { repository: repository.trim() } : {}),
    ...(typeof branch === "string" ? { branch: branch.trim() } : {}),
    ...(checks !== undefined ? { checks } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(noTestsPolicy === true ? { noTestsPolicy: true } : {}),
    ...(rules !== undefined ? { rules } : {}),
  };
}

async function readSpec(specPath: string): Promise<RunSpec> {
  let raw: string;
  try {
    raw = await readFile(specPath, "utf8");
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "EACCES") throw Object.assign(new Error(`cannot read task spec ${specPath}`), { runCode: "RUN_SPEC_MISSING" as const });
    throw new Error(`cannot read task spec ${specPath}: ${text(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`task spec is not valid JSON: ${text(err)}`);
  }
  return parseSpecValue(parsed, specPath);
}

function resolveRepositoryReference(reference: string | undefined, cwd: string): string {
  if (reference === undefined || reference.trim().length === 0) return cwd;
  const value = reference.trim();
  if (isAbsolute(value) || value === "." || value === ".." || value.startsWith(".") || value.includes("/")) return resolve(cwd, value);
  return loadRepoRegistry().resolve(value) ?? resolve(cwd, value);
}

async function repositoryRoot(reference: string): Promise<string> {
  if (!existsSync(reference)) throw new Error(`repository path does not exist: ${reference}`);
  if (!(await isGitRepo(reference))) throw new Error(`not a Git repository: ${reference}`);
  const top = (await runGit(reference, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (top.length === 0) throw new Error(`Git did not return a repository root for ${reference}`);
  return await realpath(top);
}

function isGreenfieldRoot(root: string): boolean {
  if (PROJECT_MANIFESTS.some((manifest) => existsSync(join(root, manifest)))) return false;
  try {
    return readdirSync(root, { withFileTypes: true }).every((entry) => entry.name === ".git" || entry.name.startsWith("."));
  } catch {
    return false;
  }
}

function providerNestedIssues(report: ProviderPreflightReport): RunCause["nested"] {
  return report.issues.map((issue) => ({
    code: issue.code,
    role: issue.role,
    message: redact(issue.message),
    recovery: redact(issue.recovery),
  }));
}

function providerReportSafe(report: ProviderPreflightReport): ProviderPreflightReport {
  return {
    ...report,
    roles: report.roles.map((role) => ({
      ...role,
      issues: role.issues.map((issue) => ({
        ...issue,
        message: redact(issue.message),
        recovery: redact(issue.recovery),
      })),
    })),
    issues: report.issues.map((issue) => ({
      ...issue,
      message: redact(issue.message),
      recovery: redact(issue.recovery),
    })),
    recovery: report.recovery.map((item) => redact(item)),
  };
}

function checkResolutionEnvironment(spec: RunSpec): NodeJS.ProcessEnv {
  if (spec.checks === undefined) return process.env;
  const command = spec.checks.join(" && ");
  const checks = checkToIkbiChecksJson(command);
  if (checks === undefined) return process.env;
  return { ...process.env, IKBI_CHECKS: checks };
}

function configurationRecovery(): string[] {
  return ["Set IKBI_OPERATOR_TOKEN and IKBI_WORKER_TOKEN, enable IKBI_WORKER_MODEL_ENABLED=true, then rerun ikbi doctor and the same ikbi run command."];
}

export async function preflightRun(
  argv: readonly string[],
  context: { readonly runId: string; readonly cwd: string; readonly json: boolean },
  deps: RunPreflightDeps = {},
): Promise<RunPreflightOutcome> {
  const cfg = deps.config ?? config;
  const parsed = parseRunArgs(argv);
  let base = baseResult(context.runId, null, null, null);
  if (parsed.unknownFlags.length > 0) {
    return { result: blockedResult(base, "RUN_SPEC_INVALID", "preflight.arguments", `unknown option(s): ${parsed.unknownFlags.join(", ")}`, ["Run ikbi run --help and remove the unknown options."]) };
  }
  if (parsed.specPath === undefined || parsed.specPath.trim().length === 0) {
    return { result: blockedResult(base, "RUN_SPEC_MISSING", "preflight.spec", "--spec <task-file> is required", ["Provide a readable JSON task file: ikbi run --spec <task-file>."]) };
  }

  const specPath = isAbsolute(parsed.specPath) ? parsed.specPath : resolve(context.cwd, parsed.specPath);
  let spec: RunSpec;
  try {
    spec = await readSpec(specPath);
  } catch (err) {
    const runCode = (err as { runCode?: unknown }).runCode;
    const code: RunCode = runCode === "RUN_SPEC_MISSING" ? "RUN_SPEC_MISSING" : "RUN_SPEC_INVALID";
    return { result: blockedResult(base, code, "preflight.spec", text(err), ["Fix or recreate the task JSON, then rerun ikbi run --spec <task-file>."]) };
  }
  base = baseResult(context.runId, spec.taskId, null, null);

  const repositoryReference = parsed.repository ?? spec.repository;
  let repository: string;
  try {
    repository = await repositoryRoot(resolveRepositoryReference(repositoryReference, context.cwd));
  } catch (err) {
    return { result: blockedResult(base, "RUN_REPOSITORY_INVALID", "preflight.repository", text(err), ["Pass --repo <path> or set spec.repository to a Git repository, then rerun the command."]) };
  }
  base = baseResult(context.runId, spec.taskId, repository, null);

  const workerEnabled = deps.workerModelEnabled ?? workerModelConfig.enabled;
  const governedEnabled = deps.governedExecEnabled ?? governedExecConfig.enabled;
  const governedAllowlist = deps.governedExecAllowlist ?? governedExecConfig.allowlist;
  if (cfg.identity.operatorToken === undefined || cfg.identity.operatorToken.length === 0 || cfg.identity.workerToken === undefined || cfg.identity.workerToken.length === 0 || workerEnabled !== true) {
    return { result: blockedResult(base, "RUN_CONFIGURATION_INVALID", "preflight.configuration", "production identity or worker-model configuration is incomplete", configurationRecovery()) };
  }
  if (governedEnabled !== true || !governedAllowlist.includes("git")) {
    return { result: blockedResult(base, "RUN_HOST_CAPABILITY_MISSING", "preflight.configuration", "governed execution is disabled or does not allow git", ["Enable governed execution and retain git in IKBI_GOVERNED_EXEC_ALLOWLIST, then rerun ikbi doctor."]) };
  }

  let providerPreflight: ProviderPreflightReport;
  try {
    providerPreflight = providerReportSafe((deps.providerPreflight ?? runProviderPreflight)({
      config: cfg,
      ...(deps.provider !== undefined ? { registry: deps.provider } : {}),
    }));
  } catch (err) {
    return { result: blockedResult(base, "RUN_PROVIDER_PREFLIGHT_BLOCKED", "preflight.provider", `provider preflight could not be resolved: ${text(err)}`, ["Run ikbi doctor --check-providers --json, correct the reported local configuration, and rerun."]) };
  }
  base = baseResult(context.runId, spec.taskId, repository, providerPreflight);
  if (providerPreflight.status !== "ready") {
    return {
      result: blockedResult(
        base,
        "RUN_PROVIDER_PREFLIGHT_BLOCKED",
        "preflight.provider",
        "local provider readiness is blocked; no provider invocation was attempted",
        providerPreflight.recovery.length > 0 ? providerPreflight.recovery : ["Run ikbi doctor --check-providers --json and correct the nested provider issue(s), then rerun."],
        { nested: providerNestedIssues(providerPreflight) },
      ),
    };
  }

  let branch = "";
  try {
    const symbolic = await runGit(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [1] });
    branch = symbolic.stdout.trim();
    if (symbolic.code !== 0 || branch.length === 0) throw new Error("repository is in detached HEAD state");
    await runGit(repository, ["rev-parse", "HEAD"]);
    const status = await runGit(repository, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.stdout.trim().length > 0) throw new Error("repository working tree is dirty");
  } catch (err) {
    const branchRecovery = spec.branch !== undefined
      ? [`Check out the required branch ${spec.branch}, ensure it is clean, and rerun.`]
      : ["Commit or otherwise resolve local changes, check out a named clean branch, and rerun; ikbi does not stash or alter the target repository."];
    const message = text(err);
    const branchMismatch = spec.branch !== undefined && branch !== spec.branch;
    return { result: blockedResult(base, "RUN_REPOSITORY_STATE_UNSUPPORTED", "preflight.repository-state", branchMismatch ? `current branch is ${branch || "detached"}; spec requires ${spec.branch}` : message, branchRecovery) };
  }
  if (spec.branch !== undefined && branch !== spec.branch) {
    return { result: blockedResult(base, "RUN_REPOSITORY_STATE_UNSUPPORTED", "preflight.repository-state", `current branch is ${branch}; spec requires ${spec.branch}`, [`Check out ${spec.branch}, ensure it is clean, and rerun.`]) };
  }

  const checksEnv = checkResolutionEnvironment(spec);
  const checks = resolveChecks(repository, checksEnv);
  const checksMissingForGreenfield = !checks.ok && spec.checks === undefined && isGreenfieldRoot(repository);
  if (!checks.ok && !checksMissingForGreenfield) {
    return { result: blockedResult(base, "RUN_HOST_CAPABILITY_MISSING", "preflight.verification", checks.reason ?? "verification checks could not be resolved", ["Add a supported project test configuration or declare operator-owned checks in the task spec, then rerun."]) };
  }
  if (checks.ok) {
    const unavailable = checks.checks.filter((check) => !governedAllowlist.includes(check.command));
    if (unavailable.length > 0) {
      return { result: blockedResult(base, "RUN_HOST_CAPABILITY_MISSING", "preflight.verification", `verification command(s) are not in the governed allowlist: ${unavailable.map((check) => check.command).join(", ")}`, [`Add the required verifier binaries to IKBI_GOVERNED_EXEC_ALLOWLIST, rerun ikbi doctor, and retry.`]) };
    }
  }

  const envReport = runEnvironmentChecks({ projectRoot: repository, stateDir: cfg.stateRoot, ports: deps.envPorts ?? liveDoctorEnvPorts() });
  const sandboxPorts = deps.sandboxPorts ?? liveSandboxDoctorPorts();
  const sandboxReport = runSandboxChecks({ ports: sandboxPorts });
  const envRequired = envReport.checks.filter((check) => !check.ok && check.level === "required");
  // State and receipt writability have dedicated stable run codes below. Do not
  // collapse either resource failure into the generic host-capability result.
  const sandboxRequired = sandboxReport.checks.filter((check) =>
    !check.ok && check.level === "required" && check.id !== "state-dir-writable" && check.id !== "receipts-dir-writable",
  );
  if (envRequired.length > 0 || sandboxRequired.length > 0) {
    const failed = [...envRequired, ...sandboxRequired].map((check) => `${check.label}${check.fix ? ` — ${check.fix}` : ""}`).join("; ");
    return { result: blockedResult(base, "RUN_HOST_CAPABILITY_MISSING", "preflight.host", failed, ["Run ikbi doctor --json, satisfy every required host/sandbox check, and rerun."]) };
  }

  if (!sandboxPorts.isExistingDirectoryWritable(cfg.stateRoot)) {
    return { result: blockedResult(base, "RUN_STATE_ROOT_UNWRITABLE", "preflight.state", `state root is not writable: ${cfg.stateRoot}`, [`Set IKBI_STATE_ROOT to a writable directory, then rerun ikbi doctor and ikbi run.`]) };
  }
  const receiptProbe = sandboxPorts.probeReceiptDirectory(cfg.receipt.dir);
  if (!receiptProbe.ready) {
    const detail = receiptProbe.state === "existing-unwritable"
      ? `existing receipt directory is not writable: ${cfg.receipt.dir}`
      : receiptProbe.state === "missing-uncreatable"
        ? `receipt directory is missing and cannot be safely created: ${cfg.receipt.dir}`
        : receiptProbe.state === "invalid-path"
          ? `receipt path is not a usable directory: ${cfg.receipt.dir}`
          : `receipt store is not writable: ${cfg.receipt.dir}`;
    const recovery = receiptProbe.state === "existing-unwritable"
      ? [`Make the existing receipt directory writable, or set IKBI_RECEIPT_DIR to another writable directory, then rerun ikbi doctor and ikbi run.`]
      : receiptProbe.state === "missing-uncreatable"
        ? [`Create the receipt directory beneath a writable parent, or set IKBI_RECEIPT_DIR to a safely creatable path, then rerun ikbi doctor and ikbi run.`]
        : receiptProbe.state === "invalid-path"
          ? [`Replace IKBI_RECEIPT_DIR with a directory path (not a regular file), then rerun ikbi doctor and ikbi run.`]
          : [`Set IKBI_RECEIPT_DIR to a writable directory, then rerun ikbi doctor and ikbi run.`];
    return { result: blockedResult(base, "RUN_RECEIPT_STORE_UNWRITABLE", "preflight.receipts", detail, recovery) };
  }
  if (!sandboxPorts.isCreatablePath(cfg.workspace.root)) {
    return { result: blockedResult(base, "RUN_WORKSPACE_ALLOCATION_FAILED", "preflight.workspace", `workspace root is not writable: ${cfg.workspace.root}`, [`Set IKBI_WORKSPACE_ROOT to a writable directory, then rerun.`]) };
  }

  let killStatus: KillStatus;
  try {
    killStatus = await (deps.killSwitch ?? coreKillSwitch).status();
  } catch (err) {
    return { result: blockedResult(base, "RUN_RECOVERY_REQUIRED", "preflight.recovery", `kill-switch state could not be read: ${text(err)}`, ["Run ikbi kill-status; if the latch is unreadable, repair the state root before retrying."]) };
  }
  if (killStatus.killed) {
    return { result: blockedResult(base, "RUN_RECOVERY_REQUIRED", "preflight.recovery", "an active kill-switch latch blocks new work", ["Run ikbi kill-status, then an authorized ikbi unkill before retrying."], { retryable: true }) };
  }

  let records: WorkspaceRecord[];
  try {
    records = await (deps.workspaceList ?? (() => coreWorkspaces.list()))();
  } catch (err) {
    return { result: blockedResult(base, "RUN_RECOVERY_REQUIRED", "preflight.recovery", `workspace state could not be read: ${text(err)}`, ["Run ikbi workspace ls and ikbi doctor; repair the state root or receipt/registry locks before retrying."], { retryable: false }) };
  }
  const retained = records.filter((record) => record.targetRepo === repository && record.state === "failed" && (record.note ?? "").startsWith("retained:"));
  if (retained.length > 0) {
    const first = retained[0]!;
    return { result: blockedResult(base, "RUN_RECOVERY_REQUIRED", "preflight.recovery", `retained candidate workspace ${first.id} requires operator recovery`, [`Inspect it with ikbi diff ${first.id} or ikbi workspace ls; discard it with ikbi workspace discard ${first.id} only after preserving any needed evidence, then retry.`], { candidateStateChanged: true }) };
  }
  const active = records.filter((record) => record.state === "allocating" || record.state === "allocated" || record.state === "promoting");
  if (active.length >= cfg.workspace.max) {
    return { result: blockedResult(base, "RUN_WORKSPACE_ALLOCATION_FAILED", "preflight.workspace", `workspace capacity is full (${active.length}/${cfg.workspace.max})`, ["Inspect active workspaces with ikbi workspace ls; finish or safely recover one, then retry."]) };
  }

  return { ready: { spec, repository, providerPreflight, checks: checks.ok ? checks : null } };
}

function verificationStatus(result: WorkerResult): VerificationStatus {
  const verifier = result.roles.find((role) => role.role === "verifier");
  if (verifier === undefined) return "not_started";
  return verifier.outcome === "success" ? "passed" : "failed";
}

function promotionStatus(result: WorkerResult): PromotionStatus {
  if (result.promoted) return "promoted";
  return result.workspaceId !== undefined || result.roles.some((role) => role.role === "integrator") ? "refused" : "not_attempted";
}

function mutationState(result: WorkerResult): { readonly applied: boolean; readonly partial: boolean } {
  const builder = result.roles.find((role) => role.role === "builder");
  const detail = (builder?.detail ?? {}) as Record<string, unknown>;
  const wroteFiles = Array.isArray(detail.filesWritten) && detail.filesWritten.length > 0;
  const applied = result.promoted || wroteFiles;
  return { applied, partial: applied && !result.promoted };
}

function paidInvocation(result: WorkerResult): boolean {
  if ((result.providerAttempts?.length ?? 0) > 0 || result.costUsd !== undefined) return true;
  return result.roles.some((role) => role.role === "scout" || role.role === "builder" || role.role === "critic" || role.role === "integrator");
}

function workerTerminal(result: WorkerResult, runId: string, taskId: string, repository: string, providerPreflight: ProviderPreflightReport): RunTerminalResult {
  const verification = verificationStatus(result);
  const promotion = promotionStatus(result);
  const mutation = mutationState(result);
  const paid = paidInvocation(result);
  const interrupted = result.nonPromotion?.class === "interrupted" || /\b(interrupt|cancel|kill|terminated)\b/i.test(result.reason ?? "");
  const blockedPromotion = !result.promoted && (result.outcome === "partial" || result.outcome === "rejected" || result.nonPromotion?.class === "governance-refused" || result.nonPromotion?.class === "unverifiable");
  const code: RunCode = result.promoted && verification === "passed"
    ? "RUN_COMPLETED"
    : interrupted
      ? "RUN_CANCELLED"
      : blockedPromotion
        ? (verification === "failed" || result.nonPromotion?.class === "unverifiable" ? "RUN_VERIFICATION_FAILED" : "RUN_PROMOTION_REFUSED")
        : verification === "failed"
          ? "RUN_VERIFICATION_FAILED"
          : "RUN_INVOCATION_FAILED";
  const status: RunStatus = code === "RUN_COMPLETED" ? "completed" : code === "RUN_CANCELLED" ? "cancelled" : code === "RUN_PROMOTION_REFUSED" ? "blocked" : "failed";
  const exitCode = status === "completed" ? RUN_EXIT_CODES.completed : status === "blocked" ? RUN_EXIT_CODES.blocked : status === "cancelled" ? RUN_EXIT_CODES.cancelled : RUN_EXIT_CODES.failed;
  const recovery = code === "RUN_COMPLETED"
    ? []
    : code === "RUN_VERIFICATION_FAILED"
      ? ["Inspect the retained candidate and verification receipt, correct the task or repository, then rerun when safe."]
      : code === "RUN_PROMOTION_REFUSED"
        ? ["Inspect the candidate with the reported workspace and receipts; resolve the governance or candidate issue before retrying."]
        : code === "RUN_CANCELLED"
          ? ["Inspect preserved workspace state and kill status; retry only after confirming the previous run is safely recovered."]
          : ["Inspect the retained workspace and receipts, correct the reported execution issue, then retry if the cause is transient."];
  const cause: RunCause | undefined = code === "RUN_COMPLETED" ? undefined : {
    code,
    subsystem: code === "RUN_VERIFICATION_FAILED" ? "verification" : code === "RUN_PROMOTION_REFUSED" ? "promotion" : code === "RUN_CANCELLED" ? "cancellation" : "execution",
    message: redact(result.reason ?? `authoritative worker result was ${result.outcome}`),
    paidInvocationStarted: paid,
    candidateStateChanged: mutation.applied,
    retryable: code !== "RUN_CANCELLED" || mutation.partial,
    recovery,
  };
  return {
    command: "run",
    status,
    code,
    exitCode,
    runId,
    taskId,
    repository,
    phase: status === "completed" ? "completed" : code === "RUN_VERIFICATION_FAILED" ? "verification" : code === "RUN_PROMOTION_REFUSED" ? "promotion" : code === "RUN_CANCELLED" ? "cancelled" : "execution",
    providerPreflight,
    workspace: { id: result.workspaceId ?? null, path: null },
    candidate: { id: result.workspaceId ?? null, generationId: typeof result.metadata?.generationId === "string" ? result.metadata.generationId : null },
    verification: { status: verification },
    promotion: { status: promotion },
    mutationApplied: mutation.applied,
    partialMutation: mutation.partial,
    paidInvocationStarted: paid,
    retryable: cause?.retryable ?? false,
    recovery,
    causes: cause === undefined ? [] : [cause],
    evidence: emptyEvidence(),
  };
}

function receiptStatus(result: RunTerminalResult): "success" | "failure" | "rejected" {
  if (result.status === "completed") return "success";
  if (result.status === "blocked") return "rejected";
  return "failure";
}

async function workspacePath(id: string | null): Promise<string | null> {
  if (id === null) return null;
  try {
    return (await coreWorkspaces.get(id))?.path ?? null;
  } catch {
    return null;
  }
}

async function relatedReceipts(runId: string, taskId: string): Promise<Receipt[]> {
  try {
    const all = await coreReceipts.readAll();
    return all.filter((receipt) => {
      const metadata = receipt.metadata ?? {};
      return receipt.requestId === runId || receipt.requestId === taskId || metadata.runId === runId || metadata.taskId === taskId;
    });
  } catch {
    return [];
  }
}

function evidenceFromReceipts(receiptList: readonly Receipt[]): Pick<RunEvidence, "receipts" | "invocationLedger" | "mutation" | "verification" | "promotion"> {
  const ids = receiptList.map((receipt) => `receipt:${receipt.id}`);
  const invocationLedger = receiptList.filter((receipt) => receipt.operation.includes("invoke") || receipt.metadata?.invocationId !== undefined).map((receipt) => `receipt:${receipt.id}`);
  const mutation = receiptList.filter((receipt) => receipt.changes.length > 0 || /mutation|write|repair/i.test(receipt.operation)).map((receipt) => `receipt:${receipt.id}`);
  const verification = receiptList.filter((receipt) => /verif|worker\.run\.summary/i.test(receipt.operation)).map((receipt) => `receipt:${receipt.id}`);
  const promotion = receiptList.filter((receipt) => /promot|integrat/i.test(receipt.operation) || receipt.metadata?.promoted === true).map((receipt) => `receipt:${receipt.id}`);
  return { receipts: ids, invocationLedger, mutation, verification, promotion };
}

async function writeDiagnostics(runId: string, lines: readonly string[], cfg: IkbiConfig): Promise<string | null> {
  if (lines.length === 0) return null;
  const directory = join(cfg.stateRoot, "runs");
  const path = join(directory, `${runId}.stderr.log`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, lines.join(""), { encoding: "utf8", mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

async function persistTerminalEvidence(
  result: RunTerminalResult,
  identity: ValidatedIdentity,
  cfg: IkbiConfig,
  appendReceipt: NonNullable<RunCliDeps["appendReceipt"]>,
  diagnostics: readonly string[],
): Promise<RunTerminalResult> {
  const diagnosticBundle = await writeDiagnostics(result.runId, diagnostics, cfg);
  const withDiagnostic: RunTerminalResult = {
    ...result,
    evidence: {
      ...result.evidence,
      ...(diagnosticBundle !== null ? { logs: [diagnosticBundle] } : {}),
      diagnosticBundle,
    },
  };
  try {
    const wrapper = await appendReceipt(
      {
        operation: "run.summary",
        requestSummary: { taskId: result.taskId, repository: result.repository, phase: result.phase },
        outcome: { status: receiptStatus(result), code: result.code, detail: `${result.status}: ${result.phase}` },
        changes: result.workspace.id !== null && result.mutationApplied
          ? [{ kind: "state", target: `workspace:${result.workspace.id}`, summary: result.partialMutation ? "candidate state retained for inspection" : "candidate promoted or completed" }]
          : [],
        metadata: {
          runId: result.runId,
          taskId: result.taskId,
          status: result.status,
          code: result.code,
          phase: result.phase,
          workspaceId: result.workspace.id,
          candidateId: result.candidate.id,
          generationId: result.candidate.generationId,
          verification: result.verification.status,
          promotion: result.promotion.status,
          paidInvocationStarted: result.paidInvocationStarted,
          mutationApplied: result.mutationApplied,
          partialMutation: result.partialMutation,
          retryable: result.retryable,
          repository: result.repository,
          diagnosticBundle: withDiagnostic.evidence.diagnosticBundle,
          recovery: [...result.recovery],
        },
        requestId: result.runId,
        ...(result.repository !== null ? { project: result.repository } : {}),
      },
      identity.identity,
    );
    const related = await relatedReceipts(result.runId, result.taskId ?? "");
    const selected = related.some((item) => item.id === wrapper.id) ? related : [...related, wrapper];
    const summary = evidenceFromReceipts(selected);
    return { ...withDiagnostic, evidence: { ...withDiagnostic.evidence, ...summary, receipts: [join(cfg.receipt.dir, "receipts.ndjson"), ...summary.receipts] } };
  } catch (err) {
    const cause: RunCause = {
      code: "RUN_INTERNAL_ERROR",
      subsystem: "evidence",
      message: "terminal run evidence could not be appended",
      paidInvocationStarted: result.paidInvocationStarted,
      candidateStateChanged: result.mutationApplied,
      retryable: false,
      recovery: ["Preserve the reported workspace and inspect Git directly; repair receipt-store writability before retrying."],
    };
    const detail = redact(text(err));
    const evidenceResult: RunTerminalResult = {
      ...withDiagnostic,
      status: "failed",
      code: "RUN_INTERNAL_ERROR",
      exitCode: RUN_EXIT_CODES.internal,
      phase: "evidence",
      retryable: false,
      recovery: [...cause.recovery, detail],
      causes: [...withDiagnostic.causes, cause],
    };
    return evidenceResult;
  }
}

export async function executeAuthoritativeBuild(input: AuthoritativeBuildInput): Promise<AuthoritativeBuildOutput> {
  let workerResult: WorkerResult | undefined;
  let processExitCode: number | undefined;
  const previousChecks = process.env.IKBI_CHECKS;
  const cliDeps: WorkerCliDeps = {
    operatorToken: config.identity.operatorToken,
    workerToken: config.identity.workerToken,
    stdout: () => undefined,
    stderr: (message) => input.onDiagnostic(redact(message)),
    setExit: (code) => { processExitCode = code; },
    cwd: () => input.repository,
    interactive: false,
    readPipedStdin: async () => "",
    resultSink: (result) => { workerResult = result; },
  };
  const cli = createWorkerCli(cliDeps);
  const args: string[] = ["--task-id", input.taskId, "--repo", input.repository, "--yes", "--json"];
  if (input.branch !== undefined) args.push("--base-branch", input.branch);
  if (input.checks !== undefined) args.push("--check", input.checks);
  if (input.maxCostUsd !== undefined) args.push("--max-budget-usd", String(input.maxCostUsd));
  if (input.noTestsPolicy === true) args.push("--allow-no-tests");
  args.push("--", input.goal);
  try {
    await cli.build(args);
  } finally {
    if (previousChecks === undefined) delete process.env.IKBI_CHECKS;
    else process.env.IKBI_CHECKS = previousChecks;
  }
  return { ...(workerResult !== undefined ? { result: workerResult } : {}), ...(processExitCode !== undefined ? { processExitCode } : {}) };
}

function humanResult(result: RunTerminalResult): string {
  const lines = [
    `ikbi run ${result.status}: ${result.code}`,
    `  run: ${result.runId}`,
    `  task: ${result.taskId ?? "(none)"}`,
    `  repository: ${result.repository ?? "(unresolved)"}`,
    `  phase: ${result.phase}`,
    `  verification: ${result.verification.status}; promotion: ${result.promotion.status}`,
    `  paid invocation started: ${result.paidInvocationStarted ? "yes" : "no"}; mutation applied: ${result.mutationApplied ? "yes" : "no"}`,
    `  workspace: ${result.workspace.id ?? "(none)"}${result.workspace.path ? ` — ${result.workspace.path}` : ""}`,
    `  receipts: ${result.evidence.receipts.length > 0 ? result.evidence.receipts.join(", ") : "none (preflight stopped before durable run evidence)"}`,
    `  diagnostics: ${result.evidence.diagnosticBundle ?? "stderr only; no durable diagnostic bundle"}`,
  ];
  if (result.recovery.length > 0) lines.push(`  recovery: ${result.recovery.join(" ")}`);
  return `${lines.join("\n")}\n`;
}

function emitResult(result: RunTerminalResult, json: boolean, out: (text: string) => void, err: (text: string) => void): void {
  if (json) out(`${JSON.stringify(result, null, 2)}\n`);
  else out(humanResult(result));
  if (json && result.status !== "completed") err(`ikbi run: ${result.code} — ${result.recovery.join(" ")}\n`);
}

function noTypedWorkerResult(base: RunTerminalResult, processExitCode: number | undefined): RunTerminalResult {
  const cancelled = processExitCode === 130;
  const code: RunCode = cancelled ? "RUN_CANCELLED" : "RUN_INVOCATION_FAILED";
  const recovery = cancelled
    ? ["Inspect preserved workspace state and kill status; report the cancellation before retrying."]
    : ["Inspect stderr and rerun only after confirming no preserved workspace requires recovery."];
  const cause: RunCause = {
    code,
    subsystem: cancelled ? "cancellation" : "execution",
    message: "the authoritative build path returned no typed worker result",
    paidInvocationStarted: base.paidInvocationStarted,
    candidateStateChanged: base.mutationApplied || base.partialMutation,
    retryable: !cancelled,
    recovery,
  };
  return {
    ...base,
    status: cancelled ? "cancelled" : "failed",
    code,
    exitCode: cancelled ? RUN_EXIT_CODES.cancelled : RUN_EXIT_CODES.failed,
    phase: cancelled ? "cancelled" : "execution",
    retryable: !cancelled,
    recovery,
    causes: [cause],
  };
}

export async function runCanonical(argv: readonly string[], deps: RunCliDeps = {}): Promise<RunTerminalResult | undefined> {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const parsed = parseRunArgs(argv);
  if (parsed.help) {
    out(
      "Usage: ikbi run --spec <task-file> [--repo <path-or-name>] [--json]\n\n" +
        "Run one task-file through local preflight and the LEGACY v1 worker/orchestrator.\n" +
        "Preflight is local-only and refuses before workspace allocation or provider invocation.\n\n" +
        "ENGINE: this command still drives the v1 five-role pipeline. The canonical governed engine\n" +
        "is v2: `ikbi build \"<goal>\" --repo <path>`. Use `run` only for the external-agent task-file\n" +
        "contract (spec in, one terminal JSON document out), which v2 does not yet expose.\n",
    );
    return undefined;
  }
  // V2-020/Phase 5: `run` is the ONE remaining user-facing surface that drives the v1 engine, and it
  // says so out loud on every invocation. It is retained (not migrated) because its value is the
  // external-agent TASK-FILE CONTRACT — a spec in, exactly one terminal JSON document out, with
  // local preflight — and re-homing that contract onto a v2 BuildSession is a real migration, not a
  // relabel. The notice goes to STDERR so `--json` stdout stays exactly one document.
  err(
    "ikbi run: LEGACY ENGINE — this drives the v1 five-role pipeline, not the canonical v2 engine.\n" +
      "         For ordinary builds use: ikbi build \"<goal>\" --repo <path>\n",
  );
  const now = deps.now ?? Date.now;
  const runId = deps.runId?.() ?? makeRunId(now);
  const cwd = deps.cwd?.() ?? process.cwd();
  const context = { runId, cwd, json: parsed.json } as const;
  const preflight = deps.preflight ?? ((args: readonly string[], ctx: typeof context) => preflightRun(args, ctx, deps.config === undefined ? {} : { config: deps.config }));
  let preflightOutcome: RunPreflightOutcome;
  try {
    preflightOutcome = await preflight(argv, context);
  } catch (e) {
    const result = internalResult(baseResult(runId, null, null, null), "preflight", `preflight failed unexpectedly: ${text(e)}`);
    emitResult(result, parsed.json, out, err);
    (deps.setExit ?? ((code: number) => { process.exitCode = code; }))(result.exitCode);
    return result;
  }
  if (preflightOutcome.result !== undefined) {
    emitResult(preflightOutcome.result, parsed.json, out, err);
    (deps.setExit ?? ((code: number) => { process.exitCode = code; }))(preflightOutcome.result.exitCode);
    return preflightOutcome.result;
  }
  const ready = preflightOutcome.ready;
  if (ready === undefined) {
    const result = internalResult(baseResult(runId, null, null, null), "preflight", "preflight returned neither a ready context nor a terminal result");
    emitResult(result, parsed.json, out, err);
    (deps.setExit ?? ((code: number) => { process.exitCode = code; }))(result.exitCode);
    return result;
  }

  let identity: ValidatedIdentity;
  try {
    const token = (deps.config ?? config).identity.operatorToken;
    if (token === undefined) throw new Error("operator token is unavailable after preflight");
    identity = deps.resolveIdentity !== undefined ? deps.resolveIdentity(token) : coreResolveIdentity({ token });
  } catch (e) {
    const result = blockedResult(baseResult(runId, ready.spec.taskId, ready.repository, ready.providerPreflight), "RUN_CONFIGURATION_INVALID", "preflight.identity", `operator identity could not be resolved: ${text(e)}`, configurationRecovery());
    emitResult(result, parsed.json, out, err);
    (deps.setExit ?? ((code: number) => { process.exitCode = code; }))(result.exitCode);
    return result;
  }

  const diagnostics: string[] = [];
  const goal = ready.spec.rules === undefined || ready.spec.rules.length === 0
    ? ready.spec.goal
    : `${ready.spec.goal}\n\nOperator constraints:\n${ready.spec.rules.map((rule) => `- ${rule}`).join("\n")}`;
  const checks = ready.spec.checks?.join(" && ");
  let execution: AuthoritativeBuildOutput;
  try {
    execution = await (deps.executeBuild ?? executeAuthoritativeBuild)({
      taskId: ready.spec.taskId,
      goal,
      repository: ready.repository,
      ...(ready.spec.branch !== undefined ? { branch: ready.spec.branch } : {}),
      ...(checks !== undefined ? { checks } : {}),
      ...(ready.spec.maxCostUsd !== undefined ? { maxCostUsd: ready.spec.maxCostUsd } : {}),
      ...(ready.spec.noTestsPolicy === true ? { noTestsPolicy: true } : {}),
      onDiagnostic: (line) => { diagnostics.push(redact(line)); },
    });
  } catch (e) {
    diagnostics.push(`ikbi run execution error: ${redact(text(e))}\n`);
    execution = {};
  }

  let result: RunTerminalResult;
  if (execution.result === undefined) {
    result = noTypedWorkerResult(baseResult(runId, ready.spec.taskId, ready.repository, ready.providerPreflight), execution.processExitCode);
  } else {
    result = workerTerminal(execution.result, runId, ready.spec.taskId, ready.repository, ready.providerPreflight);
    const path = await workspacePath(result.workspace.id);
    result = { ...result, workspace: { ...result.workspace, path } };
  }
  const cfg = deps.config ?? config;
  result = await persistTerminalEvidence(result, identity, cfg, deps.appendReceipt ?? ((input, who) => coreReceipts.append(input, who)), diagnostics);
  emitResult(result, parsed.json, out, err);
  (deps.setExit ?? ((code: number) => { process.exitCode = code; }))(result.exitCode);
  return result;
}
