/**
 * ikbi receipt store — lean, attributed, ordered, durable operational log.
 *
 * Built on the frozen substrate `AtomicAppendLog` (O(1) append, ordered, no
 * torn/lost lines under concurrency). SINGLE-WRITER: only the service writes
 * receipts; the CLI reads. Appends + prunes are serialized in-process under a
 * lock key DERIVED FROM THE LOG FILE PATH, so two `ReceiptStore` instances over
 * the same log are serialized by construction (no caller-supplied key can desync
 * them into duplicate seqs / dropped appends). If a CLI ever needs to WRITE
 * receipts, enable cross-process locking on the underlying log.
 *
 * Ordering survives a moving clock: `seq` is assigned from a high-water mark
 * computed as the MAX seq in the durable log (not a wall-clock value), so an NTP
 * correction or VM clock skew (even backwards) cannot cause seq reuse after a
 * restart. Retention prunes by a SEQ boundary (keep a contiguous suffix), so seq
 * continuity holds regardless of clock movement.
 *
 * APPEND-ONLY in normal operation: no mutate/update API. The ONLY deletion path
 * is `prune` — time-based wholesale hard-delete of aged receipts (no archive),
 * under the append lock, with an atomic log rewrite.
 */

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { Logger } from "pino";

import type { AgentIdentity } from "../provider/contract.js";
import { atomicWriteFile } from "../substrate/atomic.js";
import type { AtomicAppendLog } from "../substrate/append.js";
import type { LockManager } from "../substrate/lock.js";
import {
  type AgentReceiptSummary,
  type PruneResult,
  type Receipt,
  type ReceiptChange,
  RECEIPT_CONTRACT_VERSION,
  ReceiptError,
  type ReceiptInput,
  type ReceiptOutcome,
  type ReceiptQuery,
} from "./contract.js";

// Bounds for boundary-hardened append input (reject oversize/malformed).
const MAX_FIELD = 512; // ids, operation, project, role/tier/session, requestId, corrects
const MAX_TEXT = 4096; // outcome detail/error/code
const MAX_TARGET = 1024;
const MAX_CHANGES = 10_000;
const MAX_SUMMARY_BYTES = 64 * 1024; // requestSummary + metadata serialized cap
const MAX_CHANGE_FIELD_BYTES = 64 * 1024;
const VALID_STATUSES: ReadonlySet<string> = new Set(["success", "failure", "partial", "rejected"]);
const VALID_CHANGE_KINDS: ReadonlySet<string> = new Set(["file", "state", "exec", "network", "config", "other"]);
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_RETENTION_MS = 100 * ONE_YEAR_MS;

export interface ReceiptStoreDeps {
  readonly log: AtomicAppendLog<Receipt>;
  /** Path of the underlying NDJSON log file. The lock key is derived from this. */
  readonly logFile: string;
  readonly locks: LockManager;
  readonly logger: Logger;
  /** Retention window (ms). Receipts older than `now - retentionMs` are pruned. Must be > 0 and sane. */
  readonly retentionMs: number;
  /** fsync the prune rewrite. Default true. */
  readonly fsync?: boolean;
  readonly now?: () => number;
  readonly idGen?: () => string;
}

export class ReceiptStore {
  private readonly log: AtomicAppendLog<Receipt>;
  private readonly logFile: string;
  private readonly locks: LockManager;
  private readonly log_: Logger;
  private readonly appendKey: string;
  private readonly retentionMs: number;
  private readonly fsync: boolean;
  private readonly now: () => number;
  private readonly idGen: () => string;

  /** High-water seq (loaded from the durable log; kept in sync via tail catch-up). */
  private lastSeq: number | undefined;
  /** Byte offset consumed so far, for O(delta) catch-up on receipts appended elsewhere. */
  private lastOffset = 0;
  private initPromise?: Promise<void>;

