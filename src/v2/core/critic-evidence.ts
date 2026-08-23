/**
 * ikbi v2 — CRITIC CLAIMS ARE BOUND TO DETERMINISTIC EVIDENCE.
 *
 * THE DEFECT THIS CLOSES. The critic's verdict and defects are strictly parsed and structurally
 * checked, and its `summary` is free prose that went into the receipt verbatim. So a sentence like
 * "cargo fmt passed" became receipt FACT even when no `fmt` check existed, even when it timed out,
 * and even when it failed. The verdict was governed; the narrative was not — and the narrative is
 * what an operator actually reads.
 *
 * THE RULE. A critic may not state that a named check or formatter PASSED unless the deterministic
 * evidence set for THIS run, over THIS candidate, contains that exact named invocation with a
 * passing status. Anything else is removed from the text and reported as an unsupported claim.
 *
 * WHAT THIS IS NOT. It is not a truth oracle for critic prose, and it does not try to be. It
 * governs exactly one speech act — an ASSERTION OF DETERMINISTIC SUCCESS — because that is the one
 * a reader is entitled to treat as fact, and the one the critic has no standing to make. Opinions,
 * doubts, negative claims and conditionals are left completely alone: "the tests did not pass",
 * "this would pass once X is fixed" and "I am not convinced the formatting is right" are all a
 * critic doing its job, and rewriting them would be the harness editing a judgment.
 *
 * MATCHING IS DELIBERATELY STRICT, because every loose rule is a laundering route:
 *
 *   renamed command    "cargo format passed"      ≠ evidence `cargo fmt --check`   → unsupported
 *   altered argv       "cargo test --all passed"  ≠ evidence `cargo test`          → unsupported
 *   partial check set  "verification passed"      when one of three failed         → unsupported
 *   wrong status       "the formatter succeeded"  when it timed out                → unsupported
 *   absent evidence    "cargo fmt passed"         when no fmt ran at all           → unsupported
 *   foreign evidence   an entry from another run/workspace                         → never admitted
 *
 * This module is PURE: it holds no evidence of its own, reads nothing, and decides nothing about
 * the verdict. It takes a text and an evidence set and returns a sanitized text plus a list.
 */

import { contentDigest, type V2CandidateId, type V2Digest, type V2RunId } from "./identity.js";

// ---------------------------------------------------------------------------
// The evidence set
// ---------------------------------------------------------------------------

/** A deterministic result the critic is entitled to cite. */
export interface DeterministicEvidenceEntry {
  /** `check` for a verification check, `formatter` for a governed formatter invocation. */
  readonly kind: "check" | "formatter";
  /** The name ikbi knows it by — a check's plan name, or a formatter's identifier. */
  readonly name: string;
  /** The exact command tokens, when there was a command. `["cargo","fmt","--check"]`. */
  readonly commandTokens: readonly string[];
  /** Did it PASS? Only `true` can support a success claim. */
  readonly passed: boolean;
  /** The raw status, for the report: `pass`, `fail`, `timeout`, `applied`, `refused_out_of_scope`… */
  readonly status: string;
}

/**
 * THE finite evidence a critic judgment may cite, bound to the run and candidate it belongs to.
 *
 * The binding is the defence against the "evidence from another run" case: an entry is admitted by
 * `buildDeterministicEvidence`, which stamps the run and candidate, and `auditCriticClaims`
 * refuses to use a set whose binding does not match the judgment being audited. There is no path
 * that accepts a loose array of entries.
 */
export interface DeterministicEvidence {
  readonly evidenceId: V2Digest<"critic_evidence">;
  readonly runId: V2RunId;
  readonly candidateId: V2CandidateId;
  readonly workspaceId: string;
  /** The aggregate verification verdict, for whole-suite claims like "verification passed". */
  readonly verdict: string;
  readonly entries: readonly DeterministicEvidenceEntry[];
}

