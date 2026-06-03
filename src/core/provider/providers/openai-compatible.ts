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
  FinishReason,
  ModelMessage,
  ModelProvider,
  ProviderInvocation,
  ProviderResult,
  ToolCall,
  TokenUsage,
} from "../contract.js";
import { ProviderError } from "../contract.js";

/** Minimal fetch signature we depend on (matches the global `fetch`). */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
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
}

const DEFAULT_MAX_ERROR_DETAIL = 300;

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

function toWireMessages(inv: ProviderInvocation): Array<Record<string, unknown>> {
  const req = inv.request;
  const messages: readonly ModelMessage[] =
    req.messages ?? (req.prompt !== undefined ? [{ role: "user", content: req.prompt }] : []);
  return messages.map((m) => {
    const wire: Record<string, unknown> = { role: m.role, content: m.content };
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
  private readonly fetchImpl: FetchLike;
  private readonly maxErrorDetail: number;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.maxErrorDetail = opts.maxErrorDetail ?? DEFAULT_MAX_ERROR_DETAIL;
    const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (f === undefined) {
      throw new ProviderError("No fetch implementation available", {
        kind: "config",
        provider: opts.id,
        retriable: false,
      });
    }
    this.fetchImpl = f;
  }

  async invoke(inv: ProviderInvocation): Promise<ProviderResult> {
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      throw new ProviderError(`Provider "${this.id}" has no API key configured`, {
        kind: "auth",
        provider: this.id,
        retriable: false,
      });
    }

    const body: Record<string, unknown> = {
      model: inv.providerModelId,
      messages: toWireMessages(inv),
    };
    if (inv.request.temperature !== undefined) body.temperature = inv.request.temperature;
    if (inv.request.maxTokens !== undefined) body.max_tokens = inv.request.maxTokens;
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
          authorization: `Bearer ${this.apiKey}`,
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
        retriable: res.status >= 500 || res.status === 429,
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

    const content = message.content;
    if (content !== undefined && content !== null && typeof content !== "string") {
      throw badResponse(this.id, "message.content is not a string", usage);
    }
    const reasoningRaw = message.reasoning_content;
    if (reasoningRaw !== undefined && reasoningRaw !== null && typeof reasoningRaw !== "string") {
      throw badResponse(this.id, "message.reasoning_content is not a string", usage);
    }

    const toolCalls = parseToolCalls(message.tool_calls, this.id);

    const result: ProviderResult = {
      content: typeof content === "string" ? content : "",
      finishReason: mapFinishReason(choice.finish_reason),
      usage,
      ...(typeof reasoningRaw === "string" && reasoningRaw.length > 0 ? { reasoning: reasoningRaw } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    return result;
  }
}
