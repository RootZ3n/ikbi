/**
 * `velum init` — generate a velum.config.yaml with documented defaults.
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";

import { PRESETS, renderPresetConfig, listPresets } from "../presets.js";

export const CONFIG_TEMPLATE = `# Velum configuration
# AI Privacy & Injection Defense — https://www.npmjs.com/package/velum-ai

# Master switch. When false, Velum passes everything through untouched.
enabled: true

# Default PII handling level for modules without an override:
#   1 = Observe  (detect + log only, text unchanged)
#   2 = Redact   (replace PII with reversible typed placeholders, e.g. [EMAIL_1])
#   3 = Sanitize (strip PII to [REDACTED], not reversible)
defaultPiiLevel: 1

# Credential buffer time-to-live, in milliseconds (default 5 minutes).
credentialBufferTtlMs: 300000

# Extra terms that must never be redacted as credentials (case-insensitive).
# Your product/tool names go here to avoid false positives.
neverRedact:
  - myproduct
  - myservice

# Optional JSONL audit log + receipts directory.
# auditLogPath: ./state/velum-audit.jsonl
# receiptsDir: ./state/receipts

# Per-module PII level overrides, keyed by module/route name.
modules:
  chat:
    piiLevel: 2
  internal:
    piiLevel: 1
`;

export interface InitOptions {
  cwd?: string;
  force?: boolean;
  path?: string;
  /** Product preset name (nusika, toba, looney-luna). */
  preset?: string;
}

export async function runInit(options: InitOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const target = resolve(cwd, options.path ?? "velum.config.yaml");

  if (existsSync(target) && !options.force) {
    process.stderr.write(`velum init: ${target} already exists. Use --force to overwrite.\n`);
    return 1;
  }

  // ── Preset mode: write a product config + its shareable pattern pack ──
  if (options.preset) {
    const preset = PRESETS[options.preset];
    if (!preset) {
      process.stderr.write(`velum init: unknown preset '${options.preset}'.\n\nAvailable presets:\n${listPresets()}\n`);
      return 1;
    }
    const packFileName = `velum-pack.${preset.name}.json`;
    const packPath = resolve(dirname(target), packFileName);
    if (existsSync(packPath) && !options.force) {
      process.stderr.write(`velum init: ${packPath} already exists. Use --force to overwrite.\n`);
      return 1;
    }
    writeFileSync(target, renderPresetConfig(preset, basename(packFileName)), "utf-8");
    writeFileSync(packPath, JSON.stringify(preset.pack, null, 2) + "\n", "utf-8");
    process.stdout.write(`✓ Wrote ${target} (preset: ${preset.name})\n`);
    process.stdout.write(`✓ Wrote ${packPath}\n`);
    return 0;
  }

  writeFileSync(target, CONFIG_TEMPLATE, "utf-8");
  process.stdout.write(`✓ Wrote ${target}\n`);
  return 0;
}
