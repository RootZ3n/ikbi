/**
 * ikbi worker-model — CANONICAL SEMANTIC VERDICT (Phase 4).
 *
 * One truthful semantic-evaluation contract for every strategy whose candidate can reach canonical
 * promotion. A candidate may be rejected semantically ONLY when there is at least one concrete,
 * blocking, candidate-bound defect. Everything else the critic might emit — a bare `FAIL`, unparsable
 * or contradictory output, generic hand-waving, a provider/parser infrastructure failure — is NOT a
 * defect and must never masquerade as one. This module is the parser + the verdict type; the critic
 * produces a verdict, and the orchestrator/authority consume it (promotion + duel policy).
 *
 * The kinds are DISTINCT decision inputs — see `promotionEligibility` / duel policy in the orchestrator:
 *   - pass                    → semantically eligible
 *   - fail                    → concrete blocking defect(s); reject; a peer/fixer may do better
 *   - incomplete              → valid but a concrete goal requirement is unmet; reject
 *   - indeterminate           → the output cannot support pass/fail; NO autonomous promotion, NOT a defect
 *   - infrastructure-failure  → provider/timeout/context/parser failure; NOT candidate evidence
 *   - not-evaluated           → semantic evaluation was explicitly skipped by policy
 */

/** The canonical set of semantic outcomes. Only `pass` is autonomously promotable by default. */
export type SemanticVerdictKind = "pass" | "fail" | "incomplete" | "indeterminate" | "infrastructure-failure" | "not-evaluated";

/** A concrete, blocking, candidate-bound defect. A `fail` verdict MUST carry at least one. */
export interface BlockingDefect {
  /** Stable/generated identifier for the defect. */
  readonly id: string;
  /** Concise, specific claim (never a generic "implementation is wrong"). */
  readonly claim: string;
  /** Candidate-bound supporting evidence. */
  readonly evidence: string;
  /** The goal requirement this defect shows is unmet. */
  readonly requirement: string;
  readonly severity: "blocking";
  /** Model confidence in [0,1]. */
  readonly confidence: number;
  /** Where in the candidate the defect lives, when known. */
  readonly location?: { readonly file?: string; readonly symbol?: string; readonly line?: number };
  /** Whether a fixer can plausibly repair it (default true). */
  readonly repairable?: boolean;
}

/** A non-blocking observation. Never affects promotion. */
export interface SemanticAdvisory {
  readonly claim: string;
  readonly evidence?: string;
}

/** The one structured semantic verdict every strategy produces + persists. */
export interface SemanticVerdict {
  readonly kind: SemanticVerdictKind;
  readonly summary: string;
  readonly blockingDefects: readonly BlockingDefect[];
  readonly incompleteRequirements: readonly string[];
  readonly advisories: readonly SemanticAdvisory[];
  /** How the parser resolved the model output. */
  readonly parseStatus: "structured" | "repaired" | "unparsable";
  /** Candidate binding — stamped from context so a verdict cannot be reused for another candidate/tree. */
  readonly candidateId?: string;
  readonly verifiedTree?: string;
  /** The model that produced the verdict (truthful receipts). */
  readonly evaluatorModel?: string;
  /** Bounded critic retries spent (parser repair / reformat). */
  readonly retryCount?: number;
}

/** Context the orchestrator threads so the verdict binds to THIS candidate + evidence. */
export interface SemanticParseContext {
  readonly candidateId?: string;
  readonly verifiedTree?: string;
  readonly evaluatorModel?: string;
  readonly retryCount?: number;
  /** The candidate goal (used to fill a defect's `requirement` when the model omitted it). */
  readonly goal?: string;
  readonly parseStatus?: "structured" | "repaired";
}

/** Generic non-defects: a claim this vague cannot be a concrete blocking defect (→ indeterminate). */
const GENERIC_CLAIM = /^(the )?(implementation|code|change|it|this)\b.{0,40}\b(is|looks|seems|feels)\b.{0,40}\b(wrong|bad|off|incorrect|poor|weak|broken|not good|not great|suboptimal)\.?$/i;
/** A verdict token that is really just "FAIL" with nothing else — a bare rejection, not a defect. */
const BARE_TOKEN = /^(pass|fail|indeterminate|incomplete)$/i;
/** Matches parseStructuredVerdict's rubric threshold, so the two parsers agree on a below-goal PASS. */
const GOAL_CORRECTNESS_THRESHOLD = 3;

function readGoalScore(scores: unknown): number | undefined {
  if (typeof scores !== "object" || scores === null) return undefined;
  const v = (scores as Record<string, unknown>).goal_correctness;
  return typeof v === "number" ? v : undefined;
}

