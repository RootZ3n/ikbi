/**
 * ikbi worker-model — THE CANDIDATE TOURNAMENT (#tournament).
 *
 * The tournament replaces "make one cheap model behave like an autonomous agent" with a contest:
 *   1. N candidate models independently attempt the SAME task, each in its OWN isolated workspace.
 *   2. ikbi verifies EVERY candidate with the same ladder verifier (no model judge).
 *   3. A DETERMINISTIC judge scores the candidates and picks ONE winner (verified pass beats all;
 *      smaller diff, no forbidden files, fewer warnings, lower cost break ties).
 *   4. The winner's diff is REPLAYED into a CLEAN shadow workspace (pristine base ref) so any side
 *      effects of the candidate's tool use are gone and only the winning diff is present.
 *   5. The shadow is VERIFIED AGAIN. Only then does it go through the EXISTING promote path.
 *
 * Models propose. ikbi verifies. ikbi scores. One winner. No model-to-model communication. No
 * merging. No new promote paths. If ALL candidates fail, the shadow diff cannot apply, or the shadow
 * fails verification, the tournament FAILS CLOSED — there is no "best of bad" promotion.
 *
 * THIS FILE holds only the deterministic ALGORITHM. Everything that touches a real singleton
 * (workspaces, gate-wall, model invocation, receipts, events) lives behind the injected
 * `TournamentEngine` seam — so the algorithm is unit-testable with a fake, and the orchestrator
 * wires the real engine from its own closures (the same dispatch/spawn/verify path the other modes
 * use). The verifier, integrator, and promote path are UNCHANGED — the tournament is a
 * builder-layer concern only.
 */

import type { OperationContext } from "../../core/identity/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { BuildCandidate, JudgeResult } from "../deterministic-judge/index.js";
import type { BuilderMode } from "./config.js";
import { CONTRACT_VERSION } from "./contract.js";
import type { RoleResult, WorkerResult, WorkerTask } from "./contract.js";

/** One candidate's spec: which model races, in which builder lane. */
export interface CandidateSpec {
  readonly model: string;
  readonly mode: BuilderMode;
}

/** The objective result of running ONE candidate independently in its own workspace. */
export interface CandidateRun {
  readonly spec: CandidateSpec;
  /** The candidate's isolated workspace. */
  readonly workspace: WorkspaceHandle;
  /** The candidate's role results (scout → builder → [verifier]), for receipts + winner roles. */
  readonly roles: readonly RoleResult[];
  /** The objective facts the deterministic judge scores (`candidate.workspaceId === workspace.id`). */
  readonly candidate: BuildCandidate;
  /** The candidate's committed diff vs base — replayed into the shadow if it wins. */
  readonly diff: string;
}

/** The verdict of verifying the shadow workspace (the winning diff in a pristine tree). */
export interface ShadowVerification {
  readonly pass: boolean;
  /** The verifier RoleResult(s) — folded into the final result's roles + the gate-wall promote input. */
  readonly roles: readonly RoleResult[];
  readonly reason?: string;
}

/** One candidate's line in the tournament receipt (objective, auditable). */
export interface TournamentReceiptCandidate {
  readonly model: string;
  readonly mode: BuilderMode;
  readonly workspaceId: string;
  readonly builderOutcome: string;
  readonly verified: boolean;
  readonly diffLines?: number;
  readonly rejectedToolCalls: number;
}

/** The full tournament receipt: every candidate, the winner + reason, the shadow result, the promote. */
export interface TournamentReceipt {
  readonly taskId: string;
  readonly candidates: readonly TournamentReceiptCandidate[];
  readonly winner: { readonly workspaceId: string; readonly model: string; readonly composite: number } | null;
  readonly shadow: { readonly workspaceId?: string; readonly applied: boolean; readonly verified: boolean; readonly reason?: string };
  readonly promoted: boolean;
  readonly reason?: string;
}

