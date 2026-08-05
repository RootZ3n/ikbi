import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { AbonulliClient } from "./abonulli-client.js";
import type { AbonulliAnimationJob } from "./abonulli-client.js";
import type { AnimationRequestContract } from "./animation-contracts.js";
import { gameStudioConfig } from "./config.js";
import type { GameBible, GameFeatureContract, GodotProjectInspection } from "./contract.js";
import { readAndValidateGameFeatureContract } from "./feature-contracts.js";
import { generateGameBible } from "./game-bible.js";
import { inspectGodotProject } from "./project-inspector.js";

export const WORM_DEPLOYMENT_BACKFIRE_SCENE = "scenes/worm_deployment_backfire.tscn";
export const WORM_DEPLOYMENT_BACKFIRE_SCRIPT = "scripts/worm_deployment_backfire.gd";
export const WORM_DEPLOYMENT_BACKFIRE_BEATS = [
  "An egg shakes.",
  "The shell cracks.",
  "A worm emerges.",
  "A deployment mechanism activates.",
  "The mechanism malfunctions.",
  "The worm launches upward.",
  "The worm crashes back into the playfield.",
  "Smoke clears and the worm reacts.",
] as const;

export interface SliceImplementationContract {
  readonly id: string;
  readonly repoPath: string;
  readonly additiveFiles: readonly string[];
  readonly boundedChange: string;
  readonly scene: string;
  readonly script: string;
  readonly timeline: {
    readonly durationSeconds: number;
    readonly frameRate: number;
    readonly totalFrames: number;
    readonly beats: readonly { readonly index: number; readonly frame: number; readonly text: string }[];
  };
}

export interface SliceGodotRunEvidence {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly exitStatus: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly beatLogs: readonly string[];
  readonly beatsLoggedInOrder: boolean;
  readonly screenshotPath?: string;
  readonly screenshotCaptured: boolean;
}

export interface SliceRunReport {
  readonly runId: string;
  readonly repoPath: string;
  readonly contractPath: string;
  readonly inspected: Pick<GodotProjectInspection, "repoPath" | "project">;
  readonly bible: Pick<GameBible, "project" | "tests" | "gapAnalysis">;
  readonly featureContract: GameFeatureContract;
  readonly animationRequest: AnimationRequestContract;
  readonly abonulli: {
    readonly mode: "requested" | "mock";
    readonly baseUrl: string;
    readonly error?: string;
    readonly job?: AbonulliAnimationJob;
  };
  readonly implementationContract: SliceImplementationContract;
  readonly godotRun: SliceGodotRunEvidence;
}

export interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SliceDeps {
  readonly inspect?: typeof inspectGodotProject;
  readonly generateBible?: typeof generateGameBible;
  readonly validateContractFile?: typeof readAndValidateGameFeatureContract;
  readonly requestAnimation?: (contract: AnimationRequestContract, baseUrl: string) => Promise<AbonulliAnimationJob>;
  readonly runProcess?: (command: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }) => Promise<ProcessResult>;
  readonly now?: () => Date;
  readonly writeFile?: typeof writeFile;
  readonly mkdir?: typeof mkdir;
  readonly readFile?: typeof readFile;
  readonly godotPath?: string;
}

async function defaultRequestAnimation(contract: AnimationRequestContract, baseUrl: string): Promise<AbonulliAnimationJob> {
  return new AbonulliClient({ baseUrl }).requestAnimation(contract);
}

