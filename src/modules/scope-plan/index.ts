/**
 * ikbi scope-plan — module entrypoint.
 *
 * Turns an author-ordered SCOPE.md into a staged build: each stage is a SMALL builder pass run
 * through the existing shared-workspace multi-step machinery (accumulate → final verify/promote).
 * The reliability answer to cheap-model VARIANCE — a bounded pass per stage instead of one giant
 * pass whose outcome swings on luck. See parse.ts for the (forgiving) SCOPE.md format.
 */

export { parseScopePlan } from "./parse.js";
export { MAX_SCOPE_STAGES, DEFAULT_SCOPE_FILES } from "./config.js";
export type { ScopePlan, ScopeStage } from "./contract.js";
