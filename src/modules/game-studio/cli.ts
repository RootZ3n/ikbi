import { registerCommand } from "../../cli/registry.js";
import { AbonulliClient } from "./abonulli-client.js";
import { readAndValidateAnimationRequestContract } from "./animation-contracts.js";
import { gameStudioConfig } from "./config.js";
import { CONTRACT_VERSION, type GameStudioStatus, type GodotProjectInspection } from "./contract.js";
import { readAndValidateGameFeatureContract } from "./feature-contracts.js";
import { generateGameBible, renderGameBibleMarkdown } from "./game-bible.js";
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
  readonly generateBible?: typeof generateGameBible;
  readonly validateContractFile?: typeof readAndValidateGameFeatureContract;
  readonly validateAnimationContractFile?: typeof readAndValidateAnimationRequestContract;
  readonly createAbonulliClient?: (baseUrl: string) => Pick<AbonulliClient, "health" | "requestAnimation">;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

export function createGameStudioCli(deps: GameStudioCliDeps = {}) {
  const inspect = deps.inspect ?? inspectGodotProject;
  const generateBible = deps.generateBible ?? generateGameBible;
  const validateContractFile = deps.validateContractFile ?? readAndValidateGameFeatureContract;
  const validateAnimationContractFile = deps.validateAnimationContractFile ?? readAndValidateAnimationRequestContract;
  const createAbonulliClient = deps.createAbonulliClient ?? ((baseUrl: string) => new AbonulliClient({ baseUrl }));
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
    if (command === "bible") {
      const positional = withoutFlags(argv.slice(1));
      const repoPath = positional[0];
      if (repoPath === undefined) {
        err("ikbi: game-studio bible needs a repo path — usage: ikbi game-studio bible <repo-path> [--json]\n");
        setExit(1);
        return;
      }
      try {
        const bible = await generateBible(repoPath);
        out(hasJson(argv) ? `${JSON.stringify(bible, null, 2)}\n` : renderGameBibleMarkdown(bible));
      } catch (e) {
        err(`ikbi: game-studio bible failed: ${e instanceof Error ? e.message : String(e)}\n`);
        setExit(1);
      }
      return;
    }
    if (command === "contract" && argv[1] === "validate") {
      const positional = withoutFlags(argv.slice(2));
      const filePath = positional[0];
      if (filePath === undefined) {
        err("ikbi: game-studio contract validate needs a file — usage: ikbi game-studio contract validate <file.json> [--json]\n");
        setExit(1);
        return;
      }
      const result = await validateContractFile(filePath);
      if (hasJson(argv)) {
        out(`${JSON.stringify({ valid: result.valid, errors: result.errors }, null, 2)}\n`);
      } else if (result.valid) {
        out("contract: valid\n");
      } else {
        err(`contract: invalid\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`);
      }
      if (!result.valid) setExit(1);
      return;
    }
    if (command === "animation-contract" && argv[1] === "validate") {
      const positional = withoutFlags(argv.slice(2));
      const filePath = positional[0];
      if (filePath === undefined) {
        err("ikbi: game-studio animation-contract validate needs a file — usage: ikbi game-studio animation-contract validate <file.json> [--json]\n");
        setExit(1);
        return;
      }
      const result = await validateAnimationContractFile(filePath);
      if (hasJson(argv)) {
        out(`${JSON.stringify({ valid: result.valid, errors: result.errors, contract: result.contract }, null, 2)}\n`);
      } else if (result.valid) {
        out("animation-contract: valid\n");
      } else {
        err(`animation-contract: invalid\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`);
      }
      if (!result.valid) setExit(1);
      return;
    }
    if (command === "abonulli" && argv[1] === "status") {
      const client = createAbonulliClient(gameStudioConfig.abonulliBaseUrl);
      try {
        const health = await client.health();
        const payload = { baseUrl: gameStudioConfig.abonulliBaseUrl, healthy: health.status === "ok", health };
        out(hasJson(argv) ? `${JSON.stringify(payload, null, 2)}\n` : `abonulli: ${payload.healthy ? "healthy" : "unhealthy"}\nbase_url: ${payload.baseUrl}\nstatus: ${health.status}\n`);
      } catch (e) {
        err(`abonulli: unavailable\nbase_url: ${gameStudioConfig.abonulliBaseUrl}\nerror: ${e instanceof Error ? e.message : String(e)}\n`);
        setExit(1);
      }
      return;
    }
    if (command === "abonulli" && argv[1] === "request") {
      const positional = withoutFlags(argv.slice(2));
      const filePath = positional[0];
      if (filePath === undefined) {
        err("ikbi: game-studio abonulli request needs a contract — usage: ikbi game-studio abonulli request <contract.json> [--json]\n");
        setExit(1);
        return;
      }
      const validation = await validateAnimationContractFile(filePath);
      if (!validation.valid || validation.contract === undefined) {
        err(`animation-contract: invalid\n${validation.errors.map((error) => `- ${error}`).join("\n")}\n`);
        setExit(1);
        return;
      }
      try {
        const job = await createAbonulliClient(gameStudioConfig.abonulliBaseUrl).requestAnimation(validation.contract);
        if (hasJson(argv)) {
          out(`${JSON.stringify(job, null, 2)}\n`);
        } else {
          out([
            "abonulli: request created",
            `project: ${job.project.id} (${job.project.name})`,
            `sequence: ${job.sequence.id} (${job.sequence.name})`,
            `shot: ${job.shot.id}`,
            `beats: ${job.beats.length}`,
            `exports: ${job.exports.length}`,
            `export_errors: ${job.exports.filter((item) => item.error !== undefined).length}`,
          ].join("\n") + "\n");
        }
      } catch (e) {
        err(`ikbi: game-studio abonulli request failed: ${e instanceof Error ? e.message : String(e)}\n`);
        setExit(1);
      }
      return;
    }
    err("ikbi: game-studio usage: ikbi game-studio <status|inspect|bible|contract validate|animation-contract validate|abonulli status|abonulli request> [args]\n");
    setExit(1);
  }

  return { run };
}

const live = createGameStudioCli();
registerCommand({
  name: "game-studio",
  summary: "Inspect, map, validate, and request Godot game assets",
  usage: "ikbi game-studio <status|inspect|bible|contract validate|animation-contract validate|abonulli status|abonulli request> [args]",
  run: (argv) => live.run(argv),
});
