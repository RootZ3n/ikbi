/**
 * ikbi worker-model — CANONICAL EVIDENCE PACKAGE + SUBSTANCE FINGERPRINT + DETERMINISTIC EQUIVALENCE (Phase 12).
 *
 * Closes IKBI-REAUDIT-003: "specific-looking" unsupported prose could become a blocking defect, and
 * structured recovery could add unrelated evidence / drop a defect / turn defect-bearing output into pass,
 * because (a) a defect's evidence fell back to its own claim and its requirement fell back to the whole goal,
 * and (b) recovery preservation was a keyword-count + verdict-polarity heuristic, not a substance comparison.
 *
 * This module is PURE — it never calls a model. It supplies three deterministic primitives the critic wires in:
 *   1. `buildEvidencePackage(...)` — the finite, enumerated set of evidence identifiers a critic may cite.
 *      A blocking defect that cites nothing in this set is UNSUPPORTED and cannot be a concrete defect.
 *   2. `substanceFingerprint(raw)` — a local, inference-free capture of the decision-bearing substance already
 *      PRESENT in a raw critic response (verdict polarity, candidate/tree, defect claims + their evidence refs,
 *      missing requirements, advisories, severity, repairability). Built BEFORE any recovery call.
 *   3. `substanceEquivalent(fingerprint, recovered)` — proves a RECOVERED verdict's decision-bearing substance
 *      is EQUAL to the fingerprint's. Recovery may repair syntax/wrappers/field-names/placement; it may not
 *      invent, drop, reword, re-evidence, re-scope, or flip anything. Not proven ⇒ the caller keeps indeterminate.
 *
 * `validateDefectEvidence` is the parser-side gate: a defect survives only when it cites ≥1 resolvable evidence
 * id AND its requirement resolves to the goal / an acceptance criterion. Unsupported defects are dropped; if a
 * fail/incomplete verdict has no surviving decision-bearing content, the result is `indeterminate` (fail-closed).
 */

import { createHash } from "node:crypto";
import type { BlockingDefect, SemanticVerdict } from "./semantic-verdict.js";

// ── canonical evidence package ────────────────────────────────────────────────────────────────────

/** The provenance kind of one enumerated evidence identifier. */
export type EvidenceKind =
  | "candidate" | "verified-tree" | "goal-requirement" | "acceptance-criterion"
  | "changed-file" | "diff" | "deterministic-check" | "executed-test"
  | "runtime-fact" | "api-contract" | "governed-exec" | "prior-defect";

/**
 * Phase 15 (IKBI-REAUDIT2-005): the AUTHORITY CLASS of an evidence kind — what a citation of it can actually
 * PROVE. An evidence id is not authoritative merely because it exists; its class bounds what defect it may
 * support. This closes "a stylistic criticism becomes a blocker by citing the generic candidate anchor".
 *
 *   - `contextual-identity` — establishes WHICH subject is under evaluation (candidate id, snapshot/tree).
 *     Scopes other evidence; can NEVER independently prove a blocking defect.
 *   - `requirement`         — proves something is REQUIRED (the goal / an explicit acceptance criterion).
 *     Does not by itself prove the candidate violates it.
 *   - `observation`         — proves an observable candidate FACT (diff, source, a deterministic-check /
 *     executed-test result, an API shape). The substantive support a blocker needs. Bound to the snapshot.
 *   - `runtime-fact`        — an operator-supplied runtime/environment truth. ADVISORY unless a category
 *     explicitly permits it to block (runtime-compatibility-conflict).
 *   - `derived`             — a prior validated defect / an intermediate assessment. Cannot be the SOLE
 *     support for another blocker.
 */
export type EvidenceAuthorityClass = "contextual-identity" | "requirement" | "observation" | "runtime-fact" | "derived";

/** The deterministic authority class of each evidence kind — the single source of "what may this prove". */
export const AUTHORITY_CLASS_OF_KIND: Readonly<Record<EvidenceKind, EvidenceAuthorityClass>> = {
  candidate: "contextual-identity",
  "verified-tree": "contextual-identity",
  "goal-requirement": "requirement",
  "acceptance-criterion": "requirement",
  // A changed-file / diff / check / test / api the critic was SHOWN is a scoped observation of the candidate.
  "changed-file": "observation",
  diff: "observation",
  "deterministic-check": "observation",
  "executed-test": "observation",
  "api-contract": "observation",
  "governed-exec": "observation",
  // Operator-supplied runtime truth is advisory by default (only a runtime-compatibility-conflict may block on it).
  "runtime-fact": "runtime-fact",
  // A prior validated defect is derived context (a repaired candidate references it) — not fresh support.
  "prior-defect": "derived",
};

