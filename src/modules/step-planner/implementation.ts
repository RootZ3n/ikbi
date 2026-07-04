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
import { COMPLEX_INDICATORS, COMPLEX_THRESHOLD, MAX_STEPS, MIN_MULTITASK_WORDS } from "./config.js";

/**
 * Score a goal for complexity. Returns how many COMPLEX_INDICATORS match.
 * Higher = more complex.
 */
export function complexityScore(goal: string): number {
  return COMPLEX_INDICATORS.filter((re) => re.test(goal)).length;
}

/**
 * Imperative action verbs that open a genuine independent task ("Add X", "update the README").
 * A split clause that does NOT start with one of these is most likely a continuation of a single
 * sentence ("...gracefully handles expired sessions"), not a separate task.
 *
 * The trailing `(?!\s*\()` excludes a verb used as a CODE IDENTIFIER — a function-call clause like
 * "generate(prompt, options) does POST ..." opens with the method name `generate`, which collides
 * with the imperative verb "generate". Requiring the verb NOT be immediately followed by `(` keeps
 * an API description ("...and generate(x) returns y") from being miscounted as a second independent
 * task and spuriously authorizing a decomposition. "generate a report" (verb + object) still counts.
 */
const ACTION_VERB = /^(?:add|create|implement|build|write|update|modify|change|fix|refactor|remove|delete|drop|rename|move|extract|introduce|replace|migrate|document|test|wire|expose|register|configure|install|generate|setup|set up|support|enable|disable)\b(?!\s*\()/i;

/** How many of the split clauses open with an imperative action verb (a genuine-task signal). */
function actionLedClauseCount(parts: readonly string[]): number {
  return parts.filter((p) => ACTION_VERB.test(p.trim())).length;
}

/**
 * Length-preserving mask of "code-literal" spans so their punctuation never registers as a task
 * separator. Everything strictly INSIDE `(...)`, `[...]`, `{...}`, or a `` `backtick` `` span is
 * replaced with a space; the delimiters themselves are kept. A TypeScript return type
 * `{ a: number; b: string }`, a union `('a' | 'b' | 'c')`, or an inline `foo; bar` therefore
 * contributes NO semicolons / commas / "and"s to the heuristics below. Unbalanced openers mask to
 * end-of-string. The result is the same UTF-16 length as the input, so callers can locate a real
 * delimiter in the masked string and slice the ORIGINAL at the same index (see `splitByMask`).
 *
 * This is the fix for goals that carry code in their prose (e.g. "export function f(): { a; b }"):
 * before it, a TS type's `;` looked like a multi-task separator and fragmented one goal into many.
 */
export function maskCodeSpans(goal: string): string {
  const chars = goal.split(""); // UTF-16 code units → indices align with RegExp match indices
  let depth = 0;
  let inTick = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (inTick) {
      if (ch === "`") inTick = false;
      else chars[i] = " ";
      continue;
    }
    if (ch === "`") {
      inTick = true;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth > 0) chars[i] = " ";
  }
  return chars.join("");
}

/**
 * Split `original` at every match of `sep` that falls OUTSIDE a code-literal span — the matches are
 * located in the equal-length `masked` string (where in-code delimiters have become spaces) and the
 * pieces are sliced from `original` so bracketed content survives verbatim. Mirrors `String.split`:
 * the delimiter is removed and the pieces are returned untrimmed.
 */
function splitByMask(original: string, masked: string, sep: RegExp): string[] {
  const re = new RegExp(sep.source, sep.flags.includes("g") ? sep.flags : `${sep.flags}g`);
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1; // guard against a zero-width match spinning forever
      continue;
    }
    parts.push(original.slice(last, m.index));
    last = m.index + m[0].length;
  }
  parts.push(original.slice(last));
  return parts;
}

/**
 * STRONG structural separators — unambiguous multi-task markers (numbered/ordered lists or explicit
 * sequencer words after a comma). When present, the split is a real decomposition regardless of
 * length. Two signals are DELIBERATELY excluded here:
 *   - the weaker "and …and" conjunction — the classic over-trigger this guard suppresses;
 *   - semicolons — code literals (a TS type `{ a: number; b: string }`) use them freely, so a
 *     semicolon alone must NOT authorize a split. A semicolon-separated goal can still decompose,
 *     but only when corroborated by ≥2 action-led clauses (see `looksMultiTask`).
 * Detection runs on the code-masked goal so punctuation inside `()[]{}`/backticks never counts.
 */
