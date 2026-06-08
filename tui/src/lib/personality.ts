// Personality loader — reads personality/*.yaml for ikbi and builds its system prompt.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Personality {
  id: string;
  name: string;
  full_name?: string;
  intensity: 'low' | 'medium' | 'high';
  voice_summary: string;
  identity: string[];
  voice: string[];
  honesty_rules: string[];
  profanity: {
    allowed: boolean;
    style: string;
    rules: string[];
  };
  intensity_guide: Record<string, string[]>;
  // Agent-specific fields (optional) — ikbi adds build_philosophy, vocabulary, etc.
  [key: string]: unknown;
}

let cached: Personality | null = null;

export function loadPersonality(): Personality {
  if (cached) return cached;

  // tui/src/lib/personality.ts -> ../../../personality == <repo>/personality
  const personalityDir = join(__dirname, '..', '..', '..', 'personality');
  const files = readdirSync(personalityDir).filter((f: string) => f.endsWith('.yaml') || f.endsWith('.yml'));

  if (files.length === 0) {
    throw new Error(`No personality YAML found in ${personalityDir}`);
  }

  // Prefer ikbi.yaml if present; otherwise take the first.
  const chosen = files.find((f) => f.startsWith('ikbi')) ?? files[0];
  const path = join(personalityDir, chosen);
  const raw = readFileSync(path, 'utf-8');
  const parsed = yaml.load(raw) as Personality;

  if (!parsed?.id || !parsed?.name || !parsed?.voice_summary) {
    throw new Error(`Invalid personality YAML at ${path}`);
  }

  cached = parsed;
  return parsed;
}

/** Coerce an optional string-array personality field into lines, or undefined if absent. */
function lines(p: Personality, key: string): string[] | undefined {
  const v = p[key];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

/**
 * Build the system prompt from the personality. This is what is sent to the model as
 * the system message. Structured for ikbi's engineer voice — identity, build
 * philosophy, voice, vocabulary, honesty, and intensity.
 */
export function buildPersonalityPrompt(p: Personality): string {
  const sections: string[] = [];

  sections.push(`IDENTITY\n${p.identity.join('\n')}`);

  const philosophy = lines(p, 'build_philosophy');
  if (philosophy) sections.push(`BUILD PHILOSOPHY\n${philosophy.join('\n')}`);

  sections.push(`VOICE\n${p.voice.join('\n')}`);

  const vocab = lines(p, 'vocabulary');
  if (vocab) sections.push(`ENGINEERING VOCABULARY\n${vocab.join('\n')}`);

  const catchphrases = lines(p, 'catchphrases');
  if (catchphrases) sections.push(`CATCHPHRASES\n${catchphrases.join('\n')}`);

  // Honesty (non-negotiable)
  sections.push(`HONESTY RULES (non-negotiable)\n${p.honesty_rules.join('\n')}`);

  // Profanity / tone
  if (p.profanity) {
    const tone = p.profanity.allowed ? `allowed (${p.profanity.style})` : `not allowed (${p.profanity.style})`;
    sections.push(`TONE\nProfanity: ${tone}\n${p.profanity.rules.join('\n')}`);
  }

  // Intensity
  const intensityRules = p.intensity_guide[p.intensity] ?? p.intensity_guide['medium'] ?? [];
  sections.push(`INTENSITY: ${p.intensity.toUpperCase()}\n${intensityRules.join('\n')}`);

  return sections.join('\n\n---\n\n');
}
