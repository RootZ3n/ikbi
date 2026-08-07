/**
 * Narrow evidence inspection for a canonical `ikbi run`.
 *
 * It reads the existing receipt log and workspace registry. There is no second
 * event store and no replay or mutation authority here.
 */

import { join } from "node:path";

import { config } from "../core/config.js";
import { receipts as coreReceipts } from "../core/receipt/index.js";
import type { Receipt } from "../core/receipt/contract.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
import type { WorkspaceRecord } from "../core/workspace/contract.js";
import { writeStderr, writeStdout } from "./io.js";

export const INSPECT_EXIT_CODES = Object.freeze({ ok: 0, usage: 10, missing: 20, internal: 40 });

export interface InspectEvidence {
  readonly receipts: readonly string[];
  readonly logs: readonly string[];
  readonly diagnosticBundle: string | null;
  readonly invocationLedger: readonly string[];
  readonly mutation: readonly string[];
  readonly verification: readonly string[];
  readonly promotion: readonly string[];
}

export interface InspectResult {
  readonly command: "inspect";
  readonly status: "found" | "not_found" | "invalid" | "failed";
  readonly code: "INSPECT_OK" | "INSPECT_RUN_ID_MISSING" | "INSPECT_NOT_FOUND" | "INSPECT_INTERNAL_ERROR";
  readonly exitCode: number;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly repository: string | null;
  readonly run: {
    readonly status: string;
    readonly phase: string;
    readonly paidInvocationStarted: boolean | null;
    readonly mutationApplied: boolean | null;
    readonly partialMutation: boolean | null;
    readonly retryable: boolean | null;
  } | null;
  readonly workspace: { readonly id: string | null; readonly path: string | null; readonly state: string | null };
  readonly candidate: { readonly id: string | null; readonly generationId: string | null };
  readonly verification: { readonly status: string };
  readonly promotion: { readonly status: string };
  readonly evidence: InspectEvidence;
  readonly recovery: readonly string[];
}

export interface InspectDeps {
  readonly readReceipts?: () => Promise<readonly Receipt[]>;
  readonly getWorkspace?: (id: string) => Promise<WorkspaceRecord | undefined>;
  readonly receiptPath?: string;
}