function hasStrongSeparator(goal: string): boolean {
  const masked = maskCodeSpans(goal);
  // Numbered/ordered list: "1. ... 2. ..." or "1) ... 2) ...".
  if ((masked.match(/\b\d+[.)]\s*.+/g) ?? []).length >= 2) return true;
  // Explicit sequencers introduced by a comma: "do X, also Y", "do X, then Y, plus Z".
  if (/,\s*(?:also|then|additionally|plus)\s+/i.test(masked)) return true;
  return false;
}

/**
 * SENTENCE BOUNDARY — a softer ordering signal than `hasStrongSeparator`: explicit sequencer
 * words (first / then / finally / next / lastly / afterwards) that mark genuinely SEPARATE,
 * ordered sub-tasks. (Numbered lists are a STRONG separator handled by `hasStrongSeparator`; this
 * catches the "first do X then do Y" shape that lacks punctuation.) Without any such boundary, a
 * long run of "and"s is most likely ONE verbose sentence.
 */
function hasSentenceBoundary(goal: string): boolean {
  return /\b(?:first|then|finally|next|lastly|afterwards)\b/i.test(maskCodeSpans(goal));
}

/**
 * OVER-TRIGGER GUARD (Issue 2). `splitGoal` will happily fragment a verbose SINGLE task whose
 * description merely contains "and" twice — and verbose single tasks are often LONG, so a pure
 * word-count gate does not save them. Only treat a split as a genuine decomposition when there is
 * real evidence of multiple INDEPENDENT tasks:
 *   1. a STRONG structural separator (numbered list / comma+sequencer), OR
 *   2. ≥2 clauses that each open with an imperative action verb (genuine independent tasks), OR
 *   3. a clear SENTENCE BOUNDARY (sequencer words) *and* the goal clears the word-count FLOOR.
 *
 * The word count is a FLOOR (a necessary minimum), never the sole gate: a goal with NO strong
 * separator and NO sequencer words requires ≥2 action-led clauses to split, no matter how long it
 * is. Semicolons alone are NOT a strong separator (code literals use them freely) — a
 * semicolon-delimited goal still needs ≥2 action-led clauses via case (2). This, plus the code-span
 * masking in `maskCodeSpans`, is what keeps a single-imperative goal that carries TypeScript
 * signatures ("export function f(): { a; b }") from fragmenting into spurious steps.
 */
function looksMultiTask(goal: string, parts: readonly string[]): boolean {
  if (hasStrongSeparator(goal)) return true;
  if (actionLedClauseCount(parts) >= 2) return true;
  // Only weak conjunction evidence ("and …and") remains. Splitting on it is allowed ONLY when the
  // goal has a clear sentence boundary AND is long enough — never on length alone, and never when
  // there is no sentence boundary (those need ≥2 action-led clauses, already handled above).
  if (!hasSentenceBoundary(goal)) return false;
  const wordCount = goal.trim().split(/\s+/).filter(Boolean).length;
  return wordCount >= MIN_MULTITASK_WORDS;
}

/** A raw split of the goal + whether it came from an explicit NUMBERED list (which must not be
 *  regrouped — the user's own numbering is authoritative). Conjunction/semicolon splits are
 *  regrouped by `groupByActionLead` so each step is a complete task, not a mid-task fragment. */
interface GoalSplit {
  readonly parts: string[];
  readonly numbered: boolean;
}

/**
 * Split a goal on conjunctions and punctuation into sub-goals.
 * Tries multiple delimiters in order of specificity.
 */
function splitGoal(goal: string): GoalSplit {
  // All delimiter splits below are located in the code-masked view, so a separator that lives
  // inside a `()[]{}`/backtick code span (a TS type's `;`, a union's `|`, a signature's `,`) is
  // never treated as a task boundary. Pieces are still sliced from the ORIGINAL goal.
  const masked = maskCodeSpans(goal);

  // Try numbered list: "1. do X\n2. do Y" or "1) do X\n2) do Y". Markers are matched on the masked
  // view (so "0..1" inside a code span cannot masquerade as a list) but extracted from the original.
  const numbered = masked.match(/\b\d+[.)]\s*.+/g);
  if (numbered && numbered.length >= 2) {
    return {
      parts: goal
        .match(/\b\d+[.)]\s*.+/g)!
        .map((s) => s.replace(/^\d+[.)]\s*/, "").trim())
        .filter(Boolean),
      numbered: true,
    };
  }

  // Try "and" splitting: "do X and do Y and do Z"
  // Only split on "and" that separates independent clauses (not "read and write")
  const andParts = splitByMask(goal, masked, /\s+and\s+(?=[a-z])/i);
  if (andParts.length >= 2 && andParts.every((p) => p.length > 10)) {
    return { parts: andParts.map((s) => s.trim()).filter(Boolean), numbered: false };
  }

  // Try comma+conjunction: "do X, also Y, plus Z"
  const commaParts = splitByMask(goal, masked, /,\s*(?:also|then|additionally|plus|and)\s+/i);
  if (commaParts.length >= 2 && commaParts.every((p) => p.length > 10)) {
    return { parts: commaParts.map((s) => s.trim()).filter(Boolean), numbered: false };
  }

  // Try semicolons: "do X; do Y; do Z" (only semicolons OUTSIDE code spans reach here).
  const semiParts = splitByMask(goal, masked, /\s*;\s*/);
  if (semiParts.length >= 2 && semiParts.every((p) => p.length > 10)) {
    return { parts: semiParts.map((s) => s.trim()).filter(Boolean), numbered: false };
  }

  return { parts: [goal], numbered: false };
}

