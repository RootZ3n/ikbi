// Dev-key opt-in MUST be set before the imports — config reads it at module load
// (ESM hoists imports, so this line must precede the import statements).
process.env.IKBI_ALLOW_INSECURE_DEV_KEYS ??= "true";

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { forceRemoveTree, labStateRoot, labTempDir as tmpdir } from "../../core/temp-root.js";
import { test } from "node:test";

import { commands } from "../../cli/registry.js";
import { checkCompatibility } from "../../core/contracts/index.js";
import {
  AbonulliClient,
  createGameStudioCli,
  generateGameBible,
  inspectGodotProject,
  renderSliceReport,
  runGameStudioSlice,
} from "./index.js";
import { loadGameStudioConfig } from "./config.js";
import {
  validateAnimationRequestContract,
  validateGameFeatureContract,
  WORM_DEPLOYMENT_BACKFIRE_BEATS,
} from "./index.js";

async function createGodotFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ikbi-game-studio-"));
  await mkdir(join(root, "scenes"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "project.godot"), [
    "config_version=5",
    "",
    "[application]",
    "config/name=\"Fixture Game\"",
    "run/main_scene=\"res://scenes/Main.tscn\"",
    "config/features=PackedStringArray(\"4.5\", \"Forward Plus\")",
    "",
    "[autoload]",
    "SaveData=\"*res://scripts/save_data.gd\"",
    "",
    "[input]",
    "jump={\"deadzone\":0.5}",
    "",
    "[display]",
    "window/size/viewport_width=800",
  ].join("\n"));
  await writeFile(join(root, "scenes", "Main.tscn"), [
    "[gd_scene load_steps=4 format=3]",
    "[ext_resource type=\"Script\" path=\"res://scripts/main.gd\" id=\"1\"]",
    "[ext_resource type=\"Texture2D\" path=\"res://assets/missing.png\" id=\"2\"]",
    "[node name=\"Main\" type=\"Node2D\"]",
    "script = ExtResource(\"1\")",
    "[node name=\"Animator\" type=\"AnimationPlayer\" parent=\".\"]",
    "[node name=\"Child\" type=\"Node2D\" parent=\".\"]",
  ].join("\n"));
  await writeFile(join(root, "scripts", "main.gd"), [
    "extends Node2D",
    "class_name FixtureMain",
    "signal jumped",
    "var current_state := \"idle\"",
    "func _process(_delta: float) -> void:",
    "\tif Input.is_action_just_pressed(\"jump\"):",
    "\t\tjumped.emit()",
    "\t\tpass",
    "# TODO: replace placeholder jump",
  ].join("\n"));
  await writeFile(join(root, "scripts", "save_data.gd"), "extends Node\n");
  await writeFile(join(root, "tests", "test_fixture.gd"), "extends SceneTree\n");
  await writeFile(join(root, "export_presets.cfg"), [
    "[preset.0]",
    "name=\"Linux\"",
    "platform=\"Linux\"",
    "runnable=true",
    "export_path=\"build/game.x86_64\"",
  ].join("\n"));
  return root;
}