  constructor(deps: ReceiptStoreDeps) {
    // Fail-safe: reject a negative/zero/absurd retention window (a negative window
    // would compute a FUTURE cutoff and wipe everything).
    if (!Number.isFinite(deps.retentionMs) || deps.retentionMs <= 0 || deps.retentionMs > MAX_RETENTION_MS) {
      throw new ReceiptError(
        "config",
        `invalid retentionMs ${String(deps.retentionMs)} (must be > 0 and <= ${MAX_RETENTION_MS})`,
      );
    }
    this.log = deps.log;
    this.logFile = deps.logFile;
    this.locks = deps.locks;
    this.log_ = deps.logger;
    // Lock key is derived from the log file — NOT caller-supplied.
    this.appendKey = `receipt:${resolve(deps.logFile)}`;
    this.retentionMs = deps.retentionMs;
    this.fsync = deps.fsync ?? true;
    this.now = deps.now ?? Date.now;
    this.idGen = deps.idGen ?? (() => randomBytes(16).toString("hex"));
  }

  /** Append a receipt for `input`, attributed to `identity`. Returns the stored receipt. */
  async append(input: ReceiptInput, identity: AgentIdentity): Promise<Receipt> {
    const id = validateIdentity(identity);
    const clean = validateInput(input);
    return this.locks.withLock(this.appendKey, async () => {
      await this.ensureInit();
      // Catch up on anything another instance appended since our last op (O(delta)),
      // so the seq is derived from the DURABLE log — two instances sharing this
      // (logfile-derived) lock can never assign a duplicate seq.
      await this.catchUp();
      const seq = this.lastSeq === undefined ? 0 : this.lastSeq + 1;

      const receipt: Receipt = {
        contractVersion: RECEIPT_CONTRACT_VERSION,
        id: this.idGen(),
        seq,
        timestamp: this.now(),
        identity: id,
        operation: clean.operation,
        ...(clean.requestSummary !== undefined ? { requestSummary: clean.requestSummary } : {}),
        outcome: clean.outcome,
        changes: clean.changes,
        ...(clean.metadata !== undefined ? { metadata: clean.metadata } : {}),
        ...(clean.requestId !== undefined ? { requestId: clean.requestId } : {}),
        ...(clean.project !== undefined ? { project: clean.project } : {}),
        ...(clean.corrects !== undefined ? { corrects: clean.corrects } : {}),
      };

      const res = await this.log.append(receipt); // durable (per IKBI_FSYNC), ordered
      this.lastSeq = seq;
      this.lastOffset = res.nextOffset;

      this.log_.info(
        {
          event: "receipt_appended",
          receiptId: receipt.id,
          seq,
          agentId: id.agentId,
          project: receipt.project,
          operation: receipt.operation,
          status: receipt.outcome.status,
          changeCount: receipt.changes.length,
        },
        "receipt appended",
      );
      return receipt;
    });
  }

  /** All receipts, in sequence order. */
  async readAll(): Promise<Receipt[]> {
    return this.log.readAll();
  }

  /** Query receipts. All clauses AND together; ordering (by seq) is preserved. */
  async query(filter: ReceiptQuery = {}): Promise<Receipt[]> {
    const all = await this.log.readAll();
    const matched = all.filter((r) => matches(r, filter));
    if (filter.limit !== undefined && filter.limit >= 0 && matched.length > filter.limit) {
      return matched.slice(matched.length - filter.limit); // keep the most recent
    }
    return matched;
  }

  /** Number of receipts currently in the log. */
  async count(): Promise<number> {
    return (await this.log.readAll()).length;
  }

  // --- trust + memory read-seam ---

  /** An agent's receipt history. */
  async agentHistory(agentId: string, opts?: Omit<ReceiptQuery, "agentId">): Promise<Receipt[]> {
    return this.query({ ...opts, agentId });
  }

