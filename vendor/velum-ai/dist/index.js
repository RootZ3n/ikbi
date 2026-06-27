/**
 * Velum — AI Privacy & Injection Defense
 * ============================================================
 * Public API barrel. Import everything from "velum-ai", or pull adapters from
 * "velum-ai/adapters/{fastify,express,generic}".
 * ============================================================
 */
// ── Core: classification ──
export { classify, } from "./core/classify.js";
// ── Core: three-stage guard ──
export { maxDecision, scanInput, scanContext, scanOutput, applyOutputGuardSync, createOutputStreamGuard, } from "./core/guard.js";
// ── Core: guarded tool calls ──
export { guardToolCall, CREDENTIAL_PLACEHOLDER, } from "./core/tool-guard.js";
// ── Core: audit receipts ──
export { emitReceipt, configureReceipts, getReceiptConfig, } from "./core/receipts.js";
// ── Core: PII ──
export { scanPii, maskPii, demask, sanitizePii, processWithPii, getDetectionLog, clearDetectionLog, } from "./core/pii.js";
// ── Core: credential buffer ──
export { storeCredential, getCredential, consumeCredential, getAvailableCredentials, clearExpiredCredentials, clearAllCredentials, setCredentialTtl, getCredentialTtl, DEFAULT_TTL_MS, } from "./core/credential-buffer.js";
// ── Core: pattern registry ──
export { createRegistry, registry, DEFAULT_NEVER_REDACT, } from "./core/patterns.js";
// ── Config ──
export { validateConfig, VelumConfigError, } from "./config/schema.js";
export { DEFAULT_CONFIG, loadConfig, configFromEnv, applyRuntimeConfig, parseConfigYaml, } from "./config/defaults.js";
export { loadPatternPack, parsePatternPack, applyPatternPack, } from "./config/pattern-pack.js";
// ── Adapters ──
export { createVelum } from "./adapters/generic.js";
export { velumExpress } from "./adapters/express.js";
export { velumFastify } from "./adapters/fastify.js";
// ── Pipeline ──
export { guardRequest, guardResponse, } from "./core/pipeline.js";
//# sourceMappingURL=index.js.map