/**
 * Regroup conjunction-split clauses so each group BEGINS at an imperative action verb. A clause that
 * does NOT open with an action verb is a CONTINUATION of the preceding task ("...and exports greet()",
 * "...and capitalized name") and is merged back into it. Without this, a single multi-file task whose
 * prose contains intra-task "and"s ("imports X and exports Y") fragments into incoherent sub-steps —
 * the exact failure that decomposed one greeter/names goal into 5 pieces (2 of them fragments), built
 * green per-step, then got discarded by the whole-build critic. `looksMultiTask` already gated on
 * ≥2 action-led clauses, so grouping here recovers exactly those genuine tasks, each with its full
 * description. Callers fall back to the raw parts if grouping would collapse below 2 groups.
 */
function groupByActionLead(parts: readonly string[]): string[] {
  const groups: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    if (groups.length === 0 || ACTION_VERB.test(trimmed)) groups.push(trimmed);
    else groups[groups.length - 1] = `${groups[groups.length - 1]} and ${trimmed}`;
  }
  return groups;
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
  const { parts, numbered } = splitGoal(goal);
  // OVER-TRIGGER GUARD (Issue 2): a split into < 2 parts, OR a split that lacks genuine
  // multi-task evidence (a short goal whose only signal is "and" twice), is NOT a real
  // decomposition — pass through as a single step rather than spawning spurious sub-steps.
  if (parts.length < 2 || !looksMultiTask(goal, parts)) {
    // Couldn't split despite complexity indicators — pass through as single step.
    return {
      originalGoal: goal,
      steps: [{ index: 1, goal, targetFiles: extractPaths(goal) }],
      source: "heuristic",
      decomposed: false,
    };
  }

  // A NUMBERED list is explicit user structure — keep each item as its own step. A conjunction/
  // semicolon split is REGROUPED so each step begins at an action verb (mid-task continuations like
  // "...and exports greet()" merge into their parent task) — this keeps a multi-file goal from
  // fragmenting into incoherent sub-steps.
  const grouped = numbered ? parts : groupByActionLead(parts);

  // Grouping is the FINAL arbiter of the step count. If it collapses below 2 groups, the goal is ONE
  // cohesive action-led task whose prose merely contains an incidental sequencer or "and" (e.g. "Add
  // session.ts that ... calls X; then Y, and returns Z") — NOT a second task. Build it in a single
  // pass (the builder handles multi-part / multi-file goals coherently — proven on cohesive 4-file
  // goals) instead of fragmenting on misaligned "and" boundaries, which produced stuck sub-steps.
  if (grouped.length < 2) {
    return {
      originalGoal: goal,
      steps: [{ index: 1, goal, targetFiles: extractPaths(goal) }],
      source: "heuristic",
      decomposed: false,
    };
  }

  const steps: Step[] = grouped.slice(0, MAX_STEPS).map((part, i, arr) => ({
    index: i + 1,
    goal: part,
    targetFiles: extractPaths(part),
    // L4: verificationHint is RESERVED metadata — no caller consumes it yet (see Step.verificationHint).
    ...(i === arr.length - 1 ? { verificationHint: "run pnpm test to verify all changes" } : {}),
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
 * This is the MODEL strategy — an alternative to the heuristic `decompose`.
 *
 * DORMANT: NOT wired in production. The `ikbi build` CLI (worker-model/cli.ts) always uses the
 * zero-cost heuristic `decompose`; nothing in the production path calls `decomposeWithModel`. It
 * is retained — and fully unit-tested — as a ready strategy a future opt-in (e.g. an env flag that
 * threads a model invoker) can switch to when the heuristic is too coarse for a given goal. It is
 * deliberately NOT removed: wiring it later is a one-line call-site change, not a re-implementation.
 * Until then it is intentionally unused, not abandoned. See step-planner.test.ts ("DORMANT").
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
