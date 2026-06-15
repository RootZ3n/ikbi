/**
 * ikbi multi-model audit — run the read-only scout with N models and compare.
 *
 * Each model independently analyzes the same repo excerpts. Findings are
 * collected per-model, then compared:
 *   - AGREEMENT: findings both models identified (same file + similar title)
 *   - UNIQUE: findings only one model found
 *   - CONTRADICTIONS: findings that disagree (same file, different assessment)
 *
 * READ-ONLY: never writes to the repo or creates workspaces. Uses the same
 * model provider infrastructure as the builder/scout.
 */

import { toUntrustedMessage } from "../../core/injection/index.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import type { ModelRequest, ModelResponse, AgentIdentity } from "../../core/provider/contract.js";
import type { ScoutFinding } from "./scout.js";
import { gatherFiles, buildContext, type ScoutFileEntry } from "./scout-files.js";

/** One finding from a single model. Re-uses the scout's shape. */
export type { ScoutFinding };

/** Per-model result. */
export interface ModelFindings {
  readonly model: string;
  readonly findings: readonly ScoutFinding[];
  readonly tokensUsed?: number;
  readonly cost?: number;
  readonly durationMs: number;
  readonly error?: string;
}

/** Agreement entry: both models found something in the same file. */
export interface AgreementEntry {
  readonly file: string;
  readonly title: string;
  readonly modelATitle: string;
  readonly modelBTitle: string;
}

/** Contradiction entry: same file, different assessment. */
export interface ContradictionEntry {
  readonly file: string;
  readonly modelAFinding: ScoutFinding;
  readonly modelBFinding: ScoutFinding;
}

/** Structured result of a multi-model audit comparison. */
export interface ComparisonResult {
  readonly models: readonly ModelFindings[];
  readonly agreement: readonly AgreementEntry[];
  readonly unique: Readonly<Record<string, readonly ScoutFinding[]>>;
  readonly contradictions: readonly ContradictionEntry[];
  readonly summary: string;
}

