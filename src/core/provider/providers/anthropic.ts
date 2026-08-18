/**
 * ikbi provider layer — NATIVE Anthropic Messages API provider.
 *
 * Unlike the OpenAI-compatible shim (which POSTs `/chat/completions`), this talks
 * the real Anthropic `POST {baseUrl}/messages` surface. That unlocks the three
 * things the shim cannot express and that a frontier driver (opus) needs to behave
 * like Claude Code:
 *   - native `tool_use` / `tool_result` content blocks (full tool-loop round-trip),
 *   - a top-level `system` prompt separate from the message list,
 *   - PROMPT CACHING via `cache_control` breakpoints on the stable prefix
 *     (system prompt + tool schemas), which is the big cost/latency lever.
 *
 * It implements the SAME frozen `ModelProvider` contract as every other provider,
 * so the invoker/fallback/registry are untouched — only the wire shape differs.
 * Hardening mirrors the OpenAI-compatible client: injected fetch (egress-guarded),
 * runtime-validated response JSON, sanitized untrusted error bodies.
 */

import type {
  ContentPart,
  FinishReason,
  ModelMessage,
  ModelProvider,
  ModelStream,
  ProviderInvocation,
  ProviderResult,
  StreamDelta,
  ToolCall,
  ToolCallDelta,
  TokenUsage,
} from "../contract.js";
import { ProviderError } from "../contract.js";
import { resolveFetchGuard } from "../fetch-guard.js";
import { type FetchLike, parseRetryAfter } from "./openai-compatible.js";
import { parseSseBuffer } from "./sse-parse.js";

/** Anthropic API version pinned on every request (the `anthropic-version` header). */
const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic requires `max_tokens`; use this when the request does not set one. */
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_ERROR_DETAIL = 300;

export interface AnthropicOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly fetchImpl?: FetchLike;
  readonly maxErrorDetail?: number;
  /** Override the pinned API version (tests / forward-compat). */
  readonly anthropicVersion?: string;
  /**
   * Incrementally cache the CONVERSATION prefix (not just system + tools) by marking a
   * cache breakpoint on the last message of each request. Each turn/tool-round then reuses
   * the previous request's message prefix at the cheap cache-read rate — the big lever for
   * long agentic sessions. Default ON; disable via the constructor or IKBI_ANTHROPIC_CONVERSATION_CACHE=0.
   */
  readonly conversationCache?: boolean;
  /** Non-secret provenance used by local provider preflight. */
  readonly credentialSource?: string;
  /** Non-secret provenance used by local provider preflight. */
  readonly configurationSource?: string;
}

/** Anthropic's minimum cacheable prefix; a breakpoint below this is ignored by the API (no charge).
 *  We still gate the conversation breakpoint on message COUNT so single-shot prompts are byte-unchanged. */
const CONVERSATION_CACHE_MIN_MESSAGES = 2;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Strip control chars and bound length — provider error bodies are untrusted. */
function sanitizeDetail(raw: string, max: number): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

function badResponse(provider: string, why: string, usage?: TokenUsage): ProviderError {
  return new ProviderError(`Invalid response from ${provider}: ${why}`, {
    kind: "bad_response",
    provider,
    retriable: false,
    ...(usage !== undefined ? { usage } : {}),
  });
}

/** Map an Anthropic `stop_reason` to the frozen FinishReason vocabulary. */
function mapStopReason(raw: unknown): FinishReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    // `pause_turn` is emitted ONLY when Anthropic pauses a long-running turn that uses SERVER-SIDE
    // tools (web_search_20250305, code_execution, computer_use, …). ikbi never sends those — every
    // ikbi tool is a CLIENT-SIDE custom tool — so pause_turn is unreachable on this wire. Should it
    // ever appear, mapping it to "stop" is the safe degradation: the turn ends cleanly with whatever
    // content accumulated (no crash, no orphaned tool_use). We deliberately do NOT widen the frozen
    // FinishReason vocabulary with a dedicated "continue" state for a path this client cannot trigger.
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return raw === null || raw === undefined ? "unknown" : "unknown";
  }
}