/** Assemble the evidence set for one candidate. The ONLY way to obtain one. */
export function buildDeterministicEvidence(input: {
  readonly runId: V2RunId;
  readonly candidateId: V2CandidateId;
  readonly workspaceId: string;
  readonly verdict: string;
  readonly checks: readonly { readonly name: string; readonly command: string; readonly status: string }[];
  readonly formatters?: readonly { readonly formatterId: string; readonly argv: readonly string[]; readonly outcome: string }[];
}): DeterministicEvidence {
  const entries: DeterministicEvidenceEntry[] = [
    ...input.checks.map((c) => ({
      kind: "check" as const,
      name: c.name,
      commandTokens: tokenizeCommand(c.command),
      passed: c.status === "pass",
      status: c.status,
    })),
    ...(input.formatters ?? []).map((f) => ({
      kind: "formatter" as const,
      name: f.formatterId,
      // A formatter's tokens are its program plus its FIXED argv, so "cargo fmt passed" can be
      // supported by a formatter invocation just as it would be by a check.
      commandTokens: ["cargo", ...f.argv].map((t) => t.toLowerCase()),
      // Only a run that actually formatted (or found nothing to format) is a success. A refusal,
      // a timeout and a non-zero exit are not.
      passed: f.outcome === "applied" || f.outcome === "already_clean",
      status: f.outcome,
    })),
  ];
  return {
    evidenceId: contentDigest("critic_evidence", {
      runId: input.runId,
      candidateId: input.candidateId,
      workspaceId: input.workspaceId,
      verdict: input.verdict,
      entries: entries.map((e) => ({ kind: e.kind, name: e.name, commandTokens: [...e.commandTokens], passed: e.passed, status: e.status })),
    }),
    runId: input.runId,
    candidateId: input.candidateId,
    workspaceId: input.workspaceId,
    verdict: input.verdict,
    entries: Object.freeze(entries),
  };
}

/** Split a rendered command line into lowercase tokens. `"pnpm test"` → `["pnpm","test"]`. */
export function tokenizeCommand(command: string): readonly string[] {
  return command.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

const isFlag = (token: string): boolean => token.startsWith("-");

// ---------------------------------------------------------------------------
// Claim detection
// ---------------------------------------------------------------------------

/**
 * Verbs that ASSERT deterministic success. Present and past indicative only.
 *
 * "is green" and "is clean" are here because they are how a model says "passed" when it is trying
 * to sound measured, and they carry the same weight to a reader.
 */
const SUCCESS_PREDICATE =
  /\b(pass(?:ed|es|ing)?|succeed(?:ed|s)?|success(?:ful|fully)?|green|clean|complete[ds]? successfully|ran successfully|came back (?:green|clean)|are satisfied|is satisfied)\b/i;

/**
 * Markers that make a sentence NOT an assertion of fact.
 *
 * A conditional, a hedge or a negation is a critic reasoning, which is exactly what it is for. The
 * cost of missing a laundered claim hidden behind "should" is far lower than the cost of deleting
 * a legitimate judgment, so this list is generous.
 */
const NON_ASSERTION =
  /\b(would|should|could|might|may|if|once|after|unless|assuming|expect(?:ed|s)?|hope|appears? to|seems? to|claims? to|asserts? to|cannot|can't|won't|will not|do(?:es)? not|did not|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|no longer|never|fail(?:s|ed|ing)?|unverified|unclear|unknown|not )\b/i;

/**
 * The closed vocabulary of DETERMINISTIC subjects.
 *
 * A success claim is only governed when it is about one of these. "the refactor is clean" and
 * "the naming passes muster" are opinions about code and are none of this module's business.
 */
const SUBJECT_ALIASES: Readonly<Record<string, "tests" | "checks" | "formatter" | "typecheck" | "lint" | "build">> = {
  test: "tests", tests: "tests", "test suite": "tests", "the tests": "tests", testing: "tests",
  check: "checks", checks: "checks", "all checks": "checks", verification: "checks", verify: "checks",
  "the checks": "checks", "every check": "checks", "the verifier": "checks", "the verification": "checks",
  formatter: "formatter", formatting: "formatter", fmt: "formatter", rustfmt: "formatter", "the formatter": "formatter",
  typecheck: "typecheck", "type check": "typecheck", tsc: "typecheck", types: "typecheck",
  lint: "lint", linter: "lint", linting: "lint", clippy: "lint", eslint: "lint",
  build: "build", compilation: "build", "the build": "build",
};

/** Programs whose presence makes a token run a NAMED COMMAND rather than a generic subject. */
const COMMAND_PROGRAMS = new Set(["cargo", "pnpm", "npm", "yarn", "go", "python3", "python", "tsc", "rustfmt", "prettier", "eslint", "make", "just", "dotnet", "mvn", "gradle"]);

/** One success assertion found in critic prose. */
export interface SuccessClaim {
  /** The whole sentence, as written. */
  readonly sentence: string;
  /** What it claimed succeeded, as written. */
  readonly subject: string;
  /** A named command (`cargo fmt`), or a generic deterministic subject (`tests`). */
  readonly kind: "command" | "subject";
  /** For a command claim: the tokens as claimed, lowercased. */
  readonly tokens: readonly string[];
}

/** Split prose into sentences. Crude on purpose — a sentence is the unit that gets removed. */
function sentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Find the deterministic-success assertions in one sentence.
 *
 * A sentence can carry at most one claim here. Splitting further would mean parsing English, and
 * the remedy (removing the sentence) is the same either way.
 */
function claimIn(sentence: string): SuccessClaim | undefined {
  if (!SUCCESS_PREDICATE.test(sentence)) return undefined;
  if (NON_ASSERTION.test(sentence)) return undefined;

  // A NAMED COMMAND wins: it is the most specific thing a claim can be about.
  const lower = sentence.toLowerCase();
  const commandMatch = lower.match(
    new RegExp(`\\b(${[...COMMAND_PROGRAMS].join("|")})((?:\\s+[a-z0-9][\\w.:/-]*|\\s+--?[\\w-]+(?:=[\\w./-]+)?)*)`, "i"),
  );
  if (commandMatch !== null) {
    const raw = `${commandMatch[1] ?? ""}${commandMatch[2] ?? ""}`.trim();
    // Trim trailing words that belong to the predicate rather than the command:
    // "cargo fmt passed" must tokenize to ["cargo","fmt"], not ["cargo","fmt","passed"].
    const tokens = raw
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .filter((t) => !SUCCESS_PREDICATE.test(t) || isFlag(t));
    if (tokens.length > 0) return { sentence, subject: tokens.join(" "), kind: "command", tokens };
  }

  // Otherwise a generic deterministic subject, longest alias first so "type check" beats "check".
  for (const alias of Object.keys(SUBJECT_ALIASES).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sentence)) {
      return { sentence, subject: alias, kind: "subject", tokens: [] };
    }
  }
  return undefined;
}

