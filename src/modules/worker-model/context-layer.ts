/**
 * ikbi worker-model — CONTEXT LAYER (deterministic compression + file memory).
 *
 * A deterministic, model-agnostic context management layer that sits between the
 * orchestrator and the model API calls. It operates on the messages array BEFORE
 * sending to the model, compressing old tool results into lightweight summaries
 * while preserving the structural header, recent turns, and a running file index.
 *
 * ── HOW IT DIFFERS FROM context-manager.ts ──────────────────────────────────
 *  context-manager.ts uses the MODEL ITSELF to produce summaries (expensive, slow,
 *  requires an extra model call). This layer uses DETERMINISTIC pattern matching —
 *  no model call, no latency, no cost. The two work in tandem: this layer compresses
 *  first (cheap), and context-manager.ts handles the remaining overflow if needed.
 *
 * ── WHAT IS PRESERVED ──────────────────────────────────────────────────────
 *  - The HEADER (system prompt + goal/success-condition/prior-results blocks)
 *    is NEVER compressed — it is the task's frozen framing.
 *  - The most recent `recencyWindow` tool results are kept verbatim.
 *  - Everything else (old tool results) is compressed to one-line summaries.
 *  - A `context_index` tracks every file the builder has seen, even after
 *    compression, so compressed content is not truly "lost".
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────
 *  The layer does NOT alter the security model. It operates on already-neutralized
 *  messages (tool results enter via the neutralization chokepoint in builder.ts).
 *  Compressed messages retain their `untrusted` flag and `role` — only the content
 *  text is shortened. The layer never promotes untrusted content to trusted slots.
 */

import type { ModelMessage } from "../../core/provider/contract.js";
import { estimateMessageTokens, estimateTokens } from "./context-manager.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the context layer. Read from env or passed directly. */
export interface ContextLayerConfig {
  /** Token budget — compress when estimated tokens exceed this. Default 40000. */
  readonly tokenBudget: number;
  /** Number of most-recent tool results to keep uncompressed. Default 5. */
  readonly recencyWindow: number;
  /** Number of leading messages treated as the un-compressible header. Default 4. */
  readonly headerLen: number;
}

/** Default configuration — suitable for a ~64K context window model. */
export const DEFAULT_CONTEXT_LAYER_CONFIG: ContextLayerConfig = Object.freeze({
  tokenBudget: 40_000,
  recencyWindow: 5,
  headerLen: 4,
});

// ---------------------------------------------------------------------------
// File memory (the "context index")
// ---------------------------------------------------------------------------

/** A lightweight record of what the builder has seen for one file. */
export interface FileIndexEntry {
  /** The file path (relative to worktree). */
  readonly path: string;
  /** Message index at which this file was last encountered. */
  readonly messageIndex: number;
  /** One-line summary of what was seen (first 200 chars of content). */
  readonly summary: string;
  /** Key facts extracted from the content (line count, byte count, etc.). */
  readonly keyFacts: readonly string[];
}

// ---------------------------------------------------------------------------
// Compression result
// ---------------------------------------------------------------------------

/** Outcome of a compression pass. */
export interface CompressResult {
  /** Whether any messages were compressed. */
  readonly compressed: boolean;
  /** Estimated tokens before compression (present when compression ran). */
  readonly before?: number;
  /** Estimated tokens after compression. */
  readonly after?: number;
  /** Number of messages compressed. */
  readonly messagesCompressed?: number;
}

// ---------------------------------------------------------------------------
// Pattern matchers for tool result types
// ---------------------------------------------------------------------------

/** Recognized tool-result patterns and how to compress them. */
interface ToolPattern {
  readonly match: (content: string) => boolean;
  readonly compress: (content: string) => string;
}

/**
 * The ordered list of compression patterns. First match wins.
 * Each pattern detects a known tool-result shape and produces a one-line summary.
 * ORDER MATTERS: specific patterns must come before generic ones (list_dir before
 * read_file, write_file before generic multi-line).
 */