/**
 * Map Anthropic usage to the frozen TokenUsage. Anthropic reports `input_tokens`
 * EXCLUSIVE of cached tokens, so promptTokens is the sum of the fresh input plus
 * the cache-read and cache-creation counts; `cachedTokens` is the cache-READ
 * portion (served at the cheap rate). This keeps `cachedTokens <= promptTokens`,
 * as the contract requires.
 */
function mapUsage(raw: unknown): TokenUsage {
  const u = isRecord(raw) ? raw : {};
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheCreate = num(u.cache_creation_input_tokens);
  const promptTokens = input + cacheRead + cacheCreate;
  return {
    promptTokens,
    completionTokens: output,
    totalTokens: promptTokens + output,
    ...(cacheRead > 0 ? { cachedTokens: cacheRead } : {}),
  };
}

/** An ephemeral cache breakpoint — marks the end of a cacheable prefix. */
const CACHE_CONTROL = { type: "ephemeral" } as const;

/** Convert one multimodal ContentPart to an Anthropic content block. */
function partToBlock(p: ContentPart): Record<string, unknown> {
  if (p.type === "text") return { type: "text", text: p.text };
  const url = p.image_url.url;
  const dataMatch = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (dataMatch !== null) {
    return { type: "image", source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] } };
  }
  return { type: "image", source: { type: "url", url } };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
}

/**
 * Split ModelMessage[] into the top-level `system` blocks and the Anthropic
 * `messages` array. System messages are hoisted out; `tool`-role results become
 * `tool_result` blocks inside a user turn; assistant `toolCalls` become `tool_use`
 * blocks. Adjacent same-role turns are merged (Anthropic wants one user turn to
 * carry all tool_results answering the prior assistant turn).
 */
