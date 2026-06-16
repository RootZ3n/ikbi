/**
 * ikbi builder tools — gbrain BRAIN access (brain_search / brain_think / brain_put / brain_sync).
 *
 * The intelligence layer: these let the builder consult ikbi's knowledge brain (gbrain) for
 * relevant prior knowledge, synthesize across it, and write findings back. They sit ALONGSIDE
 * (never replace) project memory (CLAUDE.md/AGENTS.md), the workspace memory, and the receipt
 * store — gbrain is additive recall, not a substitute for any of those.
 *
 * Every call goes through `src/core/gbrain-bridge.ts`, which shells the `gbrain` CLI with ARRAY
 * args (no shell, no injection), a hard 30s timeout, and `~/.bun/bin` on PATH.
 *
 * GOVERNANCE: `brain_sync` MUTATES the shared brain (import + embed of a whole project), so it
 * is governance-gated — it FAILS CLOSED without a validated parent identity (`parentCtx`),
 * exactly like the `terminal` tool. The read/think/put tools are not gated (put writes a single
 * page; read/think are read-only retrieval).
 *
 * TRUST: gbrain output is retrieved KNOWLEDGE — UNTRUSTED data. This module only PRODUCES the
 * result string; the builder feeds it back through the neutralization chokepoint (same as
 * read_file / search_files / terminal output).
 */

import type { OperationContext } from "../../../core/identity/index.js";
import type { GbrainBridge } from "../../../core/gbrain-bridge.js";
import { GbrainError } from "../../../core/gbrain-bridge.js";
import type { ModelTool } from "../../../core/provider/contract.js";

/** What the brain tools need: the gbrain bridge + (for the gated sync) the run's identity. */
export interface BrainToolDeps {
  /** The gbrain bridge (default production bridge in the builder; injectable for tests). */
  readonly bridge: GbrainBridge;
  /** The run's validated OperationContext. Absent ⇒ `brain_sync` fails closed (cannot authorize). */
  readonly parentCtx?: OperationContext;
}

/** The brain tool names the builder routes to this module. */
export const BRAIN_TOOL_NAMES: ReadonlySet<string> = new Set(["brain_search", "brain_think", "brain_put", "brain_sync"]);

/** Cap on how much brain output is returned to the model in one tool result. */
const MAX_BRAIN_OUTPUT_BYTES = 12_000;

export const brainSearchTool: ModelTool = {
  name: "brain_search",
  description:
    "Search ikbi's knowledge brain (gbrain) for relevant prior knowledge by keyword/semantics. " +
    "Returns matching page titles + snippets. Use to recall conventions, past decisions, or context that isn't in the repo. " +
    'Example: {"query": "how does the promote receipt flow work"}',
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to recall from the brain." },
      limit: { type: "number", description: "Max results (default 5)." },
    },
    required: ["query"],
  },
};

export const brainThinkTool: ModelTool = {
  name: "brain_think",
  description:
    "Ask ikbi's knowledge brain (gbrain) a question — it synthesizes a cited answer across pages (multi-hop). " +
    "Slower than brain_search; use when you need a reasoned answer, not just matching pages. " +
    'Example: {"question": "why was the verifier ladder changed?"}',
  parameters: {
    type: "object",
    properties: { question: { type: "string", description: "The question to synthesize an answer for." } },
    required: ["question"],
  },
};

export const brainPutTool: ModelTool = {
  name: "brain_put",
  description:
    "Write or update a single page in ikbi's knowledge brain (gbrain). Use to record a durable finding/decision for later recall. " +
    'Example: {"slug": "notes/ikbi-promote", "content": "# Promote\\n\\nPromote propagates requestId."}',
  parameters: {
    type: "object",
    properties: {
      slug: { type: "string", description: 'The page slug, e.g. "notes/ikbi-promote".' },
      content: { type: "string", description: "The full markdown body of the page." },
    },
    required: ["slug", "content"],
  },
};

