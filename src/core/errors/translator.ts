/**
 * ikbi error translation — raw errors → user-friendly messages.
 *
 * The agent loop, the REPL, and the CLI all surface failures to a human. A raw
 * `AllProvidersFailedError: ... skipped_open_circuit` or a stack trace kills trust;
 * a one-line "the model is cooling down, try again" keeps it. This module is the
 * single place that maps a thrown value to a friendly category + suggested action.
 *
 * Detection is DUCK-TYPED (by `name` + shape + message), not `instanceof`, so this
 * module stays dependency-free — it never imports the provider/core singletons and so
 * can be used from any layer without an import cycle. The typed error classes it mirrors
 * live in `core/provider/contract.ts` (ProviderError/AllProvidersFailedError/ModelNotFoundError).
 *
 * For raw OS/SYSCALL errors (EACCES/ENOENT/ENOSPC/…) — the other half of "no stack traces in
 * user output" — `translateError` falls back to the system-error catalog in `user-facing.ts`
 * whenever its own provider-shaped classification comes up empty.
 */

import { translateSystemError } from "./user-facing.js";

/** The friendly buckets a raw error is mapped into. */
export type ErrorCategory =
  | "model_timeout"
  | "circuit_open"
  | "context_overflow"
  | "tool_failure"
  | "api_key_missing"
  | "model_not_found"
  | "network"
  | "rate_limit"
  | "auth"
  | "unknown";

/** A translated, human-facing error. */
export interface FriendlyError {
  readonly category: ErrorCategory;
  /** One-line, plain-language description of what went wrong. */
  readonly message: string;
  /** A specific, actionable next step. */
  readonly suggestion: string;
  /** The raw technical message — shown only in `--verbose`, never by default. */
  readonly technical: string;
}

/** Optional context the caller knows that the error itself may not carry. */
export interface TranslateOptions {
  /** The provider involved (e.g. "anthropic"), for the API-key/network messages. */
  readonly provider?: string;
  /** The model id involved, for the model-not-found message. */
  readonly model?: string;
  /** The tool name involved, for the tool-failure message. */
  readonly tool?: string;
}

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