function toAnthropicPayload(messages: readonly ModelMessage[]): {
  system: Array<Record<string, unknown>>;
  messages: AnthropicMessage[];
} {
  let systemText = "";
  const mapped: AnthropicMessage[] = [];

  const pushMerged = (role: "user" | "assistant", blocks: Array<Record<string, unknown>>): void => {
    if (blocks.length === 0) return;
    const last = mapped[mapped.length - 1];
    if (last !== undefined && last.role === role) {
      last.content.push(...blocks);
    } else {
      mapped.push({ role, content: blocks });
    }
  };

  for (const m of messages) {
    if (m.role === "system") {
      systemText += (systemText.length > 0 ? "\n\n" : "") + m.content;
      continue;
    }
    if (m.role === "tool") {
      pushMerged("user", [
        {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.content,
          // Propagate a FAILED tool into the native error channel so the model can tell a real
          // failure from error-shaped prose. Only emitted when the caller marked it (default omitted).
          ...(m.isError === true ? { is_error: true } : {}),
        },
      ]);
      continue;
    }
    if (m.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      // EXTENDED THINKING ROUND-TRIP: when this assistant turn reasoned, Anthropic requires the signed
      // `thinking` block be replayed VERBATIM and FIRST (before text/tool_use) so the model can resume a
      // tool-using turn. Only emitted when BOTH the text and its signature survived (an unsigned block
      // would be rejected). The text is the model's own output, carried un-neutralized to stay byte-exact.
      if (typeof m.reasoning === "string" && m.reasoning.length > 0 && typeof m.reasoningSignature === "string" && m.reasoningSignature.length > 0) {
        blocks.push({ type: "thinking", thinking: m.reasoning, signature: m.reasoningSignature });
      }
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
      if (m.toolCalls !== undefined) {
        for (const tc of m.toolCalls) {
          // Replaying a PRIOR turn's tool call: Anthropic requires `input` to be valid JSON. If a
          // historical call's arguments are unparseable, {} is the only safe fallback — the tool has
          // ALREADY run (this is context replay, not execution), and failing loud here would break the
          // whole conversation over stale history. Deliberate, not a silent data bug.
          let input: unknown = {};
          try {
            input = tc.arguments.length > 0 ? JSON.parse(tc.arguments) : {};
          } catch {
            input = {};
          }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
      }
      pushMerged("assistant", blocks);
      continue;
    }
    // user
    const blocks =
      m.parts !== undefined && m.parts.length > 0
        ? m.parts.map(partToBlock)
        : [{ type: "text", text: m.content }];
    pushMerged("user", blocks);
  }

  const system: Array<Record<string, unknown>> =
    systemText.length > 0 ? [{ type: "text", text: systemText, cache_control: CACHE_CONTROL }] : [];
  return { system, messages: mapped };
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly maxErrorDetail: number;
  private readonly anthropicVersion: string;
  private readonly conversationCache: boolean;
  private readonly credentialSource: string | undefined;
  private readonly configurationSource: string | undefined;

  constructor(opts: AnthropicOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.maxErrorDetail = opts.maxErrorDetail ?? DEFAULT_MAX_ERROR_DETAIL;
    this.anthropicVersion = opts.anthropicVersion ?? ANTHROPIC_VERSION;
    this.credentialSource = opts.credentialSource;
    this.configurationSource = opts.configurationSource;
    // Default ON; an explicit constructor value wins, else the env kill-switch, else true.
    this.conversationCache =
      opts.conversationCache ?? process.env.IKBI_ANTHROPIC_CONVERSATION_CACHE !== "0";
    // Same fail-closed egress chokepoint as every other provider: an explicit
    // fetchImpl (tests) wins; otherwise resolve the process-wide guarded fetch,
    // which throws if the egress floor has not loaded. Never raw globalThis.fetch.
    this.fetchImpl = opts.fetchImpl ?? resolveFetchGuard();
  }

  /** USABLE iff an API key is configured (the native Anthropic adapter is never keyless). */
  ready(): boolean {
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  preflightInfo() {
    return {
      kind: "anthropic" as const,
      baseUrl: this.baseUrl,
      credentialRequired: true,
      credentialPresent: this.ready(),
      ...(this.credentialSource !== undefined ? { credentialSource: this.credentialSource } : {}),
      ...(this.configurationSource !== undefined ? { configurationSource: this.configurationSource } : {}),
    };
  }

  private ensureAuth(): void {
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      throw new ProviderError(`Provider "${this.id}" has no API key configured`, {
        kind: "auth",
        provider: this.id,
        retriable: false,
      });
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey ?? "",
      "anthropic-version": this.anthropicVersion,
    };
  }

  /** Build the `/messages` request body, shared by invoke + invokeStream. */
  private buildBody(inv: ProviderInvocation, stream: boolean): Record<string, unknown> {
    const req = inv.request;
    const src: readonly ModelMessage[] =
      req.messages ?? (req.prompt !== undefined ? [{ role: "user", content: req.prompt }] : []);
    const { system, messages } = toAnthropicPayload(src);

    // INCREMENTAL CONVERSATION CACHE: mark the last message so this request's whole message prefix is
    // cached; the next request (next tool-round / next turn) reads it back cheaply. Gated on a real
    // multi-message conversation so single-shot prompts stay byte-identical. This is separate from the
    // system + tool-schema breakpoints (a stable prefix) — together up to 3 of Anthropic's 4 allowed.
    if (this.conversationCache && messages.length >= CONVERSATION_CACHE_MIN_MESSAGES) {
      const lastMsg = messages[messages.length - 1];
      const lastBlock = lastMsg?.content[lastMsg.content.length - 1];
      if (lastBlock !== undefined) lastBlock.cache_control = CACHE_CONTROL;
    }

    // EXTENDED THINKING (opt-in): enable the reasoning budget. Anthropic requires max_tokens > budget
    // and forbids a custom temperature while thinking, so we bump max_tokens above the budget and drop
    // temperature. A non-positive/absent budget leaves the request byte-identical to the non-thinking path.
    const thinkingBudget =
      req.thinking !== undefined && Number.isInteger(req.thinking.budgetTokens) && req.thinking.budgetTokens > 0
        ? req.thinking.budgetTokens
        : 0;
    let maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (thinkingBudget > 0 && maxTokens <= thinkingBudget) maxTokens = thinkingBudget + DEFAULT_MAX_TOKENS;

    const body: Record<string, unknown> = {
      model: inv.providerModelId,
      max_tokens: maxTokens,
      messages,
    };
    if (system.length > 0) body.system = system;
    // Temperature is incompatible with thinking; only send it when thinking is off.
    if (req.temperature !== undefined && thinkingBudget === 0) body.temperature = req.temperature;
    if (thinkingBudget > 0) body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
    if (req.tools !== undefined && req.tools.length > 0) {
      const tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      // Cache the tool schemas: a breakpoint on the LAST tool caches the whole
      // tool block + the system prefix before it — the largest stable prefix,
      // identical every turn. This is the primary caching win.
      const last = tools[tools.length - 1];
      if (last !== undefined) (last as Record<string, unknown>).cache_control = CACHE_CONTROL;
      body.tools = tools;
    }
    if (stream) body.stream = true;
    return body;
  }

  private async toHttpError(res: Awaited<ReturnType<FetchLike>>): Promise<ProviderError> {
    const detail = sanitizeDetail(await res.text().catch(() => ""), this.maxErrorDetail);
    const retriable = res.status >= 500 || res.status === 429;
    const retryAfterMs = retriable ? parseRetryAfter(res.headers?.get("retry-after") ?? null) : undefined;
    return new ProviderError(`HTTP ${res.status} from ${this.id}: ${detail}`, {
      kind: res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limit" : "http",
      provider: this.id,
      status: res.status,
      retriable,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  private async post(inv: ProviderInvocation, stream: boolean): Promise<Awaited<ReturnType<FetchLike>>> {
    try {
      return await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildBody(inv, stream)),
        signal: inv.signal,
      });
    } catch (cause) {
      const aborted = inv.signal.aborted || (cause instanceof Error && cause.name === "AbortError");
      throw new ProviderError(`${aborted ? "Aborted" : "Network error"} calling ${this.id}`, {
        kind: aborted ? "timeout" : "network",
        provider: this.id,
        retriable: true,
        cause,
      });
    }
  }

  async invoke(inv: ProviderInvocation): Promise<ProviderResult> {
    this.ensureAuth();
    const res = await this.post(inv, false);
    if (!res.ok) throw await this.toHttpError(res);

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

    const usage = mapUsage(parsed.usage);
    const contentBlocks = parsed.content;
    if (!Array.isArray(contentBlocks)) throw badResponse(this.id, "content is not an array", usage);

    let contentText = "";
    let reasoningText = "";
    let reasoningSignature: string | undefined;
    const toolCalls: ToolCall[] = [];
    for (const block of contentBlocks) {
      if (!isRecord(block)) continue;
      if (block.type === "thinking") {
        if (typeof block.thinking === "string") reasoningText += block.thinking;
        if (typeof block.signature === "string") reasoningSignature = block.signature;
      } else if (block.type === "text" && typeof block.text === "string") {
        contentText += block.text;
      } else if (block.type === "tool_use") {
        if (typeof block.name !== "string" || block.name.length === 0) {
          throw badResponse(this.id, "tool_use block has no name", usage);
        }
        toolCalls.push({
          id: typeof block.id === "string" ? block.id : `call_${toolCalls.length}`,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }

    // SERVED IDENTITY: verbatim from the response, and only when present. Anthropic
    // echoes the resolved model on `/messages` responses. Never defaulted to what we
    // sent — see the field's note on ProviderResult.
    const servedModelId = typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : undefined;

    const result: ProviderResult = {
      content: contentText,
      finishReason: mapStopReason(parsed.stop_reason),
      usage,
      ...(servedModelId !== undefined ? { servedModelId } : {}),
      ...(reasoningText.length > 0 ? { reasoning: reasoningText } : {}),
      ...(reasoningSignature !== undefined ? { reasoningSignature } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    return result;
  }

  async invokeStream(inv: ProviderInvocation): Promise<ModelStream> {
    this.ensureAuth();
    const res = await this.post(inv, true);
    if (!res.ok) throw await this.toHttpError(res);
    const stream = res.body;
    if (stream === undefined || stream === null) {
      throw badResponse(this.id, "streaming response has no readable body");
    }
    return this.readSse(stream);
  }

  /**
   * Translate Anthropic's typed SSE events into the provider-neutral StreamDelta
   * stream. Anthropic streams a block at a time: `content_block_start` opens a
   * text or tool_use block, `content_block_delta` carries `text_delta` /
   * `input_json_delta` fragments, `message_delta` carries the terminal
   * stop_reason + output usage, and `message_start` carries the input usage.
   * Tool-use blocks are re-indexed to a dense 0-based tool-call index so the
   * consumer's StreamAccumulator assembles them exactly as for OpenAI.
   */
  private async *readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<StreamDelta> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Anthropic content-block index -> dense tool-call index (only for tool_use blocks).
    const toolIndexByBlock = new Map<number, number>();
    let nextToolIndex = 0;
    let inputUsage: TokenUsage | undefined;

    const parse = (payload: string): unknown => {
      try {
        return JSON.parse(payload);
      } catch (cause) {
        throw new ProviderError(`Malformed SSE chunk from ${this.id}`, {
          kind: "bad_response",
          provider: this.id,
          retriable: false,
          cause,
        });
      }
    };

    const toDelta = (ev: unknown): StreamDelta | undefined => {
      if (!isRecord(ev)) return undefined;
      switch (ev.type) {
        case "message_start": {
          const msg = isRecord(ev.message) ? ev.message : {};
          inputUsage = mapUsage(msg.usage);
          return undefined;
        }
        case "content_block_start": {
          const idx = typeof ev.index === "number" ? ev.index : 0;
          const block = isRecord(ev.content_block) ? ev.content_block : {};
          if (block.type === "tool_use") {
            const toolIndex = nextToolIndex++;
            toolIndexByBlock.set(idx, toolIndex);
            const d: ToolCallDelta = {
              index: toolIndex,
              ...(typeof block.id === "string" ? { id: block.id } : {}),
              ...(typeof block.name === "string" ? { name: block.name } : {}),
              arguments: "",
            };
            return { toolCalls: [d] };
          }
          return undefined;
        }
        case "content_block_delta": {
          const idx = typeof ev.index === "number" ? ev.index : 0;
          const delta = isRecord(ev.delta) ? ev.delta : {};
          if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
            return { content: delta.text };
          }
          // Extended thinking streams as `thinking_delta` (text) then a final `signature_delta`.
          if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
            return { reasoning: delta.thinking };
          }
          if (delta.type === "signature_delta" && typeof delta.signature === "string" && delta.signature.length > 0) {
            return { reasoningSignature: delta.signature };
          }
          if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const toolIndex = toolIndexByBlock.get(idx) ?? idx;
            return { toolCalls: [{ index: toolIndex, arguments: delta.partial_json }] };
          }
          return undefined;
        }
        case "message_delta": {
          const delta = isRecord(ev.delta) ? ev.delta : {};
          const out: { finishReason?: FinishReason; usage?: TokenUsage } = {};
          if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
            out.finishReason = mapStopReason(delta.stop_reason);
          }
          // message_delta.usage carries the (cumulative) output_tokens; combine with
          // the input usage captured at message_start for the full accounting.
          if (isRecord(ev.usage)) {
            const outUsage = mapUsage(ev.usage);
            const promptTokens = inputUsage?.promptTokens ?? 0;
            const cachedTokens = inputUsage?.cachedTokens;
            out.usage = {
              promptTokens,
              completionTokens: outUsage.completionTokens,
              totalTokens: promptTokens + outUsage.completionTokens,
              ...(cachedTokens !== undefined ? { cachedTokens } : {}),
            };
          }
          return Object.keys(out).length > 0 ? out : undefined;
        }
        case "error": {
          const err = isRecord(ev.error) ? ev.error : {};
          const msg = typeof err.message === "string" ? sanitizeDetail(err.message, this.maxErrorDetail) : "stream error";
          throw new ProviderError(`Anthropic stream error from ${this.id}: ${msg}`, {
            kind: "bad_response",
            provider: this.id,
            retriable: false,
          });
        }
        default:
          return undefined;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseBuffer(buffer);
        buffer = rest;
        for (const ev of events) {
          const delta = toDelta(parse(ev));
          if (delta !== undefined) yield delta;
        }
      }
      // Flush any remaining buffered content (tail without trailing newline).
      if (buffer.length > 0) {
        const { events } = parseSseBuffer(buffer);
        for (const ev of events) {
          const delta = toDelta(parse(ev));
          if (delta !== undefined) yield delta;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* best-effort */
      }
    }
  }
}
