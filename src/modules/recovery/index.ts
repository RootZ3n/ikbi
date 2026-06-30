/**
 * ikbi recovery — module entrypoint (library-only).
 *
 * @status library-only (phase 1: the pure pool/decision core; orchestrator wiring + trust
 * deferral + ladder-as-gate-wall + the consult frontier step land in later phases).
 *
 * The first-class, self-healing recovery loop: a failure opens a recovery state ikbi owns and
 * drives the worker+mid model POOL to exhaustion in one invocation — ikbi may call upon any
 * eligible model, as long as it goes up the ladder (a monotonic tier floor). decideRecovery()
 * is the pure next-action policy; the orchestrator enacts each action and feeds trust ONCE on
 * the terminal outcome (never on intermediate attempts).
 */

export { decideRecovery, eligiblePool, recoveryFloor } from "./policy.js";
export { runRecovery, CONSULT_MODEL_ID } from "./driver.js";
export type { RecoveryExecutors, RecoveryDriverInput, RecoveryResult } from "./driver.js";
export type {
  ModelTier,
  RecoveryAttempt,
  RecoveryCandidate,
  RecoveryTerminal,
  RecoveryInput,
  RecoveryAction
} from "./contract.js";