/** A tournament lifecycle event the engine maps onto the event bus. */
export type TournamentEvent =
  | { readonly kind: "started"; readonly candidateCount: number }
  | { readonly kind: "judged"; readonly candidateCount: number; readonly winnerWorkspaceId: string | null }
  | { readonly kind: "completed"; readonly winnerWorkspaceId: string | null; readonly shadowWorkspaceId?: string; readonly promoted: boolean }
  | { readonly kind: "failed"; readonly reason: string; readonly workspaceId?: string };

/**
 * The seams the tournament needs. Everything stateful/impure is behind this; the orchestrator
 * supplies the real implementation (wired to its dispatch/spawn/verify closures), and tests supply
 * a fake. `runCandidate` is the isolation boundary — each candidate is run through it independently
 * and NEVER sees another candidate's workspace, roles, or output.
 */
export interface TournamentEngine {
  /** Which verification path ran ("ladder" | "legacy"), surfaced on the result for observability. */
  readonly verificationMode?: string;
  /** Allocate an isolated workspace from the task's base ref. Returns null on allocation failure (skip that candidate). */
  allocate(label: string): Promise<WorkspaceHandle | null>;
  /** Run ONE candidate fully (scout → builder → verifier, commit verified work) in its own workspace. Independent. */
  runCandidate(task: WorkerTask, workspace: WorkspaceHandle, spec: CandidateSpec): Promise<CandidateRun>;
  /** Score the candidates objectively (the deterministic judge — pure, no model). */
  judge(candidates: readonly BuildCandidate[]): JudgeResult;
  /** Apply a unified diff into a CLEAN workspace and commit it. Returns whether it applied + committed cleanly. */
  applyDiff(workspace: WorkspaceHandle, diff: string): Promise<{ applied: boolean; reason?: string }>;
  /** Verify a workspace with the SAME ladder verifier the candidates ran. */
  verifyShadow(task: WorkerTask, workspace: WorkspaceHandle): Promise<ShadowVerification>;
  /** Promote a workspace through the EXISTING promote path (gate-wall governs; fail-closed without it). */
  promote(task: WorkerTask, workspace: WorkspaceHandle, roles: readonly RoleResult[], composite: number): Promise<{ promoted: boolean; reason?: string; conflicts?: readonly string[] }>;
  /** Discard a workspace (best-effort teardown). */
  discard(workspace: WorkspaceHandle): Promise<void>;
  /** Retain a failed workspace on disk for inspection (best-effort; falls back to discard). */
  retain(workspace: WorkspaceHandle, reason: string): Promise<void>;
  /** Record the full tournament receipt. */
  recordReceipt(receipt: TournamentReceipt): Promise<void>;
  /** Total model cost accumulated across every candidate + the shadow this run. */
  cost(): number;
  /** Cooperative kill checkpoint: is THIS run killed? (read-only; returns the reason or undefined). */
  killed(): Promise<string | undefined>;
  /** Publish a lifecycle event (best-effort). */
  emit(event: TournamentEvent): void;
}

/** Map a candidate run onto its objective receipt line. */
function receiptCandidate(run: CandidateRun): TournamentReceiptCandidate {
  const builder = run.roles.find((r) => r.role === "builder");
  const verifier = run.roles.find((r) => r.role === "verifier");
  const verdict = (verifier?.detail as { verdict?: unknown } | undefined)?.verdict;
  return {
    model: run.spec.model,
    mode: run.spec.mode,
    workspaceId: run.workspace.id,
    builderOutcome: builder?.outcome ?? "absent",
    verified: verifier?.outcome === "success" && verdict === "pass",
    ...(run.candidate.diffLines !== undefined ? { diffLines: run.candidate.diffLines } : {}),
    rejectedToolCalls: run.candidate.rejectedToolCalls,
  };
}

