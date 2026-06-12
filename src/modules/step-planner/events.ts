/**
 * ikbi step-planner — events.
 */

import { defineEvent } from "../../core/events/index.js";

export interface StepPlanEventPayload {
  readonly taskId: string;
  readonly stepCount: number;
  readonly source: "heuristic" | "model";
  readonly decomposed: boolean;
}

export interface StepStartedEventPayload {
  readonly taskId: string;
  readonly stepIndex: number;
  readonly stepGoal: string;
}

export interface StepCompletedEventPayload {
  readonly taskId: string;
  readonly stepIndex: number;
  readonly outcome: "success" | "failure" | "skipped";
  readonly summary?: string;
}

export const stepPlanCreated = defineEvent<StepPlanEventPayload>("step-planner.plan-created");
export const stepStarted = defineEvent<StepStartedEventPayload>("step-planner.step-started");
export const stepCompleted = defineEvent<StepCompletedEventPayload>("step-planner.step-completed");
