/**
 * ikbi consult — buildConsultPacket: assemble the evidence-dense frontier brief.
 *
 * Pure-ish (fs-bound only to read the requested slices). Given slice requests + scout
 * pointers + the failure trail + the exact failing-check output, it produces a
 * ConsultPacket bounded by three budgets in cascade:
 *   1. per-slice bytes      — each slice's verbatim text is capped (readCodeSlice).
 *   2. total slice bytes    — slices are admitted in order until the budget is spent;
 *                             the one that straddles the line is trimmed to what remains,
 *                             and the rest are dropped with a recorded reason.
 *   3. packet char ceiling  — optional final ceiling; warnings drop first, then slice
 *                             bodies halve from the end (an irreducible question +
 *                             constraints floor always remains).
 *
 * No model calls. The orchestrator (phase 3) produces the slice requests from
 * project-retrieval + scout and feeds them here; the result goes to one bounded frontier
 * invocation with no tools.
 */

import { readCodeSlice } from "./codeSlice.js";
import type {
  CodeSlice,
  CodeSliceSkip,
  ConsultBudget,
  ConsultMode,
  ConsultPacket,
  ConsultPacketInput,
  ConsultRepoSummary
} from "./contract.js";
import { CONSULT_PACKET_CONTRACT_VERSION } from "./contract.js";

const defaultMaxSliceBytes = 8 * 1024;
const defaultMaxTotalSliceBytes = 64 * 1024;

function advisorAuthority(mode: ConsultMode): ConsultPacket["constraints"]["advisorAuthority"] {
  return mode === "patch" ? "propose_patch" : "recommend_only";
}

type MutableConsultPacket = {
  contractVersion: string;
  generatedAt: string;
  repoRoot: string;
  mode: ConsultMode;
  question: string;
  goal?: string;
  repoSummary?: ConsultRepoSummary;
  evidence: {
    failingChecks?: string;
    triedAndFailed: ConsultPacket["evidence"]["triedAndFailed"];
    slices: CodeSlice[];
    scoutPointers: ConsultPacket["evidence"]["scoutPointers"];
    skippedSlices: CodeSliceSkip[];
  };
  constraints: ConsultPacket["constraints"];
  budget: ConsultBudget;
  truncation: {
    anySliceTruncated: boolean;
    totalSliceBytes: number;
    maxTotalSliceBytes: number;
    maxPacketChars?: number;
    packetTruncated: boolean;
    droppedSlices: number;
  };
  warnings: string[];
};

function packetLength(packet: MutableConsultPacket): number {
  return JSON.stringify(packet).length;
}

function applyPacketCharBudget(packet: MutableConsultPacket, maxPacketChars: number | undefined): void {
  if (maxPacketChars === undefined || packetLength(packet) <= maxPacketChars) {
    return;
  }
  packet.truncation.packetTruncated = true;

  while (packet.warnings.length > 0 && packetLength(packet) > maxPacketChars) {
    packet.warnings.pop();
  }

  for (let index = packet.evidence.slices.length - 1; index >= 0 && packetLength(packet) > maxPacketChars; index -= 1) {
    const slice = packet.evidence.slices[index];
    if (slice === undefined || slice.text.length === 0) {
      continue;
    }
    let nextText = slice.text;
    while (nextText.length > 0 && packetLength(packet) > maxPacketChars) {
      nextText = nextText.slice(0, Math.max(0, Math.floor(nextText.length / 2)));
      packet.evidence.slices[index] = {
        ...slice,
        text: nextText,
        truncated: true,
        bytes: Buffer.byteLength(nextText, "utf8")
      };
    }
  }
}

export async function buildConsultPacket(input: ConsultPacketInput): Promise<ConsultPacket> {
  const maxSliceBytes = input.budget?.maxSliceBytes ?? defaultMaxSliceBytes;
  const maxTotalSliceBytes = input.budget?.maxTotalSliceBytes ?? defaultMaxTotalSliceBytes;
  const maxPacketChars = input.budget?.maxPacketChars;

  const slices: CodeSlice[] = [];
  const skippedSlices: CodeSliceSkip[] = [];
  const warnings: string[] = [];
  let totalSliceBytes = 0;
  let droppedSlices = 0;

  for (const request of input.sliceRequests) {
    const remaining = maxTotalSliceBytes - totalSliceBytes;
    if (remaining <= 0) {
      skippedSlices.push({
        path: request.path,
        startLine: request.startLine,
        endLine: request.endLine,
        reason: "total slice byte budget exceeded"
      });
      droppedSlices += 1;
      continue;
    }
    // Cap this slice by the smaller of the per-slice budget and what remains of the total.
    const result = await readCodeSlice(input.repoRoot, request, {
      maxSliceBytes: Math.min(maxSliceBytes, remaining)
    });
    if (result.slice !== undefined) {
      slices.push(result.slice);
      totalSliceBytes += result.slice.bytes;
    }
    if (result.skip !== undefined) {
      skippedSlices.push(result.skip);
    }
  }

  const packet: MutableConsultPacket = {
    contractVersion: CONSULT_PACKET_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    repoRoot: input.repoRoot,
    mode: input.mode,
    question: input.question,
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.repoSummary !== undefined ? { repoSummary: input.repoSummary } : {}),
    evidence: {
      ...(input.failingChecks !== undefined ? { failingChecks: input.failingChecks } : {}),
      triedAndFailed: [...(input.triedAndFailed ?? [])],
      slices,
      scoutPointers: [...(input.scoutPointers ?? [])],
      skippedSlices
    },
    constraints: {
      allowedFiles: [...(input.allowedFiles ?? [])],
      forbiddenFiles: [...(input.forbiddenFiles ?? [])],
      advisorAuthority: advisorAuthority(input.mode),
      verifierDeterminesTruth: true
    },
    budget: {
      maxSliceBytes,
      maxTotalSliceBytes,
      ...(maxPacketChars !== undefined ? { maxPacketChars } : {})
    },
    truncation: {
      anySliceTruncated: slices.some((slice) => slice.truncated),
      totalSliceBytes,
      maxTotalSliceBytes,
      ...(maxPacketChars !== undefined ? { maxPacketChars } : {}),
      packetTruncated: false,
      droppedSlices
    },
    warnings
  };

  applyPacketCharBudget(packet, maxPacketChars);

  return packet;
}
