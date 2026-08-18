/**
 * ikbi v2 — THE IDENTITY VOCABULARY.
 *
 * v2's first architectural commitment: nothing in the lifecycle is correlated by
 * "these two things happen to point at the same workspace". Every concept that a
 * later slice must be able to BIND to (a task, a run, a model invocation, a
 * workspace, a candidate, an observed file state, a verification verdict, a
 * promotion, a receipt) gets its OWN opaque, branded identifier.
 *
 * WHY BRANDED: TypeScript's structural typing would happily let a `CandidateId`
 * be passed where a `VerificationId` is expected if both were `string`. That is
 * exactly the class of bug that made v1's authority hard to audit — a promote
 * riding a verdict that belonged to a different tree. A brand makes the mix-up a
 * COMPILE error, and the parse functions make an unbranded string from the outside
 * world (CLI arg, JSON body, receipt on disk) impossible to smuggle in unchecked.
 *
 * WHY THIS SET (and not more): later slices will need more identities (attempt,
 * recovery, gate decision, cost entry). They are deliberately NOT invented here —
 * an unused identity is a guess. What IS fixed here is the FORMAT and the minting
 * seam, so a later identity is additive and can never be an incompatible shape.
 *
 * This module has no dependencies inside ikbi. It is the bottom of the v2 stack.
 */

import { createHash, randomUUID } from "node:crypto";

/** Brand carrier. Never exists at runtime — the emitted value is a plain string. */
declare const V2_ID_BRAND: unique symbol;

/** An opaque, nominally-typed v2 identifier. */
export type V2Id<TKind extends string> = string & { readonly [V2_ID_BRAND]: TKind };

/** The unit of OPERATOR INTENT: one goal. Stable across retries and across runs. */
export type V2TaskId = V2Id<"task">;
/** ONE execution of a task through the canonical lifecycle. A retry is a new run. */
export type V2RunId = V2Id<"run">;
/** ONE model invocation. Exists so cost/provider truth can never be attributed by guesswork. */
export type V2InvocationId = V2Id<"invocation">;
/** ONE isolated mutation space (a worktree, in the v1 donor). */
export type V2WorkspaceId = V2Id<"workspace">;
/**
 * ONE proposed body of work. A task may have MANY (shadow, tournament) — see contract.ts.
 *
 * V2-007 made this CONTENT-ADDRESSED rather than minted. A candidate is not an event that
 * happened to occur; it is the exact resulting state produced from an exact source state
 * by exact mutations. Two runs that arrive at the same work ARE the same candidate, and a
 * minted id would have hidden that — which is precisely what a tournament needs to see.
 */
export type V2CandidateId = V2Digest<"candidate">;
/** ONE observation of exact file state — the anchor a state-bound mutation compares against. */
export type V2ObservationId = V2Id<"observation">;
/** ONE verification verdict, bound to the candidate it judged. */
export type V2VerificationId = V2Id<"verification">;
/** ONE promotion attempt. */
export type V2PromotionId = V2Id<"promotion">;
/** ONE receipt record. */
export type V2ReceiptId = V2Id<"receipt">;

/** The identity kinds v2 knows about, and the string prefix each id carries. */
export const V2_ID_PREFIXES = {
  task: "task",
  run: "run",
  invocation: "inv",
  workspace: "ws",
  candidate: "cand",
  observation: "obs",
  verification: "ver",
  promotion: "promo",
  receipt: "rcpt",
} as const;

/** The identity kind names (the keys of `V2_ID_PREFIXES`). */
export type V2IdKind = keyof typeof V2_ID_PREFIXES;

/** The token half of an id: url/path/branch-safe, long enough not to collide. */
const ID_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** Is `raw` a well-formed id of exactly `kind`? (Prefix AND token both checked.) */
export function isV2Id<K extends V2IdKind>(kind: K, raw: string): boolean {
  const prefix = V2_ID_PREFIXES[kind];
  if (!raw.startsWith(`${prefix}_`)) return false;
  return ID_TOKEN_PATTERN.test(raw.slice(prefix.length + 1));
}

/** Thrown when an outside-world string is not a valid id of the expected kind. Fail-closed. */
export class V2IdentityError extends Error {
  readonly kind: V2IdKind;
  readonly raw: string;
  constructor(kind: V2IdKind, raw: string) {
    super(`not a valid v2 ${kind} id: ${JSON.stringify(raw)}`);
    this.name = "V2IdentityError";
    this.kind = kind;
    this.raw = raw;
  }
}