/** Assemble the full tournament receipt from the run state. */
function buildReceipt(
  task: WorkerTask,
  runs: readonly CandidateRun[],
  winner: { run: CandidateRun; composite: number } | null,
  shadow: TournamentReceipt["shadow"],
  promoted: boolean,
  reason?: string,
): TournamentReceipt {
  return {
    taskId: task.taskId,
    candidates: runs.map(receiptCandidate),
    winner: winner === null ? null : { workspaceId: winner.run.workspace.id, model: winner.run.spec.model, composite: winner.composite },
    shadow,
    promoted,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * Run a CANDIDATE TOURNAMENT: race `specs` independently, verify + score all, replay the winner's
 * diff into a clean shadow workspace, re-verify, and promote through the existing path. Fails closed
 * when no candidate passes, the winning diff cannot apply, or the shadow fails verification.
 */
export async function runTournament(
  task: WorkerTask,
  _parentCtx: OperationContext,
  specs: readonly CandidateSpec[],
  engine: TournamentEngine,
): Promise<WorkerResult> {
  const withMode = <T extends Record<string, unknown>>(base: T): T & { verificationMode?: string } =>
    engine.verificationMode !== undefined ? { ...base, verificationMode: engine.verificationMode } : base;

  const fail = (reason: string, workspaceId?: string): WorkerResult => {
    engine.emit({ kind: "failed", reason, ...(workspaceId !== undefined ? { workspaceId } : {}) });
    return withMode({
      contractVersion: CONTRACT_VERSION,
      taskId: task.taskId,
      outcome: "rejected" as const,
      roles: [] as readonly RoleResult[],
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      promoted: false,
      reason,
      costUsd: engine.cost(),
    });
  };

  engine.emit({ kind: "started", candidateCount: specs.length });

  // Pre-allocation kill checkpoint: do not start anything when this run is killed.
  const preKill = await engine.killed();
  if (preKill !== undefined) return fail(preKill);

  // 1. Run each candidate INDEPENDENTLY in its OWN workspace. A failed allocation skips that
  //    candidate and continues with the rest (per the error-handling contract).
  const runs: CandidateRun[] = [];
  for (let i = 0; i < specs.length; i += 1) {
    const ws = await engine.allocate(`tournament:${task.taskId}:c${i}`);
    if (ws === null) continue;
    // Kill between candidates: stop cleanly, discard everything (no half-promote), surface the kill.
    const killReason = await engine.killed();
    if (killReason !== undefined) {
      await engine.discard(ws);
      for (const r of runs) await engine.discard(r.workspace);
      return fail(killReason, ws.id);
    }
    runs.push(await engine.runCandidate(task, ws, specs[i]!));
  }

  // Every candidate workspace failed to allocate → nothing to judge, fail closed.
  if (runs.length === 0) return fail("all candidate workspaces failed to allocate — tournament fails closed");

  // 2. JUDGE — deterministic, pure, no model. Verified pass beats all; ties broken objectively.
  const verdict = engine.judge(runs.map((r) => r.candidate));
  engine.emit({ kind: "judged", candidateCount: runs.length, winnerWorkspaceId: verdict.winner?.workspaceId ?? null });

  const discardAll = async (): Promise<void> => {
    for (const r of runs) await engine.discard(r.workspace);
  };
  /** Retain the judge's top-ranked (or first) candidate for inspection, discard the rest. */
  const retainBest = async (reason: string): Promise<string | undefined> => {
    const keepId = verdict.ranking[0]?.workspaceId ?? runs[0]?.workspace.id;
    const keep = runs.find((r) => r.workspace.id === keepId);
    if (keep === undefined) {
      await discardAll();
      return undefined;
    }
    await engine.retain(keep.workspace, reason);
    for (const r of runs) if (r.workspace.id !== keep.workspace.id) await engine.discard(r.workspace);
    return keep.workspace.id;
  };

  // 2a. NO candidate passed verification (judge rejected all) → fail closed (no "best of bad").
  if (verdict.winner === null) {
    const reason = verdict.reason ?? "no candidate passed verification — tournament fails closed";
    const retainedId = await retainBest(reason);
    await engine.recordReceipt(buildReceipt(task, runs, null, { applied: false, verified: false }, false, reason));
    return fail(reason, retainedId);
  }

  const winnerId = verdict.winner.workspaceId;
  const winnerComposite = verdict.winner.composite;
  const winner = runs.find((r) => r.workspace.id === winnerId)!;
  const winnerRef = { run: winner, composite: winnerComposite };

  // 3. SHADOW REPLAY — allocate a CLEAN workspace from the same base ref and apply the winner's diff.
  const shadowKill = await engine.killed();
  if (shadowKill !== undefined) return fail(shadowKill, await retainBest(shadowKill));

  const shadow = await engine.allocate(`tournament:${task.taskId}:shadow`);
  if (shadow === null) {
    const reason = "shadow workspace allocation failed — tournament fails closed";
    const id = await retainBest(reason);
    await engine.recordReceipt(buildReceipt(task, runs, winnerRef, { applied: false, verified: false, reason }, false, reason));
    return fail(reason, id);
  }

  const apply = await engine.applyDiff(shadow, winner.diff);
  if (!apply.applied) {
    const reason = `winner's diff failed to apply to the clean shadow workspace${apply.reason !== undefined ? `: ${apply.reason}` : ""} — tournament fails closed`;
    await engine.discard(shadow);
    const id = await retainBest(reason);
    await engine.recordReceipt(buildReceipt(task, runs, winnerRef, { workspaceId: shadow.id, applied: false, verified: false, reason }, false, reason));
    return fail(reason, id);
  }

  // 4. VERIFY the shadow — the winning diff must pass in a PRISTINE tree (not the candidate's messy one).
  const shadowVerdict = await engine.verifyShadow(task, shadow);
  if (!shadowVerdict.pass) {
    const reason = `shadow verification failed${shadowVerdict.reason !== undefined ? `: ${shadowVerdict.reason}` : ""} — tournament fails closed (no fallback to other candidates)`;
    await engine.discard(shadow);
    const id = await retainBest(reason);
    await engine.recordReceipt(buildReceipt(task, runs, winnerRef, { workspaceId: shadow.id, applied: true, verified: false, reason }, false, reason));
    return fail(reason, id);
  }

  // 5. PROMOTE the shadow through the EXISTING promote path (gate-wall governs).
  const promoteKill = await engine.killed();
  if (promoteKill !== undefined) {
    await engine.discard(shadow);
    return fail(promoteKill, await retainBest(promoteKill));
  }

  // The authoritative roles for the promote (gate-wall input) + the final result are the WINNER's
  // build roles plus the SHADOW's verifier verdict (the verdict the promote actually relies on).
  const resultRoles: readonly RoleResult[] = [...winner.roles, ...shadowVerdict.roles];
  const promote = await engine.promote(task, shadow, resultRoles, winnerComposite);

  // The winner's CHANGES now live in the shadow → every candidate workspace is discarded.
  await discardAll();

  if (!promote.promoted) {
    const outcome: WorkerResult["outcome"] = promote.conflicts !== undefined && promote.conflicts.length > 0 ? "partial" : "rejected";
    const reason = promote.reason ?? "shadow not promoted (gate denied or conflict)";
    await engine.retain(shadow, reason);
    await engine.recordReceipt(buildReceipt(task, runs, winnerRef, { workspaceId: shadow.id, applied: true, verified: true, reason }, false, reason));
    engine.emit({ kind: "completed", winnerWorkspaceId: winner.workspace.id, shadowWorkspaceId: shadow.id, promoted: false });
    return withMode({
      contractVersion: CONTRACT_VERSION,
      taskId: task.taskId,
      outcome,
      roles: resultRoles,
      workspaceId: shadow.id,
      promoted: false,
      reason,
      costUsd: engine.cost(),
    });
  }

  await engine.recordReceipt(buildReceipt(task, runs, winnerRef, { workspaceId: shadow.id, applied: true, verified: true }, true));
  engine.emit({ kind: "completed", winnerWorkspaceId: winner.workspace.id, shadowWorkspaceId: shadow.id, promoted: true });
  return withMode({
    contractVersion: CONTRACT_VERSION,
    taskId: task.taskId,
    outcome: "success" as const,
    roles: resultRoles,
    workspaceId: shadow.id,
    promoted: true,
    costUsd: engine.cost(),
  });
}
