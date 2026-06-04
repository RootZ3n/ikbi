/**
 * ikbi command registrar — the parallel-build SEAM (Step S) for CLI commands.
 *
 * THE PROBLEM this solves: if every module added its subcommands by editing
 * `cli/index.ts`, that one file becomes a write-bottleneck — builders collide.
 *
 * THE CONVENTION: a module registers its CLI commands from its OWN file by calling
 * `registerCommand({ name, summary, run })`. The CLI COMPOSES every registered
 * command — its dispatcher and `help` consult the registry, so it never names
 * individual modules.
 *
 *     // src/modules/monitoring/cli.ts
 *     import { registerCommand } from "../../cli/registry.js";
 *     registerCommand({
 *       name: "status",
 *       summary: "Show engine status",
 *       run: async (argv) => { process.stdout.write("...\n"); },
 *     });
 *
 * Registrations are picked up by `cli/index.ts`. For them to exist at dispatch
 * time the module must be IMPORTED first — wired once via the `src/modules/index.ts`
 * barrel (imported by the CLI), so importing a module is all it takes to expose its
 * commands. No `cli/index.ts` edit. Built-in commands (version/models/providers/
 * help) take precedence, so a module cannot shadow a core command.
 */

/** A module-contributed CLI command. */
export interface CliCommand {
  /** The subcommand token (`ikbi <name> ...`). Lowercase, no spaces. */
  readonly name: string;
  /** One-line description shown in `ikbi help`. */
  readonly summary: string;
  /** Optional usage/args hint shown beside the summary. */
  readonly usage?: string;
  /** Run the command with the args AFTER the subcommand token. May be async. */
  run(argv: readonly string[]): void | Promise<void>;
}

/** A command name: lowercase letters/digits with optional internal hyphens/colons. */
const COMMAND_NAME_RE = /^[a-z][a-z0-9]*(?:[-:][a-z0-9]+)*$/;

/**
 * The process-wide CLI command registry. Modules append at import time; the CLI
 * consults it at dispatch.
 */
class CommandRegistry {
  private readonly cmds = new Map<string, CliCommand>();

  /** Register a module command. Throws on an invalid name or a duplicate. */
  register(cmd: CliCommand): void {
    if (!COMMAND_NAME_RE.test(cmd.name)) {
      throw new Error(`invalid CLI command name "${cmd.name}" (expected lowercase, e.g. "kill-switch")`);
    }
    if (this.cmds.has(cmd.name)) {
      throw new Error(`CLI command "${cmd.name}" is already registered`);
    }
    this.cmds.set(cmd.name, cmd);
  }

  /** Look up a registered command by name. */
  get(name: string): CliCommand | undefined {
    return this.cmds.get(name);
  }

  /** Has a command with this name been registered? */
  has(name: string): boolean {
    return this.cmds.has(name);
  }

  /** All registered commands, sorted by name (for stable `help` output). */
  all(): CliCommand[] {
    return [...this.cmds.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Test-only: clear all registrations. */
  reset(): void {
    this.cmds.clear();
  }
}

/** The single canonical CLI command registry. */
export const commands: CommandRegistry = new CommandRegistry();

/** Register a module's CLI command (see file header). The convention modules use. */
export function registerCommand(cmd: CliCommand): void {
  commands.register(cmd);
}
