/**
 * Bokahli — local inference on Mushin, over loopback.
 *
 * Bokahli speaks the OpenAI dialect, so the transport is the same hardened
 * client every other provider uses. Two things make it different enough to need
 * its own file.
 *
 * ## It refuses, and a refusal is not a failure
 *
 * Bokahli serves one attested model at a time and will not substitute. When it
 * cannot serve a request it returns a *typed* answer — `ESCALATE` with a reason,
 * or `REFUSED` — with HTTP 200, because the API did its job. That is not an
 * error in the sense the fallback chain means: nothing was broken, nothing will
 * be fixed by retrying, and the local deployment is working exactly as designed.
 *
 * The distinction matters because of where the chain goes next. `escalate()`
 * marks these as non-retriable and, through `BokahliEscalation`, as
 * `terminatesChain` — so a local refusal does not quietly become a paid API call
 * the operator never asked for. The point is not that remote inference is
 * forbidden; it is that falling back to it must be a decision, taken with the
 * reason in hand, rather than the default behaviour of a loop.
 *
 * `RUNTIME_UNHEALTHY` is the exception. It carries `retryableLocal` and means
 * the runtime is temporarily down rather than unwilling, so it behaves like an
 * ordinary transient provider failure and the chain continues.
 *
 * ## The token never goes near a process listing
 *
 * It is read from a mode-0600 file at construction and held in a closure. Not
 * an argv element, not an environment variable, not a config value that gets
 * serialised into a receipt. `assertPrivateKeyFile` refuses to read a file that
 * is group- or world-readable rather than reading it and warning, because a
 * warning about a leaked credential arrives after the leak.
 *
 * Everything that leaves this module — errors, logs, attempt records — carries
 * the escalation reason and never the token or the artifact's filesystem path.
 */

import { statSync, readFileSync } from "node:fs";
import type { ModelProvider } from "../contract.js";
import { ProviderError } from "../contract.js";
import { type FetchLike, OpenAICompatibleProvider } from "./openai-compatible.js";

export const BOKAHLI_PROVIDER_ID = "bokahli";

/** Default loopback endpoint. Bokahli also binds a tailnet address; loopback is preferred locally. */
export const BOKAHLI_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";

/** Where the API token lives on a Mushin-like host. Mode 0600, never in Git. */
export const BOKAHLI_DEFAULT_TOKEN_FILE = ".config/bokahli/token";

/**
 * Escalation reasons from `bokahli.client/1`.
 *
 * Pinned here as data rather than imported, because ikbi must not take a build
 * dependency on the Bokahli monorepo to talk to it over HTTP. The contract is
 * the wire format; this list is checked against a live deployment by
 * `bokahli.integration.test.ts`, which is what keeps the copy honest.
 */
export const BOKAHLI_ESCALATE_REASONS = [
  "NO_LOCAL_CANDIDATES",
  "NO_QUALIFIED_LOCAL_ROUTE",
  "REQUIREMENTS_UNMET",
  "CONTEXT_EXCEEDS_LOCAL_CAPABILITY",
  "CAPABILITY_UNSUPPORTED",
  "MODEL_NOT_QUALIFIED_FOR_TASK",
  "LOCAL_MODEL_SWAP_REQUIRED",
  "RUNTIME_UNHEALTHY",
] as const;

export type BokahliEscalateReason = (typeof BOKAHLI_ESCALATE_REASONS)[number];

/**
 * A local deployment declining to serve, as a typed error.
 *
 * `terminatesChain` is the field the invoker reads. It is true for every reason
 * except `RUNTIME_UNHEALTHY`: the others describe a *decision* Bokahli made
 * about what it is willing to serve, and no amount of falling through to other
 * providers addresses the thing the operator would want to know. Continuing to
 * a paid provider on the back of one is the specific behaviour this integration
 * exists to prevent.
 */
export class BokahliEscalation extends ProviderError {
  readonly reason: BokahliEscalateReason | "UNKNOWN";
  readonly detail: string;
  readonly terminatesChain: boolean;
  /** Artifacts that would satisfy the request, when the reason is a swap. */
  readonly swapCandidates: readonly { modelId: string; coldLoadSeconds: number | null }[];

  constructor(opts: {
    reason: BokahliEscalateReason | "UNKNOWN";
    detail: string;
    swapCandidates?: readonly { modelId: string; coldLoadSeconds: number | null }[];
  }) {
    const retryable = opts.reason === "RUNTIME_UNHEALTHY";
    // "http" when the runtime is merely down — that is a transient condition the
    // retry machinery already knows how to handle. "config" otherwise, because a
    // refusal is a statement about how this deployment is set up (what is
    // installed, what is qualified, what is loaded) and never a transport fault.
    // Neither is "bad_response": Bokahli's answer is well-formed and correct.
    super(`bokahli declined: ${opts.reason} — ${opts.detail}`, {
      kind: retryable ? "http" : "config",
      provider: BOKAHLI_PROVIDER_ID,
      retriable: retryable,
    });
    this.name = "BokahliEscalation";
    this.reason = opts.reason;
    this.detail = opts.detail;
    this.terminatesChain = !retryable;
    this.swapCandidates = opts.swapCandidates ?? [];
  }
}

