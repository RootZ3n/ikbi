/**
 * THE LOCAL-WORK AUTHORITY — whether a subtask may be done by a local worker, and what its
 * answer is then worth.
 *
 * THE BOUNDARY THIS ENCODES. Two systems decide two different things and neither may decide the
 * other's. IKBI decides whether a task is ELIGIBLE to leave the primary provider, whether a local
 * failure may be retried, whether fallback is permitted, whether the answer is useful, and every
 * mutation, verification, publication and promotion question. BOKAHLI decides which installed
 * artifact should serve an eligible task, whether any is qualified, and whether it has capacity —
 * and answers ROUTED, ESCALATE, REFUSED or CAPACITY_UNAVAILABLE. Nothing here ranks models. A
 * second ranking table in ikbi would drift from the one that can actually see the hardware, and
 * the drift would be invisible until it mattered.
 *
 * SO BOKAHLI IS NOT ANOTHER BUILDER. A builder is trusted to change a repository. A local worker
 * is asked a bounded question and hands back TEXT, which ikbi then has to prove is worth
 * anything. That asymmetry is the whole design: local inference gets no filesystem, no shell, no
 * tool authority, and no ability to mutate, verify, publish or promote. A proposed edit comes back
 * as DATA and is applied — if at all — later, by ikbi, through the ordinary governed mutation path.
 *
 * DETERMINISM IS A REQUIREMENT, NOT A HAPPY ACCIDENT. `decideLocalOffload` is a pure function of
 * its inputs. Given the same task, mode and observed local state it returns the same decision with
 * the same reason, every time — which is what makes an AUTO decision reviewable after the fact
 * rather than a story about what the machine felt like doing.
 *
 * AND UNKNOWN IS NEVER FAVORABLE. Every path that cannot be understood — an outcome nobody
 * enumerated, a reason that does not belong to its outcome, a validator that cannot run — refuses.
 * A local worker nobody has qualified is USEFUL and is not TRUSTED, and the difference has to live
 * in the data rather than in whoever reads it next remembering.
 */

/** Operator modes. `exact` is a diagnostics/operator selection, not an autonomy level. */
export const LOCAL_MODES = ["off", "assist", "auto", "exact"] as const;
export type LocalMode = (typeof LOCAL_MODES)[number];

/**
 * Is this a mode ikbi actually knows?
 *
 * A `LocalMode` is a compile-time promise, and nothing about a CLI flag, an environment variable,
 * a config file or an HTTP body is checked at compile time. The first version of this module took
 * the promise at face value and compared `mode === "off"`, which meant an operator who typed
 * `--mode OFF` — the string that most plainly means DO NOT CALL BOKAHLI — got an offload, because
 * the uppercase value matched neither "off" nor "auto" and fell through every branch to the
 * eligible path. Failing open on a value nobody recognises is the exact inverse of what this
 * module is for, so the check lives here, in the authority, rather than in whichever caller
 * happened to remember it.
 */
export function isLocalMode(value: unknown): value is LocalMode {
  return typeof value === "string" && (LOCAL_MODES as readonly string[]).includes(value);
}

/**
 * Task classes a local worker may be asked to do.
 *
 * Every one shares two properties: the input is a BOUNDED packet rather than a repository, and
 * the output can be checked by something that is not a language model. A class that cannot say
 * both does not belong here, however tempting the latency saving.
 */
export const ELIGIBLE_TASK_CLASSES = [
  "test_log_triage",
  "repo_recon_bounded",
  "diff_summarization",
  "receipt_summarization",
  "cited_extraction",
  "structured_classification",
  "transformation_proposal",
  "narrow_edit_proposal",
] as const;
export type LocalTaskClass = (typeof ELIGIBLE_TASK_CLASSES)[number];

/**
 * Work that must never reach a local worker, and why.
 *
 * These are not "not yet tuned". Each is a case where a wrong answer is not a bad suggestion an
 * operator can discard but an action, an authority decision, or a disclosure.
 */
