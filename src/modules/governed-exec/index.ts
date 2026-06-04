/**
 * ikbi governed-exec — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. Like gate-wall / subagent-
 * spawning, it registers NO guard / side-effect — it is a pure consumer. The
 * operator wires the executor into an entrypoint (route/CLI) in the later barrel-
 * wiring pass; this file does NOT touch `src/modules/index.ts`.
 *
 * NOTE: `gate-wall` (the exec-action enforcement layer) and `egress` (the guarded
 * fetch) are MODULE dependencies, not frozen-core contracts in `CONTRACT_VERSIONS`,
 * so they cannot be pinned here — only the frozen deps (receipt, identity, events).
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("receipt", "1.0.0");
assertContractCompatible("identity", "1.1.0");
assertContractCompatible("events", "1.0.0");

export { createGovernedExec, governedExec, type ExecFileFn, type GovernedExecDeps } from "./exec.js";
export {
  CONTRACT_VERSION,
  type ExecRequest,
  type ExecResult,
  type GovernedExec,
  type HttpRequest,
  type HttpResult,
} from "./contract.js";
export {
  governedExecConfig,
  loadGovernedExecConfig,
  DEFAULT_ALLOWLIST,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
  DEFAULT_NETWORK_TIMEOUT_MS,
  OUTPUT_TAIL_CHARS,
  type GovernedExecConfig,
} from "./config.js";
export {
  govexecRequested,
  govexecDenied,
  govexecExecuted,
  govexecFailed,
  type GovExecEventPayload,
} from "./events.js";