/** The evidence kind a canonical package id belongs to (the id prefix is the kind's discriminator). */
export function kindOfEvidenceId(id: string): EvidenceKind | undefined {
  if (id === "candidate") return "candidate";
  if (id === "tree") return "verified-tree";
  if (id === "req:goal") return "goal-requirement";
  if (id.startsWith("req:")) return "acceptance-criterion";
  if (id.startsWith("file:")) return "changed-file";
  if (id.startsWith("diff:")) return "diff";
  if (id.startsWith("check:")) return "deterministic-check";
  if (id.startsWith("test:")) return "executed-test";
  if (id.startsWith("runtime:")) return "runtime-fact";
  if (id.startsWith("api:")) return "api-contract";
  if (id.startsWith("exec:")) return "governed-exec";
  if (id.startsWith("prior:")) return "prior-defect";
  return undefined;
}

/** The authority class of a canonical package id (contextual-identity for an unknown/generic anchor). */
export function authorityClassOfId(id: string): EvidenceAuthorityClass {
  const kind = kindOfEvidenceId(id);
  return kind !== undefined ? AUTHORITY_CLASS_OF_KIND[kind] : "contextual-identity";
}

/** One enumerated evidence identifier the critic may cite. `kind` classifies its provenance. */
export interface EvidenceItem {
  readonly id: string;
  readonly kind: EvidenceKind;
  /** A short human label (for prompt rendering + receipts). */
  readonly label?: string;
}

/** The finite evidence surface a single critic evaluation is allowed to cite. */
export interface EvidencePackage {
  readonly candidateId: string;
  readonly verifiedTree?: string;
  readonly items: readonly EvidenceItem[];
  /** Every allowed evidence id (canonical form) — the resolution target. */
  readonly ids: ReadonlySet<string>;
  /** The subset of ids that are goal requirements / acceptance criteria a defect's requirement may name. */
  readonly requirementIds: ReadonlySet<string>;
  /** Known changed-file paths (so a bare `server.ts[:line]` reference resolves to `file:server.ts`). */
  readonly files: ReadonlySet<string>;
  /** Known deterministic-check names (so a bare `typecheck` resolves to `check:typecheck`). */
  readonly checks: ReadonlySet<string>;
  /** Known executed-test evidence names (a test claim must resolve here — never an invented test). */
  readonly tests: ReadonlySet<string>;
  /** Phase 15: checks that FAILED (a deterministic-check / executed-test-failure defect must cite one of these). */
  readonly failedChecks: ReadonlySet<string>;
  /** Phase 15: executed tests that FAILED (an executed-test-failure defect must cite one of these). */
  readonly failedTests: ReadonlySet<string>;
  /** Known runtime-fact ids. */
  readonly runtimeIds: ReadonlySet<string>;
  /** Whether explicit acceptance criteria were supplied (⇒ a requirement must resolve to one). */
  readonly hasExplicitCriteria: boolean;
  /** A stable content hash of the package (for the durable semantic receipt — bounded, not the raw items). */
  readonly hash: string;
}