export const INELIGIBLE_TASK_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  autonomous_publication: "publication is a governed decision; a worker that cannot be held to a policy cannot make it",
  destructive_operation: "an irreversible action must not depend on an unqualified answer",
  credential_handling: "a secret that reaches an inference request has left the operator's control",
  governance_decision: "trust, promotion and policy are ikbi's authority and are not delegated",
  promotion_decision: "eligibility for publication is adjudicated from evidence, never proposed by a worker",
  broad_refactor: "an ambiguous, repository-wide change has no bounded packet and no deterministic validator",
  unbounded_repository_access: "a local worker receives a packet, never a repository",
  unvalidatable_mutation: "without a deterministic validator, a wrong answer becomes a mutation nobody checked",
});

/** Bokahli's typed outcomes. Anything else is unknown, and unknown fails closed. */
export const LOCAL_OUTCOMES = ["ROUTED", "ESCALATE", "REFUSED", "CAPACITY_UNAVAILABLE"] as const;
export type LocalOutcome = (typeof LOCAL_OUTCOMES)[number];

/** Capacity reasons. Only `RUNTIME_UNHEALTHY` is ever worth retrying. */
export const RETRYABLE_CAPACITY_REASONS = ["RUNTIME_UNHEALTHY"] as const;

/** What ikbi observed about the local deployment when it decided. Part of the decision's inputs. */
export interface LocalOperationalState {
  /** Whether a Bokahli endpoint is configured at all. Absent configuration means OFF, always. */
  readonly configured: boolean;
  /** Whether the last probe found it reachable. `undefined` means UNPROBED — not "probably fine". */
  readonly reachable?: boolean;
  /** Consecutive failures observed this session. A local lane that keeps failing stops being tried. */
  readonly consecutiveFailures?: number;
}

export interface LocalOffloadInput {
  /**
   * The operator's mode, AS RECEIVED. Deliberately typed loosely: this function validates it, and
   * a parameter that could only ever hold a valid mode would make the validation unreachable and
   * the guarantee untestable.
   */
  readonly mode: LocalMode | string;
  /** The task class ikbi assigned. An unrecognized value is ineligible, never "probably fine". */
  readonly taskClass: string;
  /** Whether a deterministic validator exists for THIS task's output. */
  readonly hasValidator: boolean;
  /** Whether the packet handed to the worker is bounded (size-capped, explicitly assembled). */
  readonly packetBounded: boolean;
  /** True when the caller demands a QUALIFIED artifact. Never silently downgraded. */
  readonly requireQualified: boolean;
  readonly state: LocalOperationalState;
  /** Max consecutive local failures before AUTO stops choosing local. Default 3. */
  readonly failureBudget?: number;
}

/** Why a decision went the way it did. Stable strings — they are recorded and compared. */
export type LocalOffloadReason =
  | "mode_unrecognized"
  | "mode_off"
  | "not_configured"
  | "unreachable"
  | "failure_budget_exhausted"
  | "task_class_unknown"
  | "task_class_ineligible"
  | "no_deterministic_validator"
  | "packet_unbounded"
  | "eligible"
  | "operator_selected";

export interface LocalOffloadDecision {
  readonly offload: boolean;
  /** Echoed verbatim, valid or not, so a receipt records what the operator actually supplied. */
  readonly mode: LocalMode | string;
  readonly taskClass: string;
  readonly reason: LocalOffloadReason;
  /** Human-readable, derived from `reason`. Never the only record of why. */
  readonly explanation: string;
  readonly requireQualified: boolean;
  /**
   * Whether a local FAILURE may fall back to the configured primary provider.
   *
   * ASSIST never falls back silently: the operator asked for a local artifact and is owed a typed
   * local failure instead of a quietly-substituted cloud answer they did not ask for and will be
   * billed for. AUTO may fall back, because AUTO chose local as an optimization and the parent
   * task still has to finish — but only when policy says so, and never without a receipt.
   */
  readonly fallbackPermitted: boolean;
}