export const brainSyncTool: ModelTool = {
  name: "brain_sync",
  description:
    "Import a project directory into ikbi's knowledge brain (gbrain) and embed it, so its contents become searchable. " +
    "GOVERNED: requires operator authorization. " +
    'Example: {"path": "/path/to/project"}',
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Absolute path of the project directory to import + embed." } },
    required: ["path"],
  },
};

/** All four brain tool definitions, in declaration order. */
export const BRAIN_TOOLS: readonly ModelTool[] = [brainSearchTool, brainThinkTool, brainPutTool, brainSyncTool];

function bound(s: string): string {
  return s.length > MAX_BRAIN_OUTPUT_BYTES ? `${s.slice(0, MAX_BRAIN_OUTPUT_BYTES)}\n…(truncated)` : s;
}

/**
 * Run a brain tool. Pure: produces a result STRING (never throws past the call boundary, never
 * builds a message). A `DENIED:` prefix marks a governance refusal (so the caller can record it
 * as a policy violation, like terminal). An `ERROR:` prefix marks a tool failure the model can act on.
 */
export function runBrainTool(deps: BrainToolDeps, name: string, args: Record<string, unknown>): string {
  try {
    switch (name) {
      case "brain_search": {
        const query = typeof args.query === "string" ? args.query : "";
        if (query.trim().length === 0) return "ERROR: brain_search requires a non-empty 'query'";
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
        const res = deps.bridge.searchBrain(query, { limit });
        if (res.hits.length === 0) return `No brain results for "${query}".`;
        const lines = res.hits.map((h, i) => {
          const title = typeof h.title === "string" && h.title.length > 0 ? h.title : typeof h.slug === "string" ? h.slug : "(untitled)";
          const snippet = typeof h.snippet === "string" && h.snippet.length > 0 ? h.snippet : typeof h.content === "string" ? h.content : "";
          return snippet.length > 0 ? `${i + 1}. ${title}\n   ${snippet.replace(/\s+/g, " ").trim()}` : `${i + 1}. ${title}`;
        });
        return bound(lines.join("\n"));
      }
      case "brain_think": {
        const question = typeof args.question === "string" ? args.question : "";
        if (question.trim().length === 0) return "ERROR: brain_think requires a non-empty 'question'";
        return bound(deps.bridge.thinkBrain(question).answer);
      }
      case "brain_put": {
        const slug = typeof args.slug === "string" ? args.slug : "";
        const content = typeof args.content === "string" ? args.content : "";
        if (slug.trim().length === 0) return "ERROR: brain_put requires a non-empty 'slug'";
        if (content.length === 0) return "ERROR: brain_put requires non-empty 'content'";
        const out = deps.bridge.putPage(slug, content);
        return out.length > 0 ? bound(out) : `Wrote page "${slug}" to the brain.`;
      }
      case "brain_sync": {
        // GOVERNANCE GATE: mutating the shared brain across a whole project requires a validated
        // operator identity. FAIL CLOSED (no parentCtx ⇒ refuse) exactly like the terminal tool.
        if (deps.parentCtx === undefined) {
          return "DENIED: brain_sync requires operator authorization (no governed identity wired).";
        }
        const path = typeof args.path === "string" ? args.path : "";
        if (path.trim().length === 0) return "ERROR: brain_sync requires a non-empty 'path'";
        const res = deps.bridge.syncProject(path);
        return bound(`Imported and embedded "${path}" into the brain.\n${res.imported}\n${res.embedded}`.trim());
      }
      default:
        return `ERROR: unknown brain tool "${name}"`;
    }
  } catch (e) {
    if (e instanceof GbrainError) {
      // ACTIONABLE: surface the brain failure so the model can adapt (e.g. brain unavailable → proceed without it).
      return `ERROR: brain unavailable (${e.command}): ${e.message}`;
    }
    return `ERROR: brain tool failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
