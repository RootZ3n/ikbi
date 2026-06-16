/**
 * `ikbi receipts` — limit=0 must return ZERO results in the CLI, on both the
 * standard listing path and the --failures path. (lab-trust sprint, Phase 3)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentIdentity } from "../core/identity/contract.js";
import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { createReceiptsCli } from "./receipts.js";

const ID: AgentIdentity = { agentId: "worker-1", trustTier: "trusted" };

function rec(seq: number, status: Receipt["outcome"]["status"]): Receipt {
  return {
    contractVersion: "1.0.0",
    id: `r${seq}`,
    seq,
    timestamp: 1_700_000_000_000 + seq * 1000,
    identity: ID,
    operation: "worker.role.builder",
    outcome: { status },
    changes: [],
  } as Receipt;
}

/** A store that HONORS limit the way the real store does (so limit=0 → empty). */
function honoringStore(list: Receipt[]) {
  return {
    query: async (filter: ReceiptQuery = {}): Promise<Receipt[]> => {
      let result = [...list];
      if (filter.limit !== undefined && filter.limit >= 0 && result.length > filter.limit) {
        result = result.slice(result.length - filter.limit);
      }
      return result;
    },
  };
}

function capture() {
  let out = "";
  let err = "";
  let exit: number | undefined;
  return {
    stdout: (s: string) => void (out += s),
    stderr: (s: string) => void (err += s),
    setExit: (c: number) => void (exit = c),
    get out() { return out; },
    get err() { return err; },
    get exit() { return exit; },
  };
}

test("`receipts --limit 0` lists zero receipts (standard path)", async () => {
  const cap = capture();
  await createReceiptsCli({
    receipts: honoringStore([rec(1, "success"), rec(2, "success")]),
    stdout: cap.stdout,
    stderr: cap.stderr,
    setExit: cap.setExit,
  }).receipts(["--limit", "0"]);
  // limit=0 → the store returns nothing → the listing is empty.
  assert.match(cap.out, /no receipts yet/);
  assert.doesNotMatch(cap.out, /#1|#2/, "no receipts are listed");
});

test("`receipts --failures --limit 0` returns empty, not all failures", async () => {
  const cap = capture();
  await createReceiptsCli({
    receipts: honoringStore([rec(1, "failure"), rec(2, "failure")]),
    stdout: cap.stdout,
    stderr: cap.stderr,
    setExit: cap.setExit,
  }).receipts(["--failures", "--limit", "0"]);
  assert.match(cap.out, /no failed receipts/);
});
