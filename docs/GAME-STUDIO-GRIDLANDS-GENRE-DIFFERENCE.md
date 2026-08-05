# Game Studio GS-E Genre Difference Report

- proof target: Gridlands (`/pehverse/repos/game-dev/gridlands`)
- prior proof: Wyrms vs Worms (`/pehverse/repos/game-dev/wyrmsvsworms`)
- generated_on: 2026-08-05

## What The Module Learned From Gridlands

Gridlands is a different game genre from Wyrms vs Worms. The updated Game Bible classifies Gridlands as a high-confidence turn-based RPG because the project evidence points to top-down overworld movement, random encounters, turn-based battle state, RPG data tables, save/load state, and Circuit Blade progression.

Repository evidence:

- `README.md`: calls Gridlands a synthwave, turn-based RPG and names the Dragon Warrior blueprint.
- `docs/GDD_GRIDLANDS.md`: declares `Genre: Turn-based RPG`, describes top-down overworld exploration, random encounters, Fight/Skill/Item/Run combat, Circuit Blade progression, zones, bosses, items, shops, and save nodes.
- `project.godot`: declares `Overworld.tscn` as the main scene, autoloads `GameManager`, `SaveManager`, `EncounterTable`, and `SfxManager`, and maps movement plus confirm/cancel/menu inputs.
- `scenes/world/Overworld.tscn`: contains the overworld scene, camera, Zenny `CharacterBody2D`, sprite, collision shape, and animation player.
- `scripts/world/zenny_controller.gd`: implements 16px tile movement, directional input, collision probing, step registration, and encounter triggering.
- `scripts/core/game_manager.gd`: defines `OVERWORLD`, `BATTLE`, `MENU`, `DIALOG`, `CUTSCENE`, and `LOADING` states, plus random encounter and battle enter/exit hooks.
- `scripts/core/encounter_table.gd`: defines weighted zone encounter tables and reads enemy definitions from JSON.
- `data/enemies.json`: contains enemy and boss stats, abilities, loot, EXP rewards, and zone IDs.

## Contrast With Wyrms Vs Worms

Wyrms vs Worms was the GS-D vertical slice for an arcade match-3 game. That proof centered on board/cascade style gameplay, worm/dragon arcade assets, animation-backed sequence work, and a specific Wyrms deployment-backfire cutscene contract through Abonulli.

Gridlands does not ask for the same proof. Its meaningful blockers are not match resolution, cascade feel, combo feedback, worm sprite animation, or cutscene timing. Its blockers are RPG-first:

- overworld-to-battle transition
- battle scene and turn-based combat loop
- Dragon Warrior-style action menu and status UI
- Circuit Blade EXP, levels, skills, and weapon forms
- zone, skill, item, and dialog data
- save/load persistence for RPG state
- tilesets, player sprites, battle enemy sprites, UI fonts/panels, synthwave audio

This proves generalization because the module now derives the Game Bible from project evidence and selects genre-appropriate milestone blockers. A Gridlands bible describes RPG systems and a first playable RPG loop; it does not reuse Wyrms vs Worms match-3 or cutscene acceptance criteria.

## First Playable In Gridlands Terms

The first playable should be a small RPG loop:

1. Start in one compact overworld zone with visible collision boundaries.
2. Move Zenny tile-by-tile with the existing movement inputs.
3. Trigger one weighted random encounter after walking.
4. Transition into a battle scene.
5. Resolve one turn-based fight with Fight, Skill, Item, and Run commands.
6. Award EXP to the Circuit Blade on victory.
7. Return to the overworld.
8. Save and reload the player's zone, position, step count, blade state, and milestone progress.

## Current Gap Analysis

- Existing: Godot 4.5 project, main overworld scene, player movement script, camera, animation player node, autoload managers, input map, save data shape, encounter table, Zone 1 enemy data, design docs, art style guide, and reference images.
- Incomplete: battle scene, battle scripts, menu/dialog/HUD scenes, companion/weapon progression scripts, real audio playback, Godot tests, and most planned data files.
- Blocking first playable: no battle loop, no RPG UI, no playable presentation assets under `assets/`, missing `skills.json`, `items.json`, `zones.json`, and `dialog.json`, and no test coverage for the core loop.

## IKBI Fixes Made During GS-E

- Added markdown/design-document discovery to game-studio inspection by treating `.md` files as inventory resources.
- Added an additive `genre` section to the Game Bible contract with primary genre, confidence, gameplay model, evidence, first-playable milestone, and milestone blockers.
- Added genre-aware RPG blocker derivation to the Game Bible gap analysis.
- Added a Gridlands-style CI fixture and test that runs inspect plus bible without depending on the real Gridlands repository.

No frozen-core contracts were changed.
