/**
 * Velum — Default config + loaders (config file, env vars, programmatic).
 *
 * Precedence (lowest → highest):
 *   defaults  <  config file (velum.config.yaml)  <  VELUM_* env vars  <  programmatic
 *
 * A tiny YAML reader is included so Velum keeps its zero-dependency promise.
 * It supports the subset Velum emits: scalars, 2-space nesting, and `-` lists.
 */
import { type VelumConfig } from "./schema.js";
import { type PatternRegistry } from "../core/patterns.js";
export declare const DEFAULT_CONFIG: VelumConfig;
export interface LoadConfigOptions {
    /** Path to a YAML config file. Defaults to ./velum.config.yaml if it exists. */
    configPath?: string;
    /** Programmatic overrides — highest precedence. */
    overrides?: Partial<VelumConfig>;
    /** Read env vars (default true). */
    readEnv?: boolean;
    /** Environment object (default process.env). */
    env?: NodeJS.ProcessEnv;
}
/** Resolve the effective config from file + env + programmatic overrides. */
export declare function loadConfig(options?: LoadConfigOptions): VelumConfig;
/** Build a partial config from VELUM_* environment variables. */
export declare function configFromEnv(env?: NodeJS.ProcessEnv): Partial<VelumConfig>;
/**
 * Apply runtime-effecting config to a registry + the credential buffer:
 *  - merge neverRedact terms
 *  - register customPatterns
 *  - set the credential buffer TTL
 */
export declare function applyRuntimeConfig(config: VelumConfig, registry?: PatternRegistry): void;
/** Parse the supported YAML subset into a partial VelumConfig. */
export declare function parseConfigYaml(text: string): Partial<VelumConfig>;
//# sourceMappingURL=defaults.d.ts.map