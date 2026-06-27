/**
 * Velum — Configuration schema + validation.
 */
export class VelumConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "VelumConfigError";
    }
}
function isPiiLevel(v) {
    return v === 1 || v === 2 || v === 3;
}
/**
 * Validate and normalize a partial config object into a full VelumConfig,
 * filling in defaults. Throws VelumConfigError on invalid values.
 */
export function validateConfig(input, defaults) {
    const cfg = { ...defaults, ...(input ?? {}) };
    if (typeof cfg.enabled !== "boolean") {
        throw new VelumConfigError(`'enabled' must be a boolean, got ${typeof cfg.enabled}`);
    }
    if (!isPiiLevel(cfg.defaultPiiLevel)) {
        throw new VelumConfigError(`'defaultPiiLevel' must be 1, 2, or 3, got ${String(cfg.defaultPiiLevel)}`);
    }
    if (cfg.outputPiiLevel !== undefined && !isPiiLevel(cfg.outputPiiLevel)) {
        throw new VelumConfigError(`'outputPiiLevel' must be 1, 2, or 3, got ${String(cfg.outputPiiLevel)}`);
    }
    if (cfg.detectNames !== undefined && typeof cfg.detectNames !== "boolean") {
        throw new VelumConfigError("'detectNames' must be a boolean");
    }
    if (cfg.credentialBufferTtlMs !== undefined) {
        if (typeof cfg.credentialBufferTtlMs !== "number" || cfg.credentialBufferTtlMs <= 0) {
            throw new VelumConfigError("'credentialBufferTtlMs' must be a positive number");
        }
    }
    if (cfg.neverRedact !== undefined && !Array.isArray(cfg.neverRedact)) {
        throw new VelumConfigError("'neverRedact' must be an array of strings");
    }
    if (cfg.patternPacks !== undefined && !Array.isArray(cfg.patternPacks)) {
        throw new VelumConfigError("'patternPacks' must be an array of file paths");
    }
    if (cfg.modules !== undefined) {
        for (const [name, mod] of Object.entries(cfg.modules)) {
            if (mod.piiLevel !== undefined && !isPiiLevel(mod.piiLevel)) {
                throw new VelumConfigError(`module '${name}': piiLevel must be 1, 2, or 3`);
            }
        }
    }
    return cfg;
}
//# sourceMappingURL=schema.js.map