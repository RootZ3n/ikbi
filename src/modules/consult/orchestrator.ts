/**
 * ikbi consult — runConsult: the frontier-executor.
 *
 * The cheap pre-pass + one bounded frontier call, end to end:
 *   1. project-retrieval ranks the relevant files (DETERMINISTIC, zero model calls — the
 *      cheapest possible curation),
 *   2. buildConsultPacket assembles verbatim slices of those files + the exact failing checks
 *      + the failure trail into an evidence-dense ConsultPacket,
 *   3. consultModel() resolves the frontier model (cheapest-sufficient; --model overrides),
 *   4. ONE invokeModel call with NO tools and NO loop returns the plan (advise) or diff (patch).
 *
 * This is the frontier rung of the recovery loop: when the worker+mid pool is exhausted and
 * frontier is authorized, the recovery driver's consult() executor calls this. It is also the
 * standalone `ikbi consult` surface. Opus never scans the repo and never enters a tool loop —
 * the cost is one bounded request in, one bounded answer out.
 *
 * Everything is dependency-injected (invokeModel / retrieval / rosters), so the whole path
 * unit-tests against mocks with no network. v1 is retrieval-only; the scout line-level pointer
 * enrichment is an additive next increment (scoutPointers is empty until then).
 */

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { escalationConfig } from "../escalation/index.js";
import { consultModel, rosterFromIds } from "../model-router/index.js";
import type { LuakLeaderboardEntry, ModelTier, RosterModel } from "../model-router/index.js";
import type { ProjectRetrievalApi } from "../project-retrieval/index.js";
import { buildConsultPacket } from "./consultPacket.js";
import type { ConsultAttempt, ConsultMode, ConsultPacket, ConsultSliceRequest } from "./contract.js";
import { consultSystemPrompt, renderConsultPrompt } from "./prompt.js";

const DEFAULT_BUDGET_BYTES = 64 * 1024;
const DEFAULT_PER_FILE_CAP_BYTES = 8 * 1024;
const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_TOKENS_ADVISE = 1500;
const DEFAULT_MAX_TOKENS_PATCH = 2400;
const CONSULT_TEMPERATURE = 0.1;
/** Whole-file slice ceiling; the packet's per-slice + total budgets do the real trimming. */
const WHOLE_FILE_END = 1_000_000;

export interface ConsultDeps {
  readonly invokeModel?: (request: ModelRequest) => Promise<ModelResponse>;
  readonly retrieval?: ProjectRetrievalApi;
  /** Per-tier rosters for resolving the frontier model. Defaults to escalation config. */
  readonly tierRosters?: Readonly<Record<ModelTier, readonly RosterModel[]>>;
  readonly leaderboard?: readonly LuakLeaderboardEntry[];
}

export interface ConsultRequest {
  readonly repoRoot: string;
  readonly question: string;
  readonly mode: ConsultMode;
  /** Validated agent identity for the model call (e.g. ctx.identity). */
  readonly identity: ModelRequest["identity"];
  readonly goal?: string;
  /** Exact failing-check output, verbatim (never paraphrased). */
  readonly failingChecks?: string;
  /** What cheaper models already tried and why it failed (the recovery trail). */
  readonly triedAndFailed?: readonly ConsultAttempt[];
  /** Force a specific frontier model id (else cheapest-sufficient frontier). */
  readonly modelOverride?: string;
  /** Total slice byte budget for the packet. */
  readonly budgetBytes?: number;
  /** Hard cap on files pulled into the packet. */
  readonly maxFiles?: number;
  /** Frontier output cap. Defaults by mode (advise smaller than patch). */
  readonly maxTokens?: number;
}

export interface ConsultResult {
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly mode: ConsultMode;
  /** The frontier model's text — a root-cause + plan (advise) or a unified diff (patch). */
  readonly answer: string;
  readonly packet: ConsultPacket;
  readonly usage: ModelResponse["usage"];
  readonly cost: ModelResponse["cost"];
  readonly retrieval: { readonly files: number; readonly lowConfidence: boolean };
}

function defaultTierRosters(): Readonly<Record<ModelTier, readonly RosterModel[]>> {
  const t = escalationConfig.tierModels;
  return {
    worker: rosterFromIds(t.worker),
    mid: rosterFromIds(t.mid),
    frontier: rosterFromIds(t.frontier)
  };
}

export async function runConsult(req: ConsultRequest, deps: ConsultDeps = {}): Promise<ConsultResult> {
  // Lazy-load the real provider/retrieval ONLY when not injected — importing the provider eagerly
  // would pull in the network-egress floor at module load (and break mock-only unit tests).
  const invokeModel = deps.invokeModel ?? (await import("../../core/provider/index.js")).invokeModel;
  const retrieval = deps.retrieval ?? (await import("../project-retrieval/index.js")).projectRetrieval;
  const tierRosters = deps.tierRosters ?? defaultTierRosters();
  const budgetBytes = req.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const maxFiles = req.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTokens = req.maxTokens ?? (req.mode === "patch" ? DEFAULT_MAX_TOKENS_PATCH : DEFAULT_MAX_TOKENS_ADVISE);

  // 1. Deterministic, model-free retrieval — the cheap curation.
  const retrievalGoal = [req.goal, req.question].filter((s): s is string => s !== undefined && s.length > 0).join("\n");
  const retrieved = await retrieval.retrieve({
    repoPath: req.repoRoot,
    goal: retrievalGoal,
    budgetBytes,
    perFileCapBytes: DEFAULT_PER_FILE_CAP_BYTES,
    maxFiles
  });
  const paths = retrieved.files.map((f) => f.path);

  // 2. Verbatim slices of the relevant files → evidence-dense packet.
  const sliceRequests: ConsultSliceRequest[] = paths.map((path) => ({ path, startLine: 1, endLine: WHOLE_FILE_END }));
  const packet = await buildConsultPacket({
    repoRoot: req.repoRoot,
    mode: req.mode,
    question: req.question,
    ...(req.goal !== undefined ? { goal: req.goal } : {}),
    sliceRequests,
    ...(req.failingChecks !== undefined ? { failingChecks: req.failingChecks } : {}),
    ...(req.triedAndFailed !== undefined ? { triedAndFailed: req.triedAndFailed } : {}),
    allowedFiles: paths,
    budget: { maxTotalSliceBytes: budgetBytes }
  });

  // 3. Resolve the frontier model (cheapest-sufficient unless overridden).
  const resolved = req.modelOverride !== undefined
    ? { modelId: req.modelOverride, tier: "frontier" as ModelTier }
    : consultModel(tierRosters, deps.leaderboard);

  // 4. ONE bounded, tool-free frontier call.
  const response = await invokeModel({
    model: resolved.modelId,
    temperature: CONSULT_TEMPERATURE,
    maxTokens,
    identity: req.identity,
    messages: [
      { role: "system", content: consultSystemPrompt(req.mode) },
      { role: "user", content: renderConsultPrompt(packet) }
    ]
  });

  return {
    modelId: resolved.modelId,
    tier: resolved.tier,
    mode: req.mode,
    answer: response.content,
    packet,
    usage: response.usage,
    cost: response.cost,
    retrieval: { files: paths.length, lowConfidence: retrieved.lowConfidence }
  };
}
