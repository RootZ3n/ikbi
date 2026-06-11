/**
 * ikbi goal-refinement — the Socratic interview process.
 *
 * When a goal is ambiguous, vague, or underspecified, this module runs a structured
 * interview that helps the user (and the model) get on the same page BEFORE the build
 * starts. It's not a gate — it's a guide.
 *
 * THREE LAYERS:
 *   1. Pre-build deliberation (cognition layer) — detects ambiguity
 *   2. Scout-level ambiguity detection — assesses if goal maps to specific code
 *   3. Builder-level clarification — one clarifying question before starting
 *
 * The Socratic interview is the HUMAN-FACING layer: it takes the cognition layer's
 * `missingInfo` and `risks` and turns them into a structured Q&A that the user can
 * answer or skip.
 */

import type { CognitionDecision } from "../modules/cognition-layer/contract.js";

// ── Ambiguity signals ──────────────────────────────────────────────────────────

/** Signals that a goal is ambiguous. Each carries a weight (0-1). */
export interface AmbiguitySignal {
  readonly kind: "vague_verb" | "no_target" | "broad_scope" | "missing_context" | "pronoun_without_antecedent" | "multiple_interpretations";
  readonly weight: number;
  readonly detail: string;
}

/** The result of ambiguity analysis on a goal. */
export interface AmbiguityAnalysis {
  readonly score: number; // 0 = crystal clear, 1 = completely ambiguous
  readonly signals: readonly AmbiguitySignal[];
  readonly needsInterview: boolean; // score > threshold
}

const VAGUE_VERBS = new Set([
  "fix", "improve", "update", "clean", "refactor", "optimize", "enhance",
  "make better", "handle", "deal with", "address", "look at", "check",
  "review", "audit", "do", "work on",
]);

const BROAD_SCOPE_PATTERNS = [
  /\b(everything|all|entire|whole|complete)\b/i,
  /\b(better|faster|cleaner|nicer)\b/i,
  /\b(somehow|some way|anyway)\b/i,
  /\b(stuff|things|issues|problems|bugs)\b/i,
];

const PRONOUN_PATTERN = /\b(it|this|that|these|those|they|them)\b/i;

/**
 * Analyze a goal for ambiguity signals. PURE — no model calls.
 * Returns a score (0-1) and the list of signals detected.
 */
