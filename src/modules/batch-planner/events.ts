/**
 * ikbi batch-planner — its events (namespaced `batch.*` per module plan ## 8).
 *
 * Published with `source: "batch-planner"`. Payloads carry counts / ids / outcomes —
 * NEVER the goal text or build output verbatim.
 */

import { defineEvent } from "../../core/events/index.js";
import type { BatchStatus, SubtaskStatus } from "./contract.js";

/** A goal was decomposed into a validated plan. */
export const batchDecomposed = defineEvent<{ batchId: string; subtaskCount: number; levelCount: number }>("batch.decomposed");
/** A dependency level started building (its subtasks run in parallel). */
export const batchLevelStarted = defineEvent<{ batchId: string; level: number; subtaskCount: number }>("batch.level.started");
/** One subtask's worker run completed. */
export const batchSubtaskCompleted = defineEvent<{ batchId: string; subtaskId: string; outcome: SubtaskStatus; promoted: boolean }>("batch.subtask.completed");
/** Scheduling stopped early (conflict or failure). */
export const batchStopped = defineEvent<{ batchId: string; reason: "conflict" | "failure"; subtaskId: string }>("batch.stopped");
/** The batch finished. */
export const batchCompleted = defineEvent<{ batchId: string; status: BatchStatus; promotedCount: number }>("batch.completed");
