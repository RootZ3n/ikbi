/**
 * ikbi worker-model — APPROVED-correction application (Codex HIGH-2).
 *
 * Corrections are operator-approved lessons (correction-library). Before this seam they
 * could be approved but never took effect: no production role loaded them. This module is
 * the shared loader the VERIFIER and REFUTER consult at run time so an approved correction
 * actually changes build behavior (and its `appliedCount` advances via recordApplication).
 *
 * GOVERNANCE: only APPROVED corrections are ever loaded — a proposed-but-unapproved lesson
 * never alters a build (fail-closed). The bare role constructors default to NO-OP (no store
 * read, no behavior change), so unit tests and the exported singletons are byte-unchanged;
 * PRODUCTION (the orchestrator's verifierFor/refuterFor) wires `liveCorrectionAccess`.
 */

import type { CorrectionCategory, CorrectionEntry } from "../correction-library/contract.js";
import { listCorrections, recordApplication } from "../correction-library/store.js";

/** The narrow surface a role needs: read APPROVED corrections + record an application. */
export interface CorrectionAccess {
  /** Load APPROVED corrections (best-effort; returns [] on any error). */
  readonly listApproved: () => readonly CorrectionEntry[];
  /** Record that a correction was applied — increments appliedCount (best-effort; never throws). */
  readonly recordApplied: (id: string) => void;
}

/**
 * The DEFAULT for bare role construction: load nothing, record nothing. Keeps the exported
 * `verifier`/`refuter` singletons and every existing unit test byte-unchanged (no disk read).
 */
export const NOOP_CORRECTIONS: CorrectionAccess = {
  listApproved: () => [],
  recordApplied: () => {},
};

/**
 * LIVE store access (PRODUCTION wiring). Reads approved corrections from the correction-library
 * store and records applications back to it. Best-effort: a store read/write failure NEVER breaks
 * a build (a missing store dir simply yields no corrections).
 */
export const liveCorrectionAccess: CorrectionAccess = {
  listApproved: () => {
    try {
      return listCorrections({ approved: true });
    } catch {
      return [];
    }
  },
  recordApplied: (id: string) => {
    try {
      recordApplication(id);
    } catch {
      /* best-effort — recording an application must never fail the run */
    }
  },
};

/** Index a flat correction list by category (newest-first order preserved within each bucket). */
export function indexByCategory(entries: readonly CorrectionEntry[]): Map<CorrectionCategory, CorrectionEntry[]> {
  const map = new Map<CorrectionCategory, CorrectionEntry[]>();
  for (const e of entries) {
    const bucket = map.get(e.category);
    if (bucket) bucket.push(e);
    else map.set(e.category, [e]);
  }
  return map;
}