const EXPLANATION: Readonly<Record<LocalOffloadReason, string>> = Object.freeze({
  mode_unrecognized: "the local mode is not one ikbi recognises — refusing rather than guessing which was meant",
  mode_off: "local mode is OFF — no request is made to Bokahli",
  not_configured: "no Bokahli endpoint is configured; ikbi proceeds exactly as if it did not exist",
  unreachable: "the local deployment was probed and is not reachable",
  failure_budget_exhausted: "consecutive local failures reached the budget; AUTO stops selecting local",
  task_class_unknown: "the task class is not one ikbi enumerates — unknown is not eligible",
  task_class_ineligible: "this task class may never be executed by a local worker",
  no_deterministic_validator: "no deterministic validator exists for this output, so a wrong answer could not be caught",
  packet_unbounded: "the packet is not bounded; a local worker receives a packet, never a repository",
  eligible: "the task is bounded, validatable, and of an eligible class; local execution is permitted",
  operator_selected: "the operator selected this target explicitly (EXACT)",
});

/**
 * Decide whether this subtask may go to the local worker.
 *
 * ORDER IS DELIBERATE and it is the fail-closed order: the cheapest, most absolute refusals come
 * first, so a task that is ineligible ON ITS MERITS is reported as ineligible even on a machine
 * where Bokahli happens to be down — and an operator reading the record learns the real reason
 * rather than an accident of that afternoon's uptime. Only after everything structural passes do
 * the operational checks get a say.
 */