const TOOL_PATTERNS: readonly ToolPattern[] = [
  // write_file: "wrote N bytes to path" — must come before generic read_file
  {
    match: (c) => /^wrote \d+ bytes to .+$/.test(c),
    compress: (c) => c, // Already a one-liner, keep as-is
  },
  // patch result: typically short but can be multi-line
  {
    match: (c) => c.startsWith("Applied patch") || c.startsWith("Patch applied") || c.startsWith("[PATCH]"),
    compress: (c) => {
      const lines = c.split("\n");
      if (lines.length <= 3) return c;
      return `[COMPRESSED] Patch result (${lines.length} lines): ${lines[0]!.slice(0, 150)}`;
    },
  },
  // search_files: has match indicators (line numbers, "match", "found") — MUST come
  // before list_dir because search results also look like short-line listings
  {
    match: (c) => {
      const lower = c.toLowerCase();
      return (
        (lower.includes("match") || lower.includes("found") || /^\d+:/.test(c)) &&
        c.split("\n").length > 2
      );
    },
    compress: (c) => {
      const lines = c.split("\n");
      const matchCount = lines.filter((l) => /^\d+:/.test(l)).length;
      const fileCount = new Set(
        lines
          .filter((l) => l.includes(":"))
          .map((l) => l.split(":")[0]!)
      ).size;
      return `[COMPRESSED] Search results: ${matchCount} matches in ${fileCount} file(s)`;
    },
  },
  // list_dir: newline-separated entries — after search_files because search results
  // also have many short lines and would match list_dir.
  // Heuristic: directory entries typically end with "/" (dirs) or have file extensions,
  // and don't contain spaces in most filenames. Terminal output is more free-form.
  {
    match: (c) => {
      const lines = c.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length <= 3) return false;
      if (c.startsWith("//") || c.startsWith("import ") || c.startsWith("export ")) return false;
      if (c.includes("function ") || c.includes("const ")) return false;
      // Directory listing heuristic: most lines look like file/dir entries
      // (end with /, have a file extension, or are very short identifiers)
      const dirLike = lines.filter((l) => {
        const trimmed = l.trim();
        return (
          trimmed.endsWith("/") ||
          /\.\w{1,10}$/.test(trimmed) || // has file extension
          (trimmed.length < 30 && !trimmed.includes(" ")) // short, no spaces
        );
      }).length;
      // At least 70% of lines must look like directory entries
      return dirLike >= lines.length * 0.7;
    },
    compress: (c) => {
      const entries = c.split("\n").filter((l) => l.trim().length > 0);
      const pathHint = extractPathHint(c);
      const prefix = pathHint ? `Listed ${pathHint}` : "Directory listing";
      return `[COMPRESSED] ${prefix}: ${entries.length} entries`;
    },
  },
  // read_file: many lines of code/content — generic catch-all for multi-line tool results
  {
    match: (c) => {
      const lines = c.split("\n");
      return (
        lines.length > 5 &&
        !c.startsWith("ERROR:") &&
        !c.startsWith("wrote ") &&
        !c.startsWith("Checks ") &&
        !c.startsWith("[COMPRESSED") &&
        !c.includes("IKBI-CHECK-RESULTS") &&
        !c.includes("IKBI-HARNESS-FEEDBACK")
      );
    },
    compress: (c) => {
      const lines = c.split("\n");
      const preview = lines.slice(0, 3).join(" ").slice(0, 200);
      const pathHint = extractPathHint(c);
      const prefix = pathHint ? `Read ${pathHint}` : "File content";
      return `[COMPRESSED] ${prefix} (${lines.length} lines): ${preview}...`;
    },
  },
  // terminal: command output (multi-line, not a known short pattern)
  {
    match: (c) => {
      const lines = c.split("\n");
      return lines.length > 3 && !c.startsWith("[COMPRESSED");
    },
    compress: (c) => {
      const lines = c.split("\n");
      const preview = lines[0]!.slice(0, 100);
      return `[COMPRESSED] Command output (${lines.length} lines): ${preview}...`;
    },
  },
];

/** Try to extract a file/directory path hint from content. */
function extractPathHint(content: string): string | undefined {
  // Match "to path", "from path", "path:", or just a path-like string at the start
  const m =
    content.match(/(?:to|from|at|in)\s+([^\s\n]{3,80})/i) ??
    content.match(/^([^\s\n]{3,80})[:|]/m);
  return m?.[1];
}

// ---------------------------------------------------------------------------
// ContextLayer
// ---------------------------------------------------------------------------

/**
 * Deterministic context compression layer.
 *
 * Usage:
 *   const layer = new ContextLayer({ tokenBudget: 40000 });
 *   // In the builder loop, before invoking the model:
 *   layer.compress(messages);
 *   // After the loop, inspect memory:
 *   const index = layer.getContextIndex();
 */
export class ContextLayer {
  private readonly config: ContextLayerConfig;
  private readonly fileIndex = new Map<string, FileIndexEntry>();
  private compressions = 0;
  private totalMessagesCompressed = 0;

  constructor(config: Partial<ContextLayerConfig> = {}) {
    this.config = { ...DEFAULT_CONTEXT_LAYER_CONFIG, ...config };
  }

  /**
   * Compress old tool results in the messages array IN PLACE when the estimated
   * token count exceeds the budget. Returns a result indicating whether
   * compression occurred and the before/after token estimates.
   *
   * NEVER throws — a failure leaves messages untouched and returns
   * `{ compressed: false }`.
   */
  compress(messages: ModelMessage[]): CompressResult {
    try {
      // Always scan for index entries, even when under budget
      this.scanForIndex(messages);

      const before = estimateTokens(messages);
      if (before <= this.config.tokenBudget) {
        return { compressed: false };
      }

      const compressible = this.findCompressible(messages);
      if (compressible.length === 0) {
        return { compressed: false };
      }

      let currentTokens = before;
      let compressed = 0;

      // Compress from oldest to newest until under budget
      for (const idx of compressible) {
        if (currentTokens <= this.config.tokenBudget) break;

        const original = messages[idx]!;
        const summary = this.summarize(original);
        if (summary === null) continue; // unrecognized pattern, skip

        const originalTokens = estimateMessageTokens(original);
        const compressedMsg: ModelMessage = {
          ...original,
          content: summary,
        };
        const newTokens = estimateMessageTokens(compressedMsg);

        // Only replace if we actually save tokens
        if (newTokens >= originalTokens) continue;

        // Update the file index before replacing
        this.updateIndex(original, idx);

        // Replace in place
        messages[idx] = compressedMsg;
        currentTokens -= originalTokens - newTokens;
        compressed += 1;
      }

      if (compressed === 0) {
        return { compressed: false };
      }

      this.compressions += 1;
      this.totalMessagesCompressed += compressed;
      const after = estimateTokens(messages);
      return { compressed: true, before, after, messagesCompressed: compressed };
    } catch {
      // NEVER fail the build — leave messages untouched on any error
      return { compressed: false };
    }
  }

