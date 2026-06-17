/**
 * Command effect policy — RE-EXPORT SHIM.
 *
 * The canonical `commandPolicyDenyReason` now lives in the neutral `execution-policy/risk.ts`
 * module to break the circular dependency between gate-wall and governed-exec.
 * This file re-exports it so existing imports (`from "../governed-exec/policy.js"`)
 * continue to work without changes.
 */

export { commandPolicyDenyReason } from "../execution-policy/risk.js";
