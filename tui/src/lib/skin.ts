// Skin loader — reads ikbi's skin.yaml and provides it to the TUI.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SkinColors {
  banner_border: string;
  banner_title: string;
  banner_accent: string;
  ui_accent: string;
  ui_ok: string;
  ui_error: string;
  ui_warn: string;
  response_border: string;
  status_bg: string;
  status_fg: string;
  status_good: string;
  status_warn: string;
  status_bad: string;
  text: string;
  muted: string;
  prompt: string;
  selection_bg: string;
  completion_bg: string;
  completion_current_bg: string;
}

export interface SkinTheme {
  primary: string;
  accent: string;
  border: string;
  text: string;
  muted: string;
  ok: string;
  error: string;
  warn: string;
  prompt: string;
  session_label: string;
  session_border: string;
  status_bg: string;
  status_fg: string;
  status_good: string;
  status_warn: string;
  status_bad: string;
  status_critical: string;
  selection_bg: string;
  diff_added: string;
  diff_removed: string;
  diff_added_word: string;
  diff_removed_word: string;
  shell_dollar: string;
}

export interface SkinBranding {
  agent_name: string;
  welcome: string;
  goodbye: string;
  prompt_symbol: string;
  response_label: string;
  help_header: string;
}

export interface SkinSpinner {
  waiting_faces: string[];
  thinking_faces: string[];
  thinking_verbs: string[];
  wings: [string, string][];
}

export interface Skin {
  name: string;
  description: string;
  branding: SkinBranding;
  colors: SkinColors;
  banner_logo: string;
  banner_hero: string;
  spinner: SkinSpinner;
  tool_prefix: string;
  tool_emojis: Record<string, string>;
  theme: SkinTheme;
}

let cachedSkin: Skin | null = null;

export function loadSkin(): Skin {
  if (cachedSkin) return cachedSkin;

  // tui/src/lib/skin.ts -> ../../skin.yaml == tui/skin.yaml
  const skinPath = join(__dirname, '..', '..', 'skin.yaml');
  const raw = readFileSync(skinPath, 'utf-8');
  const parsed = yaml.load(raw) as Skin;

  if (!parsed?.name || !parsed?.branding || !parsed?.colors) {
    throw new Error(`Invalid skin.yaml at ${skinPath}`);
  }

  cachedSkin = parsed;
  return parsed;
}