function sceneSource(): string {
  return [
    "[gd_scene load_steps=2 format=3]",
    "",
    `[ext_resource type="Script" path="res://${WORM_DEPLOYMENT_BACKFIRE_SCRIPT}" id="1_backfire"]`,
    "",
    "[node name=\"WormDeploymentBackfire\" type=\"Node2D\"]",
    "script = ExtResource(\"1_backfire\")",
    "",
    "[node name=\"Playfield\" type=\"ColorRect\" parent=\".\"]",
    "offset_left = 0.0",
    "offset_top = 620.0",
    "offset_right = 1024.0",
    "offset_bottom = 900.0",
    "color = Color(0.2, 0.36, 0.24, 1)",
    "",
    "[node name=\"Egg\" type=\"Polygon2D\" parent=\".\"]",
    "position = Vector2(512, 584)",
    "color = Color(0.93, 0.84, 0.63, 1)",
    "polygon = PackedVector2Array(-34, 24, -42, -6, -28, -42, 0, -56, 28, -42, 42, -6, 34, 24, 14, 40, -14, 40)",
    "",
    "[node name=\"Worm\" type=\"Polygon2D\" parent=\".\"]",
    "visible = false",
    "position = Vector2(512, 584)",
    "color = Color(0.42, 0.74, 0.28, 1)",
    "polygon = PackedVector2Array(-46, -12, 30, -12, 48, 0, 30, 12, -46, 12, -58, 0)",
    "",
    "[node name=\"Mechanism\" type=\"Polygon2D\" parent=\".\"]",
    "visible = false",
    "position = Vector2(512, 610)",
    "color = Color(0.28, 0.3, 0.34, 1)",
    "polygon = PackedVector2Array(-44, 16, -20, -28, 20, -28, 44, 16, 30, 16, 12, -12, -12, -12, -30, 16)",
    "",
    "[node name=\"Smoke\" type=\"Polygon2D\" parent=\".\"]",
    "visible = false",
    "position = Vector2(536, 554)",
    "color = Color(0.58, 0.6, 0.62, 0.72)",
    "polygon = PackedVector2Array(-54, -10, -30, -42, 8, -34, 42, -18, 58, 16, 32, 42, -8, 48, -44, 26)",
  ].join("\n") + "\n";
}

function scriptSource(): string {
  return [
    "extends Node2D",
    "",
    "signal beat_started(index: int, frame: int, text: String)",
    "signal sequence_completed()",
    "",
    "const FRAME_RATE := 12",
    "const DURATION_SECONDS := 7.0",
    "const TOTAL_FRAMES := 84",
    "const BEATS := [",
    "\t{\"frame\": 0, \"text\": \"An egg shakes.\"},",
    "\t{\"frame\": 12, \"text\": \"The shell cracks.\"},",
    "\t{\"frame\": 24, \"text\": \"A worm emerges.\"},",
    "\t{\"frame\": 36, \"text\": \"A deployment mechanism activates.\"},",
    "\t{\"frame\": 48, \"text\": \"The mechanism malfunctions.\"},",
    "\t{\"frame\": 60, \"text\": \"The worm launches upward.\"},",
    "\t{\"frame\": 72, \"text\": \"The worm crashes back into the playfield.\"},",
    "\t{\"frame\": 80, \"text\": \"Smoke clears and the worm reacts.\"},",
    "]",
    "",
    "@onready var egg: Node2D = $Egg",
    "@onready var worm: Node2D = $Worm",
    "@onready var mechanism: Node2D = $Mechanism",
    "@onready var smoke: Node2D = $Smoke",
    "",
    "var _frame := 0",
    "var _beat_index := 0",
    "",
    "func _ready() -> void:",
    "\tEngine.max_fps = FRAME_RATE",
    "\tprint(\"[IKBI_SLICE] Worm Deployment Backfire start fps=%d total_frames=%d\" % [FRAME_RATE, TOTAL_FRAMES])",
    "\t_log_ready_contract()",
    "",
    "func _process(_delta: float) -> void:",
    "\twhile _beat_index < BEATS.size() and _frame >= int(BEATS[_beat_index][\"frame\"]):",
    "\t\t_run_beat(_beat_index)",
    "\t\t_beat_index += 1",
    "\t_frame += 1",
    "\tif _frame > TOTAL_FRAMES:",
    "\t\t_capture_screenshot_if_requested()",
    "\t\tprint(\"[IKBI_SLICE] sequence_completed beats=%d frames=%d\" % [BEATS.size(), TOTAL_FRAMES])",
    "\t\tsequence_completed.emit()",
    "\t\tget_tree().quit(0)",
    "",
    "func _run_beat(index: int) -> void:",
    "\tvar beat: Dictionary = BEATS[index]",
    "\tvar frame: int = int(beat[\"frame\"])",
    "\tvar text: String = String(beat[\"text\"])",
    "\tbeat_started.emit(index + 1, frame, text)",
    "\tprint(\"[IKBI_SLICE] beat=%d frame=%d text=%s\" % [index + 1, frame, text])",
    "\tmatch index:",
    "\t\t0:",
    "\t\t\tegg.rotation_degrees = -8",
    "\t\t1:",
    "\t\t\tegg.scale = Vector2(1.08, 0.92)",
    "\t\t2:",
    "\t\t\tworm.visible = true",
    "\t\t\tworm.position.y = 558",
    "\t\t3:",
    "\t\t\tmechanism.visible = true",
    "\t\t4:",
    "\t\t\tsmoke.visible = true",
    "\t\t\tmechanism.rotation_degrees = 14",
    "\t\t5:",
    "\t\t\tworm.position.y = 360",
    "\t\t6:",
    "\t\t\tworm.position.y = 584",
    "\t\t\tworm.rotation_degrees = 18",
    "\t\t7:",
    "\t\t\tsmoke.scale = Vector2(0.62, 0.62)",
    "\t\t\tworm.rotation_degrees = -10",
    "\t\t\tmechanism.rotation_degrees = -6",
    "",
    "func _capture_screenshot_if_requested() -> void:",
    "\tvar path: String = OS.get_environment(\"IKBI_GAME_STUDIO_SCREENSHOT_PATH\")",
    "\tif path.is_empty():",
    "\t\treturn",
    "\tif DisplayServer.get_name() == \"headless\":",
    "\t\tprint(\"[IKBI_SLICE] screenshot=%s status=-1\" % path)",
    "\t\treturn",
    "\tvar image: Image = get_viewport().get_texture().get_image()",
    "\tif image == null:",
    "\t\tprint(\"[IKBI_SLICE] screenshot=%s status=-1\" % path)",
    "\t\treturn",
    "\tvar err: int = image.save_png(path)",
    "\tprint(\"[IKBI_SLICE] screenshot=%s status=%d\" % [path, err])",
    "",
    "func _log_ready_contract() -> void:",
    "\tprint(\"[IKBI_SLICE] contract=worm_deployment_backfire scene=Node2D transparent_png_sequence=12fps\")",
  ].join("\n") + "\n";
}

