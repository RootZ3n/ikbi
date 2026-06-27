/**
 * Velum — Generic adapter
 * ============================================================
 * Framework-agnostic. Returns a bundle of bound functions configured from a
 * VelumConfig. Use this anywhere — a queue worker, a Lambda, a CLI, a custom
 * server — no framework required.
 * ============================================================
 */

import { classify as coreClassify, type ClassificationResult } from "../core/classify.js";
import {
  scanInput as coreScanInput,
  scanContext as coreScanContext,
  scanOutput as coreScanOutput,
  applyOutputGuardSync as coreApplyOutputGuard,
  type ScanResult,
  type ContextScanInput,
  type ContextScanResult,
  type OutputGuardResult,
} from "../core/guard.js";
import {
  scanPii as coreScanPii,
  maskPii as coreMaskPii,
  processWithPii as coreProcessWithPii,
  demask as coreDemask,
  type PiiDetection,
  type PiiResult,
  type PiiLevel,
} from "../core/pii.js";
import {
  consumeCredential,
  getAvailableCredentials,
  type CredentialMetadata,
} from "../core/credential-buffer.js";
import { createRegistry, type PatternRegistry } from "../core/patterns.js";
import { guardToolCall as coreGuardToolCall, type GuardToolCallInput, type GuardToolCallResult } from "../core/tool-guard.js";
import { loadConfig, applyRuntimeConfig } from "../config/defaults.js";
import type { VelumConfig } from "../config/schema.js";

export interface Velum {
  config: VelumConfig;
  registry: PatternRegistry;
  enabled: boolean;

  classify(message: string, sessionId?: string): ClassificationResult;
  scanInput(text: string): ScanResult;
  scanContext(messages: ContextScanInput[]): ContextScanResult;
  scanOutput(text: string): ScanResult;
  applyOutputGuard(text: string, opts?: { inCharacter: boolean }): OutputGuardResult;

  scanPii(text: string): PiiDetection[];
  maskPii(text: string): { text: string; placeholderMap: Map<string, string> };
  demask(text: string, placeholderMap: Map<string, string>): string;
  processPii(text: string, level?: PiiLevel): PiiResult;

  /** Consume (single-use) a buffered credential value by id. */
  getCredential(id: string): string | null;
  getAvailableCredentials(pattern?: string): CredentialMetadata[];

  /**
   * Guard a tool call: scan args for injection/secrets, resolve credential
   * placeholders from the buffer, and (when `dispatch` is given) scan the
   * return value. Uses this instance's registry.
   */
  guardToolCall(input: GuardToolCallInput): Promise<GuardToolCallResult>;
}

/**
 * Build a configured Velum instance. Each instance gets its own pattern
 * registry, so custom patterns/neverRedact never leak between instances.
 */
export function createVelum(config?: Partial<VelumConfig>): Velum {
  const resolved = loadConfig({ overrides: config, readEnv: false });
  const registry = createRegistry();
  applyRuntimeConfig(resolved, registry);

  const piiLevel = resolved.defaultPiiLevel;

  return {
    config: resolved,
    registry,
    enabled: resolved.enabled,

    classify: (message, sessionId) =>
      resolved.enabled
        ? coreClassify(message, sessionId, { registry })
        : passthroughClassification(message),
    scanInput: (text) => (resolved.enabled ? coreScanInput(text, registry) : allow()),
    scanContext: (messages) =>
      resolved.enabled ? coreScanContext(messages, registry) : allow(),
    scanOutput: (text) => (resolved.enabled ? coreScanOutput(text, registry) : allow()),
    applyOutputGuard: (text, opts = { inCharacter: false }) =>
      resolved.enabled
        ? coreApplyOutputGuard(text, opts, registry)
        : { text: text ?? "", scan: allow(), blocked: false, redacted: false },

    scanPii: (text) => (resolved.enabled ? coreScanPii(text, registry) : []),
    maskPii: (text) =>
      resolved.enabled ? coreMaskPii(text, registry) : { text: text ?? "", placeholderMap: new Map() },
    demask: (text, map) => coreDemask(text, map),
    processPii: (text, level) =>
      resolved.enabled
        ? coreProcessWithPii(text, level ?? piiLevel, registry)
        : { detections: [], masked: false, level: level ?? piiLevel },

    getCredential: (id) => consumeCredential(id),
    getAvailableCredentials: (pattern) => getAvailableCredentials(pattern),
    guardToolCall: (input) =>
      resolved.enabled
        ? coreGuardToolCall(input, registry)
        : Promise.resolve({
            toolName: input.toolName,
            allowed: true,
            decision: "allow" as const,
            resolvedArgs: input.args,
            argsScan: allow(),
            reasons: [],
            scanResult: (value: unknown) => ({ value, scan: allow() }),
          }),
  };
}

function allow(): ScanResult {
  return { decision: "allow", reasons: [], flags: [] };
}

function passthroughClassification(message: string): ClassificationResult {
  return {
    classification: "SAFE",
    action: "passed",
    sanitizedMessage: message ?? "",
    warnings: [],
    patternsMatched: [],
    credentialBufferIds: [],
  };
}
