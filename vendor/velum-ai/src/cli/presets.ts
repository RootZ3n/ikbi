/**
 * Velum — Product presets for `velum init --preset <product>`.
 *
 * Each preset pairs a config (raised PII level + product-safe `neverRedact`
 * terms) with a shareable pattern-pack JSON file. The config references the
 * pack via `patternPacks:`, so the product version-controls its own detection
 * rules instead of hand-coding addPattern() calls.
 */

import type { PatternPack } from "../config/pattern-pack.js";
import type { PiiLevel } from "../config/schema.js";

export interface Preset {
  name: string;
  /** Headline shown by `velum init --preset` / `--list-presets`. */
  summary: string;
  defaultPiiLevel: PiiLevel;
  neverRedact: string[];
  pack: PatternPack;
}

export const PRESETS: Record<string, Preset> = {
  nusika: {
    name: "nusika",
    summary: "Adaptive language tutor — protect learner emails/names, keep language tokens",
    defaultPiiLevel: 2, // learners share emails/names; redact PII by default
    neverRedact: [
      // Language vocabulary and companion names must never look like secrets.
      "ser", "estar", "hola", "gracias", "balam", "wei", "marcus", "nusika",
      "spanish", "mandarin", "latin", "french", "kokoro", "companion",
    ],
    pack: {
      name: "nusika",
      version: "1.0.0",
      patterns: [],
      neverRedact: ["ser", "estar", "balam", "wei", "marcus"],
    },
  },

  toba: {
    name: "toba",
    summary: "Career command center — whitelist resume terms, flag LinkedIn URLs + salary as PII",
    defaultPiiLevel: 2,
    neverRedact: [
      "resume", "linkedin", "recruiter", "applicant", "candidate", "campaign",
      "outreach", "interview", "toba", "tavily",
    ],
    pack: {
      name: "toba",
      version: "1.0.0",
      patterns: [
        {
          name: "linkedin_url",
          pattern: "https?://(?:www\\.)?linkedin\\.com/(?:in|pub)/[A-Za-z0-9_-]+",
          flags: "gi",
          category: "pii",
          severity: "warn",
          description: "LinkedIn profile URL (personal identifier)",
        },
        {
          name: "salary_figure",
          pattern: "\\$\\s?\\d{2,3}(?:,\\d{3})+(?:\\s?(?:/yr|per year|annually|k))?",
          flags: "gi",
          category: "pii",
          severity: "warn",
          description: "Salary / compensation figure",
        },
      ],
      neverRedact: ["resume", "linkedin"],
    },
  },

  "looney-luna": {
    name: "looney-luna",
    summary: "Creative production — flag cloud asset-storage signed URLs",
    defaultPiiLevel: 1,
    neverRedact: ["minimax", "comfyui", "hailuo", "luna", "synthwave", "wyrms"],
    pack: {
      name: "looney-luna",
      version: "1.0.0",
      patterns: [
        {
          name: "signed_asset_url",
          // S3/GCS/Azure pre-signed URLs carry a credential in the query string.
          pattern:
            "https?://[^\\s\"']+[?&](?:X-Amz-Signature|X-Goog-Signature|sig|Signature)=[A-Za-z0-9%_-]{16,}",
          flags: "gi",
          category: "credential",
          severity: "block",
          confidence: "high",
          description: "Pre-signed cloud asset-storage URL (embedded signature)",
        },
      ],
      neverRedact: [],
    },
  },
};

export function listPresets(): string {
  return Object.values(PRESETS)
    .map((p) => `  ${p.name.padEnd(12)} ${p.summary}`)
    .join("\n");
}

/** Render the velum.config.yaml text for a preset, referencing its pack file. */
export function renderPresetConfig(preset: Preset, packFileName: string): string {
  const neverRedact = preset.neverRedact.map((t) => `  - ${t}`).join("\n");
  return `# Velum configuration — preset: ${preset.name}
# ${preset.summary}
# AI Privacy & Injection Defense — https://www.npmjs.com/package/velum-ai

enabled: true

# Raised for this product (see preset rationale above).
#   1 = Observe  2 = Redact (reversible)  3 = Sanitize (irreversible)
defaultPiiLevel: ${preset.defaultPiiLevel}

credentialBufferTtlMs: 300000

# Product-safe terms that must never be flagged as credentials.
neverRedact:
${neverRedact}

# Shareable, version-controlled detection pack for this product.
patternPacks:
  - ./${packFileName}

# Optional JSONL audit log (uncomment to make Velum observable).
# auditLogPath: ./state/velum-audit.jsonl
`;
}