/**
 * Read a credential, refusing anything readable by more than its owner.
 *
 * Checked before the read rather than after. A warning about a group-readable
 * secret is issued once the secret has already been loaded into a process that
 * will go on to use it; refusing means the deployment is fixed before it runs.
 */
export function assertPrivateKeyFile(path: string): string {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (cause) {
    throw new Error(
      `bokahli token file is not readable at ${path}. Create it with mode 0600, ` +
        "or set the token file path explicitly.",
      { cause },
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `bokahli token file ${path} has mode ${mode.toString(8).padStart(4, "0")}; ` +
        "it must not be readable by group or others. Run: chmod 600 " +
        path,
    );
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length === 0) throw new Error(`bokahli token file ${path} is empty`);
  return token;
}

/**
 * Classify a Bokahli response body.
 *
 * Returns an escalation when the body is one, and `null` when it is an ordinary
 * completion. Bokahli's OpenAI-dialect endpoint answers a declined request with
 * a typed error object rather than a choices array, so the shape is the signal.
 */
export function readEscalation(body: unknown): BokahliEscalation | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  const route = typeof b["route"] === "object" && b["route"] !== null
    ? (b["route"] as Record<string, unknown>)
    : null;
  const outcome = typeof b["outcome"] === "string" ? b["outcome"] : null;

  // Native dialect: { outcome: "ESCALATE" | "REFUSED", route: { reason, detail } }
  if (outcome === "ESCALATE" || outcome === "REFUSED") {
    const reason = route !== null && typeof route["reason"] === "string"
      ? (route["reason"] as string)
      : "UNKNOWN";
    const detail = route !== null && typeof route["detail"] === "string"
      ? (route["detail"] as string)
      : outcome;
    const swap = route !== null && typeof route["swap"] === "object" && route["swap"] !== null
      ? (route["swap"] as Record<string, unknown>)
      : null;
    const candidates = Array.isArray(swap?.["candidates"])
      ? (swap["candidates"] as Record<string, unknown>[]).map((c) => ({
          modelId: String(c["modelId"] ?? ""),
          coldLoadSeconds: typeof c["coldLoadSeconds"] === "number" ? c["coldLoadSeconds"] : null,
        }))
      : [];
    return new BokahliEscalation({
      reason: (BOKAHLI_ESCALATE_REASONS as readonly string[]).includes(reason)
        ? (reason as BokahliEscalateReason)
        : "UNKNOWN",
      detail,
      swapCandidates: candidates,
    });
  }

  // OpenAI dialect: { error: { code, message } } where code is an escalation reason.
  const err = typeof b["error"] === "object" && b["error"] !== null
    ? (b["error"] as Record<string, unknown>)
    : null;
  if (err !== null && typeof err["code"] === "string") {
    const code = err["code"] as string;
    if ((BOKAHLI_ESCALATE_REASONS as readonly string[]).includes(code)) {
      return new BokahliEscalation({
        reason: code as BokahliEscalateReason,
        detail: typeof err["message"] === "string" ? (err["message"] as string) : code,
      });
    }
  }

  return null;
}

export interface BokahliProviderConfig {
  /** Defaults to loopback. A tailnet address is valid for a remote Mushin. */
  readonly baseUrl?: string;
  /** Absolute path to the mode-0600 token file. */
  readonly tokenFile: string;
  readonly fetchImpl?: FetchLike;
}

/**
 * Build the Bokahli provider.
 *
 * The token is read once, here, and never stored anywhere that gets serialised.
 * A missing or over-permissive token file throws at construction rather than at
 * first use, so a misconfigured deployment fails while someone is looking at it.
 */
export function createBokahliProvider(cfg: BokahliProviderConfig): ModelProvider {
  const apiKey = assertPrivateKeyFile(cfg.tokenFile);
  const inner = new OpenAICompatibleProvider({
    id: BOKAHLI_PROVIDER_ID,
    baseUrl: cfg.baseUrl ?? BOKAHLI_DEFAULT_BASE_URL,
    apiKey,
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  });

  // Wrap rather than subclass: the transport hardening, retry semantics and
  // streaming accumulation are all in OpenAICompatibleProvider and should stay
  // shared. The only Bokahli-specific behaviour is recognising a typed refusal
  // in an otherwise successful response.
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "invoke" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          const escalation = readEscalation(result);
          if (escalation !== null) throw escalation;
          return result;
        } catch (e) {
          if (e instanceof BokahliEscalation) throw e;
          // A transport-level failure that still carried a typed body — Bokahli
          // returns 503 with a reason when the runtime is down — is reclassified
          // so the reason survives into the attempt record.
          if (e instanceof ProviderError && e.provider === BOKAHLI_PROVIDER_ID) {
            const fromBody = readEscalation((e as unknown as { body?: unknown }).body);
            if (fromBody !== null) throw fromBody;
          }
          throw e;
        }
      };
    },
  }) as ModelProvider;
}
