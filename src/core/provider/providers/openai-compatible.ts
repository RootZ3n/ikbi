/**
 * ikbi provider layer — OpenAI-compatible HTTP provider.
 *
 * Both mimo direct and OpenRouter expose an OpenAI-compatible
 * `POST {baseUrl}/chat/completions` surface, so a single hardened client backs
 * both (they differ only in base URL, auth, and attribution headers).
 *
 * Hardening:
 *  - Provider JSON is runtime-validated (usage numbers, tool-call shapes, choice
 *    structure) before anything enters accounting/contract — malformed input
 *    yields a clean `bad_response` error, never garbage.
 *  - Provider-controlled error bodies are sanitized (length-bounded, control
 *    chars stripped) before entering error messages / the audit trail.
 *  - Network I/O goes through an injectable `fetch` so tests never hit the wire.
 */

import type {
  ContentPart,
  FinishReason,
  ModelMessage,
  ModelProvider,
  ProviderInvocation,
  ProviderResult,
  ToolCall,
  TokenUsage,
} from "../contract.js";
import { ProviderError } from "../contract.js";
import { resolveFetchGuard } from "../fetch-guard.js";

/** Minimal fetch signature we depend on (matches the global `fetch`). */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect?: "follow" | "error" | "manual";
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface OpenAICompatibleOptions {
  /** Provider id, e.g. "mimo" or "openrouter". */
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  /** Extra static headers (e.g. OpenRouter attribution). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Injectable fetch (defaults to global fetch). */
  readonly fetchImpl?: FetchLike;
  /** Max length for sanitized provider error detail. */
  readonly maxErrorDetail?: number;
  /**
   * KEYLESS endpoint (e.g. a local Ollama that ignores auth): skip the API-key
   * requirement and send NO Authorization header. DEFAULT false — every keyed provider
   * is unchanged. An implementation option only; the frozen ModelProvider contract is
   * untouched.
   */
  readonly keyless?: boolean;
  /**
   * Provider-specific params merged into the request body for endpoints that are
   * OpenAI-shaped but not OpenAI-compatible (e.g. direct MiMo's `thinking`). Merged
   * UNDER the engine-controlled fields — it can ADD keys but NEVER clobbers `model`
   * or `messages` (those are always authoritative). DEFAULT none — keyed providers
   * unchanged. An impl option only; the frozen ModelRequest contract is untouched.
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  /**
   * The body field name carrying the token limit. DEFAULT "max_tokens" (the OpenAI
   * standard — unchanged for every existing endpoint). Direct MiMo requires
   * "max_completion_tokens"; its roster sets this so the limit goes out under the
   * right key WITHOUT a global behavior change that could break a max_tokens-only
   * endpoint. The `maxTokens` VALUE still flows from ModelRequest into this field.
   */
  readonly tokenFieldName?: "max_tokens" | "max_completion_tokens";
}

const DEFAULT_MAX_ERROR_DETAIL = 300;

/** Cap on a server-requested backoff we will honor (a hostile/absurd value can't wedge us). */
const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Parse an HTTP `Retry-After` header into milliseconds. Supports the delta-seconds form
 * (`"5"`) and the HTTP-date form (`"Wed, 21 Oct 2025 07:28:00 GMT"`). Returns undefined for
 * an absent/unparseable/non-positive value. Clamped to MAX_RETRY_AFTER_MS.
 */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  const delta = when - nowMs;
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : undefined;
}

/** Strip control chars (incl. newlines) and bound length — provider bodies are untrusted. */
function sanitizeDetail(raw: string, max: number): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop C0 controls (incl. \n, \r, \t) and DEL.
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

function mapFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case "stop":
    case "length":
    case "content_filter":
      return raw;
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    default:
      return "unknown";
  }
}

/** Map ContentPart[] to plain wire objects (the OpenAI multimodal content array). */
function toWireParts(parts: readonly ContentPart[]): Array<Record<string, unknown>> {
  return parts.map((p) =>
    p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: p.image_url.url } },
  );
}

