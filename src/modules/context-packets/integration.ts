/**
 * ikbi context-packets — CONSUMER BRIDGES (tournament + patchsmith).
 *
 * Thin, side-effect-free adapters that turn a workspace + task into the artifacts the
 * two builder lanes consume. They are ADDITIVE: the tournament and patchsmith own their
 * control flow; these helpers only build the inputs (a fitted ContextPacket, a patch
 * prompt body) so the same byte-budgeted, confinement-safe context the evaluation
 * framework uses is available to ikbi's builders.
 *
 *   - `buildTournamentTaskPacket` — one fitted packet per candidate, sized to the
 *     candidate model's context window (the example wiring from the port spec).
 *   - `buildPatchsmithPrompt` — the UNTRUSTED context body (goal + file previews +
 *     constraints) the patchsmith feeds to a tool-free model. It is DATA, not a trusted
 *     instruction: the caller still routes it through `neutralizeUntrusted` before the
 *     model sees it.
 */

import { buildContextPacket, type ContextPacket, type ContextPacketTask } from "./contextPacket.js";
import type { RepoContextMap } from "./repoMap.js";

/** The fraction of a model's context window a packet is allowed to occupy (chars ≈ tokens·~4). */
export const DEFAULT_PACKET_WINDOW_FRACTION = 0.6;
/** Default per-file preview ceiling (bounds any single file's bytes in the packet). */
export const DEFAULT_MAX_BYTES_PER_FILE = 8 * 1024;
/** Default total preview ceiling across all selected files. */
export const DEFAULT_MAX_TOTAL_PREVIEW_BYTES = 32 * 1024;

/** What the tournament knows about one candidate model when sizing its packet. */
export interface TaskPacketModelCapabilities {
  /** The model's context window in tokens (the packet char ceiling is derived from it). */
  readonly contextWindow: number;
  /** Fraction of the window the packet may occupy (default DEFAULT_PACKET_WINDOW_FRACTION). */
  readonly windowFraction?: number;
}

/** The task description the tournament packet is built around (mirrors the contract fields). */
export interface TournamentTaskInput {
  readonly goal: string;
  readonly allowedFiles: readonly string[];
  readonly forbiddenFiles?: readonly string[];
  readonly verificationRequired?: readonly string[];
  readonly taskType?: string;
}

/** Inputs for building one candidate's task packet. */
export interface TournamentTaskPacketInput {
  readonly repoRoot: string;
  readonly repoMap: RepoContextMap;
  readonly task: TournamentTaskInput;
  readonly modelCapabilities: TaskPacketModelCapabilities;
  /** Which files to preview (defaults to the allowed files — the in-scope set). */
  readonly selectedPaths?: readonly string[];
  readonly budgets?: {
    readonly maxBytesPerFile?: number;
    readonly maxTotalPreviewBytes?: number;
  };
}

/**
 * Build ONE candidate's task packet, sized to that candidate model's context window. The
 * packet char ceiling is `contextWindow * windowFraction`, so a smaller model gets a
 * tighter, more aggressively truncated packet — the byte budgets and the packet's own
 * overflow handling guarantee it fits.
 */
export async function buildTournamentTaskPacket(input: TournamentTaskPacketInput): Promise<ContextPacket> {
  const fraction = input.modelCapabilities.windowFraction ?? DEFAULT_PACKET_WINDOW_FRACTION;
  const maxPacketChars = Math.max(0, Math.floor(input.modelCapabilities.contextWindow * fraction));
  const selectedPaths = input.selectedPaths ?? input.task.allowedFiles;

  const task: ContextPacketTask = {
    taskType: input.task.taskType ?? "tournament_candidate",
    goal: input.task.goal,
    allowedFiles: input.task.allowedFiles,
    ...(input.task.forbiddenFiles !== undefined ? { forbiddenFiles: input.task.forbiddenFiles } : {}),
    ...(input.task.verificationRequired !== undefined ? { verificationRequired: input.task.verificationRequired } : {})
  };

  return buildContextPacket({
    repoRoot: input.repoRoot,
    repoMap: input.repoMap,
    task,
    selectedPaths,
    budgets: {
      maxBytesPerFile: input.budgets?.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE,
      maxTotalPreviewBytes: input.budgets?.maxTotalPreviewBytes ?? DEFAULT_MAX_TOTAL_PREVIEW_BYTES,
      maxPacketChars
    }
  });
}

/** Options for rendering a patchsmith prompt from a packet. */
export interface PatchsmithPromptOptions {
  /** Optional failing-check output to show the model (defaults to a neutral note). */
  readonly checkOutput?: string;
}

/**
 * Render the UNTRUSTED context body the patchsmith feeds to a tool-free model: the goal,
 * byte-budgeted previews of the selected files, the failing-check output, and the
 * forbidden-file constraints — all sourced from a fitted ContextPacket. The shape mirrors
 * the patchsmith's own context body so a packet-built prompt is drop-in compatible.
 *
 * SECURITY: the returned string is DATA (it embeds untrusted file bodies). The caller
 * neutralizes it before the model sees it — this helper never marks it trusted.
 */
export function buildPatchsmithPrompt(packet: ContextPacket, options: PatchsmithPromptOptions = {}): string {
  const fileBlocks =
    packet.selectedPreviews.length > 0
      ? packet.selectedPreviews.map((preview) => `--- ${preview.path}${preview.truncated ? " (truncated)" : ""} ---\n${preview.text}`).join("\n\n")
      : "(no source files were located for the named targets)";

  const forbidden = packet.constraints.forbiddenFiles;
  const constraints = [
    `- Do NOT modify: ${[...forbidden, "tests (*.test.ts / *.spec.ts)"].join(", ")}`,
    "- Do NOT add new dependencies.",
    "- Only the listed allowed files are in scope; do NOT touch unlisted files."
  ].join("\n");

  const verification =
    packet.task.verificationRequired !== undefined && packet.task.verificationRequired.length > 0
      ? `\n\nVERIFICATION (the verifier — not you — determines truth):\n${packet.task.verificationRequired.map((v) => `- ${v}`).join("\n")}`
      : "";

  return [
    `TASK: ${packet.task.goal}`,
    "",
    "FAILING CHECK OUTPUT:",
    options.checkOutput !== undefined && options.checkOutput.length > 0 ? options.checkOutput : "(none provided — infer the fix from the task and files)",
    "",
    "RELEVANT FILES:",
    fileBlocks,
    "",
    "CONSTRAINTS:",
    constraints + verification
  ].join("\n");
}