export interface BuildEvidenceInput {
  readonly candidateId: string;
  readonly verifiedTree?: string;
  readonly goal: string;
  /** Explicit, enumerated acceptance criteria. When present, a defect requirement MUST name one. */
  readonly acceptanceCriteria?: readonly string[];
  readonly changedFiles?: readonly string[];
  /**
   * Deterministic checks the verifier ran; `isTest` marks executed-test evidence. `passed` records the
   * OBSERVED result (Phase 15) — a `*-failure` defect must cite a check that actually FAILED (passed === false).
   * Absent `passed` is treated as passed (a check the verifier surfaced without a failure is not a failure).
   */
  readonly checks?: readonly { readonly name: string; readonly isTest?: boolean; readonly passed?: boolean }[];
  readonly runtimeEvidenceIds?: readonly string[];
  readonly apiContractIds?: readonly string[];
  readonly governedExecIds?: readonly string[];
  /** Prior VALIDATED defect ids (a repaired candidate may reference the defects it was told to fix). */
  readonly priorDefectIds?: readonly string[];
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/** Build the finite evidence package from the SAME inputs already supplied to the critic prompt. */
export function buildEvidencePackage(input: BuildEvidenceInput): EvidencePackage {
  const items: EvidenceItem[] = [];
  const requirementIds = new Set<string>();
  const files = new Set<string>();
  const checks = new Set<string>();
  const tests = new Set<string>();
  const failedChecks = new Set<string>();
  const failedTests = new Set<string>();
  const runtimeIds = new Set<string>();

  items.push({ id: "candidate", kind: "candidate", label: input.candidateId });
  if (input.verifiedTree !== undefined) items.push({ id: "tree", kind: "verified-tree", label: input.verifiedTree });

  const criteria = (input.acceptanceCriteria ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  const hasExplicitCriteria = criteria.length > 0;
  if (hasExplicitCriteria) {
    criteria.forEach((c, i) => { const id = `req:${i}`; requirementIds.add(id); items.push({ id, kind: "acceptance-criterion", label: c }); });
  } else {
    // No explicit criteria ⇒ the whole goal is the single requirement anchor.
    requirementIds.add("req:goal");
    items.push({ id: "req:goal", kind: "goal-requirement", label: input.goal.trim().slice(0, 200) });
  }

  for (const f of input.changedFiles ?? []) {
    const path = f.trim();
    if (path.length === 0) continue;
    files.add(path);
    items.push({ id: `file:${path}`, kind: "changed-file", label: path });
    items.push({ id: `diff:${path}`, kind: "diff", label: path });
  }
  for (const c of input.checks ?? []) {
    const name = c.name.trim();
    if (name.length === 0) continue;
    checks.add(name);
    items.push({ id: `check:${name}`, kind: "deterministic-check", label: name });
    const failed = c.passed === false; // absent passed ⇒ not a failure (a surfaced check without a failure)
    if (failed) failedChecks.add(name);
    if (c.isTest === true) { tests.add(name); items.push({ id: `test:${name}`, kind: "executed-test", label: name }); if (failed) failedTests.add(name); }
  }
  for (const rid of input.runtimeEvidenceIds ?? []) { const id = rid.trim(); if (id.length === 0) continue; runtimeIds.add(id); items.push({ id: `runtime:${id}`, kind: "runtime-fact", label: id }); }
  for (const id of input.apiContractIds ?? []) { const t = id.trim(); if (t.length > 0) items.push({ id: `api:${t}`, kind: "api-contract", label: t }); }
  for (const id of input.governedExecIds ?? []) { const t = id.trim(); if (t.length > 0) items.push({ id: `exec:${t}`, kind: "governed-exec", label: t }); }
  for (const id of input.priorDefectIds ?? []) { const t = id.trim(); if (t.length > 0) items.push({ id: `prior:${t}`, kind: "prior-defect", label: t }); }

  const ids = new Set(items.map((it) => it.id));
  const hash = stableHash({ c: input.candidateId, t: input.verifiedTree ?? null, ids: [...ids].sort(), fc: [...failedChecks].sort(), ft: [...failedTests].sort() });
  return { candidateId: input.candidateId, ...(input.verifiedTree !== undefined ? { verifiedTree: input.verifiedTree } : {}), items, ids, requirementIds, files, checks, tests, failedChecks, failedTests, runtimeIds, hasExplicitCriteria, hash };
}

/** Resolve a raw evidence reference string to a canonical package id, or undefined when unsupported. */
export function resolveEvidenceRef(ref: string, pkg: EvidencePackage): string | undefined {
  const r = ref.trim();
  if (r.length === 0) return undefined;
  if (pkg.ids.has(r)) return r;
  // candidate / tree aliases
  if (r === pkg.candidateId) return "candidate";
  if (pkg.verifiedTree !== undefined && r === pkg.verifiedTree) return "tree";
  // strip a trailing :line / :symbol locator from a file-ish reference
  const base = r.replace(/^(file|diff):/i, "");
  const fileHead = base.split(":")[0]!.trim();
  if (pkg.files.has(base)) return `file:${base}`;
  if (pkg.files.has(fileHead)) return `file:${fileHead}`;
  // check / test names (bare or prefixed)
  const checkName = r.replace(/^check:/i, "");
  if (pkg.checks.has(checkName)) return `check:${checkName}`;
  const testName = r.replace(/^test:/i, "");
  if (pkg.tests.has(testName)) return `test:${testName}`;
  // runtime facts (bare or prefixed)
  const rid = r.replace(/^runtime:/i, "");
  if (pkg.runtimeIds.has(rid)) return `runtime:${rid}`;
  return undefined;
}

/** Collect every evidence reference a defect asserts, from the rich `evidenceIds`, `evidence[]`, and location. */
export function defectEvidenceRefs(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const ids = raw.evidenceIds;
  if (Array.isArray(ids)) for (const x of ids) if (typeof x === "string") out.push(x.trim());
  const ev = raw.evidence;
  if (Array.isArray(ev)) {
    for (const e of ev) {
      if (typeof e === "string") out.push(e.trim());
      else if (typeof e === "object" && e !== null) {
        const o = e as Record<string, unknown>;
        if (typeof o.id === "string") out.push(o.id.trim());
        if (typeof o.reference === "string") out.push(o.reference.trim());
      }
    }
  } else if (typeof ev === "string") out.push(ev.trim());
  const loc = raw.location;
  if (typeof loc === "object" && loc !== null && typeof (loc as Record<string, unknown>).file === "string") {
    out.push(((loc as Record<string, unknown>).file as string).trim());
  }
  return out.filter((s) => s.length > 0);
}

/** The resolvable canonical evidence ids a defect cites (deduplicated, sorted). */
export function resolvedDefectEvidence(raw: Record<string, unknown>, pkg: EvidencePackage): string[] {
  const resolved = new Set<string>();
  for (const ref of defectEvidenceRefs(raw)) { const id = resolveEvidenceRef(ref, pkg); if (id !== undefined) resolved.add(id); }
  return [...resolved].sort();
}

/** Resolve a defect's requirement to an allowed requirement id (goal or a named acceptance criterion). */
export function resolveRequirement(raw: Record<string, unknown>, pkg: EvidencePackage): string | undefined {
  const rid = typeof raw.requirementId === "string" ? raw.requirementId.trim() : undefined;
  if (rid !== undefined && pkg.requirementIds.has(rid)) return rid;
  const reqText = typeof raw.requirement === "string" ? raw.requirement.trim() : "";
  if (!pkg.hasExplicitCriteria) {
    // The whole goal is the sole requirement — any non-empty requirement is "part of the goal".
    return reqText.length > 0 ? "req:goal" : undefined;
  }
  // Explicit criteria: the requirement must NAME one (by id or exact canonical text).
  for (const item of pkg.items) {
    if (item.kind !== "acceptance-criterion") continue;
    if (reqText.length > 0 && item.label !== undefined && canonicalText(item.label) === canonicalText(reqText)) return item.id;
  }
  return undefined;
}

// ── deterministic substance fingerprint + equivalence ──────────────────────────────────────────────

/** Conservative canonicalization: lowercase, collapse whitespace, strip surrounding/trailing punctuation. */
export function canonicalText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.,;:!?—–-]+|[\s.,;:!?—–-]+$/g, "")
    .trim();
}

