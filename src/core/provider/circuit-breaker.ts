/**
 * ikbi provider layer — circuit breaker.
 *
 * Cross-call failure memory, keyed per (provider, model) by the invoker — a bad
 * model must not open the whole provider, and a success on one model must not
 * close it for another. After N consecutive failures the circuit OPENS and the
 * route is skipped for a cooldown window. After the cooldown it goes HALF-OPEN
 * and admits a limited number of *concurrent* trial probes (default 1); a
 * success CLOSES it, a failure re-OPENS it.
 *
 * Only retriable failures count toward health: non-retriable failures
 * (auth/config/bad-response) are reported via `recordIgnoredFailure`, which
 * releases a half-open probe slot without affecting the failure count or state.
 *
 * The clock is injectable so tests are deterministic (no real timers).
 */

export type CircuitState = "closed" | "open" | "half_open";

/** Monotonic-ish clock returning milliseconds. Injected for testability. */
export type Clock = () => number;

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  /** Max concurrent half-open trial probes (serialization bound). */
  readonly halfOpenMaxTrials: number;
  /** Defaults to `Date.now`. */
  readonly now?: Clock;
}

/** Public snapshot of breaker state for logging/observability. */
export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly openedAt: number | undefined;
  readonly halfOpenInFlight: number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMaxTrials: number;
  private readonly now: Clock;

  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | undefined;
  /** Number of half-open probes currently admitted but not yet recorded. */
  private halfOpenInFlight = 0;

  constructor(opts: CircuitBreakerOptions) {
    this.failureThreshold = opts.failureThreshold;
    this.cooldownMs = opts.cooldownMs;
    this.halfOpenMaxTrials = Math.max(1, opts.halfOpenMaxTrials);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Whether an attempt may proceed right now. Transitions open -> half_open once
   * the cooldown has elapsed, then admits at most `halfOpenMaxTrials` concurrent
   * probes. The transition and the permit grant are separated so two concurrent
   * callers cannot both reset the in-flight counter and both pass.
   *
   * If this returns true in the half-open state it has reserved a probe slot;
   * the caller MUST later call recordSuccess / recordFailure / recordIgnoredFailure.
   */
  canAttempt(): boolean {
    this.maybeHalfOpen();
    if (this.state === "closed") return true;
    if (this.state === "open") return false;
    // half_open: admit only up to the concurrency bound.
    if (this.halfOpenInFlight < this.halfOpenMaxTrials) {
      this.halfOpenInFlight += 1;
      return true;
    }
    return false;
  }

  /** Record a successful attempt — closes the circuit and clears failures. */
  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.halfOpenInFlight = 0;
    this.openedAt = undefined;
  }

  /** Record a retriable failed attempt — may open (or re-open) the circuit. */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "half_open") {
      // A trial failed: straight back to open for another cooldown.
      this.open();
      return;
    }
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.open();
    }
  }

  /**
   * Record a NON-retriable failure (auth/config/bad-response). Does not count
   * toward provider health or change state — only releases a half-open probe
   * slot so the breaker isn't left stuck with a phantom in-flight probe.
   */
  recordIgnoredFailure(): void {
    if (this.state === "half_open" && this.halfOpenInFlight > 0) {
      this.halfOpenInFlight -= 1;
    }
  }

  /** Current state snapshot (for logging/observability). */
  snapshot(): CircuitSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      halfOpenInFlight: this.halfOpenInFlight,
    };
  }

  /** Transition open -> half_open exactly once when the cooldown has elapsed. */
  private maybeHalfOpen(): void {
    if (this.state !== "open") return;
    const openedAt = this.openedAt ?? this.now();
    if (this.now() - openedAt >= this.cooldownMs) {
      this.state = "half_open";
      this.halfOpenInFlight = 0;
    }
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.halfOpenInFlight = 0;
  }
}
