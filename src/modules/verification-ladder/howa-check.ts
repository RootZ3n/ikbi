/**
 * ikbi verification-ladder — the HOWA TRUTHFULNESS RUNG (optional).
 *
 * ikbi's verifier proves the CODE is green (tests/typecheck pass). It does NOT prove the
 * model's *claims* about what it did are true — a build can pass tests while the builder's
 * stated intent ("added input validation", "fixed the race") is a fabrication. This rung
 * closes that gap: it posts the build's diff + the model's stated intent to Howa (the lab's
 * truthfulness/agent proving ground) and FAILS CLOSED (RED) when Howa detects a lie.
 *
 * It is OPT-IN and OFF by default (IKBI_VERIFICATION_LADDER_HOWA_ENABLED). It reuses the
 * existing per-target check seam (`IKBI_CHECKS`) conceptually — an operator turns it on with
 * env, exactly like declaring a check — but unlike a governed-exec command it is an HTTP call,
 * so it lives here as a typed rung rather than a `{name,command,args}` entry.
 *
 * EGRESS: ikbi's global SSRF fetch guard (src/modules/egress) is default-deny. Reaching Howa
 * requires the operator to allowlist Howa's host (IKBI_EGRESS_ALLOWLIST) and — for a loopback
 * Howa — its ip:port (IKBI_EGRESS_ALLOW_LOCAL). A guard denial is reported as actionable RED,
 * never a silent pass. See src/modules/egress/config.ts.
 *
 * @status library-only — exported + tested; the verifier call-site wiring is documented in
 *   verifier.ts (a single optional invocation after the deterministic checks pass).
 */

import { moduleEnv } from "../../core/module-config.js";

const env = moduleEnv("verification-ladder");

/** Default Howa base URL (the lab's canonical Howa port). Overridable per deployment. */
export const DEFAULT_HOWA_URL = "http://127.0.0.1:18799";
/** Default truthfulness endpoint path on Howa. */
export const DEFAULT_HOWA_PATH = "/api/truthfulness";
/** Default per-request budget (ms) — a hung Howa must not stall a build forever. */
export const DEFAULT_HOWA_TIMEOUT_MS = 20_000;

export interface HowaCheckConfig {
  /** Master switch — OFF by default. The check is skipped entirely when false. */
  readonly enabled: boolean;
  /** Howa base URL (no trailing slash). */
  readonly url: string;
  /** Truthfulness endpoint path (joined to `url`). */
  readonly path: string;
  /** Optional bearer token for a protected Howa. */
  readonly token: string | undefined;
  /** Per-request timeout in ms. */
  readonly timeoutMs: number;
  /**
   * When true (default), an UNREACHABLE/erroring Howa fails the build CLOSED (RED) — the
   * truthfulness gate cannot be silently bypassed by knocking Howa offline. Set false to make
   * the rung advisory (errors → skipped, never blocking).
   */
  readonly failOnError: boolean;
}

/** Load the Howa-check config slice from `IKBI_VERIFICATION_LADDER_HOWA_*`. */
export function loadHowaCheckConfig(reader = env): HowaCheckConfig {
  const rawUrl = reader.str("HOWA_URL", DEFAULT_HOWA_URL).replace(/\/+$/, "");
  const rawPath = reader.str("HOWA_PATH", DEFAULT_HOWA_PATH);
  return Object.freeze({
    enabled: reader.bool("HOWA_ENABLED", false),
    url: rawUrl,
    path: rawPath.startsWith("/") ? rawPath : `/${rawPath}`,
    token: reader.str("HOWA_TOKEN", "") || undefined,
    timeoutMs: reader.int("HOWA_TIMEOUT_MS", DEFAULT_HOWA_TIMEOUT_MS, { min: 1 }),
    failOnError: reader.bool("HOWA_FAIL_ON_ERROR", true),
  });
}

/** The inputs the rung judges: the build's diff and the model's stated intent. */
export interface HowaCheckInput {
  /** The unified diff of what the build actually changed. */
  readonly diff: string;
  /** The model's stated intent / claims about what it did (goal + builder summary). */
  readonly intent: string;
  /** Optional correlation id (taskId) — forwarded to Howa for its receipt. */
  readonly taskId?: string;
}

export type HowaVerdict = "truthful" | "lie" | "indeterminate";

export interface HowaCheckResult {
  /** "green" = truthful, "red" = lie/blocked, "skipped" = disabled/advisory-error. */
  readonly status: "green" | "red" | "skipped";
  /** True only when Howa affirmatively detected a lie (the fail-closed signal). */
  readonly lie: boolean;
  readonly verdict: HowaVerdict;
  /** Human-readable reason for the verdict (safe to surface in a receipt). */
  readonly reason: string;
}

