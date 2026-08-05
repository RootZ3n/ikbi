# Game Bible: Gridlands

- repo: `/pehverse/repos/game-dev/gridlands`
- generated_on: 2026-08-05
- command: `env IKBI_ALLOW_INSECURE_DEV_KEYS=true node dist/cli/index.js game-studio bible /pehverse/repos/game-dev/gridlands`
- main_scene: `res://scenes/world/Overworld.tscn`
- godot_features: `4.5`, `Forward Plus`

## Critical Answer

Gridlands is a synthwave, top-down, turn-based RPG in Godot 4.x. Its source evidence points to a Dragon Warrior-style loop: tile/grid overworld traversal, random encounters while walking, turn-based battle menus, data-driven enemy stats, save/load state, and Circuit Blade companion/weapon progression.

A first playable milestone needs one small overworld zone, one random encounter that transitions into battle, one complete turn-based fight loop, Circuit Blade EXP/level reward handling, save/load persistence for the milestone state, minimal dialog/battle/menu UI, and placeholder or final RPG presentation assets wired into Godot without missing references.

## Genre Analysis

- primary_genre: turn-based RPG
- confidence: high
- gameplay_model: top-down overworld traversal; tile/grid-aligned player movement; random encounters while walking; turn-based menu combat; data-driven enemies and companion/weapon progression

## Evidence

- `README.md` says Gridlands is a synthwave, turn-based RPG built in Godot 4.x.
- `docs/GDD_GRIDLANDS.md` declares `Genre: Turn-based RPG`.
- `project.godot` sets `run/main_scene` to `res://scenes/world/Overworld.tscn`, declares Godot 4.5 features, NES-resolution display settings, movement/confirm/cancel/menu inputs, and four autoloads.
- `scenes/world/Overworld.tscn` contains a `Node2D` overworld scene with `Camera2D`, `Zenny` as `CharacterBody2D`, `Sprite2D`, `CollisionShape2D`, and an `AnimationPlayer`.
- `scripts/world/zenny_controller.gd` implements 16px tile movement, movement input, collision checks, step registration, and random encounter triggering after tile arrival.
- `scripts/core/game_manager.gd` defines `GameState { OVERWORLD, BATTLE, MENU, DIALOG, CUTSCENE, LOADING }`, step counting, random encounter checks, `trigger_encounter`, and `end_battle`.
- `scripts/core/encounter_table.gd` defines weighted encounter tables by zone and loads enemy records from `res://data/enemies.json`.
- `scripts/core/save_manager.gd` persists current zone, player position, step count, HP/MP, inventory, glitches fixed, and Circuit Blade fields such as `blade_level`, `blade_exp`, `blade_form`, and `blade_skills`.
- `data/enemies.json` contains Zone 1 enemy and boss data with HP, attack, defense, speed, EXP/gold rewards, abilities, and loot tables.
- `docs/ART_STYLE_GUIDE.md` specifies NES 256x240 presentation, 16x16 overworld tiles, Zenny sprite sheet requirements, battle enemy sprites, neon UI panels, fonts, and synthwave audio direction.

## Inventory Summary

- scenes: 1 (`scenes/world/Overworld.tscn`)
- scripts: 5 (`encounter_table.gd`, `game_manager.gd`, `save_manager.gd`, `sfx_manager.gd`, `zenny_controller.gd`)
- autoloads: 4 (`GameManager`, `SaveManager`, `EncounterTable`, `SfxManager`)
- input actions: 7 (`move_up`, `move_down`, `move_left`, `move_right`, `confirm`, `cancel`, `menu`)
- resources: 13 (`.md`, `.json`, `.png`, `.import`)
- Godot tests detected: none
- broken scene references: none

## First Playable Blockers

- No battle scene or combat script inventory exists for the promised turn-based encounter loop.
- No menu, dialog, HUD, or battle UI scene/script inventory exists for Dragon Warrior-style choices.
- Playable RPG presentation assets are not present yet: player sprite sheet, tileset, battle enemy art, UI font/panels, and synthwave audio assets.
- Missing data files for the planned data-driven RPG content model: `skills.json`, `items.json`, `zones.json`, and `dialog.json`.
- Circuit Blade progression and weapon-form systems are not implemented as scripts; save data stores blade fields, but no companion/blade/skill system script is present.
- No Godot test scripts were detected under `test/` or `tests/`.
- TODO markers remain in `game_manager.gd` for battle scene transition and in `sfx_manager.gd` for actual audio integration.

## First Playable Milestone Definition

1. One compact walkable overworld zone with collision boundaries and a safe tutorial area.
2. One weighted random encounter from `EncounterTable` that moves from `OVERWORLD` to a battle scene.
3. One complete turn-based fight loop with Fight, Skill, Item, and Run outcomes.
4. One enemy from `data/enemies.json` and one boss-or-strong-enemy path for the first zone.
5. Circuit Blade EXP and level reward application after victory.
6. Save/load preserving zone, position, step count, blade state, inventory, and milestone progress.
7. Minimal UI: dialog box, battle command menu, HP/MP/status panel, and inventory/status screen.
8. Placeholder or final sprites, tiles, font, SFX, and music assets wired into Godot resources with no missing references.
9. A small Godot test or scripted verification path for movement, encounter trigger, combat resolution, and save/load.
