/**
 * Velum — Default config + loaders (config file, env vars, programmatic).
 *
 * Precedence (lowest → highest):
 *   defaults  <  config file (velum.config.yaml)  <  VELUM_* env vars  <  programmatic
 *
 * A tiny YAML reader is included so Velum keeps its zero-dependency promise.
 * It supports the subset Velum emits: scalars, 2-space nesting, and `-` lists.
 */

import { readFileSync, existsSync } from "node:fs";

import { validateConfig, type VelumConfig, type PiiLevel } from "./schema.js";
import { setCredentialTtl, DEFAULT_TTL_MS } from "../core/credential-buffer.js";
import { registry as defaultRegistry, type PatternRegistry } from "../core/patterns.js";
import { configureReceipts } from "../core/receipts.js";
import { loadPatternPack, applyPatternPack } from "./pattern-pack.js";

export const DEFAULT_CONFIG: VelumConfig = {
  enabled: true,
  defaultPiiLevel: 1,
  credentialBufferTtlMs: DEFAULT_TTL_MS,
  modules: {},
};

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
export function loadConfig(options: LoadConfigOptions = {}): VelumConfig {
  const { overrides, readEnv = true, env = process.env } = options;

  let fileConfig: Partial<VelumConfig> = {};
  const path = options.configPath ?? "velum.config.yaml";
  if (existsSync(path)) {
    try {
      fileConfig = parseConfigYaml(readFileSync(path, "utf-8"));
    } catch (err) {
      throw new Error(`Failed to read Velum config at ${path}: ${(err as Error).message}`);
    }
  }

  const envConfig = readEnv ? configFromEnv(env) : {};

  const merged: Partial<VelumConfig> = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...envConfig,
    ...(overrides ?? {}),
  };

  return validateConfig(merged, DEFAULT_CONFIG);
}

/** Build a partial config from VELUM_* environment variables. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<VelumConfig> {
  const out: Partial<VelumConfig> = {};
  if (env["VELUM_ENABLED"] !== undefined) out.enabled = env["VELUM_ENABLED"] !== "false" && env["VELUM_ENABLED"] !== "0";
  if (env["VELUM_DEFAULT_PII_LEVEL"] !== undefined) {
    const lvl = Number(env["VELUM_DEFAULT_PII_LEVEL"]);
    if (lvl === 1 || lvl === 2 || lvl === 3) out.defaultPiiLevel = lvl as PiiLevel;
  }
  if (env["VELUM_OUTPUT_PII_LEVEL"] !== undefined) {
    const lvl = Number(env["VELUM_OUTPUT_PII_LEVEL"]);
    if (lvl === 1 || lvl === 2 || lvl === 3) out.outputPiiLevel = lvl as PiiLevel;
  }
  if (env["VELUM_DETECT_NAMES"] !== undefined) {
    out.detectNames = env["VELUM_DETECT_NAMES"] !== "false" && env["VELUM_DETECT_NAMES"] !== "0";
  }
  if (env["VELUM_CREDENTIAL_BUFFER_TTL_MS"] !== undefined) {
    const ttl = Number(env["VELUM_CREDENTIAL_BUFFER_TTL_MS"]);
    if (Number.isFinite(ttl) && ttl > 0) out.credentialBufferTtlMs = ttl;
  }
  if (env["VELUM_AUDIT_LOG_PATH"]) out.auditLogPath = env["VELUM_AUDIT_LOG_PATH"];
  if (env["VELUM_RECEIPTS_DIR"]) out.receiptsDir = env["VELUM_RECEIPTS_DIR"];
  if (env["VELUM_NEVER_REDACT"]) {
    out.neverRedact = env["VELUM_NEVER_REDACT"].split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (env["VELUM_PATTERN_PACKS"]) {
    out.patternPacks = env["VELUM_PATTERN_PACKS"].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

/**
 * Apply runtime-effecting config to a registry + the credential buffer:
 *  - merge neverRedact terms
 *  - register customPatterns
 *  - set the credential buffer TTL
 */
