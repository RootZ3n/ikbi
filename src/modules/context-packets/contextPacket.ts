/**
 * ikbi context-packets — THE CONTEXT PACKET (the structured task brief for a model).
 *
 * A ContextPacket is everything a small/local model needs to attempt ONE task, packed
 * to fit its context window:
 *   - the task (goal + allowed/forbidden files + required verification),
 *   - a repo summary (package manager, scripts, section-bucketed file lists),
 *   - byte-budgeted previews of the SELECTED files (truncated, never unbounded),
 *   - the hard constraints (noUnlistedFiles, workerAuthority=propose_only, the
 *     verifier — not the model — determines truth),
 *   - a truncation report (what got cut to fit the budgets).
 *
 * Three budgets bound the packet: per-file bytes, total preview bytes, and a final
 * packet-character ceiling. When the packet still overflows the char ceiling, repo-map
 * sections are dropped low-value-first (other → config → docs → tests → source), then
 * warnings, then preview bodies are halved — shrinking the packet toward the ceiling
 * (best-effort: an irreducible task + constraints + repoRoot floor always remains).
 *
 * Ported from scintilla/src/core/context/contextPacket.ts. Adapted for ikbi's
 * `exactOptionalPropertyTypes` (optional fields are omitted, never set to undefined).
 */

import type { FilePreview, FilePreviewSkip } from "./filePreview.js";
import { previewRepoFiles } from "./filePreview.js";
import type { RepoContextMap } from "./repoMap.js";
import type { TaskContract, TaskContractValidationError } from "./contract.js";
import { validateTaskContract } from "./contract.js";

export type ContextPacketPromptQuality = "P0" | "P1" | "P2" | "P3" | "P4";

export interface ContextPacketTask {
  readonly benchmarkId?: string;
  readonly taskType: string;
  readonly promptQuality?: ContextPacketPromptQuality;
  readonly goal: string;
  readonly allowedFiles: readonly string[];
  readonly forbiddenFiles?: readonly string[];
  readonly verificationRequired?: readonly string[];
}

export interface ContextPacketInput {
  readonly repoRoot: string;
  readonly repoMap: RepoContextMap;
  readonly task: ContextPacketTask;
  readonly selectedPaths: readonly string[];
  readonly budgets?: {
    readonly maxBytesPerFile?: number;
    readonly maxTotalPreviewBytes?: number;
    readonly maxPacketChars?: number;
  };
}

export interface ContextPacketFromContractInput {
  readonly repoRoot: string;
  readonly repoMap: RepoContextMap;
  readonly contract: TaskContract;
  readonly selectedPaths?: readonly string[];
  readonly budgets?: ContextPacketInput["budgets"];
}

export interface ContextPacket {
  readonly generatedAt: string;
  readonly repoRoot: string;
  readonly task: ContextPacketTask;
  readonly repoSummary: {
    readonly packageManager: string;
    readonly scripts: Readonly<Record<string, string>>;
    readonly totals: RepoContextMap["totals"];
    readonly sections: {
      readonly source: readonly string[];
      readonly tests: readonly string[];
      readonly docs: readonly string[];
      readonly config: readonly string[];
      readonly other: readonly string[];
    };
  };
  readonly selectedPreviews: readonly FilePreview[];
  readonly skippedPreviews: readonly FilePreviewSkip[];
  readonly constraints: {
    readonly allowedFiles: readonly string[];
    readonly forbiddenFiles: readonly string[];
    readonly noUnlistedFiles: boolean;
    readonly workerAuthority: "propose_only";
    readonly verifierDeterminesTruth: true;
  };
  readonly truncation: {
    readonly anyFileTruncated: boolean;
    readonly totalPreviewBytes: number;
    readonly maxTotalPreviewBytes: number;
    readonly maxPacketChars?: number;
    readonly packetTruncated: boolean;
  };
  readonly warnings: readonly string[];
}

const defaultMaxBytesPerFile = 8 * 1024;
const defaultMaxTotalPreviewBytes = 32 * 1024;

export class TaskContractPacketValidationError extends Error {
  readonly errors: readonly TaskContractValidationError[];

  constructor(errors: readonly TaskContractValidationError[]) {
    super("TaskContract failed validation");
    this.name = "TaskContractPacketValidationError";
    this.errors = errors;
  }
}

type MutableContextPacket = {
  generatedAt: string;
  repoRoot: string;
  task: ContextPacketTask;
  repoSummary: {
    packageManager: string;
    scripts: Record<string, string>;
    totals: RepoContextMap["totals"];
    sections: {
      source: string[];
      tests: string[];
      docs: string[];
      config: string[];
      other: string[];
    };
  };
  selectedPreviews: FilePreview[];
  skippedPreviews: FilePreviewSkip[];
  constraints: {
    allowedFiles: string[];
    forbiddenFiles: string[];
    noUnlistedFiles: boolean;
    workerAuthority: "propose_only";
    verifierDeterminesTruth: true;
  };
  truncation: {
    anyFileTruncated: boolean;
    totalPreviewBytes: number;
    maxTotalPreviewBytes: number;
    maxPacketChars?: number;
    packetTruncated: boolean;
  };
  warnings: string[];
};

function sectionPaths(section: RepoContextMap["sections"]["source"]): string[] {
  return section.map((file) => file.path);
}