/** The `IKBI_<PROVIDER>_API_KEY` env var name for a provider (or a generic hint). */
function apiKeyEnvVar(provider: string | undefined): string {
  const p = provider?.trim();
  if (p === undefined || p.length === 0) return "IKBI_<PROVIDER>_API_KEY";
  return `IKBI_${p.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** The `ProviderError.kind` carried on a typed provider failure, if present. */
function providerKind(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "kind" in err) {
    const k = (err as { kind?: unknown }).kind;
    if (typeof k === "string") return k;
  }
  return undefined;
}

/** The provider name carried on a typed provider failure, if present. */
function providerOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "provider" in err) {
    const p = (err as { provider?: unknown }).provider;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return undefined;
}

/** The `attempts` array carried on an AllProvidersFailedError, if present. */
function attemptsOf(err: unknown): ReadonlyArray<{ outcome?: string; provider?: string }> {
  if (typeof err === "object" && err !== null && "attempts" in err) {
    const a = (err as { attempts?: unknown }).attempts;
    if (Array.isArray(a)) return a as ReadonlyArray<{ outcome?: string; provider?: string }>;
  }
  return [];
}

const CONTEXT_OVERFLOW_RE =
  /context (?:window|length)|context_length_exceeded|maximum context|too many tokens|prompt is too long|exceeds? .*context|reduce the length of the messages/i;
const CIRCUIT_RE = /circuit[\s_]?breaker|circuit (?:is )?open|skipped_open_circuit/i;
const API_KEY_RE = /api[\s_-]?key|missing key|no key|unauthor|invalid[\s_-]?(?:api[\s_-]?)?key|401|forbidden|authentication/i;
const TIMEOUT_RE = /timed? ?out|timeout|deadline exceeded|etimedout/i;
const NETWORK_RE = /network|econnrefused|enotfound|econnreset|eai_again|getaddrinfo|fetch failed|socket hang up|connect/i;
const RATE_LIMIT_RE = /rate[\s_-]?limit|429|too many requests|quota/i;

/**
 * Classify a thrown value into a friendly category. Detection order matters: the most
 * specific, structured signals (typed error names, attempt outcomes, ProviderError.kind)
 * are consulted BEFORE the message-regex fallbacks, so a precise classification always
 * wins over a coincidental keyword match.
 */
export function classifyError(err: unknown, opts: TranslateOptions = {}): ErrorCategory {
  const name = errName(err);
  const msg = rawMessage(err);

  // 1. Explicit tool failure (the caller knows a tool threw, or the loop wrapped it).
  if (opts.tool !== undefined || /^ERROR: tool ["']?.+["']? failed/i.test(msg)) return "tool_failure";

  // 2. Model not in roster.
  if (name === "ModelNotFoundError" || /not in the roster|model .* not found|unknown model/i.test(msg)) {
    return "model_not_found";
  }

  // 3. Whole fallback chain failed — read the per-route outcomes to find the REAL cause.
  if (name === "AllProvidersFailedError") {
    const attempts = attemptsOf(err);
    if (attempts.some((a) => a.outcome === "skipped_open_circuit")) return "circuit_open";
    if (attempts.some((a) => a.outcome === "auth")) return "api_key_missing";
    if (attempts.some((a) => a.outcome === "timeout")) return "model_timeout";
    if (attempts.some((a) => a.outcome === "rate_limit")) return "rate_limit";
    return "network";
  }

  // 4. A single typed ProviderError carries a precise `kind`.
  const kind = providerKind(err);
  if (kind !== undefined) {
    switch (kind) {
      case "timeout":
        return "model_timeout";
      case "auth":
        return "api_key_missing";
      case "network":
        return "network";
      case "rate_limit":
        return "rate_limit";
      default:
        break; // http/bad_response/config/unknown fall through to message heuristics
    }
  }

  // 5. Message-shape heuristics (untyped errors from deep in a provider SDK, etc.).
  if (CIRCUIT_RE.test(msg)) return "circuit_open";
  if (CONTEXT_OVERFLOW_RE.test(msg)) return "context_overflow";
  if (RATE_LIMIT_RE.test(msg)) return "rate_limit";
  if (TIMEOUT_RE.test(msg)) return "model_timeout";
  if (API_KEY_RE.test(msg)) return "api_key_missing";
  if (NETWORK_RE.test(msg)) return "network";

  return "unknown";
}

/**
 * Translate a thrown value into a friendly message + suggested action. Pure: it reads the
 * error and `opts`, returns a `FriendlyError`, and never logs or throws.
 */
export function translateError(err: unknown, opts: TranslateOptions = {}): FriendlyError {
  const category = classifyError(err, opts);
  const technical = rawMessage(err);
  const provider = opts.provider ?? providerOf(err);

  // Before the generic "Something went wrong", consult the OS/syscall catalog: a raw EACCES/
  // ENOENT/ENOSPC should surface its specific cause + fix, never a stack trace. Only when our
  // provider-shaped classification found nothing (category "unknown") so a real provider error
  // keeps its richer, provider-aware message.
  if (category === "unknown") {
    const sys = translateSystemError(err);
    if (sys !== undefined) return sys;
  }

  switch (category) {
    case "model_timeout":
      return {
        category,
        message: "The model took too long to respond.",
        suggestion: "Try a simpler prompt, or switch to a faster model with `ikbi models --recommend`.",
        technical,
      };
    case "circuit_open":
      return {
        category,
        message: "Too many recent failures — the system is cooling down.",
        suggestion: "Wait a moment and try again. If it persists, check your provider status or switch models with `ikbi models --recommend`.",
        technical,
      };
    case "context_overflow":
      return {
        category,
        message: "Your conversation is too long for the model's context window.",
        suggestion: "Run /compact to compress it, start a new session with `ikbi`, or branch with `ikbi repl --fork <id>`.",
        technical,
      };
    case "tool_failure":
      return {
        category,
        message: `A tool failed${opts.tool !== undefined ? `: ${opts.tool}` : ""}.`,
        suggestion: toolSuggestion(opts.tool),
        technical,
      };
    case "api_key_missing":
      return {
        category,
        message: `No API key found${provider !== undefined ? ` for ${provider}` : ""}.`,
        suggestion: `Run \`ikbi init\` to set up, or set \`${apiKeyEnvVar(provider)}\` in your environment.`,
        technical,
      };
    case "model_not_found":
      return {
        category,
        message: `Model${opts.model !== undefined ? ` '${opts.model}'` : ""} not found.`,
        suggestion: "Run `ikbi models --recommend` to see available models, or `ikbi models` for the full roster.",
        technical,
      };
    case "rate_limit":
      return {
        category,
        message: `The provider${provider !== undefined ? ` (${provider})` : ""} is rate-limiting requests.`,
        suggestion: "Wait a moment and try again, or switch to another provider with `ikbi models --recommend`.",
        technical,
      };
    case "network":
      return {
        category,
        message: "Could not reach the model provider.",
        suggestion: "Check your internet connection and API key, then try again.",
        technical,
      };
    case "auth":
      return {
        category,
        message: `Authentication failed${provider !== undefined ? ` for ${provider}` : ""}.`,
        suggestion: `Check that \`${apiKeyEnvVar(provider)}\` is set correctly, or run \`ikbi init\`.`,
        technical,
      };
    case "unknown":
    default:
      return {
        category: "unknown",
        message: "Something went wrong.",
        suggestion: "Re-run with `--verbose` for technical details, or run `ikbi doctor` to check your configuration.",
        technical,
      };
  }
}

/** A tool-specific hint for the tool-failure message. */
function toolSuggestion(tool: string | undefined): string {
  switch (tool) {
    case "terminal":
      return "The command may have failed or been blocked by policy. Check the command and your permissions.";
    case "web_search":
    case "web_extract":
      return "The site may be unreachable or not on the egress allowlist. Check your connection and allowlist.";
    case "read_file":
    case "write_file":
    case "patch":
    case "multi_edit":
      return "The file may not exist or be outside the workspace. Check the path.";
    case "run_checks":
      return "The project's checks could not run. Ensure dependencies are installed (`ikbi doctor --fix`).";
    default:
      return "Check the tool's inputs and try again; re-run with `--verbose` for details.";
  }
}

/**
 * Render a `FriendlyError` for terminal display. Default form is two lines (message +
 * "→ suggestion"). With `verbose`, the raw technical message (and stack, if supplied)
 * is appended so an operator can still see the underlying failure.
 */
export function formatFriendlyError(fe: FriendlyError, opts: { verbose?: boolean; stack?: string } = {}): string {
  const lines = [fe.message, `  → ${fe.suggestion}`];
  if (opts.verbose === true) {
    lines.push(`  [technical] ${fe.technical}`);
    if (opts.stack !== undefined && opts.stack.length > 0) lines.push(opts.stack);
  }
  return lines.join("\n");
}
