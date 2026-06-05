/**
 * ikbi trust — module entrypoint (the operator trust CLI surface).
 *
 * Pins the FROZEN-CORE contracts this module builds against so a drift throws a
 * clear ContractVersionError at load. The trust ENGINE itself lives in the frozen
 * core (`core/trust`); this module is the operator-facing CLI on top of it.
 *
 * The modules barrel imports this file at engine start so the `trust` operator
 * command (grant / status — the cold-start on-ramp) is registered before dispatch.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("identity", "1.1.0");
assertContractCompatible("trust", "1.0.0");

// Side-effect import: registers the `trust` operator CLI command (grant / status).
import "./cli.js";

export { createTrustCli, type TrustCliDeps } from "./cli.js";