  /** A summary of an agent's history for trust decisions (retention-window scoped). */
  async summarizeAgent(agentId: string): Promise<AgentReceiptSummary> {
    const receipts = await this.agentHistory(agentId);
    const byStatus: Record<ReceiptOutcome["status"], number> = { success: 0, failure: 0, partial: 0, rejected: 0 };
    const operations: Record<string, number> = {};
    for (const r of receipts) {
      byStatus[r.outcome.status] += 1;
      operations[r.operation] = (operations[r.operation] ?? 0) + 1;
    }
    const first = receipts[0];
    const last = receipts[receipts.length - 1];
    return {
      agentId,
      total: receipts.length,
      byStatus,
      operations,
      ...(first ? { firstSeq: first.seq, firstTimestamp: first.timestamp } : {}),
      ...(last ? { lastSeq: last.seq, lastTimestamp: last.timestamp } : {}),
    };
  }

  // --- retention (the ONLY deletion path) ---

  /** Hard-delete receipts older than the (validated) retention window. */
  async prune(): Promise<PruneResult> {
    return this.pruneOlderThan(this.now() - this.retentionMs);
  }

  /**
   * Hard-delete receipts older than `cutoffMs`, by a SEQ boundary: keep the
   * contiguous suffix starting at the first receipt within the window. Keeping a
   * suffix (rather than filtering by timestamp) guarantees seq continuity even if
   * the clock moved backward and timestamps are not strictly monotonic. Runs under
   * the append lock and rewrites the log atomically.
   */
  async pruneOlderThan(cutoffMs: number): Promise<PruneResult> {
    return this.locks.withLock(this.appendKey, async () => {
      await this.ensureInit();
      const all = await this.log.readAll();
      let firstKept = all.findIndex((r) => r.timestamp >= cutoffMs);
      if (firstKept === -1) firstKept = all.length; // everything is aged out
      const removed = firstKept;
      const kept = all.slice(firstKept);
      if (removed > 0) {
        const body = kept.length > 0 ? kept.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
        await atomicWriteFile(this.logFile, body, { fsync: this.fsync, logger: this.log_ });
        // The rewrite shifts byte offsets, so reset our consumed offset. High-water
        // seq is preserved (the newest, highest-seq receipts are the ones kept), so
        // a subsequent append never reuses a seq.
        let max = -1;
        for (const r of kept) if (r.seq > max) max = r.seq;
        this.lastSeq = max < 0 ? this.lastSeq : max;
        this.lastOffset = Buffer.byteLength(body, "utf8");
        this.log_.info(
          { event: "receipts_pruned", removed, kept: kept.length, cutoffMs },
          "pruned aged receipts (hard delete)",
        );
      }
      return { removed, kept: kept.length };
    });
  }

  private async ensureInit(): Promise<void> {
    if (this.initPromise === undefined) this.initPromise = this.loadHead();
    return this.initPromise;
  }

  /**
   * Load the high-water seq as the MAX seq in the durable log (clock-independent —
   * a backward clock cannot cause seq reuse after a restart), and record the
   * consumed byte offset for subsequent O(delta) catch-up.
   */
  private async loadHead(): Promise<void> {
    const { entries, nextOffset } = await this.log.readFrom(0);
    let max = -1;
    for (const r of entries) if (typeof r.seq === "number" && r.seq > max) max = r.seq;
    this.lastSeq = max < 0 ? undefined : max;
    this.lastOffset = nextOffset;
  }

  /** Absorb receipts appended to the log since our last op (e.g. by another instance). */
  private async catchUp(): Promise<void> {
    const { entries, nextOffset } = await this.log.readFrom(this.lastOffset);
    for (const r of entries) {
      if (this.lastSeq === undefined || r.seq > this.lastSeq) this.lastSeq = r.seq;
    }
    this.lastOffset = nextOffset;
  }
}

// ---------------------------------------------------------------------------
// Boundary validation (reject/bound malformed or oversized input)
// ---------------------------------------------------------------------------

function reqString(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ReceiptError("invalid_input", `${field} must be a non-empty string`);
  }
  if (v.length > max) throw new ReceiptError("invalid_input", `${field} exceeds ${max} chars`);
  return v;
}

function boundedRecord(v: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ReceiptError("invalid_input", `${field} must be an object`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(v);
  } catch (cause) {
    throw new ReceiptError("invalid_input", `${field} is not JSON-serializable`, { cause });
  }
  if (serialized.length > MAX_SUMMARY_BYTES) {
    throw new ReceiptError("invalid_input", `${field} exceeds ${MAX_SUMMARY_BYTES} bytes`);
  }
  return v as Record<string, unknown>;
}