function defaultRunProcess(command: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolveProcess({ status, stdout, stderr }));
  });
}

function animationRequestFromFeature(contract: GameFeatureContract): AnimationRequestContract {
  return {
    character: "worm",
    animation: "deployment_backfire",
    duration: 7,
    frame_rate: 12,
    camera: "fixed",
    background: "transparent",
    output: ["png_sequence"],
    beats: contract.player_experience,
    project_name: "Wyrms vs Worms",
    notes: "Locked character scale, no background. Vertical slice proof asset request.",
  };
}

function implementationContract(repoPath: string, contract: GameFeatureContract): SliceImplementationContract {
  return {
    id: contract.id,
    repoPath,
    additiveFiles: [WORM_DEPLOYMENT_BACKFIRE_SCENE, WORM_DEPLOYMENT_BACKFIRE_SCRIPT],
    boundedChange: "Add one self-contained Godot proof scene and one self-contained deterministic timeline script. Existing Wyrms vs Worms files are not modified.",
    scene: `res://${WORM_DEPLOYMENT_BACKFIRE_SCENE}`,
    script: `res://${WORM_DEPLOYMENT_BACKFIRE_SCRIPT}`,
    timeline: {
      durationSeconds: 7,
      frameRate: 12,
      totalFrames: 84,
      beats: contract.player_experience.map((text, index) => ({
        index: index + 1,
        frame: index < 7 ? index * 12 : 80,
        text,
      })),
    },
  };
}

function expectedBeatLog(index: number): string {
  return `[IKBI_SLICE] beat=${index + 1} frame=`;
}

function beatsLoggedInOrder(stdout: string, contract: GameFeatureContract): boolean {
  let cursor = 0;
  for (let index = 0; index < contract.player_experience.length; index += 1) {
    const marker = expectedBeatLog(index);
    const next = stdout.indexOf(marker, cursor);
    if (next < 0 || !stdout.slice(next).includes(contract.player_experience[index] as string)) return false;
    cursor = next + marker.length;
  }
  return true;
}

function extractBeatLogs(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => line.includes("[IKBI_SLICE] beat="));
}

async function writeNewFileOrSame(path: string, content: string, io: { readonly read: typeof readFile; readonly write: typeof writeFile }): Promise<void> {
  try {
    await io.write(path, content, { flag: "wx" });
  } catch (e) {
    if (!(e instanceof Error) || !("code" in e) || e.code !== "EEXIST") throw e;
    const existing = await io.read(path, "utf-8");
    if (existing !== content) throw new Error(`refusing to overwrite existing file with different content: ${path}`);
  }
}