export function analyzeGoalAmbiguity(goal: string): AmbiguityAnalysis {
  const signals: AmbiguitySignal[] = [];
  const words = goal.toLowerCase().split(/\s+/);
  const firstVerb = words[0];

  // Check specificity FIRST (vague verb weight depends on it)
  const hasPath = /[\/\\.]|\b(src|lib|test|dist|package|tsconfig|readme)\b/i.test(goal);
  const hasSpecific = goal.length > 20 && (hasPath || /["'`].+["'`]/.test(goal));

  // Check for vague verbs — BUT reduce weight if the goal also has specific targets
  if (firstVerb !== undefined && VAGUE_VERBS.has(firstVerb)) {
    const verbWeight = hasSpecific ? 0.05 : 0.3;
    signals.push({ kind: "vague_verb", weight: verbWeight, detail: `"${firstVerb}" is a vague verb — what specifically should happen?` });
  }

  // Check for no target (very short goal, no file/path/project reference)
  if (!hasSpecific && goal.split(/\s+/).length <= 5) {
    signals.push({ kind: "no_target", weight: 0.4, detail: "No specific file, path, or component mentioned" });
  }

  // Check for broad scope patterns
  for (const pat of BROAD_SCOPE_PATTERNS) {
    if (pat.test(goal)) {
      signals.push({ kind: "broad_scope", weight: 0.2, detail: `Broad scope indicator: "${goal.match(pat)?.[0]}"` });
      break; // one is enough
    }
  }

  // Check for pronouns without clear antecedent
  const pronounMatch = goal.match(PRONOUN_PATTERN);
  if (pronounMatch !== null && goal.split(/\s+/).length <= 8) {
    signals.push({ kind: "pronoun_without_antecedent", weight: 0.3, detail: `"${pronounMatch[0]}" — what does this refer to?` });
  }

  // Check for missing context (no "because", "when", "after", etc.)
  const hasContext = /\b(because|when|after|before|during|if|while|since)\b/i.test(goal);
  if (!hasContext && goal.split(/\s+/).length <= 10) {
    signals.push({ kind: "missing_context", weight: 0.15, detail: "No context for why this change is needed" });
  }

  // Calculate weighted score (capped at 1)
  const raw = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.min(1, raw);
  const needsInterview = score > 0.35;

  return { score, signals, needsInterview };
}

// ── Socratic Interview ─────────────────────────────────────────────────────────

/** A single interview question. */
export interface InterviewQuestion {
  readonly id: string;
  readonly question: string;
  readonly why: string; // why we're asking
  readonly kind: "clarify_target" | "clarify_action" | "clarify_scope" | "clarify_context" | "confirm_understanding";
}

/** The full interview plan. */
export interface InterviewPlan {
  readonly questions: readonly InterviewQuestion[];
  readonly summary: string; // what we think the goal means
  readonly refinedGoal: string; // best-effort refined goal
}

/**
 * Build an interview plan from ambiguity signals + cognition decision.
 * The questions are ordered by importance (most ambiguous first).
 */
export function buildInterviewPlan(
  goal: string,
  analysis: AmbiguityAnalysis,
  cognition?: CognitionDecision,
): InterviewPlan {
  const questions: InterviewQuestion[] = [];

  // From ambiguity signals (only significant ones — weight > 0.1)
  for (const signal of analysis.signals) {
    if (signal.weight < 0.1) continue; // skip low-weight signals
    switch (signal.kind) {
      case "vague_verb":
        questions.push({
          id: "clarify_action",
          question: `What specifically do you mean by "${goal.split(/\s+/)[0]}"? Should I fix a bug, add a feature, refactor code, or something else?`,
          why: signal.detail,
          kind: "clarify_action",
        });
        break;
      case "no_target":
        questions.push({
          id: "clarify_target",
          question: "Which file, module, or component should I focus on? A specific path would help.",
          why: signal.detail,
          kind: "clarify_target",
        });
        break;
      case "broad_scope":
        questions.push({
          id: "clarify_scope",
          question: "This sounds broad. Can you narrow it down to a specific area or set of files?",
          why: signal.detail,
          kind: "clarify_scope",
        });
        break;
      case "pronoun_without_antecedent":
        questions.push({
          id: "clarify_target",
          question: `When you say "${goal.match(PRONOUN_PATTERN)?.[0]}", what specifically are you referring to?`,
          why: signal.detail,
          kind: "clarify_target",
        });
        break;
      case "missing_context":
        questions.push({
          id: "clarify_context",
          question: "What's the context — is something broken, or are you adding something new?",
          why: signal.detail,
          kind: "clarify_context",
        });
        break;
    }
  }

  // From cognition layer's missingInfo
  if (cognition?.missingInfo !== undefined) {
    for (const info of cognition.missingInfo) {
      // Avoid duplicate question kinds
      if (!questions.some((q) => q.why === info)) {
        questions.push({
          id: `cognition_${questions.length}`,
          question: info,
          why: "Cognition layer identified this as missing",
          kind: "clarify_context",
        });
      }
    }
  }

  // From cognition layer's risks
  if (cognition?.risks !== undefined && cognition.risks.length > 0) {
    questions.push({
      id: "confirm_risks",
      question: `The deliberation layer flagged these risks: ${cognition.risks.join("; ")}. Are you aware of these?`,
      why: "Risk awareness before proceeding",
      kind: "confirm_understanding",
    });
  }

  // Build a summary of what we think the goal means
  const refinedGoal = goal; // will be refined by the model in Layer 2/3
  const summary = cognition?.rationale !== undefined && cognition.rationale.length > 0
    ? `Cognition interprets this as: ${cognition.rationale}`
    : `Goal: "${goal}" — ${analysis.signals.length} ambiguity signal(s) detected`;

  return { questions, summary, refinedGoal };
}

// ── Interview formatting ────────────────────────────────────────────────────────

/** Format an interview plan for terminal display. */
export function formatInterview(plan: InterviewPlan): string {
  const lines: string[] = [
    "",
    "╭─ Goal Refinement ─────────────────────────────────────────────╮",
    `│ ${plan.summary}`,
    "╰───────────────────────────────────────────────────────────────╯",
    "",
  ];

  if (plan.questions.length === 0) {
    lines.push("  Goal looks clear enough — proceeding with build.");
  } else {
    lines.push("  I need a bit more clarity before building:");
    lines.push("");
    for (let i = 0; i < plan.questions.length; i++) {
      const q = plan.questions[i]!;
      lines.push(`  ${i + 1}. ${q.question}`);
      lines.push(`     (${q.why})`);
      lines.push("");
    }
    lines.push("  Answer these, or press Enter to skip and I'll do my best with what I have.");
  }

  return lines.join("\n");
}

// ── Integration with the build path ─────────────────────────────────────────────

/**
 * The full pre-build refinement check. Returns:
 * - `proceed: true` → goal is clear enough, build with (possibly refined) goal
 * - `proceed: false` → goal needs clarification, print the interview
 *
 * This is the function the build CLI calls before creating the task.
 */
export function preBuildRefinement(
  goal: string,
  cognition?: CognitionDecision,
): { proceed: boolean; refinedGoal: string; interview: InterviewPlan | undefined } {
  const analysis = analyzeGoalAmbiguity(goal);

  // If the cognition layer already said "ask" or "reject", that takes priority
  if (cognition?.decision === "reject") {
    return {
      proceed: false,
      refinedGoal: goal,
      interview: {
        questions: [{ id: "rejected", question: cognition.rationale || "Goal was rejected by deliberation", why: "Cognition rejection", kind: "clarify_context" }],
        summary: `Rejected: ${cognition.rationale}`,
        refinedGoal: goal,
      },
    };
  }

  // Cognition said "warn" — proceed but surface risks (don't trigger interview for warnings)
  if (cognition?.decision === "warn") {
    return {
      proceed: true,
      refinedGoal: goal,
      interview: cognition.risks !== undefined && cognition.risks.length > 0
        ? { questions: [], summary: `Warning: ${cognition.risks.join("; ")}`, refinedGoal: goal }
        : undefined,
    };
  }

  // If cognition said "ask", use its missing info
  if (cognition?.decision === "ask" || analysis.needsInterview) {
    const plan = buildInterviewPlan(goal, analysis, cognition);
    return { proceed: false, refinedGoal: goal, interview: plan };
  }

  // Goal is clear enough
  return { proceed: true, refinedGoal: goal, interview: undefined };
}
