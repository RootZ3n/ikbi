/**
 * ikbi agent-router — user-defined agent directory (`.ikbi/agents/`).
 *
 * A team can drop persona files into `.ikbi/agents/*.yaml` or `*.json` to define custom agents —
 * a reviewer, a doc-writer, a test-author — each with its own system prompt, an allowed-tool subset,
 * and a preferred model. `ikbi agents` lists them; the REPL's `/agent <name>` switches the live
 * session onto one. This module is the LOADER: it discovers, parses, and validates those files into
 * a typed `CustomAgent[]`.
 *
 * It deliberately ships a SMALL, purpose-built YAML reader rather than adding a YAML dependency
 * (the project keeps its runtime deps minimal). It understands exactly the agent schema: scalar
 * keys, block scalars (`key: |`), and string lists (block `- item` or inline `[a, b]`) — enough
 * for a persona file, and nothing more. JSON files use the native parser.
 *
 * READ-ONLY + total: a malformed file never throws; it is skipped and reported in `errors`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** A user-defined agent persona. */
export interface CustomAgent {
  /** Unique persona name (defaults to the file's basename when the file omits `name`). */
  readonly name: string;
  /** The system prompt that defines this persona's behavior (required). */
  readonly systemPrompt: string;
  /** Tool names this persona may use. Empty/absent ⇒ the full default tool set. */
  readonly allowedTools?: readonly string[];
  /** Preferred model id for this persona (applied by the surface, e.g. the REPL `/agent`). */
  readonly modelPreference?: string;
  /** Optional one-line description for `ikbi agents` listings. */
  readonly description?: string;
  /** The file the persona was loaded from (absolute path). */
  readonly source: string;
}

/** A file that failed to load, with why (surfaced by `ikbi agents`, never thrown). */
export interface AgentLoadError {
  readonly file: string;
  readonly error: string;
}

/** The outcome of scanning an agents directory. */
export interface AgentDirectoryResult {
  readonly agents: readonly CustomAgent[];
  readonly errors: readonly AgentLoadError[];
  /** The directory that was scanned (whether or not it existed). */
  readonly dir: string;
}

/**
 * Max number of agent files (`*.yaml` / `*.yml` / `*.json`) scanned from one agents directory (RC6).
 * A directory stuffed with thousands of persona files would make every `ikbi agents` / `/agent`
 * lookup read + parse all of them. Over the limit, the scan fails CLEANLY (`AGENT_DIRECTORY_TOO_LARGE`)
 * rather than silently loading an arbitrary subset. Override with `IKBI_AGENT_DIR_MAX_FILES`
 * (positive integer); defaults to 100.
 */
export const MAX_AGENT_FILES = ((): number => {
  const raw = Number(process.env.IKBI_AGENT_DIR_MAX_FILES);
  return Number.isInteger(raw) && raw > 0 ? raw : 100;
})();

/** The conventional location of custom agents under a repo root. */
export function agentsDir(repoRoot: string): string {
  return join(repoRoot, ".ikbi", "agents");
}

// ── BUILT-IN AGENTS (shipped WITH ikbi; no .ikbi/agents/ setup required) ─────────────────────────

/** The tools a conversational, teaching persona uses: inspect + ask, never edit. Mirrors plan mode. */
const TEACHING_READONLY_TOOLS: readonly string[] = [
  "read_file", "list_dir", "search_files", "glob", "git_status", "git_diff", "git_log", "lsp_diagnostic", "ask_user",
];

/**
 * PEHLICHI — "Peh" — the built-in teaching guide and the face of ikbi. A user talks to Peh to learn
 * how ikbi works and to turn a fuzzy idea into a clear, buildable goal. Peh is read-only for now
 * (inspects + teaches + drafts the command); a launch-build capability lands separately. Peh runs on
 * its OWN model (default deepseek-v4-pro), decoupled from the build roster and overridable per session.
 */
