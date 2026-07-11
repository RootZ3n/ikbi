/**
 * ikbi worker-model — EXPERT RENTAL (the cheap-tier coordinator's "rent per sub-task" gate).
 *
 * The cheap tier is not a lone builder with an escalation ladder, and not a tournament that races
 * candidates and discards losers. It is a MIXTURE OF EXPERTS: a pool of cheap models (two vendors ×
 * two tiers) treated as ONE virtual builder. For each sub-task the coordinator RENTS the cheapest
 * expert that can plausibly do THAT task — mechanical work goes to the worker roster (flash /
 * mimo-v2.5); work that needs real reasoning is rented up to the mid roster (mimo-v2.5-pro /
 * deepseek-v4-pro) FROM THE START, not after a failure. There is no "escalation event" — the right
 * expert is picked up front by difficulty.
 *
 * This module is the routing decision only: given a sub-task's goal + the pool's tier rosters, it
 * asks model-router's `resolveModel` (the cheapest-sufficient gate) for the builder expert. The
 * difficulty estimate here is a zero-cost heuristic; the cognition-layer can supersede it later as
 * the coordinator's deliberation without changing this seam.
 */

import { resolveModel, rosterFromIds, type ModelTier } from "../model-router/index.js";

/** Regexes that mark a sub-task as needing a stronger (mid-roster) expert from the start. */
const HARDER_SIGNALS: readonly RegExp[] = Object.freeze([
  /\balgorithm/i,
  /\bconcurren/i,
  /\brace condition/i,
  /\bdeadlock/i,
  /\brefactor/i,
  /\boptimi[sz]e/i,
  /\bdebug\b/i,
  /\bfix\b[^.]*\b(bug|failure|error|regression|crash)/i,
  /\bprotocol\b/i,
  /\bstate machine\b/i,
  /\bparser?\b/i,
  /\bmigrat/i,
  /\bsecurity\b/i,
  /\bperformance\b/i,
  /\bconcurrency\b/i,
  /\brecursi/i,
  // BEHAVIORAL difficulty cues only (verbs/techniques), never entity NAMES — a step that merely
  // name-drops a function like `subtreeBounds` is not itself hard. Semantic difficulty (which step
  // actually implements the tricky logic) is the cognition-layer coordinator's job, not regex.
  /\btravers(e|al|ing)\b/i,
  /\b(depth|breadth)-first\b/i,
]);

/**
 * The coordinator's per-sub-task difficulty → requested tier. Defaults to the cheapest tier
 * (`worker`); bumps to `mid` when the goal names work that a flash-class model reliably fumbles,
 * or when the caller already classified the goal as a large build. Deliberately conservative — the
 * rental only spends UP when there is a concrete reason to, so most steps stay on the cheap roster.
 */
export function estimateTaskTier(goal: string, complexity?: string): ModelTier {
  if (complexity === "large") return "mid";
  return HARDER_SIGNALS.some((r) => r.test(goal)) ? "mid" : "worker";
}

/** Inputs for a single builder-expert rental. */
export interface RentBuilderExpertInput {
  /** The sub-task goal being built (the coordinator's routing signal). */
  readonly goal: string;
  /** Optional pre-classified complexity (`--complexity large` forces the mid roster). */
  readonly complexity?: string;
  /** The pool's per-tier rosters (escalation config's tierModels). */
  readonly tierRosters: Readonly<Record<ModelTier, readonly string[]>>;
  /** Model to fall back to if the router has no usable roster (never throws to the caller). */
  readonly fallback: string;
  /** Optional explicit tier override (e.g. a future cognition decision), skipping the heuristic. */
  readonly tierOverride?: ModelTier;
  /**
   * Optional VENDOR LANE: restrict rentals to models whose id begins with this prefix (e.g.
   * "deepseek", "mimo"). Used by the duel-on-failure path to make the second attempt a genuine PEER
   * of the first — a different vendor's experts, not a stronger rung of the same ladder. A lane that
   * filters a tier down to nothing transparently falls back to that tier's full roster.
   */
  readonly vendorLane?: string;
}

/**
 * Restrict a roster to one vendor lane. A lane-pinned attempt must stay in its lane across EVERY model
 * pick, not just the initial rental (IKBI-RT-002). Phase 11 (IKBI-REAUDIT-002): a lane with NO matching
 * model returns an EMPTY list — it NEVER silently falls back to the full roster (which would let a
 * lane-pinned attempt borrow the other vendor's models). An empty result is a configuration error the
 * caller must fail closed on (see `laneHasModels` / the attempt-setup validation), not a licence to pick
 * any available model. `undefined`/empty lane = a lane-NEUTRAL roster (unchanged).
 */
export function laneRoster(ids: readonly string[], lane: string | undefined): readonly string[] {
  if (lane === undefined || lane === "") return ids;
  return ids.filter((id) => id.startsWith(lane));
}

/** Whether a configured vendor lane has at least one model in the given roster (Phase 11). */
export function laneHasModels(ids: readonly string[], lane: string | undefined): boolean {
  return laneRoster(ids, lane).length > 0;
}

// ── SEMANTIC DIFFICULTY ROUTER (the coordinator's brain) ────────────────────────
//
// The regex heuristic above is a zero-cost floor, but it can't tell "implements the recursion"
// from "name-drops a recursive function" — difficulty is SEMANTIC. `classifyTaskTier` spends ONE
// cheap classifier-model call to rate a sub-task, so the coordinator rents a pro expert for the
// genuinely-hard step and keeps the trivial ones on flash. It ALWAYS falls back to the heuristic
// (model unavailable / bad output), so routing degrades gracefully and never blocks a build.

