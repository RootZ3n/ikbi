/**
 * ikbi consult — module entrypoint (library-only).
 *
 * @status library-only (phase 1: the consult-packet shape + builder; no CLI, no model).
 *
 * The explicit-only frontier escalation path. A cheap pre-pass (project-retrieval + scout,
 * wired in a later phase) produces slice requests + pointers; buildConsultPacket assembles
 * an evidence-dense ConsultPacket — verbatim code slices, the exact failing-check output,
 * the failure trail, and cheap-model findings kept SEPARATE as pointers — for ONE bounded
 * frontier invocation with no tools. The packet never promotes; the verification ladder
 * gates whatever comes back.
 */

export { buildConsultPacket } from "./consultPacket.js";
export { runConsult } from "./orchestrator.js";
export type { ConsultDeps, ConsultRequest, ConsultResult } from "./orchestrator.js";
export { consultSystemPrompt, renderConsultPrompt } from "./prompt.js";
export { readCodeSlice } from "./codeSlice.js";
export type { CodeSliceOptions, CodeSliceReadResult } from "./codeSlice.js";
export {
  CONSULT_PACKET_CONTRACT_VERSION
} from "./contract.js";
export type {
  ConsultMode,
  ConsultSeverity,
  ScoutPointer,
  ConsultAttempt,
  ConsultSliceRequest,
  CodeSlice,
  CodeSliceSkip,
  ConsultEvidence,
  ConsultConstraints,
  ConsultBudget,
  ConsultTruncation,
  ConsultRepoSummary,
  ConsultPacket,
  ConsultPacketInput
} from "./contract.js";
