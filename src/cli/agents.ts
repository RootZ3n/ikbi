/**
 * ikbi `agents` — list the user-defined agent personas in `.ikbi/agents/`.
 *
 * Surfaces the custom agents a repo defines (reviewer, doc-writer, test-author, …) so an operator
 * can see what's available before switching the REPL onto one with `/agent <name>`. Read-only.
 *
 *   ikbi agents              list agents in ./.ikbi/agents
 *   ikbi agents show <name>  print one agent's full definition
 *   ikbi agents --repo <dir> scan a different repo root
 */

import { registerCommand } from "./registry.js";
import { writeStdout, writeStderr } from "./io.js";
import { loadCustomAgents, type AgentDirectoryResult } from "../modules/agent-router/agent-directory.js";

export interface AgentsCliDeps {
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
  /** Load agents (default: from the filesystem). Injectable for tests. */
  readonly load?: (repoRoot: string) => AgentDirectoryResult;
}

const USAGE = "ikbi agents [show <name>] [--repo <dir>]";

function parseArgs(argv: readonly string[]): { sub: string; name?: string; repo: string; help: boolean } {
  let repo = process.cwd();
  let help = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--repo") { if (argv[i + 1] !== undefined) repo = argv[i + 1] as string; i += 1; }
    else if (!a.startsWith("-")) positional.push(a);
  }
  const sub = positional[0] ?? "list";
  const name = positional[1];
  return { sub, ...(name !== undefined ? { name } : {}), repo, help };
}

export function createAgentsCli(deps: AgentsCliDeps = {}) {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? writeStderr;
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));
  const load = deps.load ?? loadCustomAgents;

  function run(argv: readonly string[]): void {
    const args = parseArgs(argv);
    if (args.help) {
      out(`Usage: ${USAGE}\n\nList user-defined agent personas from .ikbi/agents/*.{yaml,json}.\n`);
      return;
    }
    const result = load(args.repo);

    if (args.sub === "show") {
      if (args.name === undefined) {
        err("usage: ikbi agents show <name>\n");
        setExit(1);
        return;
      }
      const agent = result.agents.find((a) => a.name.toLowerCase() === args.name!.toLowerCase());
      if (agent === undefined) {
        err(`agents: no agent named "${args.name}" in ${result.dir}\n`);
        setExit(1);
        return;
      }
      out(`Agent: ${agent.name}\n`);
      if (agent.description !== undefined) out(`Description: ${agent.description}\n`);
      out(`Model: ${agent.modelPreference ?? "(session default)"}\n`);
      out(`Allowed tools: ${agent.allowedTools !== undefined && agent.allowedTools.length > 0 ? agent.allowedTools.join(", ") : "(all)"}\n`);
      out(`Source: ${agent.source}\n`);
      out(`\nSystem prompt:\n${agent.systemPrompt}\n`);
      return;
    }

    // Default: list.
    if (result.agents.length === 0) {
      out(`No custom agents found in ${result.dir}\n`);
      out(`Define one by creating ${result.dir}/<name>.yaml with name, system_prompt, allowed_tools, model_preference.\n`);
    } else {
      out(`Custom agents (${result.agents.length}) in ${result.dir}:\n`);
      for (const a of result.agents) {
        const tools = a.allowedTools !== undefined && a.allowedTools.length > 0 ? `${a.allowedTools.length} tool(s)` : "all tools";
        const model = a.modelPreference !== undefined ? `, model ${a.modelPreference}` : "";
        const desc = a.description !== undefined ? ` — ${a.description}` : "";
        out(`  • ${a.name} (${tools}${model})${desc}\n`);
      }
      out(`\nSwitch in the REPL with: /agent <name>\n`);
    }
    if (result.errors.length > 0) {
      err(`\n${result.errors.length} file(s) could not be loaded:\n`);
      for (const e of result.errors) err(`  ✗ ${e.file}: ${e.error}\n`);
    }
  }

  return { run };
}

registerCommand({
  name: "agents",
  summary: "List user-defined agent personas from .ikbi/agents/",
  usage: USAGE,
  run: (argv) => createAgentsCli().run(argv),
});