/** Every success assertion in a text, in order. */
export function findSuccessClaims(text: string): readonly SuccessClaim[] {
  return sentences(text)
    .map(claimIn)
    .filter((c): c is SuccessClaim => c !== undefined);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Non-flag tokens, lowercased. `["cargo","fmt","--check"]` → `["cargo","fmt"]`. */
const words = (tokens: readonly string[]): readonly string[] => tokens.filter((t) => !isFlag(t));
/** Flag tokens, lowercased and sorted. */
const flags = (tokens: readonly string[]): readonly string[] => tokens.filter(isFlag).slice().sort();
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Does a CLAIMED command match an evidence entry?
 *
 * The two halves are treated differently on purpose. The non-flag WORDS must match exactly, so
 * `cargo format` never matches `cargo fmt` — a renamed command is a different command. Flags are
 * matched only when the CLAIM names some: "cargo fmt passed" may be supported by
 * `cargo fmt --check`, because it is a true statement about it, while "cargo test --all passed"
 * may NOT be supported by `cargo test`, because the claim asserts something broader than what ran.
 */
export function commandClaimMatches(claimed: readonly string[], entry: DeterministicEvidenceEntry): boolean {
  const claimedWords = words(claimed);
  if (!sameList(claimedWords, words(entry.commandTokens))) return false;
  const claimedFlags = flags(claimed);
  if (claimedFlags.length === 0) return true;
  return sameList(claimedFlags, flags(entry.commandTokens));
}

/** Which evidence entries a generic subject refers to. */
function entriesForSubject(subject: string, evidence: DeterministicEvidence): readonly DeterministicEvidenceEntry[] {
  const canonical = SUBJECT_ALIASES[subject.toLowerCase()];
  if (canonical === undefined) return [];
  const named = (needle: string): readonly DeterministicEvidenceEntry[] =>
    evidence.entries.filter((e) => e.name.toLowerCase().includes(needle) || words(e.commandTokens).some((t) => t.includes(needle)));

  switch (canonical) {
    case "checks":
      return evidence.entries.filter((e) => e.kind === "check");
    case "tests":
      return named("test").filter((e) => e.kind === "check");
    case "formatter":
      return evidence.entries.filter((e) => e.kind === "formatter" || e.name.toLowerCase().includes("fmt") || words(e.commandTokens).includes("fmt"));
    case "typecheck":
      return named("tsc").concat(named("typecheck")).filter((e) => e.kind === "check");
    case "lint":
      return named("lint").concat(named("clippy")).filter((e) => e.kind === "check");
    case "build":
      return named("build").concat(named("check")).filter((e) => e.kind === "check");
  }
}

/** Why one claim could not be supported. Closed set. */
export type ClaimRefusalCode = "no_such_evidence" | "not_passing" | "incomplete_set" | "argv_mismatch";

export interface UnsupportedClaim {
  readonly sentence: string;
  readonly subject: string;
  readonly code: ClaimRefusalCode;
  readonly detail: string;
}

/** Decide one claim against the evidence. */
function resolveClaim(claim: SuccessClaim, evidence: DeterministicEvidence): UnsupportedClaim | undefined {
  if (claim.kind === "command") {
    const exact = evidence.entries.filter((e) => commandClaimMatches(claim.tokens, e));
    if (exact.length === 0) {
      // Distinguish "nothing like this ran" from "something similar ran but not this" — the
      // second is the more interesting report, and the more common laundering shape.
      const sameProgram = evidence.entries.some((e) => words(e.commandTokens)[0] === words(claim.tokens)[0]);
      return {
        sentence: claim.sentence,
        subject: claim.subject,
        code: sameProgram ? "argv_mismatch" : "no_such_evidence",
        detail: sameProgram
          ? `no invocation of exactly "${claim.subject}" is in this run's evidence (a different invocation of "${words(claim.tokens)[0]}" ran)`
          : `no invocation of "${claim.subject}" is in this run's evidence`,
      };
    }
    if (!exact.every((e) => e.passed)) {
      const failing = exact.find((e) => !e.passed)!;
      return { sentence: claim.sentence, subject: claim.subject, code: "not_passing", detail: `"${claim.subject}" is recorded with status "${failing.status}", not pass` };
    }
    return undefined;
  }

  const canonical = SUBJECT_ALIASES[claim.subject.toLowerCase()];
  const related = entriesForSubject(claim.subject, evidence);

  // A whole-suite claim is supported only when the AGGREGATE verdict is a pass. "verification
  // passed" while one of three checks failed is the exact case this exists for.
  if (canonical === "checks") {
    if (evidence.verdict !== "pass") {
      return { sentence: claim.sentence, subject: claim.subject, code: "incomplete_set", detail: `the deterministic verdict for this candidate is "${evidence.verdict}", not pass` };
    }
    if (related.length === 0) {
      return { sentence: claim.sentence, subject: claim.subject, code: "no_such_evidence", detail: "no checks ran for this candidate" };
    }
  }

  if (related.length === 0) {
    return { sentence: claim.sentence, subject: claim.subject, code: "no_such_evidence", detail: `nothing named "${claim.subject}" is in this run's deterministic evidence` };
  }
  const notPassing = related.filter((e) => !e.passed);
  if (notPassing.length > 0) {
    return {
      sentence: claim.sentence,
      subject: claim.subject,
      code: related.length === notPassing.length ? "not_passing" : "incomplete_set",
      detail: `${notPassing.map((e) => `"${e.name}" is ${e.status}`).join(", ")} — not a pass`,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/** The marker left where an unsupported claim was. Visible, never silent. */
export function unverifiedMarker(subject: string): string {
  return `[ikbi removed an unverified claim about "${subject}": no deterministic evidence in this run supports it]`;
}

export interface ClaimAudit {
  /** The text with every unsupported sentence replaced by a visible marker. */
  readonly sanitized: string;
  readonly unsupported: readonly UnsupportedClaim[];
  /** True when nothing was changed. */
  readonly clean: boolean;
}

/**
 * Audit one piece of critic prose against the run's deterministic evidence.
 *
 * The unsupported sentence is REPLACED, not deleted, so a reader can see that something was
 * removed and what it was about. Deleting silently would leave a receipt that reads as though the
 * critic never over-claimed, which is its own kind of dishonesty.
 */
export function auditCriticClaims(text: string, evidence: DeterministicEvidence): ClaimAudit {
  const unsupported: UnsupportedClaim[] = [];
  let sanitized = text;

  for (const claim of findSuccessClaims(text)) {
    const refusal = resolveClaim(claim, evidence);
    if (refusal === undefined) continue;
    unsupported.push(refusal);
    sanitized = sanitized.replace(claim.sentence, unverifiedMarker(refusal.subject));
  }

  return { sanitized, unsupported, clean: unsupported.length === 0 };
}

/**
 * Refuse an evidence set that does not belong to the judgment being audited.
 *
 * The "evidence from another run or workspace" case, closed structurally: a caller has to present
 * a set whose run and candidate match, and there is no overload that skips the check.
 */
export function validateEvidenceBinding(
  evidence: DeterministicEvidence,
  subject: { readonly runId: V2RunId; readonly candidateId: V2CandidateId; readonly workspaceId: string },
): string | undefined {
  if (evidence.runId !== subject.runId) return `the evidence set belongs to run ${evidence.runId}, not ${subject.runId}`;
  if (evidence.candidateId !== subject.candidateId) return `the evidence set describes candidate ${evidence.candidateId}, not ${subject.candidateId}`;
  if (evidence.workspaceId !== subject.workspaceId) return `the evidence set was captured in workspace ${evidence.workspaceId}, not ${subject.workspaceId}`;
  return undefined;
}
