/**
 * ikbi step-planner — implementation.
 *
 * The decomposer breaks a complex goal into atomic steps.
 * Two strategies:
 *   1. HEURISTIC — split on "and", commas, numbered lists. Zero cost.
 *   2. MODEL — ask a model to decompose. Costs one cheap call.
 *
 * The heuristic is tried first. If it produces < 2 steps, the goal
 * is considered simple and passes through unchanged.
 */

import type { Step, StepPlan } from "./contract.js";
import { COMPLEX_INDICATORS, COMPLEX_THRESHOLD, MAX_STEPS } from "./config.js";

/**
 * Score a goal for complexity. Returns how many COMPLEX_INDICATORS match.
 * Higher = more complex.
 */
export function complexityScore(goal: string): number {
  return COMPLEX_INDICATORS.filter((re) => re.test(goal)).length;
}

/**
 * Split a goal on conjunctions and punctuation into sub-goals.
 * Tries multiple delimiters in order of specificity.
 */
function splitGoal(goal: string): string[] {
  // Try numbered list: "1. do X\n2. do Y" or "1) do X\n2) do Y"
  const numbered = goal.match(/\b\d+[.)]\s*.+/g);
  if (numbered && numbered.length >= 2) {
    return numbered.map((s) => s.replace(/^\d+[.)]\s*/, "").trim()).filter(Boolean);
  }

  // Try "and" splitting: "do X and do Y and do Z"
  // Only split on "and" that separates independent clauses (not "read and write")
  const andParts = goal.split(/\s+and\s+(?=[a-z])/i);
  if (andParts.length >= 2 && andParts.every((p) => p.length > 10)) {
    return andParts.map((s) => s.trim()).filter(Boolean);
  }

  // Try comma+conjunction: "do X, also Y, plus Z"
  const commaParts = goal.split(/,\s*(?:also|then|additionally|plus|and)\s+/i);
  if (commaParts.length >= 2 && commaParts.every((p) => p.length > 10)) {
    return commaParts.map((s) => s.trim()).filter(Boolean);
  }

  // Try semicolons: "do X; do Y; do Z"
  const semiParts = goal.split(/\s*;\s*/);
  if (semiParts.length >= 2 && semiParts.every((p) => p.length > 10)) {
    return semiParts.map((s) => s.trim()).filter(Boolean);
  }

  return [goal];
}

/**
 * Extract file paths mentioned in a goal string.
 */
function extractPaths(goal: string): string[] {
  const re = /(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,5}/g;
  const matches = goal.match(re) ?? [];
  return [...new Set(matches)].filter(
    (p) => !["and", "or", "the", "a", "an", "to", "in", "for", "with", "from"].includes(p.toLowerCase()),
  );
}

/**
 * Decompose a goal into a StepPlan using heuristics.
 * If the goal is simple (complexityScore < threshold), returns a single-step plan.
 */
export function decompose(goal: string): StepPlan {
  const score = complexityScore(goal);

  // Simple goal — no decomposition needed.
  if (score < COMPLEX_THRESHOLD) {
    return {
      originalGoal: goal,
      steps: [{ index: 1, goal, targetFiles: extractPaths(goal) }],
      source: "heuristic",
      decomposed: false,
    };
  }

  // Complex goal — try to split.
  const parts = splitGoal(goal);
  if (parts.length < 2) {
    // Couldn't split despite complexity indicators — pass through as single step.
    return {
      originalGoal: goal,
      steps: [{ index: 1, goal, targetFiles: extractPaths(goal) }],
      source: "heuristic",
      decomposed: false,
    };
  }

  const steps: Step[] = parts.slice(0, MAX_STEPS).map((part, i) => ({
    index: i + 1,
    goal: part,
    targetFiles: extractPaths(part),
    ...(i === parts.length - 1 ? { verificationHint: "run pnpm test to verify all changes" } : {}),
  }));

  return {
    originalGoal: goal,
    steps,
    source: "heuristic",
    decomposed: true,
  };
}

/**
 * Decompose a goal using a model call. The model receives the goal and
 * returns a structured JSON array of steps.
 *
 * This is the MODEL strategy — used when heuristics can't split the goal
 * but complexity is detected.
 */
export async function decomposeWithModel(
  goal: string,
  invokeModel: (prompt: string) => Promise<string>,
): Promise<StepPlan> {
  const prompt = [
    "Break this task into 2-5 atomic steps. Each step should be simple enough for a cheap AI model.",
    "Return ONLY a JSON array of objects with 'goal' and 'targetFiles' fields.",
    "Example: [{\"goal\": \"Add function X to src/foo.ts\", \"targetFiles\": [\"src/foo.ts\"]}]",
    "",
    `Task: ${goal}`,
  ].join("\n");

  try {
    const response = await invokeModel(prompt);
    // Extract JSON from the response (model might wrap it in markdown).
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // Model didn't return valid JSON — fall back to heuristic.
      return decompose(goal);
    }
    const parsed = JSON.parse(jsonMatch[0]) as Array<{ goal: string; targetFiles?: string[] }>;
    if (!Array.isArray(parsed) || parsed.length < 2) {
      return decompose(goal);
    }
    const steps: Step[] = parsed.slice(0, MAX_STEPS).map((p, i) => ({
      index: i + 1,
      goal: p.goal,
      ...(p.targetFiles !== undefined ? { targetFiles: p.targetFiles } : {}),
      ...(i === parsed.length - 1 ? { verificationHint: "run pnpm test to verify all changes" } : {}),
    }));
    return { originalGoal: goal, steps, source: "model", decomposed: true };
  } catch {
    // Model call failed — fall back to heuristic.
    return decompose(goal);
  }
}