function serializedBytes(v: unknown, field: string, max: number): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(v);
  } catch (cause) {
    throw new ReceiptError("invalid_input", `${field} is not JSON-serializable`, { cause });
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > max) throw new ReceiptError("invalid_input", `${field} exceeds ${max} bytes`);
  return bytes;
}

function boundedOptionalRecord(v: unknown, field: string, max = MAX_CHANGE_FIELD_BYTES): Readonly<Record<string, unknown>> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ReceiptError("invalid_input", `${field} must be an object`);
  }
  serializedBytes(v, field, max);
  return v as Record<string, unknown>;
}

function boundedBoolean(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new ReceiptError("invalid_input", `${field} must be a boolean`);
  return v;
}

function boundedNonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new ReceiptError("invalid_input", `${field} must be a non-negative safe integer`);
  }
  return v;
}

function validateStateRef(v: unknown, field: string): NonNullable<ReceiptChange["before"]> {
  const r = boundedOptionalRecord(v, field);
  if (r === undefined) throw new ReceiptError("invalid_input", `${field} must be an object`);
  return {
    ...(r.existed !== undefined ? { existed: boundedBoolean(r.existed, `${field}.existed`) } : {}),
    ...(r.hash !== undefined ? { hash: boundedString(r.hash, `${field}.hash`, MAX_FIELD) } : {}),
    ...(r.ref !== undefined ? { ref: boundedString(r.ref, `${field}.ref`, MAX_FIELD) } : {}),
    ...(r.bytes !== undefined ? { bytes: boundedNonNegativeInt(r.bytes, `${field}.bytes`) } : {}),
  };
}

function validateInverse(v: unknown, field: string): NonNullable<ReceiptChange["inverse"]> {
  const r = boundedOptionalRecord(v, field);
  if (r === undefined) throw new ReceiptError("invalid_input", `${field} must be an object`);
  const args = r.args !== undefined ? boundedOptionalRecord(r.args, `${field}.args`) : undefined;
  return {
    operation: reqString(r.operation, `${field}.operation`, MAX_FIELD),
    ...(args !== undefined ? { args } : {}),
  };
}

function validateIdentity(identity: AgentIdentity): AgentIdentity {
  if (typeof identity !== "object" || identity === null) {
    throw new ReceiptError("invalid_input", "identity must be an AgentIdentity object");
  }
  return {
    agentId: reqString(identity.agentId, "identity.agentId", MAX_FIELD),
    ...(identity.functionalRole !== undefined
      ? { functionalRole: reqString(identity.functionalRole, "identity.functionalRole", MAX_FIELD) }
      : {}),
    ...(identity.trustTier !== undefined ? { trustTier: reqString(identity.trustTier, "identity.trustTier", MAX_FIELD) } : {}),
    ...(identity.sessionId !== undefined ? { sessionId: reqString(identity.sessionId, "identity.sessionId", MAX_FIELD) } : {}),
    ...(identity.spawnedFrom !== undefined ? { spawnedFrom: reqString(identity.spawnedFrom, "identity.spawnedFrom", MAX_FIELD) } : {}),
  };
}

interface CleanInput {
  operation: string;
  outcome: ReceiptOutcome;
  changes: readonly ReceiptChange[];
  requestSummary?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  requestId?: string;
  project?: string;
  corrects?: string;
}

/** A string field that may be empty but must be a string within bounds. */
function boundedString(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") throw new ReceiptError("invalid_input", `${field} must be a string`);
  if (v.length > max) throw new ReceiptError("invalid_input", `${field} exceeds ${max} chars`);
  return v;
}

