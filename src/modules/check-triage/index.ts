/**
 * ikbi check-triage — module entrypoint (library-only).
 *
 * Deterministic parser: raw check stdout/stderr → structured triage (pass/fail, failing names,
 * summary, bounded head+tail, detected frameworks). No spawn, no model, never throws. Nothing
 * wires it (verifier/checks/builder) yet.
 */

export { type CheckInput, type CheckTriage } from "./contract.js";

export {
  DEFAULT_MAX_FAILURE_LEN,
  DEFAULT_MAX_FAILURES,
  DEFAULT_MAX_HEAD_BYTES,
  DEFAULT_MAX_TAIL_BYTES,
  loadCheckTriageConfig,
  checkTriageConfig,
  type CheckTriageConfig,
} from "./config.js";

export { createCheckTriage, parseCheckOutput, stripAnsi, type CheckTriageApi } from "./implementation.js";