export function applyRuntimeConfig(config: VelumConfig, registry: PatternRegistry = defaultRegistry): void {
  if (config.credentialBufferTtlMs) setCredentialTtl(config.credentialBufferTtlMs);
  if (config.neverRedact) {
    for (const term of config.neverRedact) registry.neverRedact.add(term.toLowerCase());
  }
  if (config.customPatterns) {
    for (const def of config.customPatterns) registry.addPattern(def);
  }
  // Load shareable pattern packs (each product version-controls its own).
  if (config.patternPacks) {
    for (const path of config.patternPacks) {
      try {
        applyPatternPack(loadPatternPack(path), registry);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[velum] failed to load pattern pack '${path}': ${(err as Error).message}`);
      }
    }
  }
  // Enable audit receipts when an audit log path is configured.
  configureReceipts({ auditLogPath: config.auditLogPath });
}

// ── Minimal YAML reader (zero-dependency subset) ─────────────────────────────

/** Parse the supported YAML subset into a partial VelumConfig. */
export function parseConfigYaml(text: string): Partial<VelumConfig> {
  const root = parseYaml(text);
  if (typeof root !== "object" || root === null || Array.isArray(root)) return {};
  const obj = root as Record<string, unknown>;
  const out: Partial<VelumConfig> = {};

  if (typeof obj["enabled"] === "boolean") out.enabled = obj["enabled"];
  if (obj["defaultPiiLevel"] === 1 || obj["defaultPiiLevel"] === 2 || obj["defaultPiiLevel"] === 3) {
    out.defaultPiiLevel = obj["defaultPiiLevel"] as PiiLevel;
  }
  if (obj["outputPiiLevel"] === 1 || obj["outputPiiLevel"] === 2 || obj["outputPiiLevel"] === 3) {
    out.outputPiiLevel = obj["outputPiiLevel"] as PiiLevel;
  }
  if (typeof obj["detectNames"] === "boolean") out.detectNames = obj["detectNames"];
  if (typeof obj["credentialBufferTtlMs"] === "number") out.credentialBufferTtlMs = obj["credentialBufferTtlMs"];
  if (typeof obj["auditLogPath"] === "string") out.auditLogPath = obj["auditLogPath"];
  if (typeof obj["receiptsDir"] === "string") out.receiptsDir = obj["receiptsDir"];
  if (Array.isArray(obj["neverRedact"])) out.neverRedact = obj["neverRedact"].map(String);
  if (Array.isArray(obj["patternPacks"])) out.patternPacks = obj["patternPacks"].map(String);
  if (typeof obj["modules"] === "object" && obj["modules"] !== null) {
    const modules: Record<string, { piiLevel?: PiiLevel }> = {};
    for (const [name, val] of Object.entries(obj["modules"] as Record<string, unknown>)) {
      if (val && typeof val === "object" && "piiLevel" in val) {
        const lvl = (val as Record<string, unknown>)["piiLevel"];
        if (lvl === 1 || lvl === 2 || lvl === 3) modules[name] = { piiLevel: lvl as PiiLevel };
      }
    }
    out.modules = modules;
  }
  return out;
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

interface Line {
  indent: number;
  content: string;
}

function parseYaml(text: string): YamlValue {
  const lines: Line[] = text
    .split(/\r?\n/)
    .map((raw) => stripComment(raw))
    .filter((raw) => raw.trim().length > 0)
    .map((raw) => ({ indent: raw.length - raw.trimStart().length, content: raw.trim() }));
  const [value] = parseBlock(lines, 0, 0);
  return value;
}

function stripComment(line: string): string {
  // Remove `#` comments that are not inside quotes (good enough for config).
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const first = lines[start];
  if (!first) return [null, start];

  if (first.content.startsWith("- ")) {
    const arr: YamlValue[] = [];
    let i = start;
    while (i < lines.length && lines[i]!.indent === indent && lines[i]!.content.startsWith("- ")) {
      arr.push(parseScalar(lines[i]!.content.slice(2).trim()));
      i++;
    }
    return [arr, i];
  }

  const map: { [k: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    const colon = line.content.indexOf(":");
    if (colon < 0) {
      i++;
      continue;
    }
    const key = line.content.slice(0, colon).trim();
    const rest = line.content.slice(colon + 1).trim();
    if (rest.length > 0) {
      map[key] = parseScalar(rest);
      i++;
    } else {
      // Nested block on following deeper-indented lines.
      const childIndent = i + 1 < lines.length ? lines[i + 1]!.indent : indent;
      if (childIndent > indent) {
        const [child, next] = parseBlock(lines, i + 1, childIndent);
        map[key] = child;
        i = next;
      } else {
        map[key] = null;
        i++;
      }
    }
  }
  return [map, i];
}

function parseScalar(token: string): YamlValue {
  if (token === "") return null;
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null" || token === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  return token;
}
