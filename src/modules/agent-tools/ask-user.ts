/**
 * ikbi agent tool — ask_user.
 *
 * The model's explicit channel for a clarifying question BEFORE it commits to an approach — the
 * counterpart to the cognition layer's `ask` intent (see ../cognition-layer/ask.ts), reusing that
 * module's `AskUserRequest` / `AskUserFn` shape so a model-initiated question and a deliberation-
 * initiated one are answered the same way. Supports either an open-ended question or up to 4
 * multiple-choice options.
 *
 * It resolves a real answer through whichever channel the surface supplies:
 *   - REPL / interactive chat → an `ask` callback wired to the readline prompt (opts.ask).
 *   - headless → a one-line read from stdin (allowStdinFallback), so a piped/non-TTY run still works.
 *   - no channel (e.g. a non-interactive batch build) → fail SAFE: it does NOT block; it returns a
 *     message telling the model to proceed on its best assumption and state it.
 *
 * TRUST: the user's reply is operator input — it rides back as a normal tool result and (like every
 * tool result) is re-neutralized at the caller's chokepoint before it re-enters the model.
 */

import { createInterface } from "node:readline";

import type { ModelTool } from "../../core/provider/contract.js";
import { formatAskPrompt, interpretAnswer, MAX_ASK_OPTIONS, type AskUserFn, type AskUserRequest } from "../cognition-layer/ask.js";

/** The tool declared to the model. */
export const askUserTool: ModelTool = {
  name: "ask_user",
  description:
    "Ask the operator a clarifying question and WAIT for their answer before proceeding. Use this when the request is ambiguous and a wrong assumption would waste work — not for routine decisions you can make yourself. " +
    "Provide an open-ended `question`, or add up to 4 `options` for a multiple-choice question. Returns the operator's answer. " +
    'Example: {"question": "Which database should I target?", "options": ["Postgres", "SQLite", "MySQL"]}',
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to put to the operator." },
      options: { type: "array", items: { type: "string" }, description: "Up to 4 multiple-choice options. Omit for an open-ended question." },
      header: { type: "string", description: "Optional short label for the prompt (e.g. 'Auth method')." },
    },
    required: ["question"],
  },
};

/** What the tool needs at call time: an interactive answerer and/or permission to read stdin. */
export interface AskUserDeps {
  /** The surface's interactive answerer (REPL readline). When present it wins. */
  readonly ask?: AskUserFn;
  /** Allow a one-line stdin read when no `ask` callback is wired (headless mode). Default false. */
  readonly allowStdinFallback?: boolean;
  /** Output sink for the stdin-fallback prompt (defaults to process.stdout). */
  readonly out?: (s: string) => void;
}

/**
 * Run ask_user and return a model-readable result string. Never throws past the boundary, and
 * NEVER blocks when there is no answer channel (returns guidance to proceed instead).
 */
export async function runAskUser(deps: AskUserDeps, args: Record<string, unknown>): Promise<string> {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (question.length === 0) {
    return "ERROR: ask_user requires a non-empty 'question'.";
  }
  const rawOptions = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0) : [];
  if (rawOptions.length > MAX_ASK_OPTIONS) {
    return `ERROR: ask_user accepts at most ${MAX_ASK_OPTIONS} options (got ${rawOptions.length}). Trim the list or ask an open-ended question.`;
  }
  const req: AskUserRequest = {
    question,
    ...(rawOptions.length > 0 ? { options: rawOptions } : {}),
    ...(typeof args.header === "string" && args.header.trim().length > 0 ? { header: args.header.trim() } : {}),
  };

  // 1) Interactive answerer (REPL).
  if (deps.ask !== undefined) {
    try {
      const raw = await deps.ask(req);
      return formatAnswer(req, raw);
    } catch (e) {
      return `ERROR: ask_user failed to read a response: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 2) Headless stdin fallback.
  if (deps.allowStdinFallback === true) {
    try {
      const raw = await readLineFromStdin(formatAskPrompt(req), deps.out ?? ((s) => void process.stdout.write(s)));
      return formatAnswer(req, raw);
    } catch (e) {
      return `ERROR: ask_user failed to read from stdin: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 3) No channel — fail SAFE (never hang a non-interactive run).
  return (
    "ASK_USER UNAVAILABLE: there is no interactive operator in this context, so the question cannot be answered. " +
    "Proceed with your best assumption and STATE it explicitly in your reply, or ask the operator to re-run this interactively."
  );
}

/** Format the operator's raw reply into a model-readable result, resolving the chosen option. */
function formatAnswer(req: AskUserRequest, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "The operator gave no answer (empty response). Proceed with your best assumption and state it explicitly.";
  }
  const { answer, selectedIndex } = interpretAnswer(req, trimmed);
  if (selectedIndex !== undefined) {
    return `The operator selected option ${selectedIndex + 1}: "${answer}".`;
  }
  return `The operator answered: "${answer}".`;
}

/** Read a single line from stdin after printing the prompt. Resolves "" on EOF/close. */
function readLineFromStdin(prompt: string, out: (s: string) => void): Promise<string> {
  return new Promise<string>((resolve) => {
    out(prompt);
    const rl = createInterface({ input: process.stdin, terminal: false });
    let settled = false;
    const finish = (v: string): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(v);
    };
    rl.once("line", (line) => finish(line));
    rl.once("close", () => finish(""));
  });
}
