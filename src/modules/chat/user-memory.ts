/**
 * ikbi chat — USER MEMORY (operator standing instructions, persisted across sessions).
 *
 * A small Markdown file (`~/.ikbi/instructions.md`) of operator-authored standing
 * instructions — "always use conventional commits", "never touch package-lock.json" —
 * that every chat session loads at construction and carries alongside project memory.
 * Unlike project memory (which is per-workspace), this is per-OPERATOR and global.
 *
 * The file path is `~/.ikbi/instructions.md` by default, overridable via
 * `IKBI_INSTRUCTIONS_FILE` (used by tests to pin a temp file).
 *
 * TRUST: although operator-authored, the content is treated like project memory — an
 * isolated, neutralized data-role message — so a file that absorbed an injection (an
 * editor paste, a synced dotfile) can never land in a trusted/instruction slot. It is
 * honored as guidance, but bounded and structurally isolated (see session.ts).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/** Cap on instruction bytes injected — standing instructions must not crowd the working context. */
export const MAX_USER_INSTRUCTION_BYTES = 16_000;

/** Absolute path to the operator's instructions file (IKBI_INSTRUCTIONS_FILE overrides the default). */
export function instructionsPath(): string {
  const override = process.env.IKBI_INSTRUCTIONS_FILE;
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return join(homedir(), ".ikbi", "instructions.md");
}

/**
 * Load the operator's standing instructions. Returns the (bounded) content + its source path,
 * or undefined when the file is missing/empty/unreadable. NEVER throws.
 */
export function loadUserInstructions(): { content: string; source: string } | undefined {
  const path = instructionsPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // missing/unreadable — no user memory
  }
  if (raw.trim().length === 0) return undefined;
  const content = raw.length > MAX_USER_INSTRUCTION_BYTES ? `${raw.slice(0, MAX_USER_INSTRUCTION_BYTES)}\n…(truncated)` : raw;
  return { content, source: path };
}

/** Read the raw instructions text (empty string when none). */
export function readInstructions(): string {
  try {
    return readFileSync(instructionsPath(), "utf8");
  } catch {
    return "";
  }
}

/** Append one instruction line to the file (creating it + its directory if needed). */
export function addInstruction(text: string): void {
  const line = text.trim();
  if (line.length === 0) return;
  const path = instructionsPath();
  mkdirSync(dirname(path), { recursive: true });
  const existing = readInstructions();
  const next = existing.length === 0 ? `- ${line}\n` : `${existing.replace(/\n*$/, "")}\n- ${line}\n`;
  writeFileSync(path, next, "utf8");
}

/** Clear all instructions (the file is emptied, not deleted). */
export function clearInstructions(): void {
  const path = instructionsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", "utf8");
}

/**
 * Open the instructions file in the operator's `$EDITOR` (falling back to `vi`). Side-effecting
 * and interactive — used by the REPL `/memory edit` handler. Returns true on a clean exit.
 */
export function editInstructions(): boolean {
  const path = instructionsPath();
  mkdirSync(dirname(path), { recursive: true });
  if (readInstructions().length === 0) writeFileSync(path, "", "utf8"); // ensure it exists
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  const res = spawnSync(editor, [path], { stdio: "inherit" });
  return res.status === 0;
}
