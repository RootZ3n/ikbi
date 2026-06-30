/**
 * Tests for buildConsultPacket: evidence assembly, the lossy-distillation discipline
 * (slices verbatim, scout pointers kept separate), and the three budget cascades.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildConsultPacket } from "./consultPacket.js";
import type { ConsultPacketInput } from "./contract.js";

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ikbi-consult-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  const body = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join("\n");
  await writeFile(path.join(root, "src", "feature.ts"), `${body}\n`);
  await writeFile(path.join(root, "src", "other.ts"), "export const y = 1;\nexport const z = 2;\n");
  return root;
}

function baseInput(root: string, overrides: Partial<ConsultPacketInput> = {}): ConsultPacketInput {
  return {
    repoRoot: root,
    mode: "advise",
    question: "Why does the ladder fail after the refactor?",
    sliceRequests: [{ path: "src/feature.ts", startLine: 1, endLine: 5 }],
    ...overrides
  };
}

test("assembles verbatim slices and keeps scout pointers separate from the code", async () => {
  const root = await makeRepo();
  try {
    const packet = await buildConsultPacket(
      baseInput(root, {
        scoutPointers: [{ title: "suspect init", path: "src/feature.ts", lines: [1, 5], severity: "high" }],
        failingChecks: "FAIL src/feature.test.ts: expected 0 got 1",
        triedAndFailed: [{ role: "builder", summary: "swapped order", outcome: "still red" }]
      })
    );
    assert.equal(packet.mode, "advise");
    assert.equal(packet.constraints.advisorAuthority, "recommend_only");
    assert.equal(packet.constraints.verifierDeterminesTruth, true);
    // slice text is raw code, not a summary
    assert.equal(packet.evidence.slices.length, 1);
    assert.match(packet.evidence.slices[0]!.text, /const x0 = 0;/);
    // pointers are kept in their own channel
    assert.equal(packet.evidence.scoutPointers.length, 1);
    assert.equal(packet.evidence.scoutPointers[0]!.title, "suspect init");
    // exact check output is preserved verbatim
    assert.equal(packet.evidence.failingChecks, "FAIL src/feature.test.ts: expected 0 got 1");
    assert.equal(packet.evidence.triedAndFailed.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("patch mode grants propose_patch authority", async () => {
  const root = await makeRepo();
  try {
    const packet = await buildConsultPacket(baseInput(root, { mode: "patch" }));
    assert.equal(packet.mode, "patch");
    assert.equal(packet.constraints.advisorAuthority, "propose_patch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("total slice byte budget drops later slices with a recorded reason", async () => {
  const root = await makeRepo();
  try {
    const packet = await buildConsultPacket(
      baseInput(root, {
        sliceRequests: [
          { path: "src/feature.ts", startLine: 1, endLine: 40 },
          { path: "src/other.ts", startLine: 1, endLine: 2 }
        ],
        budget: { maxTotalSliceBytes: 30 }
      })
    );
    assert.ok(packet.truncation.totalSliceBytes <= 30);
    assert.ok(packet.truncation.droppedSlices >= 1);
    assert.ok(packet.evidence.skippedSlices.some((s) => /total slice byte budget/.test(s.reason)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet char ceiling shrinks slice bodies and flags packetTruncated", async () => {
  const root = await makeRepo();
  try {
    const packet = await buildConsultPacket(
      baseInput(root, {
        sliceRequests: [{ path: "src/feature.ts", startLine: 1, endLine: 40 }],
        budget: { maxPacketChars: 600 }
      })
    );
    assert.equal(packet.truncation.packetTruncated, true);
    assert.ok(JSON.stringify(packet).length <= 600 || packet.evidence.slices[0]!.text.length === 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confinement failures surface as skippedSlices, not throws", async () => {
  const root = await makeRepo();
  try {
    const packet = await buildConsultPacket(
      baseInput(root, {
        sliceRequests: [
          { path: "../escape.ts", startLine: 1, endLine: 1 },
          { path: "src/feature.ts", startLine: 1, endLine: 2 }
        ]
      })
    );
    assert.equal(packet.evidence.slices.length, 1);
    assert.ok(packet.evidence.skippedSlices.some((s) => /traversal/.test(s.reason)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