/**
 * Parse an untrusted string into a branded id. THE ONLY sanctioned way to obtain a
 * branded id from data that came from outside the process (CLI, HTTP, a receipt on
 * disk). Throws rather than returning a degraded value — an unidentifiable record is
 * never silently adopted.
 */
export function parseV2Id<K extends V2IdKind>(kind: K, raw: string): V2Id<K> {
  if (!isV2Id(kind, raw)) throw new V2IdentityError(kind, raw);
  return raw as V2Id<K>;
}

/**
 * The id-minting seam. Production uses `randomUUID`; tests inject a deterministic
 * token source so a run's journal/receipt is byte-comparable. The FACTORY is what
 * later slices depend on — never `randomUUID` directly — so run identity always has
 * exactly one owner.
 */
export interface V2IdFactory {
  mint<K extends V2IdKind>(kind: K): V2Id<K>;
}

/** Build an id factory over a token source (default: a random UUID per id). */
export function createIdFactory(nextToken: () => string = randomUUID): V2IdFactory {
  return {
    mint<K extends V2IdKind>(kind: K): V2Id<K> {
      const token = nextToken();
      const id = `${V2_ID_PREFIXES[kind]}_${token}`;
      if (!isV2Id(kind, id)) throw new V2IdentityError(kind, id);
      return id as V2Id<K>;
    },
  };
}

// ---------------------------------------------------------------------------
// Content digests — DERIVED identity, not minted identity
// ---------------------------------------------------------------------------

/** Brand carrier for content-addressed digests. Erased at runtime. */
declare const V2_DIGEST_BRAND: unique symbol;

/**
 * A CONTENT-ADDRESSED identity: sha256 of a canonical serialization.
 *
 * Deliberately a separate species from `V2Id`. A minted id answers "which one is
 * this?" and is unique per occurrence; a digest answers "what is this made of?" and
 * is stable across runs whenever the content is. Configuration uses digests so a
 * receipt can say "this run used THIS normalized configuration" and two runs of the
 * same configuration say the same thing.
 */
export type V2Digest<TKind extends string> = string & { readonly [V2_DIGEST_BRAND]: TKind };

/** Digest of a normalized provider inventory. */
export type V2InventoryDigest = V2Digest<"inventory">;
/** Digest of a resolved, normalized profile. */
export type V2ProfileDigest = V2Digest<"profile">;
/** Digest of a complete runtime model policy — the id the model resolver receives. */
export type V2PolicyDigest = V2Digest<"policy">;
/** Digest of one authorized model-resolution decision. */
export type V2DecisionDigest = V2Digest<"decision">;
/** Digest of one assembled context package. */
export type V2ContextDigest = V2Digest<"context">;
/** Digest of one context artifact's observed content. */
export type V2ArtifactDigest = V2Digest<"artifact">;
/** Digest of the exact model input placed on the wire. */
export type V2PromptDigest = V2Digest<"prompt">;
/** Digest of one exact observation of workspace file state. */
export type V2ObservationDigest = V2Digest<"observation">;
/** Digest of one applied mutation. */
export type V2MutationDigest = V2Digest<"mutation">;
/** Digest of one captured source snapshot — the state a run started from. */
export type V2SnapshotDigest = V2Digest<"snapshot">;
/** Digest of one deterministic retrieval: which source, which query, which ranking. */
export type V2RetrievalDigest = V2Digest<"retrieval">;

/**
 * Canonical JSON: object keys sorted, `undefined` dropped, array ORDER PRESERVED
 * (order is semantic wherever v2 keeps an array — e.g. a model's fallback chain).
 * Callers that hold an unordered collection must sort it themselves BEFORE hashing,
 * so the choice of what counts as semantic ordering stays visible at the call site.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value === undefined ? null : value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const v = source[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/**
 * Content digest of a value. NEVER pass credential material to this — a digest is
 * published in receipts and CLI output, and a hash of a secret is still a fact about
 * the secret. The configuration layer strips credentials before it gets here.
 */
export function contentDigest<K extends string>(_kind: K, value: unknown): V2Digest<K> {
  return createHash("sha256").update(canonicalJson(value)).digest("hex") as V2Digest<K>;
}

/** A counter-based factory for deterministic tests (`task_seed-00000001`, …). */
export function createSequentialIdFactory(seed = "seed"): V2IdFactory {
  let n = 0;
  return createIdFactory(() => {
    n += 1;
    return `${seed}-${String(n).padStart(8, "0")}`;
  });
}