export async function runGameStudioSlice(repoPathInput: string, contractPathInput: string, options: { readonly abonulliBaseUrl?: string } = {}, deps: SliceDeps = {}): Promise<SliceRunReport> {
  const repoPath = resolve(repoPathInput);
  const contractPath = resolve(contractPathInput);
  const now = deps.now ?? (() => new Date());
  const readContract = deps.validateContractFile ?? readAndValidateGameFeatureContract;
  const write = deps.writeFile ?? writeFile;
  const read = deps.readFile ?? readFile;
  const makeDir = deps.mkdir ?? mkdir;
  const runProcess = deps.runProcess ?? defaultRunProcess;
  const inspect = deps.inspect ?? inspectGodotProject;
  const generateBibleFn = deps.generateBible ?? generateGameBible;
  const godotPath = deps.godotPath ?? gameStudioConfig.godotPath;
  const baseUrl = options.abonulliBaseUrl ?? gameStudioConfig.abonulliBaseUrl;

  const inspection = await inspect(repoPath);
  const bible = await generateBibleFn(repoPath);
  const validation = await readContract(contractPath);
  if (!validation.valid || validation.contract === undefined) {
    throw new Error(`feature contract invalid: ${validation.errors.join("; ")}`);
  }
  const runId = `gsd-${now().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${basename(repoPath).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const featureContract = validation.contract;
  const animationRequest = animationRequestFromFeature(featureContract);

  let abonulli: SliceRunReport["abonulli"];
  const requestAnimation = deps.requestAnimation ?? defaultRequestAnimation;
  try {
    abonulli = { mode: "requested", baseUrl, job: await requestAnimation(animationRequest, baseUrl) };
  } catch (e) {
    abonulli = { mode: "mock", baseUrl, error: e instanceof Error ? e.message : String(e) };
  }

  await makeDir(join(repoPath, "scenes"), { recursive: true });
  await makeDir(join(repoPath, "scripts"), { recursive: true });
  await writeNewFileOrSame(join(repoPath, WORM_DEPLOYMENT_BACKFIRE_SCENE), sceneSource(), { read, write });
  await writeNewFileOrSame(join(repoPath, WORM_DEPLOYMENT_BACKFIRE_SCRIPT), scriptSource(), { read, write });

  const screenshotPath = join("/tmp", `${runId}.png`);
  const godotDataHome = join("/tmp", `${runId}-godot-data`);
  const godotCacheHome = join("/tmp", `${runId}-godot-cache`);
  await makeDir(godotDataHome, { recursive: true });
  await makeDir(godotCacheHome, { recursive: true });
  const args = ["--headless", "--path", repoPath, `res://${WORM_DEPLOYMENT_BACKFIRE_SCENE}`];
  const processResult = await runProcess(godotPath, args, {
    cwd: repoPath,
    env: {
      ...process.env,
      XDG_DATA_HOME: godotDataHome,
      XDG_CACHE_HOME: godotCacheHome,
      IKBI_GAME_STUDIO_SCREENSHOT_PATH: screenshotPath,
    },
  });
  const beatLogs = extractBeatLogs(processResult.stdout);
  const screenshotCaptured = processResult.stdout.includes(`screenshot=${screenshotPath} status=0`);

  return {
    runId,
    repoPath,
    contractPath,
    inspected: { repoPath: inspection.repoPath, project: inspection.project },
    bible: { project: bible.project, tests: bible.tests, gapAnalysis: bible.gapAnalysis },
    featureContract,
    animationRequest,
    abonulli,
    implementationContract: implementationContract(repoPath, featureContract),
    godotRun: {
      command: [godotPath, ...args],
      cwd: repoPath,
      exitStatus: processResult.status,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      beatLogs,
      beatsLoggedInOrder: beatsLoggedInOrder(processResult.stdout, featureContract),
      screenshotPath,
      screenshotCaptured,
    },
  };
}

export function renderSliceReport(report: SliceRunReport): string {
  return [
    `slice_run: ${report.runId}`,
    `repo: ${report.repoPath}`,
    `contract: ${report.contractPath}`,
    `project: ${report.inspected.project.name ?? "(unnamed)"}`,
    `scene: ${report.implementationContract.scene}`,
    `script: ${report.implementationContract.script}`,
    `abonulli: ${report.abonulli.mode}${report.abonulli.error !== undefined ? ` (${report.abonulli.error})` : ""}`,
    `godot_command: ${report.godotRun.command.join(" ")}`,
    `godot_exit_status: ${report.godotRun.exitStatus ?? "(signal)"}`,
    `beats_logged: ${report.godotRun.beatLogs.length}/${report.featureContract.player_experience.length}`,
    `beats_in_order: ${report.godotRun.beatsLoggedInOrder ? "yes" : "no"}`,
    `screenshot: ${report.godotRun.screenshotCaptured ? report.godotRun.screenshotPath : "(not captured)"}`,
    "additive_files:",
    ...report.implementationContract.additiveFiles.map((file) => `- ${file}`),
    "beat_evidence:",
    ...report.godotRun.beatLogs.map((line) => `- ${line}`),
  ].join("\n") + "\n";
}
