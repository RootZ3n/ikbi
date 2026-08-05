// Dev-key opt-in MUST be set before the imports — config reads it at module load
// (ESM hoists imports, so this line must precede the import statements).
process.env.IKBI_ALLOW_INSECURE_DEV_KEYS ??= "true";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { commands } from "../../cli/registry.js";
import { checkCompatibility } from "../../core/contracts/index.js";
import { createGameStudioCli, generateGameBible, inspectGodotProject, validateGameFeatureContract } from "./index.js";

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
