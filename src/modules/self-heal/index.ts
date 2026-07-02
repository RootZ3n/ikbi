/**
 * ikbi self-heal — module entrypoint (library-only).
 *
 * @status library-only (phase 1: the pure disposition core + the executor-driven loop). The real
 * executors — generateFix (build on the ikbi repo), runSuite (the full `pnpm test`), runJudge
 * (deterministic judge), opusAdvise (frontier consult), and the receipt writer — plus the CLI
 * surface land in the next phase; this phase registers no command and binds no route.
 *
 * The last layer of "ikbi watches, reports, repairs itself": a harness-suspect failure (from the
 * self-monitor classifier) becomes a candidate fix, gated by correctness (suite + judge) and
 * authority (blast-radius), yielding a DISPOSITION — never a merge. decideDisposition() is the pure
 * policy; runSelfHeal() enacts it through injected executors and receipts the one terminal outcome.
 */

export { decideDisposition } from "./policy.js";
export { runSelfHeal } from "./driver.js";
export {
  CONTRACT_VERSION,
  type SelfHealDisposition,
  type CandidateFix,
  type SuiteResult,
  type JudgeResult,
  type SelfHealGateInput,
  type SelfHealVerdict,
  type SelfHealExecutors,
  type SelfHealFailure,
  type OpusAdviceContext,
  type SelfHealResult,
  type SelfHealDriverInput,
} from "./contract.js";
