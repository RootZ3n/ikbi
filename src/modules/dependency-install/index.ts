/**
 * ikbi dependency-install — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (exact targets) so a
 * drift throws a clear ContractVersionError at load. Like gate-wall / governed-exec,
 * it registers NO guard / side-effect — it is a pure consumer. The operator wires the
 * installer into an entrypoint (route/CLI) in the later barrel-wiring pass; this file
 * does NOT touch `src/modules/index.ts`.
 *
 * NOTE: `gate-wall` (install gating) and `egress` (the SSRF guard — though see the
 * honest residual: a pm subprocess is outside its in-process scope) are MODULE deps,
 * not frozen-core contracts in `CONTRACT_VERSIONS`, so they are not pinned here.
 * `events` is pinned too: it is BEYOND the plan's original dep list for this module —
 * added for install lifecycle visibility (a minor, non-security dependency).
 *
 * @status dormant (library-only)
 * DORMANT: a complete, tested LIBRARY surface (`dependencyInstall.run(...)`) with NO live
 * operator path yet — no CLI command and no HTTP route invokes it. capability-recovery may
 * RECOMMEND a dependency install as data, but never dispatches it. Wiring an entrypoint is
 * deliberate future work; until then the module only initializes (pins + config) and does
 * no work unless a consumer calls it directly. See MODULE_CENSUS.md.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("receipt", "1.0.0");
assertContractCompatible("identity", "1.1.0");
assertContractCompatible("workspace", "1.0.0");
assertContractCompatible("events", "1.0.0"); // install-lifecycle visibility (beyond the plan's original dep list)

export { createDependencyInstall, dependencyInstall, type DependencyInstallDeps, type ExecFileFn, type ReadLockfileFn } from "./install.js";
export {
  CONTRACT_VERSION,
  type DependencyInstall,
  type InstallRequest,
  type InstallResult,
  type PackageManager,
} from "./contract.js";
export {
  dependencyInstallConfig,
  loadDependencyInstallConfig,
  DEFAULT_REGISTRY_ALLOWLIST,
  DEFAULT_PACKAGE_MANAGER,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
  OUTPUT_TAIL_CHARS,
  type DependencyInstallConfig,
} from "./config.js";
export {
  depinstallRequested,
  depinstallGated,
  depinstallCompleted,
  depinstallFailed,
  type DepInstallEventPayload,
} from "./events.js";
