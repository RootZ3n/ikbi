/**
 * Velum — Generic adapter
 * ============================================================
 * Framework-agnostic. Returns a bundle of bound functions configured from a
 * VelumConfig. Use this anywhere — a queue worker, a Lambda, a CLI, a custom
 * server — no framework required.
 * ============================================================
 */
import { classify as coreClassify } from "../core/classify.js";
import { scanInput as coreScanInput, scanContext as coreScanContext, scanOutput as coreScanOutput, applyOutputGuardSync as coreApplyOutputGuard, } from "../core/guard.js";
import { scanPii as coreScanPii, maskPii as coreMaskPii, processWithPii as coreProcessWithPii, demask as coreDemask, } from "../core/pii.js";
import { consumeCredential, getAvailableCredentials, } from "../core/credential-buffer.js";
import { createRegistry } from "../core/patterns.js";
import { guardToolCall as coreGuardToolCall } from "../core/tool-guard.js";
import { loadConfig, applyRuntimeConfig } from "../config/defaults.js";
/**
 * Build a configured Velum instance. Each instance gets its own pattern
 * registry, so custom patterns/neverRedact never leak between instances.
 */
export function createVelum(config) {
    const resolved = loadConfig({ overrides: config, readEnv: false });
    const registry = createRegistry();
    applyRuntimeConfig(resolved, registry);
    const piiLevel = resolved.defaultPiiLevel;
    return {
        config: resolved,
        registry,
        enabled: resolved.enabled,
        classify: (message, sessionId) => resolved.enabled
            ? coreClassify(message, sessionId, { registry })
            : passthroughClassification(message),
        scanInput: (text) => (resolved.enabled ? coreScanInput(text, registry) : allow()),
        scanContext: (messages) => resolved.enabled ? coreScanContext(messages, registry) : allow(),
        scanOutput: (text) => (resolved.enabled ? coreScanOutput(text, registry) : allow()),
        applyOutputGuard: (text, opts = { inCharacter: false }) => resolved.enabled
            ? coreApplyOutputGuard(text, opts, registry)
            : { text: text ?? "", scan: allow(), blocked: false, redacted: false },
        scanPii: (text) => (resolved.enabled ? coreScanPii(text, registry) : []),
        maskPii: (text) => resolved.enabled ? coreMaskPii(text, registry) : { text: text ?? "", placeholderMap: new Map() },
        demask: (text, map) => coreDemask(text, map),
        processPii: (text, level) => resolved.enabled
            ? coreProcessWithPii(text, level ?? piiLevel, registry)
            : { detections: [], masked: false, level: level ?? piiLevel },
        getCredential: (id) => consumeCredential(id),
        getAvailableCredentials: (pattern) => getAvailableCredentials(pattern),
        guardToolCall: (input) => resolved.enabled
            ? coreGuardToolCall(input, registry)
            : Promise.resolve({
                toolName: input.toolName,
                allowed: true,
                decision: "allow",
                resolvedArgs: input.args,
                argsScan: allow(),
                reasons: [],
                scanResult: (value) => ({ value, scan: allow() }),
            }),
    };
}
function allow() {
    return { decision: "allow", reasons: [], flags: [] };
}
function passthroughClassification(message) {
    return {
        classification: "SAFE",
        action: "passed",
        sanitizedMessage: message ?? "",
        warnings: [],
        patternsMatched: [],
        credentialBufferIds: [],
    };
}
//# sourceMappingURL=generic.js.map