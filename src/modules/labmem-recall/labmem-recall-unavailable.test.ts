/**
 * labmem-recall graceful-failure test (Phase 4 labmem-integration hardening).
 *
 * When labmem cannot be imported (missing/unbuilt LABMEM_ROOT), the adapter must
 * raise a typed LabmemUnavailable error — never crash the caller with an opaque
 * module-resolution failure. This lives in its own file so it runs in a fresh
 * process: the adapter caches the labmem module on first successful load, so the
 * cold import-failure path must be exercised in isolation.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { recallForIkbi, renderIkbiRecall, LabmemUnavailable } from "./index.js";

test("recallForIkbi raises LabmemUnavailable (not a raw crash) when labmem is missing", async () => {
  const prev = process.env["LABMEM_ROOT"];
  const bogus = mkdtempSync(join(tmpdir(), "labmem-ikbi-missing-")); // no dist/, no core/
  process.env["LABMEM_ROOT"] = bogus;
  try {
    await assert.rejects(() => recallForIkbi(bogus), LabmemUnavailable);
    await assert.rejects(() => renderIkbiRecall(bogus), LabmemUnavailable);
  } finally {
    if (prev === undefined) delete process.env["LABMEM_ROOT"];
    else process.env["LABMEM_ROOT"] = prev;
    rmSync(bogus, { recursive: true, force: true });
  }
});