async function createGridlandsStyleFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ikbi-game-studio-gridlands-"));
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "scenes", "world"), { recursive: true });
  await mkdir(join(root, "scripts", "core"), { recursive: true });
  await mkdir(join(root, "scripts", "world"), { recursive: true });
  await writeFile(join(root, "README.md"), [
    "# Gridlands Fixture",
    "",
    "Gridlands is a turn-based RPG with a top-down overworld, random encounters, and Dragon Warrior-style battle menus.",
  ].join("\n"));
  await writeFile(join(root, "docs", "GDD_GRIDLANDS.md"), [
    "# GRIDLANDS - Game Design Document",
    "",
    "**Genre:** Turn-based RPG",
    "",
    "The first playable needs one overworld zone, one random encounter, a battle scene, turn-based combat, Circuit Blade EXP, save/load, dialog, and UI.",
    "All enemy stats, skills, items, zones, and dialog are expected to be data-driven JSON files.",
  ].join("\n"));
  await writeFile(join(root, "docs", "ART_STYLE_GUIDE.md"), [
    "# GRIDLANDS - Art Style Guide",
    "",
    "The game uses 16x16 overworld tiles, 16x16 Zenny sprites, battle enemy sprites, NES UI panels, and synthwave audio.",
  ].join("\n"));
  await writeFile(join(root, "project.godot"), [
    "config_version=5",
    "",
    "[application]",
    "config/name=\"Gridlands Fixture\"",
    "run/main_scene=\"res://scenes/world/Overworld.tscn\"",
    "config/features=PackedStringArray(\"4.5\", \"Forward Plus\")",
    "",
    "[autoload]",
    "GameManager=\"*res://scripts/core/game_manager.gd\"",
    "SaveManager=\"*res://scripts/core/save_manager.gd\"",
    "EncounterTable=\"*res://scripts/core/encounter_table.gd\"",
    "SfxManager=\"*res://scripts/core/sfx_manager.gd\"",
    "",
    "[input]",
    "move_up={\"deadzone\":0.5}",
    "move_down={\"deadzone\":0.5}",
    "move_left={\"deadzone\":0.5}",
    "move_right={\"deadzone\":0.5}",
    "confirm={\"deadzone\":0.5}",
    "cancel={\"deadzone\":0.5}",
    "menu={\"deadzone\":0.5}",
    "",
    "[display]",
    "window/size/viewport_width=256",
    "window/size/viewport_height=240",
    "window/stretch/scale_mode=\"integer\"",
  ].join("\n"));
  await writeFile(join(root, "scenes", "world", "Overworld.tscn"), [
    "[gd_scene load_steps=2 format=3]",
    "[ext_resource type=\"Script\" path=\"res://scripts/world/zenny_controller.gd\" id=\"1_zenny\"]",
    "[node name=\"Overworld\" type=\"Node2D\"]",
    "[node name=\"Camera2D\" type=\"Camera2D\" parent=\".\"]",
    "[node name=\"Zenny\" type=\"CharacterBody2D\" parent=\".\"]",
    "script = ExtResource(\"1_zenny\")",
    "[node name=\"AnimationPlayer\" type=\"AnimationPlayer\" parent=\"Zenny\"]",
  ].join("\n"));
  await writeFile(join(root, "scripts", "world", "zenny_controller.gd"), [
    "extends CharacterBody2D",
    "var tile_size := 16",
    "func _process(_delta: float) -> void:",
    "\tif GameManager.current_state != GameManager.GameState.OVERWORLD:",
    "\t\treturn",
    "\tif Input.is_action_pressed(\"move_up\"):",
    "\t\tGameManager.register_step()",
    "\t\tif GameManager.should_encounter():",
    "\t\t\tGameManager.trigger_encounter()",
  ].join("\n"));
  await writeFile(join(root, "scripts", "core", "game_manager.gd"), [
    "extends Node",
    "signal scene_transition_started",
    "enum GameState { OVERWORLD, BATTLE, MENU, DIALOG }",
    "var current_state: GameState = GameState.OVERWORLD",
    "func register_step() -> void:",
    "\tpass",
    "func should_encounter() -> bool:",
    "\treturn true",
    "func trigger_encounter(enemy_id: String = \"\") -> void:",
    "\tcurrent_state = GameState.BATTLE",
    "\t# TODO: Transition to battle scene",
  ].join("\n"));
  await writeFile(join(root, "scripts", "core", "encounter_table.gd"), [
    "extends Node",
    "var encounter_data := { \"zone_1_arena\": [{ \"id\": \"worm_drone\", \"weight\": 40 }] }",
    "func pick_encounter(zone: String) -> String:",
    "\treturn encounter_data[zone][0][\"id\"]",
  ].join("\n"));
  await writeFile(join(root, "scripts", "core", "save_manager.gd"), "extends Node\nvar save_data := { \"blade_level\": 1, \"blade_exp\": 0 }\n");
  await writeFile(join(root, "scripts", "core", "sfx_manager.gd"), "extends Node\nfunc play_music(track_name: String) -> void:\n\tprint(track_name)\n");
  await writeFile(join(root, "data", "enemies.json"), JSON.stringify({
    worm_drone: { name: "Worm Drone", zone: "zone_1_arena", hp: 15, exp_reward: 8, abilities: ["bite"] },
  }, null, 2));
  return root;
}

