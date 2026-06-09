/**
 * ikbi project-retrieval — the deterministic retrieval engine.
 *
 * Strategy (no model calls, all derived from the project-index):
 *   1. mine SEEDS from the goal — path/filename tokens and symbol-like name terms — and match them
 *      to indexed files (goal-path-match / goal-name-match). Overly-generic terms are dropped.
 *   2. EXPAND via the index graph query (callers, imports, colocated tests, same-package).
 *   3. always include PROJECT RULES (CLAUDE.md / AGENTS.md) when present.
 *   4. include the PACKAGE MANIFEST (package.json) of any package a selected file lives in.
 *   5. RANK (rules first, then by summed reason weight) and trim to the byte budget.
 *
 * Every file carries machine-readable reasons + a "why selected" note; the result carries a
 * decision trail. Deterministic: stable sorts, no clock, no randomness, no model.
 */

import { posix } from "node:path";

import { projectIndex, type ProjectIndexApi, type ProjectIndexData } from "../project-index/index.js";
import { projectRetrievalConfig, STOPWORDS, type ProjectRetrievalConfig } from "./config.js";
import type { ProjectRetrievalApi, RetrievalRequest, RetrievalResult, RetrievalReason, SelectedFile } from "./contract.js";

/** Reason → score weight. Higher = more relevant; project-rules is force-ordered first separately. */
const WEIGHT: Record<RetrievalReason, number> = {
  "project-rules": 100,
  "goal-path-match": 20,
  "goal-name-match": 12,
  "imported-by-seed": 5,
  "imports-seed": 4,
  "test-of-seed": 4,
  "package-manifest": 3,
  "name-match": 2,
  "same-package": 1,
  seed: 0,
};

/** Reason → human phrase for the "why selected" receipt. */
const PHRASE: Record<RetrievalReason, string> = {
  "project-rules": "project rules (CLAUDE.md/AGENTS.md)",
  "goal-path-match": "path named in the goal",
  "goal-name-match": "name matches a goal term",
  "imported-by-seed": "imports a goal-relevant file",
  "imports-seed": "imported by a goal-relevant file",
  "test-of-seed": "test for a goal-relevant file",
  "same-package": "same package as a goal-relevant file",
  "name-match": "name related to a goal-relevant file",
  "package-manifest": "package manifest for a relevant package",
  seed: "seed",
};

function stemOf(relPath: string): string {
  return posix.basename(relPath).replace(/\.[^.]+$/, "").toLowerCase();
}

/** Mine path-like and name-like seed tokens from the goal text. */
export function goalTokens(goal: string): { pathTokens: string[]; nameTokens: string[] } {
  const pathTokens = new Set<string>();
  for (const m of goal.matchAll(/[\w.@/-]*\/[\w.@/-]+|[\w.-]+\.[A-Za-z0-9]+/g)) pathTokens.add(m[0]);
  const nameTokens = new Set<string>();
  for (const w of goal.split(/[^A-Za-z0-9_]+/)) {
    const lw = w.toLowerCase();
    if (lw.length >= 3 && !/^\d+$/.test(lw) && !STOPWORDS.has(lw)) nameTokens.add(lw);
  }
  return { pathTokens: [...pathTokens], nameTokens: [...nameTokens] };
}

export interface ProjectRetrievalDeps {
  /** The index to retrieve over. Default: the process-wide `projectIndex` singleton. */
  readonly index?: ProjectIndexApi;
  readonly config?: ProjectRetrievalConfig;
}

