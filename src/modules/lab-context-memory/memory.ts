/**
 * ikbi lab-context-memory — the shared lab-memory store (factory + methods).
 *
 * Cross-agent by design: `byProject` returns every agent's contributions to a
 * project. ikbi populates it via `projectFromReceipts`, which STRUCTURALLY redacts —
 * it reads only operation / outcome.status / change.kind / change.target / agentId /
 * project / timestamp / seq from a receipt and NEVER its freeform metadata or
 * requestSummary (those would outlive the ≤30-day receipts they came from).
 *
 * Direct `record()` keeps the open `value` shape, but because memory is DURABLE (no TTL),
 * it SCRUBS secret-shaped content and CAPS the value size before persisting (H7) — the
 * store never holds a raw secret, and the returned entry reflects the scrubbed value.
 *
 * Durable via a substrate DocumentStore (concurrency-safe, keyed by entry id).
 */

import { createHash } from "node:crypto";

import { createDocumentStore } from "../../core/substrate/index.js";
import { isValidatedIdentity } from "../../core/identity/index.js";
import type { ValidatedIdentity } from "../../core/identity/index.js";
import type { AgentIdentity } from "../../core/identity/contract.js";
import { events as coreEvents } from "../../core/events/index.js";
import type { EventInput } from "../../core/events/index.js";
import { receipts as coreReceipts } from "../../core/receipt/index.js";
import type { Receipt, ReceiptQuery } from "../../core/receipt/contract.js";
import { labContextMemoryConfig, type LabContextMemoryConfig } from "./config.js";
import { labmemProjected, labmemQueried, labmemRecorded, type LabMemEventPayload } from "./events.js";
import { scrubSecrets, valueByteSize } from "./redaction.js";
import {
  LabMemoryError,
  type LabMemory,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryKind,
  type MemoryQuery,
  type ProjectFromReceiptsOptions,
} from "./contract.js";

const EVENT_SOURCE = "lab-context-memory";
const RECORD_OPERATION = "labmem.record";

/** Entry ids permit ":" (the component separator) on top of the store's safe charset. */
const MEMORY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** Sanitize an id component to the safe charset (filesystem + traversal safe), capped for readability. */
function slug(s: string, cap = 32): string {
  const out = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, cap);
  return out.length > 0 ? out : "_";
}

/**
 * Short stable hash of the FULL (untruncated) id tuple. The readable slug prefix truncates and collapses
 * to a safe charset, so two long/similar components (e.g. two repo paths sharing a 32-char prefix, or
 * differing only by a stripped character) would map to the SAME slug — silently MERGING two distinct
 * baselines. The hash suffix is computed over the untruncated raw components, so distinct tuples always
 * get distinct ids (drift baseline C2). Length-prefixed so components cannot alias across boundaries
 * (["a","bc"] and ["ab","c"] hash differently — no forbidden separator char needed).
 */
function idHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.map((p) => `${p.length}:${p}`).join("")).digest("hex").slice(0, 12);
}

/**
 * Deterministic, traversal-safe entry id: a READABLE slug prefix + a collision-resistant hash of the
 * FULL untruncated components. Same components ⇒ same id ⇒ upsert; components that merely share a slug
 * prefix get DIFFERENT hashes ⇒ never collide (C2). Well under the store's 200-char id cap.
 */
function makeId(project: string, agent: string, kind: MemoryKind, key: string): string {
  return `${slug(project)}:${slug(agent)}:${slug(kind)}:${slug(key)}:${idHash([project, agent, kind, key])}`;
}

