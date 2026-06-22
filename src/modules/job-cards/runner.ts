/**
 * ikbi job-cards — runner.
 *
 * Executes job cards. Respects guardrails, produces receipts, and tracks run status.
 */

import { execSync } from "node:child_process";
import type { JobCard, JobCardResult } from "./contract.js";
import { createRun, updateRun } from "./store.js";

/** Dependencies injected for testability. */
export interface RunnerDeps {
  executeGoal: (goal: string) => Promise<{ output: string; filesChanged: string[]; success: boolean }>;
  getChangedFiles: () => string[];
  isWorktreeClean: () => boolean;
  now: () => string;
}

/** Real dependencies that shell out to git. */
export const realRunnerDeps: RunnerDeps = {
  executeGoal: async (_goal: string) => {
    return { output: `Goal received: ${_goal}`, filesChanged: [], success: true };
  },
  getChangedFiles: () => {
    try {
      const out = execSync("git diff --name-only HEAD", { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      return out.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  },
  isWorktreeClean: () => {
    try {
      const out = execSync("git status --porcelain", { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      return out.trim().length === 0;
    } catch {
      return true;
    }
  },
  now: () => new Date().toISOString(),
};

/**
 * Run a job card. Creates a run record, executes the goal, checks guardrails,
 * and returns the result.
 */
export async function runCard(
  card: JobCard,
  variables: Record<string, string> = {},
  deps: RunnerDeps = realRunnerDeps,
  storeDir?: string,
): Promise<JobCardResult> {
  const run = createRun(card.id, storeDir);

  if (card.guardrails.requireCleanWorktree && !deps.isWorktreeClean()) {
    const error = "Guardrail violation: worktree is not clean";
    updateRun(card.id, run.id, { status: "failed", finishedAt: deps.now(), error }, storeDir);
    return { run: { ...run, status: "failed", finishedAt: deps.now(), error }, output: error, filesChanged: [], verificationPassed: false };
  }

  let goal = card.goalTemplate;
  for (const [key, value] of Object.entries(variables)) {
    goal = goal.replaceAll(`{{${key}}}`, value);
  }

  updateRun(card.id, run.id, { status: "running" }, storeDir);

  try {
    const result = await deps.executeGoal(goal);
    const filesChanged = result.filesChanged.length > 0 ? result.filesChanged : deps.getChangedFiles();

    if (card.guardrails.maxFilesChanged > 0 && filesChanged.length > card.guardrails.maxFilesChanged) {
      const error = `Guardrail violation: ${filesChanged.length} files changed (max ${card.guardrails.maxFilesChanged})`;
      if (card.rollback === "on-failure" || card.rollback === "always") {
        try { execSync("git checkout -- .", { timeout: 10000, stdio: "ignore" }); } catch { /* best effort */ }
      }
      updateRun(card.id, run.id, { status: "failed", finishedAt: deps.now(), error }, storeDir);
      return { run: { ...run, status: "failed", finishedAt: deps.now(), error }, output: result.output, filesChanged, verificationPassed: false };
    }

    for (const file of filesChanged) {
      for (const prot of card.guardrails.protectedPaths) {
        if (file === prot || file.startsWith(prot + "/")) {
          const error = `Guardrail violation: protected path "${prot}" was modified`;
          if (card.rollback === "on-failure" || card.rollback === "always") {
            try { execSync("git checkout -- .", { timeout: 10000, stdio: "ignore" }); } catch { /* best effort */ }
          }
          updateRun(card.id, run.id, { status: "failed", finishedAt: deps.now(), error }, storeDir);
          return { run: { ...run, status: "failed", finishedAt: deps.now(), error }, output: result.output, filesChanged, verificationPassed: false };
        }
      }
    }

    const status = result.success ? "passed" : "failed";
    const verificationPassed = card.verification === "skip" ? true : result.success;

    if (status === "failed" && (card.rollback === "on-failure" || card.rollback === "always")) {
      try { execSync("git checkout -- .", { timeout: 10000, stdio: "ignore" }); } catch { /* best effort */ }
      updateRun(card.id, run.id, { status: "rolled-back", finishedAt: deps.now() }, storeDir);
      return { run: { ...run, status: "rolled-back", finishedAt: deps.now() }, output: result.output, filesChanged, verificationPassed: false };
    }

    if (card.rollback === "always") {
      try { execSync("git checkout -- .", { timeout: 10000, stdio: "ignore" }); } catch { /* best effort */ }
    }

    updateRun(card.id, run.id, { status, finishedAt: deps.now() }, storeDir);
    return { run: { ...run, status, finishedAt: deps.now() }, output: result.output, filesChanged, verificationPassed };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (card.rollback === "on-failure" || card.rollback === "always") {
      try { execSync("git checkout -- .", { timeout: 10000, stdio: "ignore" }); } catch { /* best effort */ }
    }
    updateRun(card.id, run.id, { status: "failed", finishedAt: deps.now(), error }, storeDir);
    return { run: { ...run, status: "failed", finishedAt: deps.now(), error }, output: "", filesChanged: [], verificationPassed: false };
  }
}