const PEHLICHI: CustomAgent = {
  name: "Pehlichi",
  description: "Peh — ikbi's teaching guide. Learn ikbi and shape a clear build goal together.",
  modelPreference: "deepseek-v4-pro",
  // Read-only inspection + ask, PLUS launch_build (confirm-gated) so Peh can run an agreed goal.
  allowedTools: [...TEACHING_READONLY_TOOLS, "launch_build"],
  source: "builtin",
  systemPrompt: [
    'You are Pehlichi — "Peh" for short — the friendly guide and the face of ikbi.',
    "",
    'ikbi (Choctaw: "to build") is a governed AI coding agent that builds and repairs code, designed to work well even with small, cheap, or local models. Your job is to make ikbi approachable: teach people how to use it, and help them turn a fuzzy idea into a clear, buildable goal.',
    "",
    "WHO YOU HELP: often complete beginners. Be warm, patient, and plain-spoken. Explain any jargon. Short paragraphs. Encourage — never condescend.",
    "",
    "WHAT YOU DO:",
    "1. Explain ikbi — what it does (build / fix / verify code, only promoting changes that pass real verification), and its main commands: `ikbi build \"<goal>\" --repo <path>`, `ikbi fix`, `ikbi repl`, `ikbi doctor`.",
    "2. Help the user craft a GOOD build goal. A good goal is specific and verifiable. Draw it out of them:",
    "   - WHAT do you want built or fixed? (concrete)",
    "   - WHERE — which repo or files? You may inspect the repo read-only to ground your advice.",
    "   - What does SUCCESS look like? (a test passes, a feature works, an error is gone)",
    "   - Any CONSTRAINTS? (don't touch X, keep it small, use a certain library)",
    "   Once the goal is clear, either hand them the ready-to-run command (e.g. `ikbi build \"add a /health endpoint that returns 200, with a test\" --repo .`) OR — if they'd like — offer to run it for them.",
    "3. Answer honestly about what ikbi can and cannot do. If a task is likely too big for a small model, say so and help find a smaller first step — ikbi is honest about its limits, and so are you.",
    "",
    "HOW YOU WORK:",
    "- You never EDIT code directly. But once you and the user have shaped a clear goal AND they say they want to run it, you may launch the build yourself with the launch_build tool. The user is asked to CONFIRM before any build runs — never launch without an explicit go-ahead. After it finishes, explain plainly what happened: did it pass verification and promote, or not, and why.",
    "- Builds run on the repo this session is working in. If the user wants a different repo, tell them to reopen with `ikbi peh --repo <path>`.",
    "- Keep goals SMALL and clearly scoped; ikbi does best with well-defined tasks. If a request is large, break it into a first small step together.",
    "- When you inspect a repo, use what you find to make your advice concrete — name the real files, the detected language, the test command.",
    "",
    "Be the guide you would have wanted on day one: kind, clear, and genuinely useful.",
  ].join("\n"),
};

/** All personas that ship WITH ikbi. Custom `.ikbi/agents/` entries of the same name override these. */
const BUILTIN_AGENTS: readonly CustomAgent[] = [PEHLICHI];

/** The personas bundled with ikbi (available with zero setup). */
export function getBuiltinAgents(): readonly CustomAgent[] {
  return BUILTIN_AGENTS;
}

/**
 * Load all custom agents from `<repoRoot>/.ikbi/agents/`. Returns the valid agents plus a list of
 * per-file errors. A missing directory is not an error — it yields an empty result.
 */
export function loadCustomAgents(repoRoot: string, maxFiles: number = MAX_AGENT_FILES): AgentDirectoryResult {
  const dir = agentsDir(repoRoot);
  if (!existsSync(dir)) return { agents: [], errors: [], dir };

  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /\.(ya?ml|json)$/i.test(n)).sort();
  } catch (e) {
    return { agents: [], errors: [{ file: dir, error: `could not read directory: ${msg(e)}` }], dir };
  }

  // RC6: fail CLOSED on an oversized directory rather than silently loading an arbitrary subset.
  if (names.length > maxFiles) {
    return {
      agents: [],
      errors: [{
        file: dir,
        error: `AGENT_DIRECTORY_TOO_LARGE: ${names.length} agent files in "${dir}" exceeds the limit of ${maxFiles} (set IKBI_AGENT_DIR_MAX_FILES to change)`,
      }],
      dir,
    };
  }

  const agents: CustomAgent[] = [];
  const errors: AgentLoadError[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const file = join(dir, name);
    const parsed = loadAgentFile(file);
    if ("error" in parsed) {
      errors.push({ file, error: parsed.error });
      continue;
    }
    if (seen.has(parsed.agent.name)) {
      errors.push({ file, error: `duplicate agent name "${parsed.agent.name}" (already defined by an earlier file)` });
      continue;
    }
    seen.add(parsed.agent.name);
    agents.push(parsed.agent);
  }
  return { agents, errors, dir };
}

/**
 * Load BUILT-IN + custom agents merged by name. Built-ins are the base; a custom `.ikbi/agents/`
 * entry with the same name OVERRIDES its built-in (a team can re-skin Pehlichi). Custom-vs-custom
 * duplicate errors from loadCustomAgents are preserved. This is what the REPL `/agent` command and
 * `ikbi agents` read, so a bundled persona like Pehlichi is available with zero setup.
 */
export function loadAllAgents(repoRoot: string, maxFiles: number = MAX_AGENT_FILES): AgentDirectoryResult {
  const custom = loadCustomAgents(repoRoot, maxFiles);
  const byName = new Map<string, CustomAgent>();
  for (const b of getBuiltinAgents()) byName.set(b.name.toLowerCase(), b);
  for (const c of custom.agents) byName.set(c.name.toLowerCase(), c); // custom overrides built-in
  return { agents: [...byName.values()], errors: custom.errors, dir: custom.dir };
}