/**
 * The decision-bearing substance of ONE defect, order-independent for comparison. Phase 15 (IKBI-REAUDIT2-006)
 * adds FIELD-PRESENCE tracking: `requirementId`, `repairable`, and `category` record present-vs-absent (null =
 * absent) so recovery cannot FILL an omitted requirement association / repairability / category — a schema
 * repairer may restructure, never supply a decision-bearing field the raw output did not contain.
 */
export interface DefectSubstance {
  readonly claim: string;                 // canonicalized
  readonly evidence: readonly string[];   // sorted canonical evidence refs (raw refs, NOT resolved — resolution is the package's job)
  readonly requirement: string;           // canonicalized free-text (may be "")
  readonly requirementId: string | null;  // Phase 15: the requirement ID present (null = absent)
  readonly severity: string;              // "blocking" | "advisory" | ...
  readonly repairable: boolean | null;    // present value, or null = absent
  readonly category: string | null;       // Phase 15: the declared category (null = absent)
}

/** A local, inference-free capture of what a raw/parsed critic response actually asserts. */
export interface SubstanceFingerprint {
  readonly verdictPolarity: "pass" | "blocking" | "indeterminate" | "unknown";
  readonly candidateId?: string;
  readonly verifiedTree?: string;
  readonly defects: readonly DefectSubstance[];
  readonly missingRequirements: readonly string[]; // canonical, sorted
  readonly advisories: readonly string[];          // canonical, sorted
  readonly hash: string;
}

const RAW_BLOCKING = /^(fail|failed|reject|rejected|incomplete|partial)$/;
const RAW_PASS = /^(pass|passed|approve|approved|ok)$/;

function rawTokenPolarity(obj: Record<string, unknown>): "pass" | "blocking" | "indeterminate" | "unknown" {
  const v = obj.verdict ?? obj.result ?? obj.status;
  if (typeof v !== "string") return "unknown";
  const t = v.trim().toLowerCase();
  if (RAW_PASS.test(t)) return "pass";
  if (RAW_BLOCKING.test(t)) return "blocking";
  if (t === "indeterminate" || t === "unknown" || t === "unsure") return "indeterminate";
  return "unknown";
}

function extractJson(content: string): Record<string, unknown> | undefined {
  const m = content.match(/\{[\s\S]*\}/);
  if (m === null) return undefined;
  try { const o = JSON.parse(m[0]) as unknown; return typeof o === "object" && o !== null ? (o as Record<string, unknown>) : undefined; }
  catch { return undefined; }
}

function rawEvidenceRefs(d: Record<string, unknown>): string[] {
  return [...new Set(defectEvidenceRefs(d).map((r) => r.trim()).filter((r) => r.length > 0))].sort();
}

function defectSubstanceOf(d: Record<string, unknown>): DefectSubstance | undefined {
  const claim = typeof d.claim === "string" ? canonicalText(d.claim) : "";
  if (claim.length === 0) return undefined;
  const severity = typeof d.severity === "string" ? d.severity.trim().toLowerCase() : "blocking";
  const rid = typeof d.requirementId === "string" && d.requirementId.trim().length > 0 ? d.requirementId.trim() : null;
  const rawCat = typeof d.category === "string" && d.category.trim().length > 0 ? d.category.trim().toLowerCase() : null;
  const category = rawCat === "unspecified" ? null : rawCat; // the default category is equivalent to absent
  return {
    claim,
    evidence: rawEvidenceRefs(d),
    requirement: typeof d.requirement === "string" ? canonicalText(d.requirement) : "",
    requirementId: rid,
    severity,
    repairable: typeof d.repairable === "boolean" ? d.repairable : null,
    category,
  };
}

/**
 * Build the deterministic substance fingerprint of a RAW critic response — reading ONLY what is explicitly
 * present (never inferring a missing verdict/defect/binding). Defect-bearing arrays are read from the known
 * keys wherever the model placed them (`blockingDefects` / `defects` / `issues`), so a wrong-array structural
 * failure is still captured for the equivalence check.
 */