/** Coerce a persisted numeric field (patterns hold counts) to a finite number, else the default. */
function asCount(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

/** Minimal read-seam surface this module needs from the receipt store. */
interface ReceiptReadSeam {
  query(filter?: ReceiptQuery): Promise<Receipt[]>;
}

/** Minimal document-store surface (substitutable in tests). */
export interface MemoryStore {
  get(id: string): Promise<MemoryEntry | undefined>;
  put(id: string, value: MemoryEntry): Promise<void>;
  list(): Promise<string[]>;
}

/** Injectable dependencies (tests substitute store / receipts / publish / clock). */
export interface LabMemoryDeps {
  readonly config?: LabContextMemoryConfig;
  readonly store?: MemoryStore;
  readonly receipts?: ReceiptReadSeam;
  readonly publish?: (input: EventInput<LabMemEventPayload>) => void;
  readonly now?: () => number;
}

/** STRUCTURAL redaction: the ONLY receipt fields that reach a persisted entry. Never
 * touches receipt.metadata or receipt.requestSummary (freeform / never-secrets fields). */
function redactActivity(r: Receipt): Readonly<Record<string, unknown>> {
  return {
    operation: r.operation,
    outcomeStatus: r.outcome.status,
    changeKinds: r.changes.map((c) => c.kind),
    changeTargets: r.changes.map((c) => c.target),
    summary: `${r.identity.agentId} ${r.operation} → ${r.outcome.status}`,
  };
}

/** Build the lab-memory store. The default deps wire the live singletons + a DocumentStore. */
export function createLabMemory(deps: LabMemoryDeps = {}): LabMemory {
  const config = deps.config ?? labContextMemoryConfig;
  const store: MemoryStore =
    deps.store ?? createDocumentStore<MemoryEntry>({ dir: config.memoryDir, idPattern: MEMORY_ID_PATTERN });
  const receipts = deps.receipts ?? (coreReceipts as ReceiptReadSeam);
  const publish = deps.publish ?? ((input: EventInput<LabMemEventPayload>) => void coreEvents.publish(input));
  const now = deps.now ?? Date.now;

  function emit(
    event: { create: (p: LabMemEventPayload, o?: { source?: string; attribution?: { identity?: AgentIdentity; operation?: string } }) => EventInput<LabMemEventPayload> },
    payload: LabMemEventPayload,
    identity: AgentIdentity | undefined,
  ): void {
    publish(event.create(payload, { source: EVENT_SOURCE, attribution: { ...(identity !== undefined ? { identity } : {}), operation: RECORD_OPERATION } }));
  }

  /** Upsert an entry with an EXPLICIT agent (record uses the caller; projection uses the receipt's agent). */
  async function upsert(parts: { project: string; agent: string; kind: MemoryKind; key: string; value: Readonly<Record<string, unknown>>; sourceReceiptSeq?: number }): Promise<MemoryEntry> {
    const id = makeId(parts.project, parts.agent, parts.kind, parts.key);
    const existing = await store.get(id);
    const entry: MemoryEntry = {
      id,
      project: parts.project,
      agent: parts.agent,
      kind: parts.kind,
      key: parts.key,
      value: parts.value,
      ...(parts.sourceReceiptSeq !== undefined ? { sourceReceiptSeq: parts.sourceReceiptSeq } : {}),
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    await store.put(id, entry);
    return entry;
  }

  async function loadAll(): Promise<MemoryEntry[]> {
    const ids = await store.list();
    const loaded = await Promise.all(ids.map((id) => store.get(id)));
    return loaded.filter((e): e is MemoryEntry => e !== undefined);
  }

  async function record(input: MemoryEntryInput, identity: ValidatedIdentity): Promise<MemoryEntry> {
    if (!config.enabled) throw new LabMemoryError("disabled", "lab-context-memory is disabled — refusing to record");
    if (!isValidatedIdentity(identity)) throw new LabMemoryError("identity", "record requires a validated identity");

    // H7 SIZE CAP: durable shared memory holds SUMMARIES, not blobs. An over-cap value
    // is REJECTED fail-closed (the caller must summarize) — never silently truncated/stored.
    const size = valueByteSize(input.value);
    if (size > config.maxValueBytes) {
      throw new LabMemoryError("too_large", `record value is ${size} bytes — exceeds the ${config.maxValueBytes}-byte cap; summarize before persisting to durable shared memory`);
    }
    // H7 SECRET SCRUB: scrub secret-shaped content from value BEFORE persist, so the
    // DURABLE store never holds a raw secret. The persisted AND returned entry carry the
    // scrubbed value — a caller cannot read back the unscrubbed original.
    const value = scrubSecrets(input.value);

    const agent = identity.identity.agentId;
    const entry = await upsert({ project: input.project, agent, kind: input.kind, key: input.key, value, ...(input.sourceReceiptSeq !== undefined ? { sourceReceiptSeq: input.sourceReceiptSeq } : {}) });
    emit(labmemRecorded, { project: entry.project, agent: entry.agent, kind: entry.kind }, identity.identity);
    return entry;
  }

  async function projectFromReceipts(opts: ProjectFromReceiptsOptions): Promise<{ projected: number }> {
    if (!config.enabled) throw new LabMemoryError("disabled", "lab-context-memory is disabled — refusing to project");
    if (!isValidatedIdentity(opts.identity)) throw new LabMemoryError("identity", "projectFromReceipts requires a validated identity");

    const filter: ReceiptQuery = {
      ...(opts.project !== undefined ? { project: opts.project } : {}),
      ...(opts.agent !== undefined ? { agentId: opts.agent } : {}),
      ...(opts.fromSeq !== undefined ? { fromSeq: opts.fromSeq } : {}),
      limit: config.maxReceiptsPerProjection,
    };
    const found = await receipts.query(filter);

    let projected = 0;
    // activity entries — one per receipt, attributed to the RECEIPT's agent (cross-agent).
    // Skipped when patternsOnly (the build-completion baseline hook wants only the drift baseline).
    if (opts.patternsOnly !== true) {
      for (const r of found) {
        const project = r.project ?? "(unscoped)";
        await upsert({ project, agent: r.identity.agentId, kind: "activity", key: `seq-${r.seq}`, value: redactActivity(r), sourceReceiptSeq: r.seq });
        projected += 1;
      }
    }

    // pattern entries — success/failure rates per (agent, project, operation).
    const groups = new Map<string, { agent: string; project: string; operation: string; receipts: Receipt[] }>();
    for (const r of found) {
      const project = r.project ?? "(unscoped)";
      const k = JSON.stringify([r.identity.agentId, project, r.operation]);
      const g = groups.get(k) ?? { agent: r.identity.agentId, project, operation: r.operation, receipts: [] };
      g.receipts.push(r);
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      // CUMULATIVE baseline: a `pattern` entry is the durable, established success rate for
      // (agent, project, operation) — it MUST survive receipt pruning and MUST NOT be diluted
      // by re-projecting the same receipts. So we MERGE only outcomes newer than the pattern's
      // high-water `lastSeq` into the existing counts (idempotent across repeated projections),
      // rather than overwriting from the current query window. This is what makes drift's
      // baseline diverge from its recent-window and detect a real decline.
      const id = makeId(g.project, g.agent, "pattern", `op-${g.operation}`);
      const prev = await store.get(id);
      const pv = (prev?.value ?? {}) as Record<string, unknown>;
      // PER-STORE HIGH-WATER (drift baseline C1): `seq` is monotonic only WITHIN one receipt store, but
      // the lab-memory dir can be SHARED across installs with INDEPENDENT seq spaces. A single scalar
      // high-water would drop a second install's low seqs as "already projected" (or double-count on
      // overlap). Track the high-water PER store scope; the accumulated counts stay MERGED (one baseline
      // per operation, so drift's read side is unchanged). Legacy entries carried a scalar `lastSeq`;
      // seed THIS scope's mark from it so a pre-scoping baseline upgrades in place without re-counting.
      const storeScope = config.storeScope;
      const hasMap = typeof pv.lastSeqByStore === "object" && pv.lastSeqByStore !== null;
      const prevByStore = hasMap ? (pv.lastSeqByStore as Record<string, unknown>) : {};
      const lastSeqByStore: Record<string, number> = {};
      for (const [k, v] of Object.entries(prevByStore)) lastSeqByStore[k] = asCount(v, -1);
      // This scope's mark if it has one; else -1 for a NEW scope on an already-scoped entry. Only when NO
      // map exists yet (a pre-scoping legacy entry, first upgrade) do we seed from the scalar `lastSeq` —
      // otherwise a second install's fresh scope would wrongly inherit the first install's scalar mark.
      const prevLastSeq = storeScope in lastSeqByStore ? lastSeqByStore[storeScope]! : hasMap ? -1 : asCount(pv.lastSeq, -1);
      const fresh = g.receipts.filter((r) => r.seq > prevLastSeq).sort((a, b) => a.seq - b.seq);
      if (fresh.length === 0) continue; // nothing new for this operation in THIS store — baseline unchanged
      const addSucc = fresh.filter((x) => x.outcome.status === "success").length;
      const successes = asCount(pv.successes, 0) + addSucc;
      const failures = asCount(pv.failures, 0) + (fresh.length - addSucc);
      const lastReceipt = fresh[fresh.length - 1] as Receipt;
      lastSeqByStore[storeScope] = lastReceipt.seq;
      await upsert({
        project: g.project, agent: g.agent, kind: "pattern", key: `op-${g.operation}`,
        // `lastSeq` retained for back-compat/observability (the max across scopes for THIS write);
        // `lastSeqByStore` is the authoritative per-store high-water the freshness gate reads.
        value: { operation: g.operation, successes, failures, total: successes + failures, lastOutcome: lastReceipt.outcome.status, lastSeq: lastReceipt.seq, lastSeqByStore },
      });
      projected += 1;
    }

    emit(labmemProjected, { ...(opts.project !== undefined ? { project: opts.project } : {}), ...(opts.agent !== undefined ? { agent: opts.agent } : {}), count: projected }, opts.identity.identity);
    return { projected };
  }

  async function byProject(project: string): Promise<MemoryEntry[]> {
    const result = (await loadAll()).filter((e) => e.project === project);
    emit(labmemQueried, { project, count: result.length }, undefined);
    return result;
  }

  async function byAgent(agent: string, q?: { project?: string; kind?: MemoryKind }): Promise<MemoryEntry[]> {
    const result = (await loadAll()).filter(
      (e) => e.agent === agent && (q?.project === undefined || e.project === q.project) && (q?.kind === undefined || e.kind === q.kind),
    );
    emit(labmemQueried, { agent, ...(q?.project !== undefined ? { project: q.project } : {}), ...(q?.kind !== undefined ? { kind: q.kind } : {}), count: result.length }, undefined);
    return result;
  }

  async function query(filter: MemoryQuery): Promise<MemoryEntry[]> {
    const result = (await loadAll()).filter(
      (e) =>
        (filter.project === undefined || e.project === filter.project) &&
        (filter.agent === undefined || e.agent === filter.agent) &&
        (filter.kind === undefined || e.kind === filter.kind) &&
        (filter.key === undefined || e.key === filter.key),
    );
    emit(labmemQueried, { ...(filter.project !== undefined ? { project: filter.project } : {}), ...(filter.agent !== undefined ? { agent: filter.agent } : {}), ...(filter.kind !== undefined ? { kind: filter.kind } : {}), count: result.length }, undefined);
    return result;
  }

  function get(id: string): Promise<MemoryEntry | undefined> {
    return store.get(id);
  }

  return { record, projectFromReceipts, byProject, byAgent, query, get };
}

/** The default process-wide lab memory, wired to the live singletons + a DocumentStore. */
export const labMemory: LabMemory = createLabMemory();

/** Re-export the derived-id helper for callers that need the canonical id. */
export { makeId as labMemoryId };
