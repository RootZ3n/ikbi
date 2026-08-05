// Dev-key opt-in MUST be set before the imports — config reads it at module load
// (ESM hoists imports, so this line must precede the import statements).
process.env.IKBI_ALLOW_INSECURE_DEV_KEYS ??= "true";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { commands } from "../../cli/registry.js";
import { checkCompatibility } from "../../core/contracts/index.js";
import { createGameStudioCli, inspectGodotProject } from "./index.js";

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
  const root = await mkdtemp(join(tmpdir(), "ikbi-game-studio-"));
  await mkdir(join(root, "scenes"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
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
    "[gd_scene load_steps=3 format=3]",
    "[ext_resource type=\"Script\" path=\"res://scripts/main.gd\" id=\"1\"]",
    "[ext_resource type=\"Texture2D\" path=\"res://assets/missing.png\" id=\"2\"]",
    "[node name=\"Main\" type=\"Node2D\"]",
    "[node name=\"Child\" type=\"Node2D\" parent=\".\"]",
  ].join("\n"));
  await writeFile(join(root, "scripts", "main.gd"), "extends Node2D\nclass_name FixtureMain\n");
  await writeFile(join(root, "scripts", "save_data.gd"), "extends Node\n");
  await writeFile(join(root, "export_presets.cfg"), [
    "[preset.0]",
    "name=\"Linux\"",
    "platform=\"Linux\"",
    "runnable=true",
    "export_path=\"build/game.x86_64\"",
  ].join("\n"));

  const report = await inspectGodotProject(root, () => new Date("2026-08-05T00:00:00.000Z"));
  assert.equal(report.project.name, "Fixture Game");
  assert.equal(report.project.configVersion, 5);
  assert.deepEqual(report.project.features, ["4.5", "Forward Plus"]);
  assert.equal(report.project.autoloads[0]?.singleton, true);
  assert.equal(report.scenes[0]?.nodeCount, 2);
  assert.equal(report.scripts.some((s) => s.path === "scripts/main.gd" && s.className === "FixtureMain"), true);
  assert.equal(report.exportPresets[0]?.platform, "Linux");
  assert.deepEqual(report.brokenReferences, [
    { source: "scenes/Main.tscn", referencedPath: "res://assets/missing.png", reason: "missing-resource" },
  ]);
});