function toWireMessages(inv: ProviderInvocation): Array<Record<string, unknown>> {
  const req = inv.request;
  const messages: readonly ModelMessage[] =
    req.messages ?? (req.prompt !== undefined ? [{ role: "user", content: req.prompt }] : []);
  return messages.map((m) => {
    // MULTIMODAL: when `parts` is present and non-empty, the OpenAI wire format wants the
    // ARRAY as `content` ([{type:"text"...},{type:"image_url"...}]). Otherwise the plain
    // string (current behavior). `content` (string) remains the flattened-text fallback.
    const partsWire = m.parts !== undefined && m.parts.length > 0 ? toWireParts(m.parts) : undefined;
    const wire: Record<string, unknown> = { role: m.role, content: partsWire ?? m.content };
    if (m.name !== undefined) wire.name = m.name;
    if (m.toolCallId !== undefined) wire.tool_call_id = m.toolCallId;
    // Assistant messages can carry prior tool calls so the tool loop round-trips.
    if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      wire.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return wire;
  });
}

function safeExtraHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "content-type") continue;
    out[name] = value;
  }
  return out;
}

// --- response validation -------------------------------------------------

function badResponse(provider: string, why: string, usage?: TokenUsage): ProviderError {
  return new ProviderError(`Invalid response from ${provider}: ${why}`, {
    kind: "bad_response",
    provider,
    retriable: false,
    ...(usage !== undefined ? { usage } : {}),
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Flatten an array-form response content into its text: concat the `text` of text parts. */
function flattenContentParts(parts: readonly unknown[]): string {
  return parts
    .map((p) => (isRecord(p) && p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .filter((t) => t.length > 0)
    .join("");
}

/** A token count must be a finite, non-negative, safe integer (or absent). */
function readCount(obj: Record<string, unknown>, key: string, provider: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isSafeInteger(v)) {
    throw badResponse(provider, `usage.${key} is not a valid token count`);
  }
  return v;
}

function parseUsage(raw: unknown, provider: string): TokenUsage {
  const u = isRecord(raw) ? raw : {};
  const promptTokens = readCount(u, "prompt_tokens", provider) ?? 0;
  const completionTokens = readCount(u, "completion_tokens", provider) ?? 0;
  const totalTokens = readCount(u, "total_tokens", provider) ?? promptTokens + completionTokens;

  let cachedTokens: number | undefined;
  const details = u.prompt_tokens_details;
  if (isRecord(details)) {
    cachedTokens = readCount(details, "cached_tokens", provider);
    if (cachedTokens !== undefined && cachedTokens > promptTokens) {
      throw badResponse(provider, "usage.cached_tokens exceeds prompt_tokens");
    }
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
  };
}

function parseToolCalls(raw: unknown, provider: string): ToolCall[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badResponse(provider, "message.tool_calls is not an array");
  return raw.map((entry, i) => {
    if (!isRecord(entry)) throw badResponse(provider, `tool_calls[${i}] is not an object`);
    const fn = entry.function;
    if (!isRecord(fn) || typeof fn.name !== "string" || fn.name.length === 0) {
      throw badResponse(provider, `tool_calls[${i}].function.name is missing`);
    }
    const args = fn.arguments;
    if (args !== undefined && typeof args !== "string") {
      throw badResponse(provider, `tool_calls[${i}].function.arguments must be a string`);
    }
    return {
      id: typeof entry.id === "string" ? entry.id : `call_${i}`,
      name: fn.name,
      arguments: typeof args === "string" ? args : "",
    };
  });
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly extraBody: Readonly<Record<string, unknown>>;
  private readonly tokenFieldName: "max_tokens" | "max_completion_tokens";
  private readonly fetchImpl: FetchLike;
  private readonly maxErrorDetail: number;
  private readonly keyless: boolean;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.extraHeaders = safeExtraHeaders(opts.extraHeaders ?? {});
    this.extraBody = opts.extraBody ?? {};
    this.tokenFieldName = opts.tokenFieldName ?? "max_tokens";
    this.maxErrorDetail = opts.maxErrorDetail ?? DEFAULT_MAX_ERROR_DETAIL;
    this.keyless = opts.keyless ?? false;
    // Outbound HTTP is gated by the network-egress floor (the fetch-guard seam).
    // An explicit fetchImpl (tests) still wins; absent one, we resolve the
    // process-wide GUARDED fetch — FAIL-CLOSED: resolveFetchGuard() throws
    // EgressGuardMissingError if the egress floor has not loaded. We NEVER fall
    // back to raw globalThis.fetch, so no provider can reach the network un-guarded.
    // This is the single chokepoint every construction site flows through.
    this.fetchImpl = opts.fetchImpl ?? resolveFetchGuard();
  }

  async invoke(inv: ProviderInvocation): Promise<ProviderResult> {
    // A KEYLESS provider (local Ollama et al.) needs no key; a keyed one fails closed.
    if (!this.keyless && (this.apiKey === undefined || this.apiKey.length === 0)) {
      throw new ProviderError(`Provider "${this.id}" has no API key configured`, {
        kind: "auth",
        provider: this.id,
        retriable: false,
      });
    }

    // extraBody is spread FIRST so the engine-controlled fields below always win —
    // it can ADD provider params (e.g. MiMo's `thinking`) but never clobber
    // model/messages (set unconditionally) or the token/temperature fields.
    const body: Record<string, unknown> = {
      ...this.extraBody,
      model: inv.providerModelId,
      messages: toWireMessages(inv),
    };
    if (inv.request.temperature !== undefined) body.temperature = inv.request.temperature;
    // The token limit goes out under the configured field name ("max_tokens" by
    // default; "max_completion_tokens" for direct MiMo). The VALUE is engine-controlled.
    if (inv.request.maxTokens !== undefined) body[this.tokenFieldName] = inv.request.maxTokens;
    if (inv.request.tools !== undefined && inv.request.tools.length > 0) {
      body.tools = inv.request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Keyless: send NO Authorization header (the endpoint ignores auth).
          ...(this.keyless ? {} : { authorization: `Bearer ${this.apiKey}` }),
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: inv.signal,
      });
    } catch (cause) {
      // A fetch abort (timeout/fallback) surfaces as an AbortError; classify as timeout.
      const aborted = inv.signal.aborted || (cause instanceof Error && cause.name === "AbortError");
      throw new ProviderError(`${aborted ? "Aborted" : "Network error"} calling ${this.id}`, {
        kind: aborted ? "timeout" : "network",
        provider: this.id,
        retriable: true,
        cause,
      });
    }

    if (!res.ok) {
      const detail = sanitizeDetail(await res.text().catch(() => ""), this.maxErrorDetail);
      const retriable = res.status >= 500 || res.status === 429;
      const retryAfterMs = retriable ? parseRetryAfter(res.headers?.get("retry-after") ?? null) : undefined;
      throw new ProviderError(`HTTP ${res.status} from ${this.id}: ${detail}`, {
        kind:
          res.status === 401 || res.status === 403
            ? "auth"
            : res.status === 429
              ? "rate_limit"
              : "http",
        provider: this.id,
        status: res.status,
        // 4xx (except 429) are permanent on this provider; 5xx/429 are retriable.
        retriable,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (cause) {
      throw new ProviderError(`Malformed JSON from ${this.id}`, {
        kind: "bad_response",
        provider: this.id,
        retriable: false,
        cause,
      });
    }

    if (!isRecord(parsed)) throw badResponse(this.id, "body is not an object");

    // Parse usage first so we can attribute it even if the rest is malformed.
    const usage = parseUsage(parsed.usage, this.id);

    const choices = parsed.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw badResponse(this.id, "no choices", usage);
    }
    const choice = choices[0];
    if (!isRecord(choice)) throw badResponse(this.id, "choices[0] is not an object", usage);
    const message = choice.message;
    if (!isRecord(message)) throw badResponse(this.id, "choices[0].message is missing", usage);

    // A response message's content is normally a string. Some multimodal-capable
    // providers may echo an ARRAY of content parts; accept that too and flatten its
    // text parts into the canonical string. Anything else is still a bad response.
    const content = message.content;
    let contentText: string;
    if (content === undefined || content === null) {
      contentText = "";
    } else if (typeof content === "string") {
      contentText = content;
    } else if (Array.isArray(content)) {
      contentText = flattenContentParts(content);
    } else {
      throw badResponse(this.id, "message.content is not a string or content array", usage);
    }
    const reasoningRaw = message.reasoning_content;
    if (reasoningRaw !== undefined && reasoningRaw !== null && typeof reasoningRaw !== "string") {
      throw badResponse(this.id, "message.reasoning_content is not a string", usage);
    }

    const toolCalls = parseToolCalls(message.tool_calls, this.id);

    const result: ProviderResult = {
      content: contentText,
      finishReason: mapFinishReason(choice.finish_reason),
      usage,
      ...(typeof reasoningRaw === "string" && reasoningRaw.length > 0 ? { reasoning: reasoningRaw } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    return result;
  }
}