export function substanceFingerprint(rawContent: string): SubstanceFingerprint {
  const obj = extractJson(rawContent ?? "");
  if (obj === undefined) {
    return { verdictPolarity: "unknown", defects: [], missingRequirements: [], advisories: [], hash: stableHash({ p: "unknown" }) };
  }
  const polarity = rawTokenPolarity(obj);
  const candidateId = typeof obj.candidateId === "string" ? obj.candidateId.trim() : undefined;
  const verifiedTree = typeof obj.verifiedTree === "string" ? obj.verifiedTree.trim() : undefined;

  const defectArrays = [obj.blockingDefects, obj.defects, obj.issues].filter(Array.isArray) as unknown[][];
  const defects: DefectSubstance[] = [];
  for (const arr of defectArrays) {
    for (const raw of arr) {
      if (typeof raw === "string") { const c = canonicalText(raw); if (c.length > 0) defects.push({ claim: c, evidence: [], requirement: "", requirementId: null, severity: "blocking", repairable: null, category: null }); }
      else if (typeof raw === "object" && raw !== null) { const s = defectSubstanceOf(raw as Record<string, unknown>); if (s !== undefined) defects.push(s); }
    }
  }
  defects.sort((a, b) => (a.claim < b.claim ? -1 : a.claim > b.claim ? 1 : 0));

  const missing: string[] = [];
  const mr = Array.isArray(obj.missingRequirements) ? obj.missingRequirements : Array.isArray(obj.incompleteRequirements) ? obj.incompleteRequirements : Array.isArray(obj.missing) ? obj.missing : [];
  for (const item of mr) {
    if (typeof item === "string") { const c = canonicalText(item); if (c.length > 0) missing.push(c); }
    else if (typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).requirement === "string") { const c = canonicalText((item as Record<string, unknown>).requirement as string); if (c.length > 0) missing.push(c); }
  }
  missing.sort();

  const advisories: string[] = [];
  const av = Array.isArray(obj.advisories) ? obj.advisories : [];
  for (const a of av) {
    if (typeof a === "string") { const c = canonicalText(a); if (c.length > 0) advisories.push(c); }
    else if (typeof a === "object" && a !== null && typeof (a as Record<string, unknown>).claim === "string") { const c = canonicalText((a as Record<string, unknown>).claim as string); if (c.length > 0) advisories.push(c); }
  }
  advisories.sort();

  const hash = stableHash({ polarity, candidateId: candidateId ?? null, verifiedTree: verifiedTree ?? null, defects, missing, advisories });
  return { verdictPolarity: polarity, ...(candidateId !== undefined ? { candidateId } : {}), ...(verifiedTree !== undefined ? { verifiedTree } : {}), defects, missingRequirements: missing, advisories, hash };
}

/** The decision-bearing substance of a PARSED recovered verdict, in the same shape (for comparison). */
function verdictSubstance(v: SemanticVerdict): { polarity: "pass" | "blocking" | "indeterminate" | "unknown"; defects: DefectSubstance[]; missing: string[]; advisories: string[] } {
  const polarity = v.kind === "pass" ? "pass" : v.kind === "fail" || v.kind === "incomplete" ? "blocking" : v.kind === "indeterminate" ? "indeterminate" : "unknown";
  const defects = v.blockingDefects.map((d): DefectSubstance => ({
    claim: canonicalText(d.claim),
    evidence: [...new Set((d.evidenceIds ?? []).map((r) => r.trim()).filter((r) => r.length > 0))].sort(),
    requirement: canonicalText(d.requirement),
    requirementId: typeof d.requirementId === "string" && d.requirementId.trim().length > 0 ? d.requirementId.trim() : null,
    severity: d.severity,
    repairable: typeof d.repairable === "boolean" ? d.repairable : null,
    // `unspecified` is the DEFAULT category the parser stamps on any validated defect — treat it as ABSENT so a
    // structure-only reformat (which the parser re-stamps `unspecified`) is not flagged as an invented category.
    category: typeof d.category === "string" && d.category.trim().length > 0 && d.category.trim().toLowerCase() !== "unspecified" ? d.category.trim().toLowerCase() : null,
  }));
  defects.sort((a, b) => (a.claim < b.claim ? -1 : a.claim > b.claim ? 1 : 0));
  return { polarity, defects, missing: [...v.incompleteRequirements.map(canonicalText)].sort(), advisories: [...v.advisories.map((a) => canonicalText(a.claim))].sort() };
}