function emptyEvidence(): InspectEvidence {
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

function parseArgs(argv: readonly string[]): { readonly runId?: string; readonly json: boolean; readonly help: boolean; readonly unknown: readonly string[] } {
  let runId: string | undefined;
  let json = false;
  let help = false;
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--") runId = argv[i + 1];
    else if (arg.startsWith("-")) unknown.push(arg);
    else if (runId === undefined) runId = arg;
    else unknown.push(arg);
  }
  return { ...(runId !== undefined ? { runId } : {}), json, help, unknown };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boolValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function related(receipts: readonly Receipt[], runId: string, taskId: string | null): Receipt[] {
  return receipts.filter((receipt) => {
    const metadata = receipt.metadata ?? {};
    return receipt.requestId === runId || metadata.runId === runId || (taskId !== null && (receipt.requestId === taskId || metadata.taskId === taskId));
  });
}

function receiptIds(items: readonly Receipt[], predicate: (receipt: Receipt) => boolean): string[] {
  return items.filter(predicate).map((receipt) => `receipt:${receipt.id}`);
}

function buildResult(runId: string | null, status: InspectResult["status"], code: InspectResult["code"], exitCode: number, message?: string): InspectResult {
  return {
    command: "inspect",
    status,
    code,
    exitCode,
    runId,
    taskId: null,
    repository: null,
    run: message === undefined ? null : { status: "unavailable", phase: message, paidInvocationStarted: null, mutationApplied: null, partialMutation: null, retryable: null },
    workspace: { id: null, path: null, state: null },
    candidate: { id: null, generationId: null },
    verification: { status: "not_started" },
    promotion: { status: "not_attempted" },
    evidence: emptyEvidence(),
    recovery: message === undefined ? [] : [message],
  };
}

export async function inspectRun(runId: string, deps: InspectDeps = {}): Promise<InspectResult> {
  let all: Receipt[];
  try {
    all = [...(await (deps.readReceipts ?? (() => coreReceipts.readAll()))())];
  } catch {
    return buildResult(runId, "failed", "INSPECT_INTERNAL_ERROR", INSPECT_EXIT_CODES.internal, "receipt store could not be read");
  }
  const wrapper = all
    .filter((receipt) => receipt.operation === "run.summary" && (receipt.requestId === runId || receipt.metadata?.runId === runId))
    .at(-1);
  if (wrapper === undefined) return buildResult(runId, "not_found", "INSPECT_NOT_FOUND", INSPECT_EXIT_CODES.missing, "no canonical run.summary receipt matched this run id");

  const metadata = wrapper.metadata ?? {};
  const taskId = stringValue(metadata.taskId) ?? stringValue(wrapper.requestSummary?.taskId);
  const repository = stringValue(metadata.repository) ?? stringValue(wrapper.project);
  const workspaceId = stringValue(metadata.workspaceId);
  const generationId = stringValue(metadata.generationId);
  const items = related(all, runId, taskId);
  let workspace: WorkspaceRecord | undefined;
  if (workspaceId !== null) workspace = await (deps.getWorkspace ?? ((id: string) => coreWorkspaces.get(id)))(workspaceId).catch(() => undefined);
  const status = stringValue(metadata.status) ?? wrapper.outcome.status;
  const phase = stringValue(metadata.phase) ?? "unknown";
  const diagnosticBundle = stringValue(metadata.diagnosticBundle);
  const evidence: InspectEvidence = {
    receipts: [deps.receiptPath ?? join(config.receipt.dir, "receipts.ndjson"), `receipt:${wrapper.id}`, ...items.filter((item) => item.id !== wrapper.id).map((item) => `receipt:${item.id}`)],
    logs: diagnosticBundle !== null ? [diagnosticBundle] : ["stderr (process stream; no durable log configured)"],
    diagnosticBundle,
    invocationLedger: receiptIds(items, (receipt) => receipt.operation.includes("invoke") || receipt.metadata?.invocationId !== undefined),
    mutation: receiptIds(items, (receipt) => receipt.changes.length > 0 || /mutation|write|repair/i.test(receipt.operation)),
    verification: receiptIds(items, (receipt) => /verif|worker\.run\.summary/i.test(receipt.operation)),
    promotion: receiptIds(items, (receipt) => /promot|integrat/i.test(receipt.operation) || receipt.metadata?.promoted === true),
  };
  const verificationReceipt = items.findLast((receipt) => receipt.metadata?.verificationResult !== undefined);
  const promotionReceipt = items.findLast((receipt) => receipt.metadata?.promoted !== undefined || /promot/i.test(receipt.operation));
  const verificationStatus = stringValue(metadata.verification) ?? stringValue(verificationReceipt?.metadata?.verificationResult) ?? "not_started";
  const promotionStatus = stringValue(metadata.promotion) ?? (promotionReceipt?.metadata?.promoted === true ? "promoted" : "not_attempted");
  const recovery = Array.isArray(metadata.recovery) ? metadata.recovery.filter((value): value is string => typeof value === "string") : [];
  return {
    command: "inspect",
    status: "found",
    code: "INSPECT_OK",
    exitCode: INSPECT_EXIT_CODES.ok,
    runId,
    taskId,
    repository,
    run: {
      status,
      phase,
      paidInvocationStarted: boolValue(metadata.paidInvocationStarted),
      mutationApplied: boolValue(metadata.mutationApplied),
      partialMutation: boolValue(metadata.partialMutation),
      retryable: boolValue(metadata.retryable),
    },
    workspace: { id: workspaceId, path: workspace?.path ?? null, state: workspace?.state ?? null },
    candidate: { id: stringValue(metadata.candidateId) ?? workspaceId, generationId },
    verification: { status: verificationStatus },
    promotion: { status: promotionStatus },
    evidence,
    recovery,
  };
}

function human(result: InspectResult): string {
  if (result.status !== "found") return `ikbi inspect: ${result.code} — ${result.recovery.join(" ")}\n`;
  return [
    `ikbi inspect: ${result.runId}`,
    `  status: ${result.run?.status ?? "unknown"}; phase: ${result.run?.phase ?? "unknown"}`,
    `  task: ${result.taskId ?? "(unknown)"}`,
    `  repository: ${result.repository ?? "(unknown)"}`,
    `  workspace: ${result.workspace.id ?? "(none)"}${result.workspace.path ? ` — ${result.workspace.path}` : ""} [${result.workspace.state ?? "unknown"}]`,
    `  candidate: ${result.candidate.id ?? "(none)"}${result.candidate.generationId ? ` / generation ${result.candidate.generationId}` : ""}`,
    `  verification: ${result.verification.status}; promotion: ${result.promotion.status}`,
    `  invocation ledger: ${result.evidence.invocationLedger.length > 0 ? result.evidence.invocationLedger.join(", ") : "none"}`,
    `  mutation evidence: ${result.evidence.mutation.length > 0 ? result.evidence.mutation.join(", ") : "none"}`,
    `  receipts: ${result.evidence.receipts.join(", ")}`,
    `  diagnostics: ${result.evidence.diagnosticBundle ?? "stderr only; no durable diagnostic bundle"}`,
    ...(result.recovery.length > 0 ? [`  recovery: ${result.recovery.join(" ")}`] : []),
    "",
  ].join("\n");
}

export async function runInspect(argv: readonly string[], io: { readonly out?: (text: string) => void; readonly err?: (text: string) => void; readonly setExit?: (code: number) => void } = {}): Promise<InspectResult | undefined> {
  const out = io.out ?? writeStdout;
  const err = io.err ?? writeStderr;
  const parsed = parseArgs(argv);
  if (parsed.help) {
    out("Usage: ikbi inspect <run-id> [--json]\n\nSummarize existing run receipts, workspace state, verification, promotion, and diagnostics.\n");
    return undefined;
  }
  const setExit = io.setExit ?? ((code: number) => { process.exitCode = code; });
  if (parsed.unknown.length > 0 || parsed.runId === undefined || parsed.runId.trim().length === 0) {
    const result = buildResult(null, "invalid", "INSPECT_RUN_ID_MISSING", INSPECT_EXIT_CODES.usage, "provide one run id: ikbi inspect <run-id>");
    if (parsed.json) out(`${JSON.stringify(result, null, 2)}\n`);
    else err(human(result));
    setExit(result.exitCode);
    return result;
  }
  const result = await inspectRun(parsed.runId.trim());
  if (parsed.json) out(`${JSON.stringify(result, null, 2)}\n`);
  else out(human(result));
  if (result.status !== "found") err(`${result.code}: ${result.recovery.join(" ")}\n`);
  setExit(result.exitCode);
  return result;
}
