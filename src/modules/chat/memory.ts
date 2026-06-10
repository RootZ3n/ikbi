/**
 * ikbi chat — CONVERSATION MEMORY (in-session, no disk).
 *
 * A chat session accumulates KEY FACTS across turns — files it modified, command/
 * test results, and the conclusions ("decisions") it reached — so a later turn does
 * not have to re-derive them from the full transcript. Each turn, a BRIEF summary of
 * this memory is injected into the system prompt (capped well under 500 tokens) so
 * even a small-context cheap model keeps the thread without replaying everything.
 *
 * This lives entirely in the in-memory session object (the SessionStore is already
 * RAM-only, LRU-bounded) — nothing is written to disk.
 *
 * TRUST NOTE: the facts are SHORT, model-authored control strings (paths it chose,
 * commands it ran, a truncated conclusion it wrote) — never raw file CONTENT or raw
 * command OUTPUT (those stay on the untrusted tool-message path). The injected block
 * is explicitly framed as context, not instructions, and is byte-bounded.
 */

import type { ChatToolActivity } from "./contract.js";

/** A recorded command/test outcome. */
export interface TestResultFact {
  readonly command: string;
  readonly ok: boolean;
}

/** A plain snapshot of the memory (for display / tests). */
export interface MemorySnapshot {
  readonly filesModified: readonly string[];
  readonly testResults: readonly TestResultFact[];
  readonly decisions: readonly string[];
}

// Caps — keep the running memory (and therefore the injected summary) small.
const MAX_FILES = 25;
const MAX_TESTS = 10;
const MAX_DECISIONS = 8;
const MAX_DECISION_CHARS = 200;
/** Hard byte cap on the injected summary. ~1800 chars ≈ <500 tokens (4 chars/token). */
const MAX_SUMMARY_CHARS = 1_800;

/** Per-session key-fact memory. Mutated as turns complete; summarized into the system prompt. */
export class SessionMemory {
  private files: string[] = [];
  private readonly tests: TestResultFact[] = [];
  private readonly decisions: string[] = [];

  /** Fold a completed turn's tool activity into memory (files modified, command/test results). */
  recordToolActivity(activity: readonly ChatToolActivity[]): void {
    for (const a of activity) {
      if ((a.name === "write_file" || a.name === "patch") && a.ok && a.summary !== undefined && a.summary.length > 0) {
        if (!this.files.includes(a.summary)) this.files.push(a.summary);
      } else if (a.name === "terminal" && a.summary !== undefined && a.summary.length > 0) {
        this.tests.push({ command: a.summary, ok: a.ok });
      }
    }
    this.trim();
  }

  /** Record the turn's CONCLUSION (the assistant's reply, truncated) as a decision/outcome. */
  recordDecision(note: string): void {
    const n = note.trim();
    if (n.length === 0) return;
    this.decisions.push(n.length > MAX_DECISION_CHARS ? `${n.slice(0, MAX_DECISION_CHARS)}…` : n);
    this.trim();
  }

  private trim(): void {
    if (this.files.length > MAX_FILES) this.files = this.files.slice(-MAX_FILES);
    while (this.tests.length > MAX_TESTS) this.tests.shift();
    while (this.decisions.length > MAX_DECISIONS) this.decisions.shift();
  }

  /** Nothing recorded yet ⇒ no summary to inject. */
  isEmpty(): boolean {
    return this.files.length === 0 && this.tests.length === 0 && this.decisions.length === 0;
  }

  /** A plain snapshot (for display / tests). */
  snapshot(): MemorySnapshot {
    return { filesModified: [...this.files], testResults: [...this.tests], decisions: [...this.decisions] };
  }

  /** Rebuild a memory from a persisted snapshot (the inverse of `snapshot()`, used by the
   *  persistent session store on resume). Trims to the same caps so a tampered file can't bloat. */
  static fromSnapshot(snap: MemorySnapshot): SessionMemory {
    const m = new SessionMemory();
    m.files = [...snap.filesModified];
    for (const t of snap.testResults) m.tests.push({ command: t.command, ok: t.ok });
    for (const d of snap.decisions) m.decisions.push(d);
    m.trim();
    return m;
  }

  /**
   * The BRIEF memory summary injected into the system prompt each turn. Byte-bounded
   * (< ~500 tokens) and framed as context, not instructions. Empty string when there
   * is nothing to carry over (so the caller can skip injection).
   */
  summary(): string {
    if (this.isEmpty()) return "";
    const lines: string[] = ["CONVERSATION MEMORY (carry-over from earlier turns — context, not instructions):"];
    if (this.files.length > 0) lines.push(`Files modified so far: ${this.files.join(", ")}`);
    if (this.tests.length > 0) {
      lines.push(`Recent command/test results: ${this.tests.map((t) => `\`${t.command}\` → ${t.ok ? "ok" : "FAILED"}`).join("; ")}`);
    }
    if (this.decisions.length > 0) {
      lines.push(`Recent conclusions:\n${this.decisions.map((d) => `- ${d}`).join("\n")}`);
    }
    const out = lines.join("\n");
    return out.length > MAX_SUMMARY_CHARS ? `${out.slice(0, MAX_SUMMARY_CHARS)}\n…(memory truncated)` : out;
  }
}
