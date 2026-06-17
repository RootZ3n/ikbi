/**
 * ikbi provider layer — Server-Sent-Events (SSE) line parser.
 *
 * OpenAI-compatible streaming endpoints reply with an SSE body: a sequence of
 *   data: {json}\n\n
 * frames, terminated by a `data: [DONE]\n\n` sentinel. The wire arrives in
 * arbitrary network-sized chunks that DO NOT align to frame boundaries, so a
 * stateful, byte-stream-tolerant parser is required: feed it whatever text just
 * arrived plus the leftover from last time, and it returns the COMPLETE `data:`
 * payloads it could extract and the unparsed remainder to carry forward.
 *
 * Pure and dependency-free — exercised directly in isolation by the tests.
 */

/** The result of parsing one buffered slice of an SSE stream. */
export interface SseParseResult {
  /**
   * The payload of every COMPLETE `data:` line found (the text after `data:`,
   * trimmed), in arrival order. This includes the `[DONE]` sentinel verbatim —
   * the caller decides what it means; everything else is a JSON chunk string.
   */
  readonly events: string[];
  /** The trailing partial line (no terminating newline yet) to prepend next call. */
  readonly rest: string;
}

/** The SSE sentinel that marks end-of-stream (no JSON follows it). */
export const SSE_DONE = "[DONE]";

/**
 * Extract the complete `data:` payloads from a buffer of SSE text. Only lines
 * terminated by `\n` are consumed; an unterminated trailing fragment is returned
 * as `rest` so a frame split across network chunks is never lost or mis-parsed.
 *
 * Per the SSE spec we ignore blank lines (event separators), comment lines (`:`),
 * and non-`data:` fields (`event:`, `id:`, `retry:`) — OpenAI uses only `data:`.
 */
export function parseSseBuffer(buffer: string): SseParseResult {
  const events: string[] = [];
  let rest = buffer;
  let nl: number;
  while ((nl = rest.indexOf("\n")) !== -1) {
    // Strip an optional CR (CRLF line endings) before consuming the line.
    const line = rest.slice(0, nl).replace(/\r$/, "");
    rest = rest.slice(nl + 1);
    const trimmed = line.trim();
    if (trimmed.length === 0) continue; // event separator / keep-alive blank line
    if (trimmed.startsWith(":")) continue; // comment / heartbeat
    if (trimmed.startsWith("data:")) {
      events.push(trimmed.slice("data:".length).trim());
    }
    // Any other SSE field (event:/id:/retry:) is irrelevant to the chat path.
  }
  return { events, rest };
}