/** Find one agent by name (case-insensitive), built-in or custom. Returns undefined when absent. */
export function findCustomAgent(repoRoot: string, name: string): CustomAgent | undefined {
  const target = name.trim().toLowerCase();
  return loadAllAgents(repoRoot).agents.find((a) => a.name.toLowerCase() === target);
}

/** Load + validate a single agent file. */
export function loadAgentFile(file: string): { agent: CustomAgent } | { error: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { error: `read failed: ${msg(e)}` };
  }
  let raw: Record<string, unknown>;
  try {
    raw = /\.json$/i.test(file) ? (JSON.parse(text) as Record<string, unknown>) : parseSimpleYaml(text);
  } catch (e) {
    return { error: `parse failed: ${msg(e)}` };
  }
  return validateAgent(raw, file);
}

/** Coerce a parsed record into a validated CustomAgent (or an error). */
export function validateAgent(raw: Record<string, unknown>, file: string): { agent: CustomAgent } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "not an object" };
  // Accept both snake_case (documented) and camelCase (JSON convenience).
  const name = str(raw.name) ?? basename(file);
  const systemPrompt = str(raw.system_prompt) ?? str(raw.systemPrompt);
  if (name.length === 0) return { error: "missing 'name'" };
  if (systemPrompt === undefined || systemPrompt.trim().length === 0) return { error: "missing 'system_prompt'" };
  const allowedTools = strList(raw.allowed_tools) ?? strList(raw.allowedTools);
  const modelPreference = str(raw.model_preference) ?? str(raw.modelPreference);
  const description = str(raw.description);
  return {
    agent: {
      name,
      systemPrompt: systemPrompt.trim(),
      ...(allowedTools !== undefined && allowedTools.length > 0 ? { allowedTools } : {}),
      ...(modelPreference !== undefined ? { modelPreference } : {}),
      ...(description !== undefined ? { description } : {}),
      source: file,
    },
  };
}

// ── helpers ────────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter((s) => s.length > 0);
}

function basename(file: string): string {
  const parts = file.split(/[\\/]/);
  return (parts[parts.length - 1] ?? file).replace(/\.(ya?ml|json)$/i, "");
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A minimal YAML reader for the agent schema ONLY. Supports:
 *   key: scalar              → string/number/bool (quotes stripped)
 *   key: |                   → block scalar (more-indented following lines, joined by \n)
 *   key:                     → followed by `- item` lines → string list
 *   key: [a, b, c]           → inline flow list → string list
 * Comments (`# …`) and blank lines are ignored. This is NOT a general YAML parser.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] as string;
    const line = stripComment(rawLine);
    if (line.trim().length === 0) { i += 1; continue; }
    // Only handle top-level (non-indented) keys; nested content is consumed by the handlers below.
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (m === null) { i += 1; continue; }
    const key = m[1] as string;
    const rest = (m[2] as string).trim();

    if (rest === "|" || rest === "|-" || rest === ">") {
      // Block scalar: gather following lines that are more indented than the key.
      const blockLines: string[] = [];
      i += 1;
      let indent: number | undefined;
      while (i < lines.length) {
        const bl = lines[i] as string;
        if (bl.trim().length === 0) { blockLines.push(""); i += 1; continue; }
        const leading = bl.length - bl.trimStart().length;
        if (leading === 0) break; // back to a top-level key
        if (indent === undefined) indent = leading;
        blockLines.push(bl.slice(indent));
        i += 1;
      }
      // Trim trailing blank lines.
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") blockLines.pop();
      out[key] = rest === ">" ? blockLines.join(" ") : blockLines.join("\n");
      continue;
    }

    if (rest.length === 0) {
      // Possibly a block list of `- item` lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const il = stripComment(lines[j] as string);
        if (il.trim().length === 0) { j += 1; continue; }
        const leading = il.length - il.trimStart().length;
        if (leading === 0) break;
        const lm = /^\s*-\s*(.+)$/.exec(il);
        if (lm === null) break;
        items.push(unquote((lm[1] as string).trim()));
        j += 1;
      }
      out[key] = items.length > 0 ? items : "";
      i = j;
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      // Inline flow list.
      const inner = rest.slice(1, -1).trim();
      out[key] = inner.length === 0 ? [] : inner.split(",").map((s) => unquote(s.trim())).filter((s) => s.length > 0);
      i += 1;
      continue;
    }

    out[key] = coerceScalar(unquote(rest));
    i += 1;
  }
  return out;
}

function stripComment(line: string): string {
  // Strip a `#` comment that is not inside quotes (good enough for the agent schema).
  let inS = false;
  let inD = false;
  for (let k = 0; k < line.length; k += 1) {
    const c = line[k];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD) return line.slice(0, k);
  }
  return line;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerceScalar(s: string): string | number | boolean {
  if (s === "true") return true;
  if (s === "false") return false;
  return s;
}