/** Options for the multi-audit runner. */
export interface MultiAuditOptions {
  readonly repoPath: string;
  readonly models: readonly string[];
  readonly goal?: string;
  readonly timeoutMs?: number;
  readonly invokeModel?: (request: ModelRequest) => Promise<ModelResponse>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SCOUT_TEMPERATURE = 0.2;
const SCOUT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

const SCOUT_SYSTEM =
  "You are the SCOUT in a build pipeline. Investigate the provided repository " +
  "excerpts against the stated goal and list concise, concrete findings (one per " +
  "line, starting with '- '): what exists, what's relevant, and what the builder " +
  "should know. When a finding is about a specific file, START the line with its " +
  "path and (if you can) a line number, like `- src/foo.ts:42 — does X`, so the " +
  "builder can drill straight to it. Read-only — do not propose edits.";

/** Default agent identity for the multi-audit (probation tier, read-only). */
const AUDIT_IDENTITY: AgentIdentity = {
  agentId: "multi-audit",
  functionalRole: "scout",
  trustTier: "probation",
  spawnedFrom: "operator",
};

// ── Finding parsing ────────────────────────────────────────────────────────────

/** Extract a leading `path[:line[-line]]` reference from a finding line, if present.
 *  Handles backtick-wrapped paths like `src/foo.ts:42`. */
function extractPathRef(text: string): { path?: string; lines?: [number, number] } {
  // Strip backticks and try to find a path reference
  const stripped = text.replace(/`/g, " ");
  const m = stripped.match(/(?:^|\s)([\w./-]+\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?)?/);
  if (m === null || m[1] === undefined) return {};
  const path = m[1];
  if (m[2] === undefined) return { path };
  const start = Number.parseInt(m[2], 10);
  const end = m[3] !== undefined ? Number.parseInt(m[3], 10) : start;
  return { path, lines: [start, end] };
}

/**
 * Parse the model's bullet output into structured findings; fall back to one finding.
 * Validates path refs against the structure (same logic as scout).
 */
function parseFindings(content: string, structure: readonly ScoutFileEntry[]): ScoutFinding[] {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const bullets = lines.filter((l) => /^[-*]\s+/.test(l) || /^\d+[.)]\s+/.test(l));
  if (bullets.length > 0) {
    return bullets.map((l, i) => {
      const detail = l.replace(/^([-*]|\d+[.)])\s+/, "");
      const { path, lines: lineRange } = extractPathRef(detail);
      // Validate path against structure — drop refs to nonexistent files
      const validatedPath = path !== undefined
        ? structure.find((e) => {
            const p = e.path.toLowerCase();
            const ref = path.toLowerCase();
            return p === ref || p.endsWith(`/${ref}`) || ref.endsWith(`/${p}`);
          })?.path
        : undefined;
      return {
        title: `finding-${i + 1}`,
        detail,
        ...(validatedPath !== undefined ? { path: validatedPath } : {}),
        ...(lineRange !== undefined ? { lines: lineRange } : {}),
      };
    });
  }
  const detail = content.trim();
  return [{ title: "investigation", detail: detail.length > 0 ? detail : "(no analysis returned)" }];
}

// ── Fuzzy title similarity ─────────────────────────────────────────────────────

/**
 * Fuzzy Jaccard similarity on word tokens. "complex tool loop" vs "builder tool loop is complex"
 * should match because they share the majority of tokens.
 */
function titleSimilarity(a: string, b: string): number {
  const STOP_WORDS: ReadonlySet<string> = new Set(["the", "is", "are", "was", "has", "have", "had", "not", "and", "but", "for", "that", "this", "with", "from"]);
  const tokenize = (s: string): Set<string> =>
    new Set(
      s.toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP_WORDS.has(w)),
    );
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Normalize a file path for comparison (strip leading ./ or /). */
function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\//, "").toLowerCase();
}

/** Check if two paths refer to the same file. */
function sameFile(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

// ── Comparison algorithm ───────────────────────────────────────────────────────

/** Similarity threshold for title matching. 0.3 separates paraphrased agreement
 *  (e.g. "project has good documentation" ≈ "documentation is well organized")
 *  from contradictions (e.g. "auth has good coverage" ≠ "auth is untested"). */
const TITLE_SIMILARITY_THRESHOLD = 0.3;

/** Sentinel findings that represent "no analysis" — exclude from comparison. */
const SENTINEL_PATTERNS = [/^\(no/i, /^no findings/i, /^no analysis/i];

function isSentinel(finding: ScoutFinding): boolean {
  return SENTINEL_PATTERNS.some((p) => p.test(finding.detail.trim()));
}

/**
 * Compare findings from two models. Returns agreement, unique, and contradiction entries.
 */
export function compareFindings(
  modelAFindings: readonly ScoutFinding[],
  modelBFindings: readonly ScoutFinding[],
): {
  agreement: AgreementEntry[];
  uniqueA: ScoutFinding[];
  uniqueB: ScoutFinding[];
  contradictions: ContradictionEntry[];
} {
  // Filter out sentinel findings (e.g. "(no findings)") before comparison
  const realA = modelAFindings.filter((f) => !isSentinel(f));
  const realB = modelBFindings.filter((f) => !isSentinel(f));

  const agreement: AgreementEntry[] = [];
  const contradictions: ContradictionEntry[] = [];
  const matchedA = new Set<number>();
  const matchedB = new Set<number>();

  // Find agreements: same file + similar title
  for (let i = 0; i < realA.length; i++) {
    const fA = realA[i]!;
    for (let j = 0; j < realB.length; j++) {
      const fB = realB[j]!;
      const fileMatch =
        (fA.path !== undefined && fB.path !== undefined && sameFile(fA.path, fB.path)) ||
        (fA.path === undefined && fB.path === undefined);
      if (!fileMatch) continue;
      const sim = titleSimilarity(fA.detail, fB.detail);
      if (sim >= TITLE_SIMILARITY_THRESHOLD) {
        agreement.push({
          file: fA.path ?? "(general)",
          title: fA.detail,
          modelATitle: fA.detail,
          modelBTitle: fB.detail,
        });
        matchedA.add(i);
        matchedB.add(j);
        break; // each A finding matches at most one B finding
      }
    }
  }

  // Find contradictions: same file, NOT similar enough to agree, but same file
  for (let i = 0; i < realA.length; i++) {
    if (matchedA.has(i)) continue;
    const fA = realA[i]!;
    if (fA.path === undefined) continue;
    for (let j = 0; j < realB.length; j++) {
      if (matchedB.has(j)) continue;
      const fB = realB[j]!;
      if (fB.path === undefined || !sameFile(fA.path, fB.path)) continue;
      // Same file, different assessment — contradiction
      contradictions.push({ file: fA.path, modelAFinding: fA, modelBFinding: fB });
      matchedA.add(i);
      matchedB.add(j);
      break;
    }
  }

  const uniqueA = realA.filter((_, i) => !matchedA.has(i));
  const uniqueB = realB.filter((_, i) => !matchedB.has(i));

  return { agreement, uniqueA, uniqueB, contradictions };
}

// ── Model invocation ───────────────────────────────────────────────────────────

/**
 * Run the scout analysis with a single model against pre-gathered context.
 * Returns findings and timing info.
 */
async function runScoutModel(
  model: string,
  context: { text: string; used: number; structure: readonly ScoutFileEntry[] },
  goal: string,
  timeoutMs: number,
  invokeModel: (request: ModelRequest) => Promise<ModelResponse>,
): Promise<ModelFindings> {
  const start = performance.now();
  try {
    const neutralized = coreNeutralize(context.text, { source: "external", identity: AUDIT_IDENTITY, origin: "multi-audit-excerpts" });
    const untrustedExcerpts = toUntrustedMessage(neutralized, { role: "user" });

    const request: ModelRequest = {
      model,
      temperature: SCOUT_TEMPERATURE,
      maxTokens: SCOUT_MAX_TOKENS,
      identity: AUDIT_IDENTITY,
      timeoutMs,
      messages: [
        { role: "system", content: SCOUT_SYSTEM },
        toUntrustedMessage(coreNeutralize(`Goal:\n${goal}`, { source: "external", identity: AUDIT_IDENTITY, origin: "multi-audit-goal" }), { role: "user" }),
        untrustedExcerpts,
      ],
    };

    const response = await invokeModel(request);
    const durationMs = performance.now() - start;
    const findings = parseFindings(response.content, context.structure);
    return {
      model,
      findings,
      tokensUsed: response.usage.totalTokens,
      cost: response.cost.usd,
      durationMs,
    };
  } catch (err) {
    const durationMs = performance.now() - start;
    return {
      model,
      findings: [],
      durationMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Run a multi-model audit: gather files once, invoke each model independently,
 * then compare findings.
 *
 * READ-ONLY: never writes to the repo or creates workspaces.
 */
export async function runMultiAudit(options: MultiAuditOptions): Promise<ComparisonResult> {
  const {
    repoPath,
    models,
    goal = "investigate the repository structure, dependencies, and potential issues",
    timeoutMs = process.env.IKBI_MULTI_AUDIT_TIMEOUT_MS !== undefined
      ? Number.parseInt(process.env.IKBI_MULTI_AUDIT_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS,
    invokeModel,
  } = options;

  // Gather files once — shared across all models
  const files = gatherFiles(repoPath);
  const context = buildContext(files, repoPath);

  // Resolve the invoke function
  const invoke = invokeModel ?? resolveDefaultInvoker();

  // Run all models in parallel
  const results = await Promise.all(
    models.map((m) => runScoutModel(m, context, goal, timeoutMs, invoke)),
  );

  // Compare pairwise (for 2 models)
  const allAgreement: AgreementEntry[] = [];
  const allContradictions: ContradictionEntry[] = [];
  const allUnique: Record<string, ScoutFinding[]> = {};

  // Initialize unique findings for each model
  for (const r of results) allUnique[r.model] = [];

  if (results.length === 2) {
    const r0 = results[0]!;
    const r1 = results[1]!;
    if (r0.error === undefined && r1.error === undefined) {
      const comp = compareFindings(r0.findings, r1.findings);
      allAgreement.push(...comp.agreement);
      allContradictions.push(...comp.contradictions);
      allUnique[r0.model] = comp.uniqueA;
      allUnique[r1.model] = comp.uniqueB;
    } else {
      // If one or both errored, populate unique from successful ones
      for (const r of results) {
        if (r.error === undefined) allUnique[r.model] = [...r.findings];
      }
    }
  } else if (results.length === 1) {
    // Single model: all findings are "unique" to that model
    const r = results[0]!;
    if (r.error === undefined) {
      allUnique[r.model] = [...r.findings];
    }
  } else {
    // N > 2 models: compare all pairs, accumulate agreements
    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const ri = results[i]!;
        const rj = results[j]!;
        if (ri.error === undefined && rj.error === undefined) {
          const comp = compareFindings(ri.findings, rj.findings);
          allAgreement.push(...comp.agreement);
          allContradictions.push(...comp.contradictions);
        }
      }
    }
    // For N>2, unique = findings not in any agreement
    for (const r of results) {
      if (r.error !== undefined) continue;
      allUnique[r.model] = r.findings.filter((f) => {
        return !allAgreement.some((a) => a.modelATitle === f.detail || a.modelBTitle === f.detail);
      });
    }
  }

  // Build summary
  const totalFindings = new Set(allAgreement.map((a) => a.title)).size +
    Object.values(allUnique).reduce((sum, u) => sum + u.length, 0);
  const coverage = results
    .filter((r) => r.error === undefined)
    .map((r) => `${r.model}: ${r.findings.length}/${totalFindings}`)
    .join(", ");

  const summary = `Compared ${models.length} model(s); ${allAgreement.length} agreement(s), ${allContradictions.length} contradiction(s). Coverage: ${coverage}`;

  return {
    models: results,
    agreement: allAgreement,
    unique: allUnique,
    contradictions: allContradictions,
    summary,
  };
}

/**
 * Resolve the default model invoker using the real provider infrastructure.
 * This is lazy-loaded so tests can inject a mock.
 */
function resolveDefaultInvoker(): (request: ModelRequest) => Promise<ModelResponse> {
  return async (request: ModelRequest): Promise<ModelResponse> => {
    const { invokeModel } = await import("../../core/provider/index.js");
    return invokeModel(request);
  };
}

// ── Report formatting ──────────────────────────────────────────────────────────

/**
 * Format a ComparisonResult as a human-readable report.
 */
export function formatComparisonReport(result: ComparisonResult): string {
  const lines: string[] = [];

  // Header
  const modelNames = result.models.map((m) => m.model).join(" vs ");
  lines.push(`═══ Multi-Model Audit: ${modelNames} ═══`);
  lines.push("");

  // Per-model summary
  for (const m of result.models) {
    const err = m.error !== undefined ? ` ERROR: ${m.error}` : "";
    const cost = m.cost !== undefined ? `$${m.cost.toFixed(4)}` : "$???";
    const duration = (m.durationMs / 1000).toFixed(2);
    lines.push(`Model (${m.model}): ${m.findings.length} finding(s) (${duration}s, ${cost})${err}`);
  }
  lines.push("");

  // Agreements
  if (result.agreement.length > 0) {
    lines.push(`✅ AGREEMENT (${result.agreement.length} finding(s) both models found):`);
    for (let i = 0; i < result.agreement.length; i++) {
      const a = result.agreement[i]!;
      lines.push(`  ${i + 1}. ${a.file} — ${a.title}`);
    }
  } else {
    lines.push("✅ AGREEMENT (0): (none)");
  }
  lines.push("");

  // Unique findings per model
  for (const [model, findings] of Object.entries(result.unique)) {
    if (findings.length > 0) {
      lines.push(`🔵 UNIQUE TO ${model} (${findings.length} finding(s)):`);
      for (let i = 0; i < findings.length; i++) {
        const f = findings[i]!;
        lines.push(`  ${i + 1}. ${f.path ?? "(general)"} — ${f.detail}`);
      }
    } else {
      lines.push(`🔵 UNIQUE TO ${model} (0): (none)`);
    }
    lines.push("");
  }

  // Contradictions
  if (result.contradictions.length > 0) {
    lines.push(`⚠️ CONTRADICTIONS (${result.contradictions.length}):`);
    for (const c of result.contradictions) {
      lines.push(`  ${c.file}:`);
      lines.push(`    A: ${c.modelAFinding.detail}`);
      lines.push(`    B: ${c.modelBFinding.detail}`);
    }
  } else {
    lines.push("⚠️ CONTRADICTIONS (0): (none)");
  }
  lines.push("");

  // Coverage
  const totalUnique = new Set(result.agreement.map((a) => a.title)).size +
    Object.values(result.unique).reduce((sum, u) => sum + u.length, 0);
  const coverageLines = result.models
    .filter((m) => m.error === undefined)
    .map((m) => {
      const found = m.findings.length;
      const pct = totalUnique > 0 ? Math.round((found / totalUnique) * 100) : 0;
      return `${m.model} found ${found}/${totalUnique} (${pct}%)`;
    });
  lines.push(`Coverage: ${coverageLines.join(", ")}`);

  return lines.join("\n");
}