export function createProjectRetrieval(deps: ProjectRetrievalDeps = {}): ProjectRetrievalApi {
  const index = deps.index ?? projectIndex;
  const cfg = deps.config ?? projectRetrievalConfig;

  async function retrieve(req: RetrievalRequest): Promise<RetrievalResult> {
    // Ensure a current index (builds if absent, incrementally refreshes otherwise). Any failure
    // propagates so the caller (scout) can fall back to its legacy path.
    const data: ProjectIndexData = (await index.refresh(req.repoPath)).data;
    const byPath = new Map(data.files.map((f) => [f.path, f]));
    const receipts: string[] = [];

    // ── 1. seeds ────────────────────────────────────────────────────────────────
    const reasons = new Map<string, Set<RetrievalReason>>();
    const addReason = (path: string, r: RetrievalReason): void => {
      if (!byPath.has(path)) return;
      (reasons.get(path) ?? reasons.set(path, new Set()).get(path)!).add(r);
    };

    const { pathTokens, nameTokens } = goalTokens(req.goal);
    const explicitPaths = (req.seeds ?? []).filter((s) => byPath.has(s.replace(/^\.\//, "")));
    const explicitTerms = (req.seeds ?? []).filter((s) => !byPath.has(s.replace(/^\.\//, "")));

    const seedFiles = new Set<string>();
    for (const ep of explicitPaths) {
      const p = ep.replace(/^\.\//, "");
      addReason(p, "goal-path-match");
      seedFiles.add(p);
    }
    for (const pt of [...pathTokens]) {
      const norm = pt.replace(/^\.?\//, "");
      // F1: prefer the MOST SPECIFIC match. An exact repo-relative path is unambiguous → always seed.
      const exact = data.files.filter((f) => f.path === norm);
      if (exact.length > 0) {
        for (const f of exact) {
          addReason(f.path, "goal-path-match");
          seedFiles.add(f.path);
        }
        continue;
      }
      // Otherwise a slashed fragment matches by path suffix; a BARE basename (e.g. "index.ts",
      // "types.ts", "package.json") is treated like a generic term — seeded only when NOT too
      // generic (≤ maxPerTerm matches), so a common filename can never seed the whole repo.
      const hits = norm.includes("/")
        ? data.files.filter((f) => f.path.endsWith(`/${norm}`))
        : data.files.filter((f) => posix.basename(f.path) === posix.basename(norm));
      if (hits.length === 0) continue;
      if (hits.length > cfg.maxPerTerm) {
        receipts.push(`path token "${pt}" matched ${hits.length} files — too generic, skipped as a seed`);
        continue;
      }
      for (const f of hits) {
        addReason(f.path, "goal-path-match");
        seedFiles.add(f.path);
      }
    }
    // name terms → basename-stem matches (drop terms that are too generic to be a useful seed)
    const stemIndex = new Map<string, string[]>();
    for (const f of data.files) (stemIndex.get(stemOf(f.path)) ?? stemIndex.set(stemOf(f.path), []).get(stemOf(f.path))!).push(f.path);
    for (const term of [...nameTokens, ...explicitTerms.map((t) => t.toLowerCase())]) {
      const hits = stemIndex.get(term) ?? [];
      if (hits.length === 0) continue;
      if (hits.length > cfg.maxPerTerm) {
        receipts.push(`term "${term}" matched ${hits.length} files — too generic, skipped as a seed`);
        continue;
      }
      for (const p of hits) {
        addReason(p, "goal-name-match");
        seedFiles.add(p);
      }
    }
    // F1: overall seed cap — never let goal mining explode into a huge seed set (bounds the
    // expansion fan-out and the O(seeds × files) query cost on large repos).
    // A3/F3: rank by RELEVANCE (summed reason weight: exact path-match > name-match), NEVER
    // alphabetically — a critical `z-critical-auth.ts` must not be dropped for an earlier weak
    // `a-constants.ts`. Path asc only breaks exact-score ties.
    if (seedFiles.size > cfg.maxSeeds) {
      const seedScore = (p: string): number => [...(reasons.get(p) ?? [])].reduce((s, r) => s + (WEIGHT[r] ?? 0), 0);
      const ranked = [...seedFiles].sort((a, b) => {
        const d = seedScore(b) - seedScore(a);
        return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
      });
      const kept = new Set(ranked.slice(0, cfg.maxSeeds));
      let dropped = 0;
      for (const p of [...seedFiles]) {
        if (!kept.has(p)) {
          seedFiles.delete(p);
          reasons.delete(p); // drop its goal reasons; it may still return via graph expansion
          dropped += 1;
        }
      }
      receipts.push(`seed cap ${cfg.maxSeeds} reached — kept the ${cfg.maxSeeds} highest-relevance seed(s) by match specificity, dropped ${dropped} lower-relevance`);
    }
    receipts.push(seedFiles.size > 0 ? `seeds: ${[...seedFiles].sort().join(", ")}` : "no goal seeds matched — falling back to a project-structure baseline");

    // ── 2. graph expansion (callers / imports / tests / same-package) ─────────────
    if (seedFiles.size > 0) {
      const expanded = await index.query(req.repoPath, { seeds: [...seedFiles], want: "related", limit: 1000 });
      for (const item of expanded) for (const r of item.reasons) addReason(item.path, r);
      receipts.push(`graph expansion: +${expanded.length} related file(s) via the import/test graph`);
    } else {
      // baseline: each package's entry file + its manifest, so a vague goal still gets structure.
      for (const p of data.packages) if (p.entry !== undefined) addReason(p.entry, "package-manifest");
    }

    // ── 3. project rules (always, when present) ───────────────────────────────────
    let rulesCount = 0;
    for (const f of data.files) {
      const b = posix.basename(f.path);
      if (b === "CLAUDE.md" || b === "AGENTS.md") {
        addReason(f.path, "project-rules");
        rulesCount += 1;
      }
    }
    if (rulesCount > 0) receipts.push(`project rules: ${rulesCount} file(s) (CLAUDE.md/AGENTS.md) found — included subject to budget`);

    // ── 4. package manifests for packages of selected files ───────────────────────
    const selectedPkgs = new Set<string>();
    for (const p of reasons.keys()) {
      const pkg = byPath.get(p)?.package;
      if (pkg !== undefined) selectedPkgs.add(pkg);
    }
    for (const root of selectedPkgs) addReason(root === "" ? "package.json" : `${root}/package.json`, "package-manifest");

    // ── 5. rank + budget ──────────────────────────────────────────────────────────
    const scored = [...reasons.entries()].map(([path, set]) => {
      const rs = [...set].sort();
      return { path, reasons: rs, score: rs.reduce((s, r) => s + (WEIGHT[r] ?? 0), 0) };
    });
    const isRule = (x: { reasons: readonly RetrievalReason[] }): boolean => x.reasons.includes("project-rules");
    const rulesFirst = scored.filter(isRule).sort((a, b) => (a.path < b.path ? -1 : 1));
    const rest = scored
      .filter((x) => !isRule(x))
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const budget = req.budgetBytes ?? cfg.budgetBytes;
    const cap = req.perFileCapBytes ?? cfg.perFileCapBytes;
    const maxFiles = req.maxFiles ?? cfg.maxFiles;
    const files: SelectedFile[] = [];
    let totalBytes = 0;
    let truncatedByBudget = false;
    const costOf = (path: string): number => Math.min(byPath.get(path)?.size ?? 0, cap);
    const admit = (o: { path: string; reasons: RetrievalReason[]; score: number }): void => {
      totalBytes += costOf(o.path);
      files.push({ path: o.path, bytes: byPath.get(o.path)?.size ?? 0, score: o.score, reasons: o.reasons, why: o.reasons.map((r) => PHRASE[r]).join("; ") });
    };

    // F3: rules respect the budget (NO unconditional first-file admission). Include as MANY rules as
    // fit; record which rules file was dropped for budget.
    for (const o of rulesFirst) {
      if (files.length >= maxFiles) {
        truncatedByBudget = true;
        break;
      }
      if (totalBytes + costOf(o.path) <= budget) admit(o);
      else {
        truncatedByBudget = true;
        receipts.push(`project-rules file "${o.path}" dropped — exceeds the ${budget}B budget`);
      }
    }
    // F2: non-rules are score-ordered; STOP at the first that does not fit. A strictly-lower-scored
    // file must never jump ahead of a higher-scored one that was dropped for budget.
    for (const o of rest) {
      if (files.length >= maxFiles || totalBytes + costOf(o.path) > budget) {
        truncatedByBudget = true;
        break;
      }
      admit(o);
    }
    receipts.push(`budget ${budget}B: selected ${files.length} file(s), ${totalBytes}B, truncated=${truncatedByBudget}`);

    // F6/A1: LOUD low-confidence — never let the caller assume a microscopic view was "enough".
    // Low confidence when the index is incomplete (truncated), or when a large repo yielded NO goal
    // seeds (only a structural baseline), or when the selection covers a tiny fraction of a big repo.
    const totalFiles = data.files.length;
    const lowReasons: string[] = [];
    if (data.truncated) lowReasons.push("the project-index is truncated (incomplete)");
    if (seedFiles.size === 0 && totalFiles >= cfg.lowConfidenceMinFiles) lowReasons.push(`no goal seeds matched in a ${totalFiles}-file repo (structure baseline only)`);
    if (totalFiles >= cfg.lowConfidenceMinFiles && files.length / totalFiles < cfg.lowCoverageFraction) {
      lowReasons.push(`selection covers ${((files.length / totalFiles) * 100).toFixed(2)}% of ${totalFiles} files`);
    }
    const lowConfidence = lowReasons.length > 0;
    if (lowConfidence) receipts.push(`LOW CONFIDENCE: ${lowReasons.join("; ")} — do NOT treat this context as exhaustive; full verification required`);

    return { mode: "index", files, seeds: [...seedFiles].sort(), totalBytes, truncatedByBudget, lowConfidence, ...(lowConfidence ? { lowConfidenceReason: lowReasons.join("; ") } : {}), receipts };
  }

  return { retrieve };
}

/** The process-wide retrieval (over the default project-index). */
export const projectRetrieval: ProjectRetrievalApi = createProjectRetrieval();
