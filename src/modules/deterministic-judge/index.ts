/**
 * ikbi deterministic-judge — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. It registers NO guard / side-
 * effect and is a PURE scorer — it imports NO model/provider, NO workspace, and NO
 * worker-model; it scores already-captured BuildCandidates. That import-surface
 * absence is the purity guarantee (enforced by a test).
 *
 * NO gate-wall: the judge scores, it does not govern or execute. (It gates promotion
 * by picking a winner, so correctness matters — hence the heavy determinism tests.)
 *
 * Only `events` is pinned: the judge emits a single `judge.evaluated` event and is
 * NOT identity-attributed (it is engine-internal scoring, not an agent action).
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("events", "1.0.0");

export {
  createDeterministicJudge,
  deterministicJudge,
  defaultOverrides,
  defaultFamilies,
  type DeterministicJudgeDeps,
} from "./judge.js";
export {
  CONTRACT_VERSION,
  type BuildCandidate,
  type CandidateVerdict,
  type DeterministicJudge,
  type JudgeFamily,
  type JudgeOverride,
  type JudgeResult,
} from "./contract.js";
export {
  deterministicJudgeConfig,
  loadDeterministicJudgeConfig,
  DEFAULT_MAX_DIFF_LINES,
  DEFAULT_MAX_FILES,
  TIE_EPSILON,
  FAMILY_WEIGHTS,
  type DeterministicJudgeConfig,
} from "./config.js";
export {
  judgeEvaluated,
  type JudgeEventPayload,
} from "./events.js";