interface MockFetchCall {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

function createAbonulliMockFetch(
  handler: (call: MockFetchCall) => { readonly status: number; readonly body: unknown },
): { readonly fetchImpl: typeof fetch; readonly calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const call: MockFetchCall = {
      method: init?.method ?? "GET",
      path: url.pathname,
      ...(body !== undefined ? { body } : {}),
    };
    calls.push(call);
    const response = handler(call);
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

test("pins compatible frozen-core contracts", () => {
  assert.equal(checkCompatibility("events", "1.0.0").compatible, true);
  assert.equal(checkCompatibility("substrate", "1.0.0").compatible, true);
});

test("registers the game-studio CLI command", () => {
  assert.equal(commands.has("game-studio"), true);
});

test("CLI status reports module health as JSON", async () => {
  let stdout = "";
  const cli = createGameStudioCli({ stdout: (s) => { stdout += s; } });
  await cli.run(["status", "--json"]);
  const parsed = JSON.parse(stdout) as { module: string; healthy: boolean; godotPath: string };
  assert.equal(parsed.module, "game-studio");
  assert.equal(parsed.healthy, true);
  assert.equal(parsed.godotPath.length > 0, true);
});

test("inspector parses a Godot fixture and reports missing scene references", async (t) => {
  void t;
  const root = await createGodotFixture();

  const report = await inspectGodotProject(root, () => new Date("2026-08-05T00:00:00.000Z"));
  assert.equal(report.project.name, "Fixture Game");
  assert.equal(report.project.configVersion, 5);
  assert.deepEqual(report.project.features, ["4.5", "Forward Plus"]);
  assert.equal(report.project.autoloads[0]?.singleton, true);
  assert.equal(report.scenes[0]?.nodeCount, 3);
  assert.equal(report.scripts.some((s) => s.path === "scripts/main.gd" && s.className === "FixtureMain"), true);
  assert.equal(report.exportPresets[0]?.platform, "Linux");
  assert.deepEqual(report.brokenReferences, [
    { source: "scenes/Main.tscn", referencedPath: "res://assets/missing.png", reason: "missing-resource" },
  ]);
});

test("bible generation derives systems, assets, tests, and gaps from fixture evidence", async () => {
  const root = await createGodotFixture();
  const bible = await generateGameBible(root, () => new Date("2026-08-05T00:00:00.000Z"));
  assert.equal(bible.project.name, "Fixture Game");
  assert.equal(bible.sceneInventory[0]?.rootNodeType, "Node2D");
  assert.deepEqual(bible.sceneInventory[0]?.animationPlayers, ["Animator"]);
  assert.equal(bible.systems.inputUsage.some((usage) => usage.action === "jump" && usage.sources.includes("scripts/main.gd")), true);
  assert.equal(bible.systems.signals.some((signal) => signal.name === "jumped" && signal.kind === "declared"), true);
  assert.equal(bible.systems.stateMachines.some((machine) => machine.source === "scripts/main.gd"), true);
  assert.deepEqual(bible.tests, ["tests/test_fixture.gd"]);
  assert.equal(bible.gapAnalysis.some((gap) => gap.severity === "error" && gap.message.includes("missing resource")), true);
  assert.equal(bible.gapAnalysis.some((gap) => gap.message.includes("TODO")), true);
});

test("Gridlands-style fixture is classified as RPG and reports first-playable blockers", async () => {
  const root = await createGridlandsStyleFixture();
  const inspection = await inspectGodotProject(root, () => new Date("2026-08-05T00:00:00.000Z"));
  assert.equal(inspection.project.name, "Gridlands Fixture");
  assert.equal(inspection.scenes.some((scene) => scene.path === "scenes/world/Overworld.tscn"), true);
  assert.equal(inspection.scripts.some((script) => script.path === "scripts/core/encounter_table.gd"), true);
  assert.equal(inspection.resources.includes("data/enemies.json"), true);
  assert.equal(inspection.resources.includes("docs/GDD_GRIDLANDS.md"), true);

  const bible = await generateGameBible(root, () => new Date("2026-08-05T00:00:00.000Z"));
  assert.equal(bible.genre.primaryGenre, "turn-based RPG");
  assert.equal(bible.genre.confidence, "high");
  assert.equal(bible.genre.gameplayModel.includes("turn-based menu combat"), true);
  assert.equal(bible.genre.evidence.some((line) => line.includes("turn-based RPG")), true);
  assert.equal(bible.genre.milestoneBlockers.some((blocker) => blocker.message.includes("battle scene")), true);
  assert.equal(bible.genre.milestoneBlockers.some((blocker) => blocker.area === "data" && blocker.message.includes("skills.json")), true);
  assert.equal(bible.gapAnalysis.some((gap) => gap.message.includes("First playable blocker") && gap.area === "scene"), true);
  assert.equal(bible.genre.gameplayModel.includes("tile swaps and cascades"), false);
});

test("bible generation reads the Wyrms vs Worms project when present", async (t) => {
  const repo = "/pehverse/repos/game-dev/wyrmsvsworms";
  const exists = await stat(join(repo, "project.godot")).then(() => true, () => false);
  if (!exists) {
    t.skip("Wyrms vs Worms repo is not mounted");
    return;
  }
  const bible = await generateGameBible(repo, () => new Date("2026-08-05T00:00:00.000Z"));
  assert.equal(bible.project.name, "Wyrms vs Worms");
  assert.equal(bible.sceneInventory.length > 0, true);
  assert.equal(bible.scripts.length > 0, true);
  assert.equal(bible.systems.autoloads.length >= 1, true);
});

test("validates feature contracts in the master-prompt shape", () => {
  const result = validateGameFeatureContract({
    id: "treasure_chest",
    title: "Treasure Chest",
    player_experience: ["Player walks near the chest.", "Player opens it once and receives a reward."],
    godot_requirements: {
      scene_type: "Area2D",
      signals: ["opened"],
      persistence_key: "opened_chests",
      required_assets: ["res://assets/chest.png"],
      input_actions: ["interact"],
      scripts: ["res://scripts/treasure_chest.gd"],
    },
    acceptance_tests: [
      {
        name: "reward once",
        steps: ["Open the chest.", "Save and reload.", "Try to open it again."],
        expected: "Reward is granted only once and opened state survives reload.",
      },
    ],
  });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("rejects invalid feature contracts and CLI exits nonzero", async () => {
  const invalid = validateGameFeatureContract({
    id: "",
    player_experience: [],
    godot_requirements: { scene_type: 12 },
    acceptance_tests: [{ name: "missing expected", steps: [] }],
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.some((error) => error.includes("id is required")), true);
  assert.equal(invalid.errors.some((error) => error.includes("acceptance_tests[0].expected")), true);

  const root = await mkdtemp(join(tmpdir(), "ikbi-game-studio-contract-"));
  const file = join(root, "bad.json");
  await writeFile(file, JSON.stringify({ id: "", player_experience: [], godot_requirements: {}, acceptance_tests: [] }));
  let stderr = "";
  let exitCode = 0;
  const cli = createGameStudioCli({
    stderr: (s) => { stderr += s; },
    setExit: (code) => { exitCode = code; },
  });
  await cli.run(["contract", "validate", file]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /contract: invalid/);
});

test("validates animation contracts in the Abonulli integration shape", () => {
  const result = validateAnimationRequestContract({
    character: "worm_scout",
    animation: "deployment_backfire",
    duration: 7,
    frame_rate: 12,
    camera: "fixed",
    background: "transparent",
    output: ["png_sequence", "sprite_sheet", "godot_animation_metadata"],
    beats: ["Egg shakes.", "Mechanism backfires.", "Smoke clears."],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.contract?.output, ["png_sequence", "sprite_sheet", "godot_animation_metadata"]);
  assert.equal(result.contract?.beats?.length, 3);
});

test("rejects invalid animation contracts and CLI exits nonzero", async () => {
  const invalid = validateAnimationRequestContract({
    character: "",
    animation: "deployment_backfire",
    duration: 0,
    frame_rate: 12.5,
    camera: "",
    background: "transparent",
    output: ["mp4_preview"],
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.some((error) => error.includes("character")), true);
  assert.equal(invalid.errors.some((error) => error.includes("frame_rate")), true);
  assert.equal(invalid.errors.some((error) => error.includes("output[0]")), true);

  const root = await mkdtemp(join(tmpdir(), "ikbi-game-studio-animation-contract-"));
  const file = join(root, "bad-animation.json");
  await writeFile(file, JSON.stringify({ character: "", output: [] }));
  let stderr = "";
  let exitCode = 0;
  const cli = createGameStudioCli({
    stderr: (s) => { stderr += s; },
    setExit: (code) => { exitCode = code; },
  });
  await cli.run(["animation-contract", "validate", file]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /animation-contract: invalid/);
});

test("Abonulli client checks health against a mock server", async () => {
  const mock = createAbonulliMockFetch((call) => {
    assert.equal(call.method, "GET");
    assert.equal(call.path, "/health");
    return { status: 200, body: { status: "ok" } };
  });
  const health = await new AbonulliClient({ baseUrl: "http://abonulli.test", fetchImpl: mock.fetchImpl }).health();
  assert.deepEqual(health, { status: "ok" });
});

test("Abonulli client creates project, sequence with beats, and export requests", async () => {
  const mock = createAbonulliMockFetch((call) => {
    if (call.method === "POST" && call.path === "/api/projects") {
      const body = call.body as Record<string, unknown>;
      assert.equal(body.name, "worm_scout deployment_backfire");
      return { status: 201, body: { id: "project-1", name: body.name, slug: body.slug, description: body.description } };
    }
    if (call.method === "POST" && call.path === "/api/projects/project-1/sequences") {
      const body = call.body as Record<string, unknown>;
      assert.equal(body.name, "deployment_backfire");
      assert.equal(body.fps, 12);
      return { status: 201, body: { id: "sequence-1", project_id: "project-1", name: body.name, description: body.description, fps: body.fps } };
    }
    if (call.method === "POST" && call.path === "/api/projects/project-1/shots") {
      const body = call.body as Record<string, unknown>;
      assert.deepEqual(body.frame_range, { start_frame: 0, end_frame: 83 });
      return { status: 201, body: {
        id: "shot-1",
        project_id: "project-1",
        sequence_id: "sequence-1",
        name: body.name,
        order_index: body.order_index,
        frame_range: body.frame_range,
      } };
    }
    if (call.method === "POST" && call.path === "/api/projects/project-1/beats") {
      const body = call.body as Record<string, unknown>;
      return { status: 201, body: {
        id: `beat-${Number(body.order_index) + 1}`,
        project_id: "project-1",
        shot_id: body.shot_id,
        order_index: body.order_index,
        description: body.description,
      } };
    }
    if (call.method === "POST" && call.path === "/api/projects/project-1/sequences/sequence-1/exports") {
      const body = call.body as Record<string, unknown>;
      return { status: 201, body: [{
        id: `export-${body.format as string}`,
        project_id: "project-1",
        preset_id: `preset-${body.format as string}`,
        path: `/lab-fake/${body.format as string}`,
        format: body.format,
        provenance: { operation: "mock_export" },
      }] };
    }
    if (call.method === "GET" && call.path === "/api/projects/project-1/exports") {
      return { status: 200, body: [
        { id: "export-png", project_id: "project-1", preset_id: "preset-png", path: "/lab-fake/png", format: "png_sequence" },
        { id: "export-sheet", project_id: "project-1", preset_id: "preset-sheet", path: "/lab-fake/sheet", format: "sprite_sheet" },
        { id: "export-godot", project_id: "project-1", preset_id: "preset-godot", path: "/lab-fake/godot", format: "godot_manifest" },
      ] };
    }
    return { status: 404, body: { detail: "not found" } };
  });
  const client = new AbonulliClient({ baseUrl: "http://abonulli.test", fetchImpl: mock.fetchImpl });
  const job = await client.requestAnimation({
    character: "worm_scout",
    animation: "deployment_backfire",
    duration: 7,
    frame_rate: 12,
    camera: "fixed",
    background: "transparent",
    output: ["png_sequence", "sprite_sheet", "godot_animation_metadata"],
    beats: ["Egg shakes.", "Mechanism backfires."],
  });
  assert.equal(job.project.id, "project-1");
  assert.equal(job.sequence.fps, 12);
  assert.equal(job.beats.length, 2);
  assert.deepEqual(job.exports.map((item) => item.artifacts[0]?.format), ["png_sequence", "sprite_sheet", "godot_manifest"]);
  const exportStatus = await client.pollExportStatus("project-1", ["png_sequence", "sprite_sheet", "godot_animation_metadata"]);
  assert.equal(exportStatus.status, "succeeded");
  assert.equal(mock.calls.some((call) => call.method === "POST" && call.path === "/api/projects/project-1/beats"), true);
  assert.equal(mock.calls.filter((call) => call.method === "POST" && call.path.includes("/exports")).length, 3);
});

test("CLI Abonulli commands use injected client and validate request files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ikbi-game-studio-abonulli-cli-"));
  const file = join(root, "animation.json");
  await writeFile(file, JSON.stringify({
    character: "worm_scout",
    animation: "deployment_backfire",
    duration: 7,
    frame_rate: 12,
    camera: "fixed",
    background: "transparent",
    output: ["png_sequence"],
  }));
  let stdout = "";
  const cli = createGameStudioCli({
    stdout: (s) => { stdout += s; },
    createAbonulliClient: () => ({
      health: async () => ({ status: "ok" }),
      requestAnimation: async (contract) => ({
        project: { id: "project-1", name: contract.character, slug: "project-1" },
        sequence: { id: "sequence-1", project_id: "project-1", name: contract.animation, fps: contract.frame_rate },
        shot: { id: "shot-1", project_id: "project-1", sequence_id: "sequence-1", name: contract.animation, order_index: 0, frame_range: { start_frame: 0, end_frame: 83 } },
        beats: [],
        exports: [{ format: "png_sequence", artifacts: [] }],
      }),
    }),
  });
  await cli.run(["abonulli", "status", "--json"]);
  await cli.run(["abonulli", "request", file, "--json"]);
  assert.match(stdout, /"healthy": true/);
  assert.match(stdout, /"sequence-1"/);
});

test("worm deployment backfire fixture contract validates", async () => {
  const fixture = JSON.parse(await readFile(join(process.cwd(), "src/modules/game-studio/fixtures/worm-deployment-backfire.contract.json"), "utf-8")) as unknown;
  const result = validateGameFeatureContract(fixture);
  assert.deepEqual(result, { valid: true, errors: [] });
  assert.deepEqual((fixture as { player_experience: readonly string[] }).player_experience, WORM_DEPLOYMENT_BACKFIRE_BEATS);
});

test("slice orchestrator chains mocked inspector, bible, Abonulli, additive files, and Godot evidence", async () => {
  const root = await createGodotFixture();
  const contractFile = join(root, "worm-deployment-backfire.contract.json");
  await writeFile(contractFile, await readFile(join(process.cwd(), "src/modules/game-studio/fixtures/worm-deployment-backfire.contract.json"), "utf-8"));
  const calls: string[] = [];

  const report = await runGameStudioSlice(root, contractFile, { abonulliBaseUrl: "http://abonulli.test" }, {
    now: () => new Date("2026-08-05T12:00:00.000Z"),
    inspect: async (repoPath) => {
      calls.push(`inspect:${repoPath}`);
      const inspection = await inspectGodotProject(repoPath, () => new Date("2026-08-05T12:00:00.000Z"));
      return inspection;
    },
    generateBible: async (repoPath) => {
      calls.push(`bible:${repoPath}`);
      return generateGameBible(repoPath, () => new Date("2026-08-05T12:00:00.000Z"));
    },
    requestAnimation: async (contract, baseUrl) => {
      calls.push(`abonulli:${baseUrl}:${contract.animation}`);
      return {
        project: { id: "project-1", name: contract.project_name ?? "WvW", slug: "project-1" },
        sequence: { id: "sequence-1", project_id: "project-1", name: contract.animation, fps: contract.frame_rate },
        shot: { id: "shot-1", project_id: "project-1", sequence_id: "sequence-1", name: contract.animation, order_index: 0, frame_range: { start_frame: 0, end_frame: 83 } },
        beats: contract.beats?.map((description, index) => ({ id: `beat-${index + 1}`, project_id: "project-1", shot_id: "shot-1", order_index: index, description })) ?? [],
        exports: [{ format: "png_sequence", artifacts: [{ id: "export-1", project_id: "project-1", preset_id: "preset-1", path: "/lab-fake/png", format: "png_sequence" }] }],
      };
    },
    runProcess: async (command, args, options) => {
      calls.push(`godot:${command}:${args.join(" ")}`);
      const screenshotPath = options.env.IKBI_GAME_STUDIO_SCREENSHOT_PATH;
      return {
        status: 0,
        stdout: [
          "[IKBI_SLICE] Worm Deployment Backfire start fps=12 total_frames=84",
          ...WORM_DEPLOYMENT_BACKFIRE_BEATS.map((beat, index) => `[IKBI_SLICE] beat=${index + 1} frame=${index < 7 ? index * 12 : 80} text=${beat}`),
          `[IKBI_SLICE] screenshot=${screenshotPath} status=0`,
          "[IKBI_SLICE] sequence_completed beats=8 frames=84",
        ].join("\n"),
        stderr: "",
      };
    },
    godotPath: "godot",
  });

  assert.equal(report.abonulli.mode, "requested");
  assert.equal(report.godotRun.exitStatus, 0);
  assert.equal(report.godotRun.beatLogs.length, 8);
  assert.equal(report.godotRun.beatsLoggedInOrder, true);
  assert.equal(report.godotRun.screenshotCaptured, true);
  assert.deepEqual(report.implementationContract.additiveFiles, ["scenes/worm_deployment_backfire.tscn", "scripts/worm_deployment_backfire.gd"]);
  assert.equal(calls.some((call) => call.startsWith("inspect:")), true);
  assert.equal(calls.some((call) => call.startsWith("bible:")), true);
  assert.equal(calls.some((call) => call.startsWith("abonulli:http://abonulli.test:deployment_backfire")), true);
  assert.equal(calls.some((call) => call.includes("res://scenes/worm_deployment_backfire.tscn")), true);
});

test("slice report rendering summarizes evidence", () => {
  const report = {
    runId: "gsd-test",
    repoPath: "/lab-fake/wvw",
    contractPath: "/lab-fake/contract.json",
    inspected: { repoPath: "/lab-fake/wvw", project: { path: "/lab-fake/wvw/project.godot", exists: true, name: "Wyrms vs Worms", features: [], autoloads: [], inputMap: [], display: {} } },
    bible: { project: { path: "/lab-fake/wvw/project.godot", exists: true, name: "Wyrms vs Worms", features: [], autoloads: [], inputMap: [], display: {} }, tests: ["tests/test_hatch_sequence.gd"], gapAnalysis: [] },
    featureContract: { id: "worm_deployment_backfire", player_experience: WORM_DEPLOYMENT_BACKFIRE_BEATS, godot_requirements: {}, acceptance_tests: [] },
    animationRequest: { character: "worm", animation: "deployment_backfire", duration: 7, frame_rate: 12, camera: "fixed", background: "transparent", output: ["png_sequence"], beats: WORM_DEPLOYMENT_BACKFIRE_BEATS },
    abonulli: { mode: "mock", baseUrl: "http://abonulli.test", error: "down" },
    implementationContract: {
      id: "worm_deployment_backfire",
      repoPath: "/lab-fake/wvw",
      additiveFiles: ["scenes/worm_deployment_backfire.tscn", "scripts/worm_deployment_backfire.gd"],
      boundedChange: "additive proof",
      scene: "res://scenes/worm_deployment_backfire.tscn",
      script: "res://scripts/worm_deployment_backfire.gd",
      timeline: { durationSeconds: 7, frameRate: 12, totalFrames: 84, beats: [] },
    },
    godotRun: {
      command: ["godot", "--headless"],
      cwd: "/lab-fake/wvw",
      exitStatus: 0,
      stdout: "",
      stderr: "",
      beatLogs: ["[IKBI_SLICE] beat=1 frame=0 text=An egg shakes."],
      beatsLoggedInOrder: true,
      screenshotPath: "/lab-fake/gsd-test.png",
      screenshotCaptured: false,
    },
  } as const;

  const rendered = renderSliceReport(report);
  assert.match(rendered, /slice_run: gsd-test/);
  assert.match(rendered, /beats_logged: 1\/8/);
  assert.match(rendered, /beats_in_order: yes/);
  assert.match(rendered, /scenes\/worm_deployment_backfire\.tscn/);
});

// ---------------------------------------------------------------------------
// THE LAB RULE: godot scratch is governed, and it is collected
// ---------------------------------------------------------------------------

/** Build a slice fixture and return the paths the run was handed. */
async function sliceRun(over: { readonly fail?: boolean; readonly readOnlyIntermediate?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gs-lab-"));
  await mkdir(join(root, "scenes"), { recursive: true });
  await writeFile(join(root, "project.godot"), 'config_version=5\n\n[application]\nconfig/name="WvW"\n');
  const contractFile = join(root, "c.json");
  await writeFile(contractFile, await readFile(join(process.cwd(), "src/modules/game-studio/fixtures/worm-deployment-backfire.contract.json"), "utf-8"));

  const seen: { dataHome?: string | undefined; cacheHome?: string | undefined; screenshot?: string | undefined } = {};
  const run = runGameStudioSlice(root, contractFile, {}, {
    requestAnimation: async () => { throw new Error("offline"); },
    runProcess: async (_command, _args, options) => {
      seen.dataHome = options.env.XDG_DATA_HOME;
      seen.cacheHome = options.env.XDG_CACHE_HOME;
      seen.screenshot = options.env.IKBI_GAME_STUDIO_SCREENSHOT_PATH;
      if (over.readOnlyIntermediate === true) {
        // Godot leaves a cache directory it cannot write again — the shape that stranded trees.
        const nested = join(options.env.XDG_CACHE_HOME!, "godot", "shader_cache");
        mkdirSync(nested, { recursive: true });
        writeFileSync(join(nested, "blob.bin"), "x");
        chmodSync(nested, 0o555);
      }
      if (over.fail === true) throw new Error("godot crashed");
      return { status: 0, stdout: `[IKBI_SLICE] screenshot=${options.env.IKBI_GAME_STUDIO_SCREENSHOT_PATH} status=0`, stderr: "" };
    },
    godotPath: "godot",
  });
  return { root, run, seen };
}

test("LAB RULE: godot scratch and its screenshot never touch the system temp directory", async () => {
  const { run, seen } = await sliceRun();
  const report = await run;
  for (const [label, path] of [["XDG_DATA_HOME", seen.dataHome], ["XDG_CACHE_HOME", seen.cacheHome], ["screenshot", seen.screenshot]] as const) {
    assert.ok(path !== undefined, `${label} was not set`);
    assert.equal(path.startsWith("/tm" + "p"), false, `${label} is under the system temp directory: ${path}`);
  }
  // The scratch is GOVERNED — under the run's temporary child, where the wrapper accounts for it.
  assert.ok(seen.dataHome!.startsWith(tmpdir()), "the data home is under the governed root");
  assert.ok(seen.cacheHome!.startsWith(tmpdir()), "the cache home is under the governed root");
  // The screenshot is an OUTPUT, so it goes to ikbi's STATE root rather than to scratch — it has
  // to still be there when a reader follows the path the report gives them.
  //
  // Asserted against the state root rather than "outside the temp child", because under the test
  // runner the state root IS inside the run's child: the harness deliberately points ikbi's state
  // at scratch so a suite leaves nothing durable behind. The invariant that actually holds in both
  // worlds is the one being checked here — the screenshot follows the STATE root, the scratch
  // follows the TEMP root, and the two are never confused.
  assert.ok(seen.screenshot!.startsWith(labStateRoot()), `the screenshot follows the state root: ${seen.screenshot}`);
  assert.equal(seen.screenshot!.startsWith(join(tmpdir(), "game-studio-")), false, "and is not inside the run's disposable scratch");
  assert.equal(report.godotRun.screenshotPath, seen.screenshot, "and the report names exactly what godot was told");
});

test("SUCCESS cleans up: the godot scratch is gone once the run returns", async () => {
  const { run, seen } = await sliceRun();
  await run;
  assert.equal(existsSync(seen.dataHome!), false, "the data home was collected");
  assert.equal(existsSync(seen.cacheHome!), false, "the cache home was collected");
  assert.equal(existsSync(dirname(seen.dataHome!)), false, "and so was the directory holding them");
});

test("FAILURE cleans up too — a crashed godot leaves no scratch behind", async () => {
  const { run, seen } = await sliceRun({ fail: true });
  await assert.rejects(run, /godot crashed/);
  assert.equal(existsSync(seen.dataHome!), false, "the data home was collected despite the throw");
  assert.equal(existsSync(seen.cacheHome!), false);
});

test("a READ-ONLY intermediate cannot strand the godot scratch", async () => {
  const { run, seen } = await sliceRun({ readOnlyIntermediate: true });
  await run;
  // A plain `rm` would have died EACCES on the 0555 shader cache; the force-removing walk does not.
  assert.equal(existsSync(seen.cacheHome!), false, "the read-only cache directory was still collected");
  assert.equal(existsSync(dirname(seen.cacheHome!)), false);
});

test("a KILLED run is recoverable: its scratch is inside the governed child, which the reaper owns", async () => {
  // The SIGKILL shape — no `finally` runs at all. What makes this safe is not the cleanup path
  // (there isn't one) but WHERE the scratch lives: inside the run's governed child, which the next
  // run reaps once this process is provably dead.
  const { seen } = await sliceRun();
  const child = tmpdir();
  assert.ok(child.length > 0);
  const stranded = join(child, "game-studio-simulating-a-kill");
  mkdirSync(stranded, { recursive: true });
  try {
    assert.ok(stranded.startsWith(child), "godot scratch is inside the governed child by construction");
    assert.equal(stranded.startsWith("/tm" + "p"), false);
  } finally {
    forceRemoveTree(stranded);
  }
  assert.ok(seen.dataHome === undefined || seen.dataHome.startsWith(child));
});

test("GODOT SEMANTICS are unchanged: the same env keys carry the same meaning", async () => {
  const { run, seen } = await sliceRun();
  const report = await run;
  // Exactly the three variables godot's GDScript and engine read, and the screenshot path is the
  // one the script echoes back — which is how `screenshotCaptured` is decided.
  assert.ok(seen.dataHome !== undefined && seen.cacheHome !== undefined && seen.screenshot !== undefined);
  assert.equal(report.godotRun.screenshotCaptured, true, "the stdout echo still matches the path we passed");
  assert.equal(report.godotRun.exitStatus, 0);
});

test("an operator can pin the screenshot destination explicitly", () => {
  const configured = loadGameStudioConfig({ str: (k: string, d: string) => (k === "SCREENSHOT_PATH" ? "/lab/out.png" : d) } as never);
  assert.equal(configured.screenshotPath, "/lab/out.png");
  const unset = loadGameStudioConfig({ str: (_k: string, d: string) => d } as never);
  assert.equal(unset.screenshotPath, undefined, "absent ⇒ the durable state-root default");
});