  /**
   * Scan the messages array and update the file index with any new file
   * information. This runs independently of compression — the index always
   * reflects what the builder has seen, whether the messages are compressed
   * or not.
   */
  scanForIndex(messages: readonly ModelMessage[]): void {
    for (let i = this.config.headerLen; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role === "tool") {
        this.updateIndex(m, i);
      }
    }
  }

  /**
   * Find indices of compressible messages: tool results that are NOT in the
   * header and NOT in the recent window. Returns indices sorted oldest-first
   * so we compress the oldest first.
   */
  private findCompressible(messages: readonly ModelMessage[]): number[] {
    const { headerLen, recencyWindow } = this.config;

    // Count tool results from the end to identify the recent window
    const recentToolIndices = new Set<number>();
    let toolCount = 0;
    for (let i = messages.length - 1; i >= headerLen; i--) {
      if (messages[i]!.role === "tool") {
        toolCount += 1;
        if (toolCount <= recencyWindow) {
          recentToolIndices.add(i);
        }
      }
    }

    // Collect compressible: old tool results not in recent window
    const result: number[] = [];
    for (let i = headerLen; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role === "tool" && !recentToolIndices.has(i)) {
        result.push(i);
      }
    }

    return result;
  }

  /**
   * Summarize a single message using deterministic pattern matching.
   * Returns null if the message doesn't match any known pattern (caller
   * should skip it).
   */
  private summarize(msg: ModelMessage): string | null {
    const content = msg.content;

    // Never compress messages that are already compressed or carry
    // actional feedback markers (these are ikbi-authored, trusted, load-bearing)
    if (
      content.startsWith("[COMPRESSED") ||
      content.includes("IKBI-CHECK-RESULTS") ||
      content.includes("IKBI-HARNESS-FEEDBACK")
    ) {
      return null;
    }

    // Try each pattern in order
    for (const pattern of TOOL_PATTERNS) {
      if (pattern.match(content)) {
        return pattern.compress(content);
      }
    }

    // Fallback: if content is long, truncate
    if (content.length > 500) {
      return `[COMPRESSED] ${content.slice(0, 200)}...`;
    }

    return null;
  }

  /**
   * Update the file index with information extracted from a tool result message.
   * This is called BEFORE the message is replaced with its compressed form,
   * so the index captures the full content.
   */
  private updateIndex(msg: ModelMessage, index: number): void {
    const content = msg.content;

    // Try to extract a path
    let path: string | undefined;
    let facts: string[] = [];

    // read_file patterns
    const readMatch = content.match(/^([^\n]{1,200})/);
    if (readMatch && !content.startsWith("ERROR:") && !content.startsWith("wrote ")) {
      const lines = content.split("\n");
      if (lines.length > 3) {
        path = extractPathHint(content);
        facts = [`${lines.length} lines`, `${content.length} chars`];
      }
    }

    // write_file pattern
    const writeMatch = content.match(/^wrote (\d+) bytes to (.+)$/);
    if (writeMatch) {
      path = writeMatch[2]!;
      facts = [`${writeMatch[1]} bytes written`];
    }

    // list_dir pattern
    if (!path) {
      const entries = content.split("\n").filter((l) => l.trim().length > 0);
      if (entries.length > 2 && entries.every((l) => l.length < 100)) {
        path = extractPathHint(content);
        facts = [`${entries.length} entries`];
      }
    }

    // Update if we found a path
    if (path !== undefined) {
      const existing = this.fileIndex.get(path);
      this.fileIndex.set(path, {
        path,
        messageIndex: index,
        summary: content.slice(0, 200),
        keyFacts: facts.length > 0 ? facts : existing?.keyFacts ?? [],
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  /** Get the current file index (read-only view). */
  getContextIndex(): ReadonlyMap<string, FileIndexEntry> {
    return this.fileIndex;
  }

  /** Get the number of compression passes performed. */
  getCompressions(): number {
    return this.compressions;
  }

  /** Get the total number of messages compressed across all passes. */
  getTotalMessagesCompressed(): number {
    return this.totalMessagesCompressed;
  }

  /** Get the current configuration. */
  getConfig(): Readonly<ContextLayerConfig> {
    return this.config;
  }
}
