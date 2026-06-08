/**
 * ikbi chat — module entrypoint.
 *
 * Pins the FROZEN-CORE contracts this module builds against (provider for
 * invokeModel, injection for the neutralization chokepoint, identity for the
 * governed parent context) so a drift throws a clear ContractVersionError at load.
 * Importing this file REGISTERS the `POST /chat` route (via ./routes side effect);
 * the module barrel (src/modules/index.ts) imports it so the server exposes it.
 *
 * NOTE: governed-exec (the terminal's governance) is a MODULE dependency, not a
 * frozen-core contract, so it is not pinned here — only the frozen deps are.
 */

import { assertContractCompatible } from "../../core/contracts/index.js";

assertContractCompatible("provider", "1.1.0");
assertContractCompatible("injection", "1.0.0");
assertContractCompatible("identity", "1.1.0");

// Side-effect: register the POST /chat route on import.
import "./routes.js";

export { CONTRACT_VERSION, type ChatRequest, type ChatResponse, type ChatToolActivity } from "./contract.js";
export { ChatSession, sessionStore } from "./session.js";