function extractJsonObject(content: string): Record<string, unknown> | undefined {
  const m = content.match(/\{[\s\S]*\}/);
  if (m === null) return undefined;
  try {
    const o = JSON.parse(m[0]) as unknown;
    return typeof o === "object" && o !== null ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isConcreteClaim(s: string): boolean {
  const t = s.trim();
  if (t.length < 8) return false; // too short to be a concrete defect
  if (BARE_TOKEN.test(t)) return false;
  if (GENERIC_CLAIM.test(t)) return false;
  return true;
}

/**
 * Flatten a defect's `evidence` to a string. Accepts the legacy scalar string AND the Phase 9 rich
 * `evidence: [{kind, reference, detail}]` array (each entry joined "kind: reference — detail"). Falls
 * back to the claim when the model supplied no usable evidence.
 */
function flattenEvidence(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (Array.isArray(value)) {
    const parts = value
      .map((e): string => {
        if (typeof e === "string") return e.trim();
        if (typeof e === "object" && e !== null) {
          const o = e as Record<string, unknown>;
          const kind = typeof o.kind === "string" ? o.kind.trim() : "";
          const ref = typeof o.reference === "string" ? o.reference.trim() : "";
          const detail = typeof o.detail === "string" ? o.detail.trim() : "";
          const head = [kind, ref].filter((s) => s.length > 0).join(": ");
          return [head, detail].filter((s) => s.length > 0).join(" — ");
        }
        return "";
      })
      .filter((s) => s.length > 0);
    if (parts.length > 0) return parts.join("; ");
  }
  return fallback;
}

/**
 * Concrete missing requirements. Accepts the legacy `string[]` (`incompleteRequirements`/`missing`) AND
 * the Phase 9 rich `missingRequirements: [{requirement, evidence}]`. Only concrete requirements survive.
 */
function readMissingRequirements(obj: Record<string, unknown>): string[] {
  const src = Array.isArray(obj.missingRequirements)
    ? obj.missingRequirements
    : Array.isArray(obj.incompleteRequirements)
      ? obj.incompleteRequirements
      : Array.isArray(obj.missing)
        ? obj.missing
        : [];
  const out: string[] = [];
  for (const item of src) {
    if (typeof item === "string") {
      if (isConcreteClaim(item)) out.push(item.trim());
    } else if (typeof item === "object" && item !== null) {
      const req = (item as Record<string, unknown>).requirement;
      if (typeof req === "string" && isConcreteClaim(req)) out.push(req.trim());
    }
  }
  return out;
}

/** Concrete defects from the RICH `blockingDefects` schema only. */
function richDefects(obj: Record<string, unknown>, goal: string): BlockingDefect[] {
  const out: BlockingDefect[] = [];
  const rich = Array.isArray(obj.blockingDefects) ? obj.blockingDefects : [];
  for (const [i, raw] of rich.entries()) {
    if (typeof raw !== "object" || raw === null) continue;
    const d = raw as Record<string, unknown>;
    const claim = typeof d.claim === "string" ? d.claim.trim() : "";
    if (!isConcreteClaim(claim)) continue; // a defect without a concrete claim is not a defect
    const evidence = flattenEvidence(d.evidence, claim);
    const requirement = typeof d.requirement === "string" && d.requirement.trim().length > 0 ? d.requirement.trim() : goal;
    const loc = typeof d.location === "object" && d.location !== null ? (d.location as Record<string, unknown>) : undefined;
    out.push({
      id: `d${i + 1}`,
      claim,
      evidence,
      requirement,
      severity: "blocking",
      confidence: typeof d.confidence === "number" ? Math.max(0, Math.min(1, d.confidence)) : 0.7,
      ...(loc !== undefined
        ? { location: { ...(typeof loc.file === "string" ? { file: loc.file } : {}), ...(typeof loc.symbol === "string" ? { symbol: loc.symbol } : {}), ...(typeof loc.line === "number" ? { line: loc.line } : {}) } }
        : {}),
      ...(typeof d.repairable === "boolean" ? { repairable: d.repairable } : {}),
    });
  }
  return out;
}

/** Concrete defects from the LEGACY `issues: string[]` schema. Only meaningful on a FAIL verdict. */
function legacyDefects(obj: Record<string, unknown>, goal: string): BlockingDefect[] {
  const issues = Array.isArray(obj.issues) ? obj.issues.filter((x): x is string => typeof x === "string") : [];
  const out: BlockingDefect[] = [];
  for (const [i, issue] of issues.entries()) {
    if (!isConcreteClaim(issue)) continue;
    out.push({ id: `d${i + 1}`, claim: issue.trim(), evidence: issue.trim(), requirement: goal, severity: "blocking", confidence: 0.6 });
  }
  return out;
}

/** On a PASS, any `issues` become non-blocking ADVISORIES (never a blocking defect). */
function issuesAsAdvisories(obj: Record<string, unknown>): SemanticAdvisory[] {
  const issues = Array.isArray(obj.issues) ? obj.issues.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  return issues.map((s) => ({ claim: s.trim() }));
}

function normalizeVerdictToken(raw: unknown): "pass" | "fail" | "incomplete" | "indeterminate" | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase();
  if (t === "pass") return "pass";
  if (t === "fail") return "fail";
  if (t === "incomplete") return "incomplete";
  if (t === "indeterminate") return "indeterminate";
  return undefined;
}

function stamp(v: Omit<SemanticVerdict, "candidateId" | "verifiedTree" | "evaluatorModel" | "retryCount">, ctx: SemanticParseContext | undefined): SemanticVerdict {
  return {
    ...v,
    ...(ctx?.candidateId !== undefined ? { candidateId: ctx.candidateId } : {}),
    ...(ctx?.verifiedTree !== undefined ? { verifiedTree: ctx.verifiedTree } : {}),
    ...(ctx?.evaluatorModel !== undefined ? { evaluatorModel: ctx.evaluatorModel } : {}),
    ...(ctx?.retryCount !== undefined ? { retryCount: ctx.retryCount } : {}),
  };
}

const indeterminate = (summary: string, ctx: SemanticParseContext | undefined, parseStatus: "structured" | "repaired" | "unparsable" = "structured"): SemanticVerdict =>
  stamp({ kind: "indeterminate", summary, blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus }, ctx);

/**
 * Parse a critic model response into the canonical `SemanticVerdict`. STRICT:
 *   - `fail` requires ≥1 concrete blocking defect (else → indeterminate — a bare/empty FAIL).
 *   - `incomplete` requires ≥1 concrete missing requirement (else → indeterminate).
 *   - `pass` must carry NO blocking defects (contradiction → indeterminate).
 *   - unparsable / plain-text `FAIL` / generic-only claims → indeterminate.
 * Never fabricates a defect. Never turns indeterminate into fail.
 */
export function parseSemanticVerdict(content: string, ctx?: SemanticParseContext): SemanticVerdict {
  const trimmed = (content ?? "").trim();
  if (trimmed.length === 0) return indeterminate("empty critic response", ctx, "unparsable");

  const obj = extractJsonObject(trimmed);
  if (obj === undefined) return indeterminate("critic output was not parseable structured JSON", ctx, "unparsable");

  // CANDIDATE/TREE BINDING (Phase 9): if the model ECHOED a binding that disagrees with the one under
  // evaluation, the verdict describes a DIFFERENT candidate/tree — it cannot bind here → indeterminate
  // (never a defect, never recovery-eligible). A missing echo is fine (the context binding is stamped).
  const echoedCandidate = typeof obj.candidateId === "string" ? obj.candidateId.trim() : undefined;
  const echoedTree = typeof obj.verifiedTree === "string" ? obj.verifiedTree.trim() : undefined;
  if (ctx?.candidateId !== undefined && echoedCandidate !== undefined && echoedCandidate.length > 0 && echoedCandidate !== ctx.candidateId)
    return indeterminate("cross-candidate: critic output is bound to a different candidateId than the candidate under evaluation", ctx, "unparsable");
  if (ctx?.verifiedTree !== undefined && echoedTree !== undefined && echoedTree.length > 0 && echoedTree !== ctx.verifiedTree)
    return indeterminate("stale-tree: critic output is bound to a different verifiedTree than the candidate under evaluation", ctx, "unparsable");

  const advisories: SemanticAdvisory[] = (Array.isArray(obj.advisories) ? obj.advisories : [])
    .map((a): SemanticAdvisory | undefined => (typeof a === "object" && a !== null && typeof (a as Record<string, unknown>).claim === "string" ? { claim: ((a as Record<string, unknown>).claim as string).trim(), ...(typeof (a as Record<string, unknown>).evidence === "string" ? { evidence: (a as Record<string, unknown>).evidence as string } : {}) } : undefined))
    .filter((a): a is SemanticAdvisory => a !== undefined && a.claim.length > 0);
  const summary = typeof obj.summary === "string" && obj.summary.trim().length > 0 ? obj.summary.trim() : typeof obj.feedback === "string" ? obj.feedback.trim() : "";
  const parseStatus = ctx?.parseStatus ?? "structured";

  // Accept both the legacy PASS/FAIL and the canonical pass/fail/incomplete/indeterminate tokens.
  const verdict = normalizeVerdictToken(obj.verdict);
  if (verdict === undefined) return indeterminate("critic verdict was missing or not one of pass/fail/incomplete/indeterminate", ctx, "unparsable");

  const goal = ctx?.goal ?? "the stated goal";
  const rich = richDefects(obj, goal);
  const incompleteRequirements = readMissingRequirements(obj);

  if (verdict === "pass") {
    // A pass that also lists RICH blocking defects is CONTRADICTORY — cannot safely resolve intent.
    // (Legacy `issues` on a PASS are advisories, not defects.)
    if (rich.length > 0) return indeterminate("contradictory critic output: verdict=pass but blocking defects were listed", ctx);
    // RUBRIC: a PASS whose goal_correctness score is below the passing threshold contradicts itself —
    // the change does not adequately satisfy the goal. That is a concrete, goal-relevant INCOMPLETE
    // (consistent with parseStructuredVerdict's PASS→FAIL rubric override), not a fabricated defect.
    const goalScore = readGoalScore(obj.scores);
    if (goalScore !== undefined && goalScore < GOAL_CORRECTNESS_THRESHOLD) {
      return stamp({ kind: "incomplete", summary: summary || "goal not adequately met", blockingDefects: [], incompleteRequirements: [`goal_correctness=${goalScore} is below the passing threshold (${GOAL_CORRECTNESS_THRESHOLD}) — the change does not adequately satisfy the goal`], advisories: [...advisories, ...issuesAsAdvisories(obj)], parseStatus }, ctx);
    }
    return stamp({ kind: "pass", summary: summary || "no concrete blocking defect", blockingDefects: [], incompleteRequirements: [], advisories: [...advisories, ...issuesAsAdvisories(obj)], parseStatus }, ctx);
  }
  if (verdict === "incomplete") {
    if (incompleteRequirements.length === 0) return indeterminate("verdict=incomplete but no concrete missing requirement was named", ctx);
    return stamp({ kind: "incomplete", summary: summary || "requested goal not fully met", blockingDefects: rich, incompleteRequirements, advisories, parseStatus }, ctx);
  }
  if (verdict === "indeterminate") {
    return indeterminate(summary || "critic reported indeterminate", ctx);
  }
  // verdict === "fail": require ≥1 concrete blocking defect (rich schema, else legacy `issues`).
  const blockingDefects = rich.length > 0 ? rich : legacyDefects(obj, goal);
  if (blockingDefects.length === 0) {
    // A FAIL with no concrete defect is a bare rejection — NOT authentic defect evidence.
    return indeterminate(summary || "verdict=fail but no concrete blocking defect was provided", ctx);
  }
  return stamp({ kind: "fail", summary: summary || "concrete blocking defect(s) found", blockingDefects, incompleteRequirements, advisories, parseStatus }, ctx);
}

/** A verdict that is genuinely a critic INFRASTRUCTURE failure (provider/parser/timeout/context). */
export function infrastructureFailureVerdict(summary: string, ctx?: SemanticParseContext): SemanticVerdict {
  return stamp({ kind: "infrastructure-failure", summary, blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "unparsable" }, ctx);
}

/** A verdict for a candidate whose semantic evaluation was explicitly skipped by policy. */
export function notEvaluatedVerdict(reason: string): SemanticVerdict {
  return { kind: "not-evaluated", summary: reason, blockingDefects: [], incompleteRequirements: [], advisories: [], parseStatus: "structured" };
}

/** True when the verdict authentically describes THIS candidate/tree (no cross-candidate/stale reuse). */
export function verdictBindsCandidate(v: SemanticVerdict, candidateId: string | undefined, verifiedTree: string | undefined): boolean {
  if (v.candidateId !== undefined && candidateId !== undefined && v.candidateId !== candidateId) return false;
  if (v.verifiedTree !== undefined && verifiedTree !== undefined && v.verifiedTree !== verifiedTree) return false;
  return true;
}

/**
 * Promotion eligibility from a semantic verdict (Phase 4 default policy). Only `pass` is autonomously
 * promotable; `not-evaluated` promotes only when policy explicitly marks semantic evaluation optional
 * for the task. Everything else withholds autonomous promotion (fail-closed under uncertainty).
 */
export function semanticPromotionEligible(kind: SemanticVerdictKind, semanticEvaluationOptional: boolean): boolean {
  if (kind === "pass") return true;
  if (kind === "not-evaluated") return semanticEvaluationOptional;
  return false;
}

/**
 * Whether a non-promoting semantic verdict makes the candidate DUEL-ELIGIBLE (Phase 2). A concrete
 * quality rejection (fail/incomplete) is — a different vendor lane might do better. An indeterminate or
 * infrastructure/not-evaluated verdict is NOT: a peer vendor cannot fix an unparsable critic or a
 * provider outage, and running one would waste the peer's cost and blur the two attempts.
 */
export function semanticDuelEligible(kind: SemanticVerdictKind): boolean {
  return kind === "fail" || kind === "incomplete";
}