/** A minimal text-in/text-out model call the difficulty router uses (injectable for tests). */
export type ClassifierInvoke = (prompt: string) => Promise<string>;

const CLASSIFY_PROMPT =
  "You are the difficulty ROUTER for a build pipeline's cheap model pool. Rate how hard ONE coding " +
  "sub-task is for a CHEAP/small model to get RIGHT ON THE FIRST TRY. Reply with ONLY compact JSON: " +
  '{"tier":"worker|mid","rationale":"<=12 words"}.\n' +
  "worker = mechanical/boilerplate a small model handles reliably: create a file, add exports/re-exports, " +
  "wire a simple type, follow an obvious existing pattern, write straightforward tests.\n" +
  "mid = the CORE LOGIC needs real reasoning a small model routinely fumbles: recursion, tree/graph " +
  "traversal, non-trivial algorithms, tricky state, exact fiddly signatures, subtle edge cases.\n" +
  "Judge the LOGIC actually implemented, not the wording — a step that merely mentions a hard-sounding " +
  "function name but only re-exports or tests it is worker. Default to worker; pick mid only with a concrete reason.\n\nSUB-TASK:\n";

/** Parse the router's JSON verdict; undefined when it isn't the expected shape. */
function parseTierVerdict(raw: string): { tier: ModelTier; rationale: string } | undefined {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m === null) return undefined;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const t = typeof o.tier === "string" ? o.tier.toLowerCase().trim() : "";
    if (t !== "worker" && t !== "mid" && t !== "frontier") return undefined;
    return { tier: t as ModelTier, rationale: typeof o.rationale === "string" ? o.rationale.slice(0, 120) : "" };
  } catch {
    return undefined;
  }
}

/** Clamp a tier to at most `ceiling` (the cheap-tier pool is worker+mid; never rent frontier here). */
function clampCeiling(tier: ModelTier, ceiling: ModelTier): ModelTier {
  const order: readonly ModelTier[] = ["worker", "mid", "frontier"];
  return order.indexOf(tier) > order.indexOf(ceiling) ? ceiling : tier;
}

/** The router's difficulty verdict for one sub-task. */
export interface DifficultyVerdict {
  readonly tier: ModelTier;
  readonly rationale: string;
  readonly source: "model" | "heuristic";
}

/**
 * Semantically rate a sub-task's difficulty → the tier to rent the builder at. Spends one cheap
 * classifier call; on ANY failure (throw, empty, unparseable) falls back to the zero-cost regex
 * heuristic. An explicit `--complexity large` short-circuits to `mid` without a call. The result is
 * clamped to `ceiling` (default "mid") so the cheap tier never rents outside its 4-model pool.
 */
export async function classifyTaskTier(
  goal: string,
  invoke: ClassifierInvoke,
  opts?: { complexity?: string; ceiling?: ModelTier },
): Promise<DifficultyVerdict> {
  const ceiling = opts?.ceiling ?? "mid";
  if (opts?.complexity === "large") return { tier: clampCeiling("mid", ceiling), rationale: "operator marked --complexity large", source: "heuristic" };
  try {
    const raw = await invoke(`${CLASSIFY_PROMPT}${goal}`);
    const verdict = parseTierVerdict(raw);
    if (verdict !== undefined) return { tier: clampCeiling(verdict.tier, ceiling), rationale: verdict.rationale, source: "model" };
  } catch {
    /* fall through to the heuristic — routing must never block a build */
  }
  return { tier: clampCeiling(estimateTaskTier(goal, opts?.complexity), ceiling), rationale: "classifier unavailable — heuristic fallback", source: "heuristic" };
}

/** Resolve the cheapest classifier-role model (always worker-tier); falls back to `fallback`. */
export function resolveClassifierModel(tierRosters: Readonly<Record<ModelTier, readonly string[]>>, fallback: string): string {
  try {
    return resolveModel({
      role: "classifier",
      requestedTier: "worker",
      tierRosters: {
        worker: rosterFromIds(tierRosters.worker),
        mid: rosterFromIds(tierRosters.mid),
        frontier: rosterFromIds(tierRosters.frontier),
      },
    }).modelId;
  } catch {
    return fallback;
  }
}

/** The rented expert for one sub-task. */
export interface RentedExpert {
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly reason: string;
}

/**
 * Rent the cheapest-sufficient builder expert for one sub-task. Pure + total: on any router error
 * (e.g. an empty roster) it returns the caller's fallback rather than throwing, so a rental decision
 * can never break a build — the worst case is "use the tier's default builder".
 */
export function rentBuilderExpert(input: RentBuilderExpertInput): RentedExpert {
  const requestedTier = input.tierOverride ?? estimateTaskTier(input.goal, input.complexity);
  try {
    const res = resolveModel({
      role: "builder",
      requestedTier,
      tierRosters: {
        worker: rosterFromIds(laneRoster(input.tierRosters.worker, input.vendorLane)),
        mid: rosterFromIds(laneRoster(input.tierRosters.mid, input.vendorLane)),
        frontier: rosterFromIds(laneRoster(input.tierRosters.frontier, input.vendorLane)),
      },
    });
    return { modelId: res.modelId, tier: res.tier, reason: `rented ${res.modelId} (${res.reason})` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { modelId: input.fallback, tier: requestedTier, reason: `rental fell back to ${input.fallback} (${detail})` };
  }
}
