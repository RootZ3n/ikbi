/**
 * ikbi structured code review — constructive, single-model.
 *
 * Where `multi-audit` runs an adversarial multi-model SCOUT to flag hypotheses, `review` is the
 * CONSTRUCTIVE counterpart: one model reads the target files and returns a balanced, structured
 * review — an overall summary plus file-by-file comments with severity ratings, covering code
 * quality, potential bugs, performance, readability, and test coverage. It REUSES the audit
 * infrastructure (the same bounded `buildContext` file-reader and the same neutralize→invokeModel
 * path) but with a constructive prompt and a review-shaped parser.
 *
 * READ-ONLY: it never writes to the repo or creates workspaces. The repo excerpts are UNTRUSTED →
 * neutralized before the model call, exactly like the scout/audit.
 */

import { createHash } from "node:crypto";

import { neutralizeUntrusted as coreNeutralize, toUntrustedMessage } from "../../core/injection/index.js";
import type { AgentIdentity, ModelMessage, ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { buildContext } from "./scout-files.js";

/** Severity of a single review comment. "praise" calls out a genuine strength. */
export type ReviewSeverity = "critical" | "high" | "medium" | "low" | "info" | "praise";

/** A single file-scoped review comment. */
export interface ReviewComment {
  readonly file: string;
  readonly line?: number;
  readonly severity: ReviewSeverity;
  /** quality | bug | performance | readability | testing | other. */
  readonly category: string;
  readonly comment: string;
  /** An optional concrete suggested change. */
  readonly suggestion?: string;
  /** Stable id (file|category|comment hash) for dedupe/reference. */
  readonly id: string;
}

/** The structured result of a code review. */
export interface ReviewResult {
  /** The model that produced the review. */
  readonly model: string;
  /** Overall constructive summary (strengths + the most important opportunities). */
  readonly summary: string;
  /** File-by-file comments, ordered as the model returned them. */
  readonly comments: readonly ReviewComment[];
  /** The files that were sent for review (repo-relative). */
  readonly filesReviewed: readonly string[];
  /** Present iff the review failed (model error / no content). */
  readonly error?: string;
}

/** Options for a review run. */
export interface ReviewOptions {
  readonly repoPath: string;
  /** Absolute paths of the files to review. Empty ⇒ the runner returns an explanatory result. */
  readonly files: readonly string[];
  readonly model: string;
  /** Optional unified diff to focus the review on what changed (folded into the prompt as context). */
  readonly diff?: string;
  readonly timeoutMs?: number;
  readonly invokeModel?: (request: ModelRequest) => Promise<ModelResponse>;
}

const REVIEW_TEMPERATURE = 0.2;
const REVIEW_MAX_TOKENS = 2_048;
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_DIFF_BYTES = 16_000;

/** Read-only review identity (probation tier). */
const REVIEW_IDENTITY: AgentIdentity = {
  agentId: "code-review",
  functionalRole: "critic",
  trustTier: "probation",
  spawnedFrom: "operator",
};

const REVIEW_SYSTEM =
  "You are a CONSTRUCTIVE senior code reviewer. Review the provided code and return BALANCED, " +
  "actionable feedback — call out genuine strengths as well as opportunities to improve. You are " +
  "NOT hostile and NOT a bug-bounty hunter: your goal is to help the author ship better code.\n\n" +
  "Cover these dimensions: code quality, potential bugs, performance, readability, and test coverage.\n\n" +
  "Return ONLY a JSON object (no prose, no markdown fences) of this shape:\n" +
  "{\n" +
  '  "summary": "2-4 sentence overall assessment — strengths first, then the most important opportunities",\n' +
  '  "comments": [\n' +
  "    {\n" +
  '      "file": "relative/path.ts",\n' +
  '      "line": 42,\n' +
  '      "severity": "critical|high|medium|low|info|praise",\n' +
  '      "category": "quality|bug|performance|readability|testing",\n' +
  '      "comment": "what and why",\n' +
  '      "suggestion": "a concrete improvement (optional)"\n' +
  "    }\n" +
  "  ]\n" +
  "}\n\n" +
  "Use severity \"praise\" for things done well. Reference real files and line numbers. Be specific and concise.";

const SEVERITY_VALUES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low", "info", "praise"]);
const CATEGORY_VALUES: ReadonlySet<string> = new Set(["quality", "bug", "performance", "readability", "testing", "other"]);

/** Run a constructive structured review of `files` with one model. Never throws — errors land in `error`. */
export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
  const { repoPath, files, model } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (files.length === 0) {
    return { model, summary: "No files to review.", comments: [], filesReviewed: [], error: "no files matched the review scope" };
  }

  const context = buildContext(files, repoPath);
  const filesReviewed = context.structure.map((s) => s.path);
  if (context.text.trim().length === 0) {
    return { model, summary: "No readable file content to review.", comments: [], filesReviewed, error: "no readable content" };
  }

  const invoke = options.invokeModel ?? (async (request: ModelRequest) => (await import("../../core/provider/index.js")).invokeModel(request));

  const messages: ModelMessage[] = [
    { role: "system", content: REVIEW_SYSTEM },
  ];
  if (options.diff !== undefined && options.diff.trim().length > 0) {
    const diff = options.diff.slice(0, MAX_DIFF_BYTES);
    messages.push(
      toUntrustedMessage(
        coreNeutralize(`The review should focus on these CHANGES (unified diff):\n${diff}`, { source: "external", identity: REVIEW_IDENTITY, origin: "review-diff" }),
        { role: "user" },
      ),
    );
  }
  messages.push(
    toUntrustedMessage(
      coreNeutralize(`Files to review:\n${context.text}`, { source: "external", identity: REVIEW_IDENTITY, origin: "review-files" }),
      { role: "user" },
    ),
  );

  try {
    const response = await invoke({
      model,
      temperature: REVIEW_TEMPERATURE,
      maxTokens: REVIEW_MAX_TOKENS,
      identity: REVIEW_IDENTITY,
      timeoutMs,
      messages,
    });
    const parsed = parseReview(response.content);
    return { model, summary: parsed.summary, comments: parsed.comments, filesReviewed };
  } catch (e) {
    return { model, summary: "Review failed.", comments: [], filesReviewed, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Parse the model's JSON review. Tolerant: strips fences, falls back to a summary-only result. */
export function parseReview(content: string): { summary: string; comments: ReviewComment[] } {
  const json = extractJson(content);
  if (json !== undefined && typeof json === "object" && json !== null) {
    const obj = json as Record<string, unknown>;
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    const rawComments = Array.isArray(obj.comments) ? obj.comments : [];
    const comments: ReviewComment[] = [];
    for (const c of rawComments) {
      if (typeof c !== "object" || c === null) continue;
      const rec = c as Record<string, unknown>;
      const file = typeof rec.file === "string" ? rec.file : "(general)";
      const comment = typeof rec.comment === "string" ? rec.comment.trim() : "";
      if (comment.length === 0) continue;
      const severity = typeof rec.severity === "string" && SEVERITY_VALUES.has(rec.severity.toLowerCase()) ? (rec.severity.toLowerCase() as ReviewSeverity) : "info";
      const category = typeof rec.category === "string" && CATEGORY_VALUES.has(rec.category.toLowerCase()) ? rec.category.toLowerCase() : "other";
      const line = typeof rec.line === "number" && rec.line > 0 ? rec.line : undefined;
      const suggestion = typeof rec.suggestion === "string" && rec.suggestion.trim().length > 0 ? rec.suggestion.trim() : undefined;
      comments.push({
        file,
        ...(line !== undefined ? { line } : {}),
        severity,
        category,
        comment,
        ...(suggestion !== undefined ? { suggestion } : {}),
        id: createHash("sha256").update(`${file}|${category}|${comment}`).digest("hex").slice(0, 12),
      });
    }
    if (summary.length > 0 || comments.length > 0) {
      return { summary: summary.length > 0 ? summary : "(no summary returned)", comments };
    }
  }
  // Fallback: treat the whole reply as the summary so a non-JSON answer is never lost.
  const text = content.trim();
  return { summary: text.length > 0 ? text : "(no review returned)", comments: [] };
}

/** Extract the first top-level JSON object from possibly-fenced model output. */
function extractJson(content: string): unknown {
  const text = content.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

const SEVERITY_ORDER: Record<ReviewSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, praise: 5 };
const SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  critical: "🔴 critical", high: "🟠 high", medium: "🟡 medium", low: "🔵 low", info: "ℹ️ info", praise: "✅ praise",
};

/** Render a review result as Markdown (the default human-readable format). */
export function formatReviewMarkdown(result: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`# Code Review`);
  lines.push("");
  lines.push(`_Model: ${result.model} · ${result.filesReviewed.length} file(s) reviewed_`);
  lines.push("");
  if (result.error !== undefined) {
    lines.push(`> ⚠️ Review incomplete: ${result.error}`);
    lines.push("");
  }
  lines.push(`## Summary`);
  lines.push("");
  lines.push(result.summary);
  lines.push("");

  if (result.comments.length === 0) {
    lines.push("_No specific comments._");
    return lines.join("\n");
  }

  // Counts by severity.
  const counts = new Map<ReviewSeverity, number>();
  for (const c of result.comments) counts.set(c.severity, (counts.get(c.severity) ?? 0) + 1);
  const countLine = (Object.keys(SEVERITY_ORDER) as ReviewSeverity[])
    .filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `${SEVERITY_LABEL[s]}: ${counts.get(s)}`)
    .join(" · ");
  if (countLine.length > 0) {
    lines.push(`**${result.comments.length} comment(s)** — ${countLine}`);
    lines.push("");
  }

  // Group comments by file, files in stable order, comments by severity within a file.
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of result.comments) {
    const arr = byFile.get(c.file) ?? [];
    arr.push(c);
    byFile.set(c.file, arr);
  }
  for (const [file, comments] of byFile) {
    lines.push(`## ${file}`);
    lines.push("");
    comments.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    for (const c of comments) {
      const loc = c.line !== undefined ? `:${c.line}` : "";
      lines.push(`- **${SEVERITY_LABEL[c.severity]}** [${c.category}] ${file}${loc} — ${c.comment}`);
      if (c.suggestion !== undefined) lines.push(`  - 💡 _Suggestion:_ ${c.suggestion}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