export function decideLocalOffload(input: LocalOffloadInput): LocalOffloadDecision {
  const base = { mode: input.mode, taskClass: input.taskClass, requireQualified: input.requireQualified };
  const no = (reason: LocalOffloadReason): LocalOffloadDecision =>
    Object.freeze({ ...base, offload: false, reason, explanation: EXPLANATION[reason], fallbackPermitted: false });

  // AN UNREADABLE MODE IS CHECKED FIRST, before OFF and before eligibility. A value nobody
  // recognises cannot be interpreted charitably in either direction: "OFF" is probably a typo for
  // off, and "Auto" is probably a typo for auto, and acting on either guess would be ikbi deciding
  // an authorization question on the operator's behalf. It refuses, and says so.
  if (!isLocalMode(input.mode)) return no("mode_unrecognized");

  // OFF is absolute and is checked before anything else remaining, including whether Bokahli
  // exists. It is the compatibility-safe default, and an operator who set it is owed zero local
  // requests.
  if (input.mode === "off") return no("mode_off");

  // STRUCTURAL ELIGIBILITY — properties of the TASK, independent of the deployment's health.
  if (Object.prototype.hasOwnProperty.call(INELIGIBLE_TASK_CLASSES, input.taskClass)) return no("task_class_ineligible");
  if (!(ELIGIBLE_TASK_CLASSES as readonly string[]).includes(input.taskClass)) return no("task_class_unknown");
  if (!input.hasValidator) return no("no_deterministic_validator");
  if (!input.packetBounded) return no("packet_unbounded");

  // OPERATIONAL STATE.
  if (!input.state.configured) return no("not_configured");
  // UNPROBED is not "reachable". Only an explicit `false` is a refusal, so an un-probed lane is
  // allowed to try and fail honestly rather than being blocked by an assumption.
  if (input.state.reachable === false) return no("unreachable");
  const budget = input.failureBudget ?? 3;
  if ((input.state.consecutiveFailures ?? 0) >= budget) return no("failure_budget_exhausted");

  return Object.freeze({
    ...base,
    offload: true,
    reason: input.mode === "exact" ? "operator_selected" : "eligible",
    explanation: EXPLANATION[input.mode === "exact" ? "operator_selected" : "eligible"],
    // Only AUTO may substitute the primary provider for a failed local call. See the field's note.
    fallbackPermitted: input.mode === "auto",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTING (OR REFUSING) WHAT CAME BACK
// ─────────────────────────────────────────────────────────────────────────────

/** What the local deployment said it did, as ikbi received it. */
export interface LocalResponseFacts {
  readonly outcome: string;
  readonly reason?: string;
  /** The artifact the deployment attested to serving, if it attested at all. */
  readonly attested?: {
    readonly modelId: string;
    readonly artifactDigest: string;
    readonly attested: boolean;
    readonly qualificationStatus: string;
  };
  /** The artifact ikbi ASKED for, when it asked for a specific one (EXACT). */
  readonly expectedModelId?: string;
  readonly expectedDigest?: string;
}

export type LocalRejection =
  | "unknown_outcome"
  | "reason_outcome_mismatch"
  | "refused"
  | "escalated"
  | "capacity_unavailable"
  | "identity_mismatch"
  | "digest_mismatch"
  | "unattested_identity"
  | "unqualified_artifact"
  | "validator_rejected"
  | "citation_unresolved";

export interface LocalAcceptance {
  readonly accepted: boolean;
  readonly rejection?: LocalRejection;
  readonly detail: string;
  /** Present only on acceptance. How the result must be treated downstream. */
  readonly supervision?: LocalSupervision;
}

/**
 * The mark an accepted-but-unqualified result carries.
 *
 * Recorded as DATA, because a convention that a supervised result "should be reviewed" survives
 * exactly as long as the next person who remembers it.
 */
export interface LocalSupervision {
  readonly executionClass: "local";
  readonly qualified: boolean;
  readonly humanReviewRequired: boolean;
  readonly autonomousPromotionAllowed: boolean;
  readonly reason: string;
}

/**
 * Judge a local response before any of it is believed.
 *
 * `requireQualified` is checked BEFORE supervision is offered. A caller that demanded a qualified
 * artifact must receive a refusal, never a supervised result quietly relabelled as good enough —
 * downgrading here is precisely the failure the flag exists to prevent.
 */
export function acceptLocalResponse(
  facts: LocalResponseFacts,
  opts: { readonly requireQualified: boolean; readonly requireAttestation: boolean },
): LocalAcceptance {
  const reject = (rejection: LocalRejection, detail: string): LocalAcceptance =>
    Object.freeze({ accepted: false, rejection, detail });

  if (!(LOCAL_OUTCOMES as readonly string[]).includes(facts.outcome)) {
    return reject("unknown_outcome", `outcome ${JSON.stringify(facts.outcome)} is not one ikbi understands`);
  }
  if (facts.outcome === "REFUSED") return reject("refused", `the local deployment refused: ${facts.reason ?? "no reason given"}`);
  if (facts.outcome === "ESCALATE") return reject("escalated", `the local deployment escalated: ${facts.reason ?? "no reason given"}`);
  if (facts.outcome === "CAPACITY_UNAVAILABLE") {
    return reject("capacity_unavailable", `no local capacity: ${facts.reason ?? "no reason given"}`);
  }

  // ROUTED with a reason belonging to a different outcome is a PROTOCOL disagreement, not a
  // routing decision, and reading past it would mean trusting a message we demonstrably
  // misunderstand.
  if (facts.reason !== undefined && facts.reason.length > 0) {
    return reject("reason_outcome_mismatch", `ROUTED carried reason ${JSON.stringify(facts.reason)}, which belongs to a refusal`);
  }

  const attested = facts.attested;
  if (facts.expectedModelId !== undefined && attested?.modelId !== facts.expectedModelId) {
    // A substituted artifact is not a smaller version of what was asked for; it is a different
    // answer with someone else's name on it.
    return reject("identity_mismatch", `asked for ${facts.expectedModelId}, served ${attested?.modelId ?? "(nothing attested)"}`);
  }
  if (facts.expectedDigest !== undefined && attested?.artifactDigest !== facts.expectedDigest) {
    return reject("digest_mismatch", `asked for digest ${facts.expectedDigest}, served ${attested?.artifactDigest ?? "(none)"}`);
  }
  if (opts.requireAttestation && attested?.attested !== true) {
    // `attested: false` and "no attestation block" are the same fact: the deployment did not
    // prove what it ran. Neither is upgraded by wanting it to be.
    return reject("unattested_identity", "attestation was required and the deployment did not attest what it served");
  }

  const qualified = attested?.qualificationStatus === "QUALIFIED";
  if (opts.requireQualified && !qualified) {
    return reject("unqualified_artifact", `a qualified artifact was required; the deployment reported ${attested?.qualificationStatus ?? "UNKNOWN"}`);
  }

  return Object.freeze({
    accepted: true,
    detail: qualified ? "qualified local result" : "supervised-local result from an unqualified artifact",
    supervision: Object.freeze({
      executionClass: "local" as const,
      qualified,
      // An unqualified artifact's answer is evidence, never a decision.
      humanReviewRequired: !qualified,
      autonomousPromotionAllowed: false,
      reason: qualified
        ? `artifact ${attested?.modelId ?? "unknown"} is qualified`
        : `artifact ${attested?.modelId ?? "unknown"} reported ${attested?.qualificationStatus ?? "UNKNOWN"}`,
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CITATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check every citation a local answer made against the packet it was given.
 *
 * A citation that does not resolve EXACTLY is not a small inaccuracy; it is the model describing
 * something it was never shown, which is the failure mode a cheap quantized worker has most of.
 * Exact substring containment, not fuzzy matching: a "close enough" citation check is a citation
 * check that passes for invented text.
 */
export function resolveCitations(
  packet: readonly { readonly id: string; readonly content: string }[],
  citations: readonly { readonly sourceId: string; readonly quote: string }[],
): { readonly resolved: boolean; readonly unresolved: readonly string[] } {
  const bySource = new Map(packet.map((p) => [p.id, p.content]));
  const unresolved: string[] = [];
  for (const c of citations) {
    const content = bySource.get(c.sourceId);
    // SAY WHICH FAILURE IT WAS. "unresolved" covers three different mistakes — a source that was
    // never supplied, an empty quote, and text that simply is not there — and an operator deciding
    // whether the worker hallucinated or ikbi mislabelled the packet needs to know which. The
    // first version of this message truncated the quote to 60 characters, which hid the actual
    // mismatch behind an ellipsis and made a real debugging session considerably longer.
    if (content === undefined) {
      unresolved.push(`sourceId ${JSON.stringify(c.sourceId)} is not in the packet (supplied: ${packet.map((p) => p.id).join(", ")})`);
      continue;
    }
    if (c.quote.length === 0) {
      unresolved.push(`${c.sourceId}: empty quote — citing nothing is not citing`);
      continue;
    }
    if (!content.includes(c.quote)) {
      unresolved.push(`${c.sourceId}: quote not found verbatim: ${JSON.stringify(c.quote)}`);
    }
  }
  return Object.freeze({ resolved: unresolved.length === 0, unresolved: Object.freeze(unresolved) });
}

// ─────────────────────────────────────────────────────────────────────────────
// RETRY
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalRetryPolicy {
  /** Max ATTEMPTS in total, including the first. Default 2 — one retry. */
  readonly maxAttempts?: number;
  /** Base backoff in ms. Jittered. Default 250. */
  readonly baseDelayMs?: number;
  /** Hard ceiling on added latency across all retries. Default 2000ms. */
  readonly maxAddedLatencyMs?: number;
}

export interface LocalRetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
  readonly reason: string;
}

/**
 * Whether a failed local attempt may be retried, and how long to wait.
 *
 * ONLY A TRANSIENT RUNTIME IS RETRYABLE. A malformed protocol response, an identity mismatch and
 * a refusal are all STABLE facts about this request — repeating it changes nothing and spends the
 * operator's latency to learn what we already know. A queue that is full is a decision too, not a
 * hiccup. The total added latency is capped so a bounded retry policy cannot become an unbounded
 * wait by arithmetic.
 *
 * `jitter` is injected (0..1) so this stays a pure function and a test can pin the delay.
 */
export function decideLocalRetry(
  input: {
    readonly rejection: LocalRejection;
    readonly retryableLocal?: boolean;
    readonly attemptsMade: number;
    readonly latencySpentMs: number;
    readonly capacityReason?: string;
  },
  policy: LocalRetryPolicy = {},
  jitter = 0.5,
): LocalRetryDecision {
  const maxAttempts = policy.maxAttempts ?? 2;
  const base = policy.baseDelayMs ?? 250;
  const cap = policy.maxAddedLatencyMs ?? 2000;
  const no = (reason: string): LocalRetryDecision => Object.freeze({ retry: false, delayMs: 0, reason });

  if (input.rejection !== "capacity_unavailable") return no(`${input.rejection} is a stable fact; repeating the request cannot change it`);
  if (input.capacityReason !== undefined && !(RETRYABLE_CAPACITY_REASONS as readonly string[]).includes(input.capacityReason)) {
    return no(`${input.capacityReason} is a capacity DECISION, not a transient fault`);
  }
  // The deployment's own judgement outranks ours: if it says this is not retryable, it is not.
  if (input.retryableLocal === false) return no("the deployment reported the condition as not retryable");
  if (input.attemptsMade >= maxAttempts) return no(`attempt budget exhausted (${input.attemptsMade}/${maxAttempts})`);
  if (input.latencySpentMs >= cap) return no(`added-latency cap reached (${input.latencySpentMs}ms >= ${cap}ms)`);

  const exponential = base * 2 ** (input.attemptsMade - 1);
  // Jittered, and clipped to whatever budget is actually left rather than to the nominal delay.
  const jittered = Math.round(exponential * (0.5 + jitter * 0.5));
  const delayMs = Math.max(0, Math.min(jittered, cap - input.latencySpentMs));
  return Object.freeze({ retry: true, delayMs, reason: "RUNTIME_UNHEALTHY is transient and within budget" });
}

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK ACCOUNTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The record a fallback MUST produce.
 *
 * There is no silent fallback. An operator who chose a local lane and quietly received a paid
 * cloud answer has been billed for a decision nobody told them about, and the only defence is that
 * the substitution is unpleasant to perform without writing down exactly what happened.
 */
export interface LocalFallbackEvent {
  readonly localDecision: LocalOffloadReason | LocalRejection;
  /** The artifact that was admitted and attempted, when one was. */
  readonly attemptedModelId?: string;
  readonly attemptedArtifactDigest?: string;
  readonly failureReason: string;
  readonly retryCount: number;
  readonly fallbackProvider: string;
  readonly addedLatencyMs: number;
  /** Whether any partial local output existed and was thrown away. */
  readonly partialOutputDiscarded: boolean;
}

/**
 * Build the fallback record, or refuse the fallback outright.
 *
 * A fallback that policy does not permit is not performed and not recorded as if it had been —
 * the caller is told no. Partial local output is ALWAYS discarded: half an answer from an
 * unqualified worker, spliced onto a different model's completion, is a result no one can reason
 * about and nobody asked for.
 */
export function authorizeFallback(input: {
  readonly decision: LocalOffloadDecision;
  readonly rejection: LocalRejection | LocalOffloadReason;
  readonly failureReason: string;
  readonly retryCount: number;
  readonly fallbackProvider: string;
  readonly addedLatencyMs: number;
  readonly hadPartialOutput: boolean;
  readonly attempted?: { readonly modelId?: string; readonly artifactDigest?: string };
}): { readonly permitted: boolean; readonly detail: string; readonly event?: LocalFallbackEvent } {
  if (!input.decision.fallbackPermitted) {
    return Object.freeze({
      permitted: false,
      detail:
        input.decision.mode === "assist"
          ? "ASSIST returns a typed local failure; it never substitutes the primary provider unasked"
          : `fallback is not permitted in mode ${input.decision.mode}`,
    });
  }
  return Object.freeze({
    permitted: true,
    detail: `falling back to ${input.fallbackProvider} after ${input.retryCount} local retry/retries`,
    event: Object.freeze({
      localDecision: input.rejection,
      ...(input.attempted?.modelId !== undefined ? { attemptedModelId: input.attempted.modelId } : {}),
      ...(input.attempted?.artifactDigest !== undefined ? { attemptedArtifactDigest: input.attempted.artifactDigest } : {}),
      failureReason: input.failureReason,
      retryCount: input.retryCount,
      fallbackProvider: input.fallbackProvider,
      addedLatencyMs: input.addedLatencyMs,
      partialOutputDiscarded: input.hadPartialOutput,
    }),
  });
}
