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

/** One enumerated evidence identifier the critic may cite. `kind` classifies its provenance. */
export interface EvidenceItem {
  readonly id: string;
  readonly kind:
    | "candidate" | "verified-tree" | "goal-requirement" | "acceptance-criterion"
    | "changed-file" | "diff" | "deterministic-check" | "executed-test"
    | "runtime-fact" | "api-contract" | "governed-exec" | "prior-defect";
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
  /** Deterministic checks the verifier ran; `isTest` marks executed-test evidence. */
  readonly checks?: readonly { readonly name: string; readonly isTest?: boolean }[];
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
    if (c.isTest === true) { tests.add(name); items.push({ id: `test:${name}`, kind: "executed-test", label: name }); }
  }
  for (const rid of input.runtimeEvidenceIds ?? []) { const id = rid.trim(); if (id.length === 0) continue; runtimeIds.add(id); items.push({ id: `runtime:${id}`, kind: "runtime-fact", label: id }); }
  for (const id of input.apiContractIds ?? []) { const t = id.trim(); if (t.length > 0) items.push({ id: `api:${t}`, kind: "api-contract", label: t }); }
  for (const id of input.governedExecIds ?? []) { const t = id.trim(); if (t.length > 0) items.push({ id: `exec:${t}`, kind: "governed-exec", label: t }); }
  for (const id of input.priorDefectIds ?? []) { const t = id.trim(); if (t.length > 0) items.push({ id: `prior:${t}`, kind: "prior-defect", label: t }); }

  const ids = new Set(items.map((it) => it.id));
  const hash = stableHash({ c: input.candidateId, t: input.verifiedTree ?? null, ids: [...ids].sort() });
  return { candidateId: input.candidateId, ...(input.verifiedTree !== undefined ? { verifiedTree: input.verifiedTree } : {}), items, ids, requirementIds, files, checks, tests, runtimeIds, hasExplicitCriteria, hash };
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

/** The decision-bearing substance of ONE defect, order-independent for comparison. */
export interface DefectSubstance {
  readonly claim: string;                 // canonicalized
  readonly evidence: readonly string[];   // sorted canonical evidence refs (raw refs, NOT resolved — resolution is the package's job)
  readonly requirement: string;           // canonicalized (may be "")
  readonly severity: string;              // "blocking" | "advisory" | ...
  readonly repairable: boolean | null;
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
  return {
    claim,
    evidence: rawEvidenceRefs(d),
    requirement: typeof d.requirement === "string" ? canonicalText(d.requirement) : "",
    severity,
    repairable: typeof d.repairable === "boolean" ? d.repairable : null,
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
      if (typeof raw === "string") { const c = canonicalText(raw); if (c.length > 0) defects.push({ claim: c, evidence: [], requirement: "", severity: "blocking", repairable: null }); }
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
    severity: d.severity,
    repairable: typeof d.repairable === "boolean" ? d.repairable : null,
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
    if (raw.repairable !== null && rd.repairable !== null && raw.repairable !== rd.repairable) mismatches.push("repairability-changed");
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

export interface DefectValidation {
  readonly valid: boolean;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
  readonly requirementId?: string;
}

/**
 * Validate ONE blocking defect against the evidence package. A defect is VALID only when it cites at least one
 * resolvable evidence id AND its requirement resolves to the goal / a named acceptance criterion. An unsupported
 * claim (no resolvable evidence), a test claim citing a test not in executed-test evidence, or an off-goal
 * requirement is INVALID and must not become a concrete defect.
 */
export function validateDefectEvidence(rawDefect: Record<string, unknown>, pkg: EvidencePackage): DefectValidation {
  const evidenceIds = resolvedDefectEvidence(rawDefect, pkg);
  if (evidenceIds.length === 0) {
    const cited = defectEvidenceRefs(rawDefect);
    return { valid: false, reason: cited.length === 0 ? "defect-cites-no-evidence" : "defect-cites-unsupplied-evidence", evidenceIds: [] };
  }
  const requirementId = resolveRequirement(rawDefect, pkg);
  if (requirementId === undefined) return { valid: false, reason: "defect-requirement-outside-goal", evidenceIds };
  return { valid: true, reason: "supported", evidenceIds, requirementId };
}

/** Validate a missing-requirement entry: it must name the goal or a supplied acceptance criterion. */
export function validateMissingRequirement(raw: unknown, pkg: EvidencePackage): { valid: boolean; requirementId?: string } {
  const obj = typeof raw === "string" ? { requirement: raw } : typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const requirementId = resolveRequirement(obj, pkg);
  return requirementId !== undefined ? { valid: true, requirementId } : { valid: false };
}

export { type BlockingDefect };