export interface EquivalenceResult {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

/**
 * Prove the RECOVERED verdict's decision-bearing substance EQUALS the raw fingerprint's. Recovery may only
 * repair structure — every mismatch below is a substantive mutation and rejects the recovery (→ indeterminate).
 * A recovered `indeterminate` is always acceptable (it preserves "cannot determine"). The comparison is exact
 * on canonicalized claims / evidence sets / requirements — never fuzzy similarity.
 */
export function substanceEquivalent(fingerprint: SubstanceFingerprint, recovered: SemanticVerdict): EquivalenceResult {
  if (recovered.kind === "indeterminate") return { ok: true, mismatches: [] };
  const mismatches: string[] = [];
  const rec = verdictSubstance(recovered);

  // 1. verdict polarity must not flip
  if (fingerprint.verdictPolarity === "pass" && rec.polarity === "blocking") mismatches.push("verdict-flipped-pass-to-blocking");
  if (fingerprint.verdictPolarity === "blocking" && rec.polarity === "pass") mismatches.push("verdict-flipped-blocking-to-pass");
  // a blocking recovery from raw with no discernible polarity AND no defect substance invents a rejection
  if (rec.polarity === "blocking" && fingerprint.verdictPolarity !== "blocking" && fingerprint.defects.length === 0) mismatches.push("blocking-verdict-without-raw-substance");

  // 2. candidate / tree binding must not change
  if (fingerprint.candidateId !== undefined && recovered.candidateId !== undefined && fingerprint.candidateId !== recovered.candidateId) mismatches.push("candidate-binding-changed");
  if (fingerprint.verifiedTree !== undefined && recovered.verifiedTree !== undefined && fingerprint.verifiedTree !== recovered.verifiedTree) mismatches.push("tree-binding-changed");

  // 3. defect set equality (claims) — no added, dropped, or reworded defect
  const rawClaims = fingerprint.defects.map((d) => d.claim);
  const recClaims = rec.defects.map((d) => d.claim);
  if (rawClaims.length !== recClaims.length) mismatches.push(`defect-count-changed:${rawClaims.length}->${recClaims.length}`);
  const rawSet = new Set(rawClaims);
  const recSet = new Set(recClaims);
  for (const c of recSet) if (!rawSet.has(c)) mismatches.push("defect-added-or-reworded");
  for (const c of rawSet) if (!recSet.has(c)) mismatches.push("defect-dropped-or-reworded");

  // 4. per-defect evidence / requirement / severity / repairability must not drift (matched by claim)
  const rawByClaim = new Map(fingerprint.defects.map((d) => [d.claim, d] as const));
  for (const rd of rec.defects) {
    const raw = rawByClaim.get(rd.claim);
    if (raw === undefined) continue; // already flagged as added
    // evidence: the recovered evidence set may not INTRODUCE a reference the raw defect never had.
    for (const e of rd.evidence) if (!raw.evidence.includes(e)) mismatches.push("evidence-added");
    for (const e of raw.evidence) if (!rd.evidence.includes(e)) mismatches.push("evidence-removed");
    if (raw.requirement !== "" && rd.requirement !== "" && raw.requirement !== rd.requirement) mismatches.push("requirement-changed");
    if (raw.severity !== rd.severity) mismatches.push("severity-changed");
    // FIELD-PRESENCE (Phase 15, IKBI-REAUDIT2-006): recovery may not FILL/DROP a decision-bearing field.
    // requirement-id: recovery may not ADD a SPECIFIC criterion association (whole-goal `req:goal` is the
    // benign default that any substantive defect earns, so filling it is not a substance change), nor CHANGE
    // or DROP a specific association the raw defect stated.
    const rawRid = raw.requirementId, recRid = rd.requirementId;
    if (rawRid === null && recRid !== null && recRid !== "req:goal") mismatches.push("requirement-id-added");
    else if (rawRid !== null && recRid === null) mismatches.push("requirement-id-removed");
    else if (rawRid !== null && recRid !== null && rawRid !== recRid) mismatches.push("requirement-id-changed");
    // repairability: recovery may not fill an omitted value, drop a stated one, or flip it (fixer-eligibility drift).
    if (raw.repairable === null && rd.repairable !== null) mismatches.push("repairability-added");
    else if (raw.repairable !== null && rd.repairable === null) mismatches.push("repairability-removed");
    else if (raw.repairable !== null && rd.repairable !== null && raw.repairable !== rd.repairable) mismatches.push("repairability-changed");
    // category: recovery may not invent or change the typed category (which selects the support matrix).
    if (raw.category === null && rd.category !== null) mismatches.push("category-added");
    else if (raw.category !== null && rd.category !== null && raw.category !== rd.category) mismatches.push("category-changed");
  }

  // 5. missing requirements + advisories set equality (no advisory→blocker movement, no invented requirement)
  if (!setEqual(fingerprint.missingRequirements, rec.missing)) mismatches.push("missing-requirements-changed");
  if (!setEqual(fingerprint.advisories, rec.advisories)) mismatches.push("advisories-changed");
  // an advisory in the raw that reappears as a blocking defect is a promotion of severity
  for (const adv of fingerprint.advisories) if (rec.defects.some((d) => d.claim === adv)) mismatches.push("advisory-promoted-to-blocker");

  return { ok: mismatches.length === 0, mismatches: [...new Set(mismatches)] };
}

function setEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

// ── defect evidence validation (parser-side gate) ───────────────────────────────────────────────────

// ── typed defect categories + deterministic support matrix (Phase 15) ────────────────────────────────

/**
 * The controlled category a blocking defect declares. Each category has DETERMINISTIC support requirements
 * (the support matrix below) — a defect cannot be policy-bearing without declaring one that its cited evidence
 * can support. An absent/unknown category degrades to `unspecified` (the default rule: needs a substantive
 * observation), so a defect can never gain authority by omitting a category.
 */
export type DefectCategory =
  | "missing-required-output" | "behavioral-failure" | "executed-test-failure" | "deterministic-check-failure"
  | "api-contract-mismatch" | "file-content-mismatch" | "missing-file-or-symbol" | "security-policy-violation"
  | "explicit-style-policy-violation" | "runtime-compatibility-conflict" | "snapshot-integrity-conflict"
  | "unspecified";

const KNOWN_CATEGORIES = new Set<DefectCategory>([
  "missing-required-output", "behavioral-failure", "executed-test-failure", "deterministic-check-failure",
  "api-contract-mismatch", "file-content-mismatch", "missing-file-or-symbol", "security-policy-violation",
  "explicit-style-policy-violation", "runtime-compatibility-conflict", "snapshot-integrity-conflict", "unspecified",
]);

/** Read the model-declared defect category; an unknown/absent value degrades to `unspecified` (never gains authority). */
export function resolveDefectCategory(raw: Record<string, unknown>): DefectCategory {
  const c = typeof raw.category === "string" ? raw.category.trim().toLowerCase() : "";
  return KNOWN_CATEGORIES.has(c as DefectCategory) ? (c as DefectCategory) : "unspecified";
}

/** The deterministic support rule for a category — what its cited evidence must include to support a blocker. */
interface CategoryRule {
  /** The observation kinds that count as substantive support for THIS category. "any" = every observation kind. */
  readonly observation: readonly EvidenceKind[] | "any";
  /** A cited check/test id must be in the package's FAILED set. */
  readonly requireFailed?: "check" | "test" | "either";
  /** Requires an explicit style requirement (a named acceptance criterion) OR a failed deterministic check. */
  readonly requireStylePolicy?: boolean;
  /** Requires a cited runtime-fact id (the environment truth the conflict rests on). */
  readonly requireRuntimeFact?: boolean;
  /** Requires ABSENCE evidence — a failed check OR an explicit criterion naming the expected (absent) output. */
  readonly requireAbsence?: boolean;
  /** An operational condition, never a candidate correctness defect — never supportable as a blocker. */
  readonly operationalOnly?: boolean;
}

const SUPPORT_MATRIX: Readonly<Record<DefectCategory, CategoryRule>> = {
  "executed-test-failure": { observation: ["executed-test"], requireFailed: "test" },
  "deterministic-check-failure": { observation: ["deterministic-check"], requireFailed: "check" },
  "behavioral-failure": { observation: ["executed-test", "deterministic-check"], requireFailed: "either" },
  "api-contract-mismatch": { observation: ["api-contract", "changed-file", "diff"] },
  "file-content-mismatch": { observation: ["changed-file", "diff"] },
  "missing-file-or-symbol": { observation: ["deterministic-check", "changed-file", "diff"], requireAbsence: true },
  "missing-required-output": { observation: ["deterministic-check", "changed-file", "diff"], requireAbsence: true },
  "security-policy-violation": { observation: ["governed-exec", "diff", "changed-file", "deterministic-check"] },
  "explicit-style-policy-violation": { observation: ["deterministic-check"], requireStylePolicy: true },
  "runtime-compatibility-conflict": { observation: ["changed-file", "diff"], requireRuntimeFact: true },
  "snapshot-integrity-conflict": { observation: "any", operationalOnly: true },
  unspecified: { observation: "any" },
};

export interface DefectValidation {
  readonly valid: boolean;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly requirementId?: string;
  /** Phase 15: the category the defect was validated as (declared or `unspecified`). */
  readonly category: DefectCategory;
  /** Phase 15: the support-matrix rule that admitted (or would have admitted) this defect. */
  readonly supportKind: string;
  /** Phase 15: the authority classes of the cited, resolvable evidence (for the receipt). */
  readonly authorityClasses: readonly EvidenceAuthorityClass[];
}

/** Whether a cited id is a substantive OBSERVATION for the given rule (candidate/tree/requirement/runtime/derived are not). */
function isSubstantiveObservation(id: string, rule: CategoryRule): boolean {
  const kind = kindOfEvidenceId(id);
  if (kind === undefined) return false;
  if (AUTHORITY_CLASS_OF_KIND[kind] !== "observation") return false;
  return rule.observation === "any" || rule.observation.includes(kind);
}

/**
 * Validate ONE blocking defect against the evidence package + the deterministic support matrix (Phase 15,
 * IKBI-REAUDIT2-005). A defect is VALID only when ALL hold:
 *   1. it cites ≥1 resolvable evidence id;
 *   2. its requirement resolves to the goal / a named acceptance criterion;
 *   3. it cites ≥1 SUBSTANTIVE OBSERVATION for its declared category — a CONTEXTUAL anchor (candidate/tree),
 *      a bare requirement, an advisory runtime fact, or a derived prior-defect can never be the sole support;
 *   4. the category's extra support requirement is met (a `*-failure` needs a FAILED check; a style defect
 *      needs an explicit style criterion OR a failed formatter check; a runtime conflict needs a runtime fact;
 *      a missing-* needs absence evidence).
 * An unsupported claim (candidate-anchor-only, off-goal requirement, unfailed check, style-without-policy) is
 * INVALID and must not become a concrete defect.
 */
export function validateDefectEvidence(rawDefect: Record<string, unknown>, pkg: EvidencePackage): DefectValidation {
  const category = resolveDefectCategory(rawDefect);
  const rule = SUPPORT_MATRIX[category];
  const evidenceIds = resolvedDefectEvidence(rawDefect, pkg);
  const authorityClasses = [...new Set(evidenceIds.map(authorityClassOfId))];
  const fail = (reason: string): DefectValidation => ({ valid: false, reason, evidenceIds, category, supportKind: "none", authorityClasses });

  if (evidenceIds.length === 0) {
    const cited = defectEvidenceRefs(rawDefect);
    return fail(cited.length === 0 ? "defect-cites-no-evidence" : "defect-cites-unsupplied-evidence");
  }
  const requirementId = resolveRequirement(rawDefect, pkg);
  if (requirementId === undefined) return fail("defect-requirement-outside-goal");

  // An operational condition is never a candidate correctness defect (it explains why evaluation/promotion
  // could not proceed) — it can never be a model-asserted blocker.
  if (rule.operationalOnly === true) return fail(`category-is-operational-not-correctness:${category}`);

  // 3. SUBSTANTIVE OBSERVATION — the core anti-anchor rule. Contextual identity (candidate/tree), a bare
  // requirement, an advisory runtime fact, or a derived prior-defect proves identity/requirement only.
  const observations = evidenceIds.filter((id) => isSubstantiveObservation(id, rule));

  // 4a. explicit-style-policy-violation: an explicit STYLE criterion (a named acceptance criterion, NOT the
  // whole goal) OR a failed formatter/linter deterministic-check. A style preference citing the generic
  // candidate anchor + the whole goal is NOT blocking.
  if (rule.requireStylePolicy === true) {
    const namedCriterion = requirementId !== "req:goal" && pkg.requirementIds.has(requirementId);
    const failedFormatter = evidenceIds.some((id) => kindOfEvidenceId(id) === "deterministic-check" && pkg.failedChecks.has(id.replace(/^check:/, "")));
    if (!namedCriterion && !failedFormatter) return fail("style-defect-without-explicit-policy");
    return { valid: true, reason: "supported", evidenceIds, requirementId, category, supportKind: namedCriterion ? "explicit-style-criterion" : "failed-formatter-check", authorityClasses };
  }

  if (observations.length === 0) return fail(authorityClasses.every((c) => c === "contextual-identity") ? "defect-cites-only-contextual-evidence" : "defect-cites-no-substantive-observation");

  // 4b. `*-failure` categories require a cited check/test that ACTUALLY FAILED (a passing check cannot support
  // a failure claim). The critic runs after the verifier, so a green tree cannot fabricate a test failure.
  if (rule.requireFailed !== undefined) {
    const citesFailedCheck = evidenceIds.some((id) => kindOfEvidenceId(id) === "deterministic-check" && pkg.failedChecks.has(id.replace(/^check:/, "")));
    const citesFailedTest = evidenceIds.some((id) => kindOfEvidenceId(id) === "executed-test" && pkg.failedTests.has(id.replace(/^test:/, "")));
    const ok = rule.requireFailed === "check" ? citesFailedCheck : rule.requireFailed === "test" ? citesFailedTest : citesFailedCheck || citesFailedTest;
    if (!ok) return fail("defect-cites-no-failed-check");
  }

  // 4c. runtime-compatibility-conflict: needs the operator-supplied runtime fact the conflict rests on.
  if (rule.requireRuntimeFact === true && !evidenceIds.some((id) => kindOfEvidenceId(id) === "runtime-fact")) return fail("runtime-conflict-without-runtime-fact");

  // 4d. missing-* : needs ABSENCE evidence — a failed check OR an explicit criterion naming the expected output
  // (the whole-goal anchor alone cannot prove a specific output is absent).
  if (rule.requireAbsence === true) {
    const failedCheck = evidenceIds.some((id) => kindOfEvidenceId(id) === "deterministic-check" && pkg.failedChecks.has(id.replace(/^check:/, "")));
    const namedCriterion = requirementId !== "req:goal" && pkg.requirementIds.has(requirementId);
    if (!failedCheck && !namedCriterion) return fail("missing-defect-without-absence-evidence");
  }

  return { valid: true, reason: "supported", evidenceIds, requirementId, category, supportKind: `observation:${category}`, authorityClasses };
}

/** Validate a missing-requirement entry: it must name the goal or a supplied acceptance criterion. */
export function validateMissingRequirement(raw: unknown, pkg: EvidencePackage): { valid: boolean; requirementId?: string } {
  const obj = typeof raw === "string" ? { requirement: raw } : typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const requirementId = resolveRequirement(obj, pkg);
  return requirementId !== undefined ? { valid: true, requirementId } : { valid: false };
}

export { type BlockingDefect };
