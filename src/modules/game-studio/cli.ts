import { registerCommand } from "../../cli/registry.js";
import { gameStudioConfig } from "./config.js";
import { CONTRACT_VERSION, type GameStudioStatus, type GodotProjectInspection } from "./contract.js";
import { inspectGodotProject } from "./project-inspector.js";

function hasJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

function withoutFlags(argv: readonly string[]): string[] {
  return argv.filter((a) => !a.startsWith("-"));
}

export function gameStudioStatus(): GameStudioStatus {
  return {
    module: "game-studio",
    contractVersion: CONTRACT_VERSION,
    healthy: true,
    godotPath: gameStudioConfig.godotPath,
  };
}

function renderStatus(status: GameStudioStatus): string {
  return [
    "game-studio: healthy",
    `contract: ${status.contractVersion}`,
    `godot: ${status.godotPath}`,
  ].join("\n") + "\n";
}

function renderInspection(report: GodotProjectInspection): string {
  return [
    `Godot project: ${report.project.name ?? "(unnamed)"}`,
    `repo: ${report.repoPath}`,
    `config_version: ${report.project.configVersion ?? "(missing)"}`,
    `main_scene: ${report.project.mainScene ?? "(missing)"}`,
    `features: ${report.project.features.join(", ") || "(none)"}`,
    `autoloads: ${report.project.autoloads.length}`,
    `input_actions: ${report.project.inputMap.length}`,
    `scenes: ${report.scenes.length}`,
    `scripts: ${report.scripts.length}`,
    `resources: ${report.resources.length}`,
    `export_presets: ${report.exportPresets.length}`,
    `tests: ${report.tests.length}`,
    `broken_references: ${report.brokenReferences.length}`,
  ].join("\n") + "\n";
}

export interface GameStudioCliDeps {
  readonly inspect?: typeof inspectGodotProject;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

export function createGameStudioCli(deps: GameStudioCliDeps = {}) {
  const inspect = deps.inspect ?? inspectGodotProject;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  async function run(argv: readonly string[]): Promise<void> {
    const command = argv[0];
    if (command === "status") {
      const status = gameStudioStatus();
      out(hasJson(argv) ? `${JSON.stringify(status, null, 2)}\n` : renderStatus(status));
      return;
    }
    if (command === "inspect") {
      const positional = withoutFlags(argv.slice(1));
      const repoPath = positional[0];
      if (repoPath === undefined) {
        err("ikbi: game-studio inspect needs a repo path — usage: ikbi game-studio inspect <repo-path> [--json]\n");
        setExit(1);
        return;
      }
      try {
        const report = await inspect(repoPath);
        out(hasJson(argv) ? `${JSON.stringify(report, null, 2)}\n` : renderInspection(report));
      } catch (e) {
        err(`ikbi: game-studio inspect failed: ${e instanceof Error ? e.message : String(e)}\n`);
        setExit(1);
      }
      return;
    }
    err("ikbi: game-studio usage: ikbi game-studio <status|inspect> [args]\n");
    setExit(1);
  }

  return { run };
}

const live = createGameStudioCli();
registerCommand({
  name: "game-studio",
  summary: "Inspect and report on Godot game projects",
  usage: "ikbi game-studio <status|inspect> [args]",
  run: (argv) => live.run(argv),
});
