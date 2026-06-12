/**
 * ikbi receipt store — public surface (lean operational log).
 *
 * The engine's attributed, ordered, durable OPERATIONAL record — for
 * troubleshooting and for trust/memory to project over. Retention-bounded; NOT a
 * cryptographic ledger (tamper-evidence intentionally omitted — see contract.ts).
 *
 *     const r = await receipts.append(
 *       { operation: "model.invoke", outcome: { status: "success" }, project: "ikbi", changes: [...] },
 *       who.identity,                       // the validated AgentIdentity
 *     );
 *     const history = await receipts.agentHistory("builder-3");   // trust/memory read-seam
 *     const byProject = await receipts.query({ project: "ikbi" });
 *     await receipts.prune();                                     // retention hard-delete
 *
 * Default store wired from `config` + the frozen substrate: receipts append to an
 * `AtomicAppendLog` at `<receipt dir>/receipts.ndjson`. Single-writer (the
 * service writes; the CLI reads). Receipts ARE the durable operational record —
 * distinct from `log.ts` telemetry.
 *
 * Reversibility hook (`ReceiptChange`) carries what UNDO will need; undo is a
 * later module. Read-seam (`agentHistory` / `summarizeAgent` / `query` incl.
 * `project`) is what trust + memory read.
 */

import { join } from "node:path";

import { config } from "../config.js";
import { childLogger } from "../log.js";
import { createAppendLog, locks } from "../substrate/index.js";
import type { Receipt } from "./contract.js";
import { ReceiptStore } from "./store.js";

const log = childLogger("receipt");

function buildDefaultStore(): ReceiptStore {
  const rc = config.receipt;
  const logFile = join(rc.dir, "receipts.ndjson");
  return new ReceiptStore({
    log: createAppendLog<Receipt>({ path: logFile, crossProcess: true }),
    logFile,
    locks,
    logger: log,
    retentionMs: rc.retentionDays * 24 * 60 * 60 * 1000,
  });
}

/** The process-wide receipt store. */
export const receipts: ReceiptStore = buildDefaultStore();

// --- re-export the contract + building blocks ---
export { ReceiptStore } from "./store.js";
export type { ReceiptStoreDeps } from "./store.js";
export {
  RECEIPT_CONTRACT_VERSION,
  ReceiptError,
  type AgentReceiptSummary,
  type InverseOp,
  type PruneResult,
  type Receipt,
  type ReceiptChange,
  type ReceiptInput,
  type ReceiptOutcome,
  type ReceiptQuery,
  type StateRef,
} from "./contract.js";
