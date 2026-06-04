/**
 * ikbi worker-model substrate — its events (namespaced `worker.*` per module plan ## 8).
 *
 * Published on the existing event bus with `source: "worker-model"` and identity
 * attribution (parent on run-level events, the spawned role identity on role-level
 * events). Transient live signals; receipts are the durable record.
 */

import { defineEvent } from "../../core/events/index.js";
import type { WorkerOutcome, WorkerRole } from "./contract.js";

/** A run started — workspace allocated, about to dispatch roles. (Attribution: parent.) */
export const workerStarted = defineEvent<{ taskId: string; workspaceId: string }>("worker.started");

/** A role is about to run, under its spawned identity. (Attribution: role identity.) */
export const workerRoleDispatched = defineEvent<{ taskId: string; role: WorkerRole; tier?: string }>(
  "worker.role.dispatched",
);

/** A role finished. (Attribution: role identity.) */
export const workerRoleCompleted = defineEvent<{ taskId: string; role: WorkerRole; outcome: WorkerOutcome }>(
  "worker.role.completed",
);

/** A run completed (success / partial). (Attribution: parent.) */
export const workerCompleted = defineEvent<{
  taskId: string;
  outcome: WorkerOutcome;
  promoted: boolean;
  workspaceId: string;
}>("worker.completed");

/** A run failed (a role failed/rejected/stub, or an infrastructure error). (Attribution: parent.) */
export const workerFailed = defineEvent<{ taskId: string; reason: string; workspaceId?: string }>("worker.failed");