function validateOutcome(v: unknown): ReceiptOutcome {
  if (typeof v !== "object" || v === null) throw new ReceiptError("invalid_input", "outcome must be an object");
  const o = v as Record<string, unknown>;
  if (typeof o.status !== "string" || !VALID_STATUSES.has(o.status)) {
    throw new ReceiptError("invalid_input", `outcome.status must be one of ${[...VALID_STATUSES].join("/")}`);
  }
  return {
    status: o.status as ReceiptOutcome["status"],
    ...(o.detail !== undefined ? { detail: boundedString(o.detail, "outcome.detail", MAX_TEXT) } : {}),
    ...(o.error !== undefined ? { error: boundedString(o.error, "outcome.error", MAX_TEXT) } : {}),
    ...(o.code !== undefined ? { code: boundedString(o.code, "outcome.code", MAX_FIELD) } : {}),
  };
}

function validateChanges(v: unknown): readonly ReceiptChange[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ReceiptError("invalid_input", "changes must be an array");
  if (v.length > MAX_CHANGES) throw new ReceiptError("invalid_input", `changes exceeds ${MAX_CHANGES} entries`);
  const out: ReceiptChange[] = [];
  for (let i = 0; i < v.length; i += 1) {
    const c = v[i];
    if (typeof c !== "object" || c === null) throw new ReceiptError("invalid_input", "each change must be an object");
    const ch = c as Record<string, unknown>;
    const kind = reqString(ch.kind, `changes[${i}].kind`, MAX_FIELD);
    if (!VALID_CHANGE_KINDS.has(kind)) {
      throw new ReceiptError("invalid_input", `changes[${i}].kind must be one of ${[...VALID_CHANGE_KINDS].join("/")}`);
    }
    const clean: ReceiptChange = {
      kind: kind as ReceiptChange["kind"],
      target: reqString(ch.target, `changes[${i}].target`, MAX_TARGET),
      ...(ch.before !== undefined ? { before: validateStateRef(ch.before, `changes[${i}].before`) } : {}),
      ...(ch.after !== undefined ? { after: validateStateRef(ch.after, `changes[${i}].after`) } : {}),
      ...(ch.inverse !== undefined ? { inverse: validateInverse(ch.inverse, `changes[${i}].inverse`) } : {}),
      ...(ch.summary !== undefined ? { summary: boundedString(ch.summary, `changes[${i}].summary`, MAX_TEXT) } : {}),
    };
    serializedBytes(clean, `changes[${i}]`, MAX_CHANGE_FIELD_BYTES);
    out.push(clean);
  }
  serializedBytes(out, "changes", MAX_CHANGE_FIELD_BYTES);
  return out;
}

function validateInput(input: ReceiptInput): CleanInput {
  if (typeof input !== "object" || input === null) {
    throw new ReceiptError("invalid_input", "receipt input must be an object");
  }
  return {
    operation: reqString(input.operation, "operation", MAX_FIELD),
    outcome: validateOutcome(input.outcome),
    changes: validateChanges(input.changes),
    ...(input.requestSummary !== undefined ? { requestSummary: boundedRecord(input.requestSummary, "requestSummary") } : {}),
    ...(input.metadata !== undefined ? { metadata: boundedRecord(input.metadata, "metadata") } : {}),
    ...(input.requestId !== undefined ? { requestId: boundedString(input.requestId, "requestId", MAX_FIELD) } : {}),
    ...(input.project !== undefined ? { project: boundedString(input.project, "project", MAX_FIELD) } : {}),
    ...(input.corrects !== undefined ? { corrects: boundedString(input.corrects, "corrects", MAX_FIELD) } : {}),
  };
}

function matches(r: Receipt, f: ReceiptQuery): boolean {
  if (f.agentId !== undefined && r.identity.agentId !== f.agentId) return false;
  if (f.project !== undefined && r.project !== f.project) return false;
  if (f.operation !== undefined && r.operation !== f.operation) return false;
  if (f.status !== undefined && r.outcome.status !== f.status) return false;
  if (f.fromTime !== undefined && r.timestamp < f.fromTime) return false;
  if (f.toTime !== undefined && r.timestamp > f.toTime) return false;
  if (f.fromSeq !== undefined && r.seq < f.fromSeq) return false;
  if (f.toSeq !== undefined && r.seq > f.toSeq) return false;
  return true;
}