function packetLength(packet: MutableContextPacket): number {
  return JSON.stringify(packet).length;
}

function truncateStringToFit(packet: MutableContextPacket, maxPacketChars: number): void {
  for (let index = packet.selectedPreviews.length - 1; index >= 0 && packetLength(packet) > maxPacketChars; index -= 1) {
    const preview = packet.selectedPreviews[index];
    if (preview === undefined || preview.text.length === 0) {
      continue;
    }

    let nextText = preview.text;
    while (nextText.length > 0 && packetLength(packet) > maxPacketChars) {
      nextText = nextText.slice(0, Math.max(0, Math.floor(nextText.length / 2)));
      packet.selectedPreviews[index] = {
        ...preview,
        text: nextText,
        truncated: true,
        bytesRead: Buffer.byteLength(nextText, "utf8")
      };
    }
  }
}

function applyPacketCharBudget(packet: MutableContextPacket, maxPacketChars: number | undefined): void {
  if (maxPacketChars === undefined || packetLength(packet) <= maxPacketChars) {
    return;
  }

  packet.truncation.packetTruncated = true;

  const sectionOrder: Array<keyof MutableContextPacket["repoSummary"]["sections"]> = ["other", "config", "docs", "tests", "source"];
  for (const section of sectionOrder) {
    while (packet.repoSummary.sections[section].length > 0 && packetLength(packet) > maxPacketChars) {
      packet.repoSummary.sections[section].pop();
    }
  }

  while (packet.warnings.length > 0 && packetLength(packet) > maxPacketChars) {
    packet.warnings.pop();
  }

  if (packetLength(packet) > maxPacketChars) {
    truncateStringToFit(packet, maxPacketChars);
  }
}

export async function buildContextPacket(input: ContextPacketInput): Promise<ContextPacket> {
  const maxBytesPerFile = input.budgets?.maxBytesPerFile ?? defaultMaxBytesPerFile;
  const maxTotalPreviewBytes = input.budgets?.maxTotalPreviewBytes ?? defaultMaxTotalPreviewBytes;
  const previewResult = await previewRepoFiles(input.repoRoot, input.selectedPaths, {
    maxBytesPerFile,
    maxTotalBytes: maxTotalPreviewBytes
  });

  const packet: MutableContextPacket = {
    generatedAt: new Date().toISOString(),
    repoRoot: input.repoRoot,
    task: {
      ...input.task,
      allowedFiles: [...input.task.allowedFiles],
      ...(input.task.forbiddenFiles !== undefined ? { forbiddenFiles: [...input.task.forbiddenFiles] } : {}),
      ...(input.task.verificationRequired !== undefined ? { verificationRequired: [...input.task.verificationRequired] } : {})
    },
    repoSummary: {
      packageManager: input.repoMap.packageManager,
      scripts: { ...input.repoMap.scripts },
      totals: { ...input.repoMap.totals },
      sections: {
        source: sectionPaths(input.repoMap.sections.source),
        tests: sectionPaths(input.repoMap.sections.tests),
        docs: sectionPaths(input.repoMap.sections.docs),
        config: sectionPaths(input.repoMap.sections.config),
        other: sectionPaths(input.repoMap.sections.other)
      }
    },
    selectedPreviews: previewResult.previews.map((preview) => ({ ...preview })),
    skippedPreviews: previewResult.skipped.map((skip) => ({ ...skip })),
    constraints: {
      allowedFiles: [...input.task.allowedFiles],
      forbiddenFiles: [...(input.task.forbiddenFiles ?? [])],
      noUnlistedFiles: true,
      workerAuthority: "propose_only",
      verifierDeterminesTruth: true
    },
    truncation: {
      anyFileTruncated: previewResult.previews.some((preview) => preview.truncated),
      totalPreviewBytes: previewResult.totalBytesRead,
      maxTotalPreviewBytes,
      ...(input.budgets?.maxPacketChars !== undefined ? { maxPacketChars: input.budgets.maxPacketChars } : {}),
      packetTruncated: false
    },
    warnings: [...input.repoMap.warnings, ...previewResult.warnings]
  };

  applyPacketCharBudget(packet, input.budgets?.maxPacketChars);

  return packet;
}

export async function buildContextPacketFromContract(input: ContextPacketFromContractInput): Promise<ContextPacket> {
  const validation = validateTaskContract(input.contract);
  if (!validation.ok) {
    throw new TaskContractPacketValidationError(validation.errors);
  }

  const contract = validation.contract;
  return buildContextPacket({
    repoRoot: input.repoRoot,
    repoMap: input.repoMap,
    task: {
      ...(contract.benchmarkId !== undefined ? { benchmarkId: contract.benchmarkId } : {}),
      taskType: contract.taskType,
      ...(contract.promptQuality !== undefined ? { promptQuality: contract.promptQuality } : {}),
      goal: contract.goal,
      allowedFiles: contract.allowedFiles,
      ...(contract.forbiddenFiles !== undefined ? { forbiddenFiles: contract.forbiddenFiles } : {}),
      ...(contract.verificationRequired !== undefined ? { verificationRequired: contract.verificationRequired } : {})
    },
    selectedPaths: input.selectedPaths ?? contract.allowedFiles,
    ...(input.budgets !== undefined ? { budgets: input.budgets } : {})
  });
}