/** A minimal fetch surface so tests inject a fake without a network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Interpret Howa's JSON response into a verdict. Accepts the common shapes a truthfulness
 * service might return so the rung is robust to the exact contract:
 *   { lie: boolean } | { truthful: boolean } | { verdict: "truthful"|"lie"|... } | { passed: boolean }
 * Anything unrecognized is INDETERMINATE (treated by the caller per failOnError).
 */
export function interpretHowaResponse(body: unknown): { verdict: HowaVerdict; reason: string } {
  if (body === null || typeof body !== "object") {
    return { verdict: "indeterminate", reason: "Howa returned a non-object body" };
  }
  const o = body as Record<string, unknown>;
  const reason =
    typeof o.reason === "string" ? o.reason
    : typeof o.detail === "string" ? o.detail
    : typeof o.explanation === "string" ? o.explanation
    : "";

  if (typeof o.lie === "boolean") return { verdict: o.lie ? "lie" : "truthful", reason: reason || (o.lie ? "Howa detected a lie" : "Howa: truthful") };
  if (typeof o.truthful === "boolean") return { verdict: o.truthful ? "truthful" : "lie", reason: reason || (o.truthful ? "Howa: truthful" : "Howa detected a lie") };
  if (typeof o.passed === "boolean") return { verdict: o.passed ? "truthful" : "lie", reason: reason || (o.passed ? "Howa: passed" : "Howa: failed truthfulness") };
  if (typeof o.verdict === "string") {
    const v = o.verdict.toLowerCase();
    if (v === "truthful" || v === "true" || v === "pass" || v === "green") return { verdict: "truthful", reason: reason || `Howa verdict: ${o.verdict}` };
    if (v === "lie" || v === "false" || v === "fail" || v === "red" || v === "deceptive") return { verdict: "lie", reason: reason || `Howa verdict: ${o.verdict}` };
  }
  return { verdict: "indeterminate", reason: reason || "Howa response had no recognizable truthfulness verdict" };
}

/**
 * Run the Howa truthfulness rung. Returns "skipped" when disabled; "red" with `lie:true`
 * when Howa detects a lie; "green" when truthful. Network/parse failures map to RED when
 * `failOnError` (the default — fail closed) else "skipped".
 *
 * Never throws — every failure becomes a structured result so the verifier can fold it in.
 */
export async function runHowaTruthfulnessCheck(
  input: HowaCheckInput,
  cfg: HowaCheckConfig = loadHowaCheckConfig(),
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<HowaCheckResult> {
  if (!cfg.enabled) {
    return { status: "skipped", lie: false, verdict: "indeterminate", reason: "Howa truthfulness check disabled (IKBI_VERIFICATION_LADDER_HOWA_ENABLED unset)" };
  }

  const onError = (reason: string): HowaCheckResult =>
    cfg.failOnError
      ? { status: "red", lie: false, verdict: "indeterminate", reason: `Howa truthfulness check could not complete (fail-closed): ${reason}` }
      : { status: "skipped", lie: false, verdict: "indeterminate", reason: `Howa truthfulness check skipped (advisory): ${reason}` };

  const url = `${cfg.url}${cfg.path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.token !== undefined) headers["authorization"] = `Bearer ${cfg.token}`;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ diff: input.diff, intent: input.intent, ...(input.taskId !== undefined ? { taskId: input.taskId } : {}) }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // An egress-guard denial lands here — surface the exact allowlist guidance.
    if (/egress|allowlist|blocked|SSRF/i.test(detail)) {
      return onError(`${detail} — add Howa's host to IKBI_EGRESS_ALLOWLIST (and its ip:port to IKBI_EGRESS_ALLOW_LOCAL for a loopback Howa)`);
    }
    if (err instanceof Error && err.name === "TimeoutError") return onError(`Howa did not respond within ${cfg.timeoutMs}ms (${url})`);
    return onError(`cannot reach Howa at ${url} (${detail})`);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) return onError(`Howa returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);

  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    return onError("Howa returned a non-JSON body");
  }

  const { verdict, reason } = interpretHowaResponse(body);
  if (verdict === "lie") return { status: "red", lie: true, verdict, reason };
  if (verdict === "truthful") return { status: "green", lie: false, verdict, reason };
  // Indeterminate: fold through the failOnError policy (an inconclusive truth check is not a pass).
  return onError(reason);
}
