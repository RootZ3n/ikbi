/**
 * ikbi frozen-core contract versioning — the unified compatibility surface.
 *
 * This phase is FORMALIZATION, not new capability: every frozen contract already
 * carries a `*_CONTRACT_VERSION`; this module makes that one consistent, checkable
 * pattern so the parallel-module phase has a single compatibility story.
 *
 * SINGLE SOURCE OF TRUTH: the version values here are IMPORTED from the contracts
 * themselves, so this registry can never drift from the real contract versions.
 *
 * THE COMPATIBILITY RULE (the frozen-rule, codified):
 *   - Versions are semantic (major.minor.patch).
 *   - ADDITIVE, backward-compatible change (a new OPTIONAL field) bumps MINOR — a
 *     module built against an older minor keeps working (it ignores the new field).
 *   - A CHANGE or REMOVAL of an existing field is BREAKING: it bumps MAJOR and
 *     requires cross-module coordination.
 *   - Therefore a module that targets `X@a.b.c` is compatible with the present
 *     `X@A.B.C` iff `A === a` (same major) AND `B.C >= b.c` (present is at least
 *     what the module expects). A different major, or a present version OLDER than
 *     the target, is incompatible — surfaced as a clear typed error, never silent
 *     drift.
 *
 * NOTE (flagged, not changed): the provider contract's version constant is named
 * `CONTRACT_VERSION` (all the others are `<NAME>_CONTRACT_VERSION`). That is a
 * frozen contract, so it is NOT renamed here; this module re-exports it under the
 * canonical `PROVIDER_CONTRACT_VERSION` name for consistency.
 */

import { CONTRACT_VERSION as PROVIDER_CONTRACT_VERSION } from "../provider/contract.js";
import { INJECTION_CONTRACT_VERSION } from "../injection/contract.js";
import { IDENTITY_CONTRACT_VERSION } from "../identity/contract.js";
import { SUBSTRATE_CONTRACT_VERSION } from "../substrate/contract.js";
import { RECEIPT_CONTRACT_VERSION } from "../receipt/contract.js";
import { TRUST_CONTRACT_VERSION } from "../trust/contract.js";
import { EVENT_CONTRACT_VERSION } from "../events/contract.js";
import { WORKSPACE_CONTRACT_VERSION } from "../workspace/contract.js";

export { PROVIDER_CONTRACT_VERSION };

/** The frozen core contracts, in dependency-ish order. */
export const CONTRACT_NAMES = [
  "provider",
  "injection",
  "identity",
  "substrate",
  "receipt",
  "trust",
  "events",
  "workspace",
] as const;

export type ContractName = (typeof CONTRACT_NAMES)[number];

/**
 * The single registry of frozen-core contract versions. Values are imported from
 * the contracts themselves — this map is generated from the source of truth, not
 * a hand-maintained copy.
 */
export const CONTRACT_VERSIONS: Readonly<Record<ContractName, string>> = Object.freeze({
  provider: PROVIDER_CONTRACT_VERSION,
  injection: INJECTION_CONTRACT_VERSION,
  identity: IDENTITY_CONTRACT_VERSION,
  substrate: SUBSTRATE_CONTRACT_VERSION,
  receipt: RECEIPT_CONTRACT_VERSION,
  trust: TRUST_CONTRACT_VERSION,
  events: EVENT_CONTRACT_VERSION,
  workspace: WORKSPACE_CONTRACT_VERSION,
});

/** A typed contract-version failure. */
export class ContractVersionError extends Error {
  readonly contract: ContractName;
  readonly expected: string;
  readonly actual: string;
  constructor(contract: ContractName, expected: string, actual: string, detail: string) {
    super(`contract "${contract}" version mismatch: module targets ${expected}, present is ${actual} — ${detail}`);
    this.name = "ContractVersionError";
    this.contract = contract;
    this.expected = expected;
    this.actual = actual;
  }
}

interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(v: string): SemVer {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (m === null) throw new Error(`invalid contract version "${v}" (expected major.minor.patch)`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Whether a module that TARGETS `target` is compatible with the PRESENT version.
 * Compatible iff same major AND present >= target (present has at least the
 * additive fields the module expects).
 */
export function isCompatible(target: string, present: string): boolean {
  const t = parseVersion(target);
  const p = parseVersion(present);
  if (t.major !== p.major) return false;
  if (p.minor !== t.minor) return p.minor > t.minor;
  return p.patch >= t.patch;
}

/** The present version of a frozen contract. */
export function contractVersion(name: ContractName): string {
  return CONTRACT_VERSIONS[name];
}

export interface CompatibilityResult {
  readonly contract: ContractName;
  readonly target: string;
  readonly present: string;
  readonly compatible: boolean;
  readonly reason: string;
}

/** Non-throwing compatibility check a module can use to inspect drift. */
export function checkCompatibility(name: ContractName, target: string): CompatibilityResult {
  const present = CONTRACT_VERSIONS[name];
  let compatible: boolean;
  let reason: string;
  try {
    compatible = isCompatible(target, present);
    reason = compatible
      ? "compatible (same major; present >= target)"
      : parseVersion(target).major !== parseVersion(present).major
        ? "breaking: major version differs"
        : "present is older than the targeted version";
  } catch (err) {
    compatible = false;
    reason = err instanceof Error ? err.message : "invalid version";
  }
  return { contract: name, target, present, compatible, reason };
}

/**
 * Assert a module is building against a compatible version of a frozen contract.
 * Throws `ContractVersionError` on mismatch (clear, typed — never silent drift).
 * Modules call this at startup to detect a contract that moved under them.
 */
export function assertContractCompatible(name: ContractName, target: string): void {
  const result = checkCompatibility(name, target);
  if (!result.compatible) {
    throw new ContractVersionError(name, target, result.present, result.reason);
  }
}
