import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import {
  CONTRACT_VERSION,
  type AnimationPlayerIndicator,
  type GameBible,
  type GameBibleAssets,
  type GameBibleGap,
  type GameBibleGenreAnalysis,
  type GameBibleMilestoneBlocker,
  type GameBibleScene,
  type InputUsageIndicator,
  type SceneInventoryItem,
  type ScriptInventoryItem,
  type SignalIndicator,
  type StateMachineIndicator,
} from "./contract.js";
import { inspectGodotProject } from "./project-inspector.js";

interface SceneDetails {
  readonly rootNodeName?: string;
  readonly rootNodeType?: string;
  readonly nodeTypes: Readonly<Record<string, number>>;
  readonly scriptPaths: readonly string[];
  readonly animationPlayers: readonly string[];
}

interface ScriptDetails {
  readonly signals: readonly SignalIndicator[];
  readonly inputActions: readonly string[];
  readonly stateMachineEvidence: readonly string[];
  readonly todoLines: readonly string[];
  readonly passLines: readonly string[];
}

interface ProjectEvidence {
  readonly docs: ReadonlyMap<string, string>;
  readonly scripts: ReadonlyMap<string, string>;
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

async function readProjectFile(root: string, projectPath: string): Promise<string> {
  return readFile(resolve(root, projectPath), "utf-8").catch(() => "");
}

function parseSceneDetails(text: string): SceneDetails {
  const nodeTypes: Record<string, number> = {};
  const scripts: string[] = [];
  const animationPlayers: string[] = [];
  let rootNodeName: string | undefined;
  let rootNodeType: string | undefined;

  for (const match of text.matchAll(/^\[node[^\]]*\bname="([^"]+)"[^\]]*\btype="([^"]+)"/gm)) {
    const name = match[1] ?? "";
    const type = match[2] ?? "";
    if (rootNodeName === undefined) rootNodeName = name;
    if (rootNodeType === undefined) rootNodeType = type;
    nodeTypes[type] = (nodeTypes[type] ?? 0) + 1;
    if (type === "AnimationPlayer") animationPlayers.push(name);
  }

  for (const match of text.matchAll(/^\[ext_resource[^\]]*\btype="Script"[^\]]*\bpath="(res:\/\/[^"]+)"/gm)) {
    scripts.push(match[1] ?? "");
  }

  return {
    ...(rootNodeName !== undefined ? { rootNodeName } : {}),
    ...(rootNodeType !== undefined ? { rootNodeType } : {}),
    nodeTypes: Object.fromEntries(Object.entries(nodeTypes).sort(([a], [b]) => a.localeCompare(b))),
    scriptPaths: [...new Set(scripts)].sort(),
    animationPlayers: [...new Set(animationPlayers)].sort(),
  };
}

function parseScriptDetails(path: string, text: string): ScriptDetails {
  const signals: SignalIndicator[] = [];
  const inputActions = new Set<string>();
  const stateMachineEvidence: string[] = [];
  const todoLines: string[] = [];
  const passLines: string[] = [];

  for (const match of text.matchAll(/^\s*signal\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    signals.push({ source: path, name: match[1] ?? "", kind: "declared" });
  }
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.emit\(/g)) {
    signals.push({ source: path, name: match[1] ?? "", kind: "emitted" });
  }
  for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.connect\(/g)) {
    signals.push({ source: path, name: match[1] ?? "", kind: "connected" });
  }
  for (const match of text.matchAll(/Input\.is_action_(?:pressed|just_pressed|just_released)\("([^"]+)"\)/g)) {
    inputActions.add(match[1] ?? "");
  }

  const stateHints = [
    /\benum\s+[A-Za-z_][A-Za-z0-9_]*State\b/,
    /\bcurrent_state\b/,
    /\bstate_machine\b/,
    /\bmatch\s+[A-Za-z_][A-Za-z0-9_]*state\b/,
    /\bSTATE_[A-Z0-9_]+\b/,
  ];
  stateHints.forEach((hint) => {
    if (hint.test(text)) stateMachineEvidence.push(hint.source);
  });
  if (/\bstate\b/i.test(path)) stateMachineEvidence.push("state in filename");

  text.split(/\r?\n/).forEach((line, index) => {
    if (/\b(?:TODO|FIXME|XXX)\b/i.test(line)) todoLines.push(`${path}:${index + 1}: ${line.trim()}`);
    if (/^\s*pass\s*(?:#.*)?$/.test(line)) passLines.push(`${path}:${index + 1}: pass`);
  });

  return {
    signals,
    inputActions: [...inputActions].sort(),
    stateMachineEvidence: [...new Set(stateMachineEvidence)].sort(),
    todoLines,
    passLines,
  };
}

function buildAssets(paths: readonly string[]): GameBibleAssets {
  return {
    total: paths.length,
    byType: countBy(paths.map((path) => extname(path).toLowerCase() || "(none)")),
    paths,
  };
}

function buildInputUsage(scriptDetails: ReadonlyMap<string, ScriptDetails>): InputUsageIndicator[] {
  const byAction = new Map<string, string[]>();
  for (const [source, details] of scriptDetails) {
    details.inputActions.forEach((action) => {
      const sources = byAction.get(action) ?? [];
      sources.push(source);
      byAction.set(action, sources);
    });
  }
  return [...byAction.entries()]
    .map(([action, sources]) => ({ action, sources: [...new Set(sources)].sort() }))
    .sort((a, b) => a.action.localeCompare(b.action));
}

function buildStateMachines(scriptDetails: ReadonlyMap<string, ScriptDetails>): StateMachineIndicator[] {
  return [...scriptDetails.entries()]
    .filter(([, details]) => details.stateMachineEvidence.length > 0)
    .map(([source, details]) => ({ source, evidence: details.stateMachineEvidence }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

function includesAny(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function evidenceLine(path: string, text: string, terms: readonly string[]): string | undefined {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => includesAny(line, terms));
  if (index < 0) return undefined;
  return `${path}:${index + 1}: ${lines[index]?.trim() ?? ""}`;
}

function hasPath(paths: readonly string[], pattern: RegExp): boolean {
  return paths.some((path) => pattern.test(path));
}

function buildGenreAnalysis(
  projectName: string | undefined,
  scenes: readonly GameBibleScene[],
  scripts: readonly ScriptInventoryItem[],
  assets: GameBibleAssets,
  evidence: ProjectEvidence,
): GameBibleGenreAnalysis {
  const allText = [
    projectName ?? "",
    ...evidence.docs.values(),
    ...evidence.scripts.values(),
    ...assets.paths,
    ...scenes.map((scene) => `${scene.path} ${scene.rootNodeName ?? ""} ${scene.rootNodeType ?? ""} ${Object.keys(scene.nodeTypes).join(" ")}`),
    ...scripts.map((script) => `${script.path} ${script.className ?? ""} ${script.extendsName ?? ""}`),
  ].join("\n");

  const rpgTerms = ["turn-based", "Dragon Warrior", "RPG", "overworld", "random encounter", "enemy", "EXP", "battle"];
  const match3Terms = ["match-3", "swap", "cascade", "combo", "board", "score", "cutscene", "worm"];
  const rpgScore = rpgTerms.filter((term) => includesAny(allText, [term])).length
    + (hasPath(scripts.map((script) => script.path), /encounter|save_manager|game_manager/i) ? 2 : 0)
    + (hasPath(assets.paths, /data\/enemies\.json$/i) ? 2 : 0);
  const match3Score = match3Terms.filter((term) => includesAny(allText, [term])).length;
  const primaryGenre = rpgScore >= Math.max(5, match3Score + 2)
    ? "turn-based RPG"
    : match3Score >= 5
      ? "arcade match-3"
      : includesAny(allText, ["grid", "tile"])
        ? "grid-based game"
        : "unknown";

  const proofTerms = primaryGenre === "turn-based RPG" ? rpgTerms : primaryGenre === "arcade match-3" ? match3Terms : ["grid", "tile"];
  const proofEvidence = [
    ...[...evidence.docs.entries()].map(([path, text]) => evidenceLine(path, text, proofTerms)).filter((line): line is string => line !== undefined),
    ...[...evidence.scripts.entries()].map(([path, text]) => evidenceLine(path, text, proofTerms)).filter((line): line is string => line !== undefined),
    hasPath(assets.paths, /data\/enemies\.json$/i) ? "data/enemies.json: data-driven enemy database present" : undefined,
    hasPath(scripts.map((script) => script.path), /scripts\/core\/encounter_table\.gd$/i) ? "scripts/core/encounter_table.gd: weighted random encounter table present" : undefined,
  ].filter((line): line is string => line !== undefined);

  const gameplayModel = primaryGenre === "turn-based RPG"
    ? [
      "top-down overworld traversal",
      "tile/grid-aligned player movement",
      "random encounters while walking",
      "turn-based menu combat",
      "data-driven enemies and companion/weapon progression",
    ]
    : primaryGenre === "arcade match-3"
      ? [
        "board-based matching",
        "tile swaps and cascades",
        "score/combo arcade feedback",
        "sprite animation beats",
      ]
      : ["grid or tile-based play"];

  const scenePaths = scenes.map((scene) => scene.path);
  const scriptPaths = scripts.map((script) => script.path);
  const blockers: GameBibleMilestoneBlocker[] = [];

  if (primaryGenre === "turn-based RPG") {
    if (!hasPath(scenePaths, /battle/i) || !hasPath(scriptPaths, /battle|combat/i)) {
      blockers.push({
        area: "scene",
        message: "No battle scene or combat script inventory exists for the promised turn-based encounter loop.",
        evidence: ["Expected scenes/battle or scripts/battle from RPG design; inventory only shows current scene/script paths."],
      });
    }
    if (!hasPath(scenePaths, /ui|menu|dialog/i) || !hasPath(scriptPaths, /ui|menu|dialog/i)) {
      blockers.push({
        area: "scene",
        message: "No menu, dialog, HUD, or battle UI scene/script inventory exists for Dragon Warrior-style choices.",
        evidence: ["Expected action menu, status display, dialog boxes, and inventory/status screens."],
      });
    }
    if (!hasPath(assets.paths, /assets\/(sprites|tilesets|audio|fonts)\//i)) {
      blockers.push({
        area: "asset",
        message: "Playable RPG presentation assets are not present yet.",
        evidence: ["Expected player sprite sheet, tileset, battle enemy art, UI font/panels, and synthwave audio assets."],
      });
    }
    for (const requiredData of ["skills.json", "items.json", "zones.json", "dialog.json"]) {
      if (!assets.paths.some((path) => path.endsWith(`data/${requiredData}`))) {
        blockers.push({
          area: "data",
          message: `Missing ${requiredData}, needed for the planned data-driven RPG content model.`,
          evidence: ["GDD section 7.3 says enemy stats, skills, items, zone configs, and dialog should live in JSON."],
        });
      }
    }
    if (!hasPath(scriptPaths, /companion|blade|weapon|skill/i)) {
      blockers.push({
        area: "system",
        message: "Circuit Blade progression and weapon-form systems are not implemented as scripts.",
        evidence: ["Save data stores blade fields, but no companion/blade/skill system script is present."],
      });
    }
  }

  return {
    primaryGenre,
    confidence: proofEvidence.length >= 3 ? "high" : proofEvidence.length >= 1 ? "medium" : "low",
    gameplayModel,
    evidence: proofEvidence.slice(0, 12),
    firstPlayableMilestone: primaryGenre === "turn-based RPG"
      ? [
        "One small walkable overworld zone with collisions and encounter-safe tutorial space.",
        "One random encounter that transitions from overworld to a battle scene.",
        "One complete turn-based fight loop with Fight, Skill, Item, and Run outcomes.",
        "Circuit Blade level/EXP reward applied after victory.",
        "Save/load preserves zone, position, blade state, and first milestone progress.",
        "Minimal RPG UI: dialog, battle command menu, HP/MP/status, inventory/status surfaces.",
        "Placeholder or final sprites/tiles/audio wired through Godot resources without missing references.",
      ]
      : [
        "One complete core loop scene.",
        "A visible player objective, input path, win/lose or progress condition, and restart path.",
        "Assets and tests covering the core loop.",
      ],
    milestoneBlockers: blockers,
  };
}

function buildGaps(
  scenes: readonly GameBibleScene[],
  scripts: readonly ScriptInventoryItem[],
  tests: readonly string[],
  brokenReferences: readonly { readonly source: string; readonly referencedPath: string }[],
  scriptDetails: ReadonlyMap<string, ScriptDetails>,
  mainScene: string | undefined,
  autoloadPaths: readonly string[],
  genre: GameBibleGenreAnalysis,
): GameBibleGap[] {
  const gaps: GameBibleGap[] = [];
  if (mainScene === undefined) {
    gaps.push({ severity: "error", area: "project", message: "Project has no run/main_scene.", evidence: ["project.godot [application]"] });
  } else if (!scenes.some((scene) => `res://${scene.path}` === mainScene)) {
    gaps.push({ severity: "error", area: "project", message: "Configured main scene is missing from scene inventory.", evidence: [mainScene] });
  }
  for (const reference of brokenReferences) {
    gaps.push({
      severity: "error",
      area: "asset",
      message: "Scene references a missing resource.",
      evidence: [`${reference.source} -> ${reference.referencedPath}`],
    });
  }
  for (const autoloadPath of autoloadPaths) {
    if (!scripts.some((script) => `res://${script.path}` === autoloadPath)) {
      gaps.push({ severity: "error", area: "system", message: "Autoload script is missing.", evidence: [autoloadPath] });
    }
  }

  const classes = scripts.map((script) => script.className).filter((name): name is string => name !== undefined);
  for (const [className, count] of Object.entries(countBy(classes)).filter(([, count]) => count > 1)) {
    gaps.push({ severity: "warning", area: "script", message: "Duplicate GDScript class_name detected.", evidence: [`${className} appears ${count} times`] });
  }
  if (tests.length === 0) {
    gaps.push({ severity: "warning", area: "test", message: "No Godot test scripts detected.", evidence: ["No paths under test/ or tests/"] });
  }
  if (!scenes.some((scene) => scene.animationPlayers.length > 0) && scripts.some((script) => /anim/i.test(script.path))) {
    gaps.push({
      severity: "warning",
      area: "scene",
      message: "Animation-oriented scripts exist, but no AnimationPlayer nodes were detected in scenes.",
      evidence: scripts.filter((script) => /anim/i.test(script.path)).map((script) => script.path),
    });
  }

  for (const details of scriptDetails.values()) {
    if (details.todoLines.length > 0) {
      gaps.push({ severity: "info", area: "script", message: "Implementation TODO/FIXME markers remain.", evidence: details.todoLines.slice(0, 20) });
    }
    if (details.passLines.length > 0) {
      gaps.push({ severity: "info", area: "script", message: "Bare pass statements detected.", evidence: details.passLines.slice(0, 20) });
    }
  }
  for (const blocker of genre.milestoneBlockers) {
    gaps.push({
      severity: blocker.area === "asset" || blocker.area === "data" ? "warning" : "error",
      area: blocker.area,
      message: `First playable blocker: ${blocker.message}`,
      evidence: blocker.evidence,
    });
  }
  return gaps;
}

export async function generateGameBible(repoPath: string, now: () => Date = () => new Date()): Promise<GameBible> {
  const inspection = await inspectGodotProject(repoPath, now);
  const sceneDetails = new Map<string, SceneDetails>();
  const scriptDetails = new Map<string, ScriptDetails>();

  await Promise.all(inspection.scenes.map(async (scene) => {
    sceneDetails.set(scene.path, parseSceneDetails(await readProjectFile(inspection.repoPath, scene.path)));
  }));
  await Promise.all(inspection.scripts.map(async (script) => {
    scriptDetails.set(script.path, parseScriptDetails(script.path, await readProjectFile(inspection.repoPath, script.path)));
  }));

  const docs = new Map<string, string>();
  await Promise.all(inspection.resources.filter((path) => path.endsWith(".md")).map(async (path) => {
    docs.set(path, await readProjectFile(inspection.repoPath, path));
  }));
  const scriptTexts = new Map<string, string>();
  await Promise.all(inspection.scripts.map(async (script) => {
    scriptTexts.set(script.path, await readProjectFile(inspection.repoPath, script.path));
  }));

  const sceneInventory: GameBibleScene[] = inspection.scenes.map((scene: SceneInventoryItem) => {
    const details = sceneDetails.get(scene.path) ?? { nodeTypes: {}, scriptPaths: [], animationPlayers: [] };
    return {
      ...scene,
      ...(details.rootNodeName !== undefined ? { rootNodeName: details.rootNodeName } : {}),
      ...(details.rootNodeType !== undefined ? { rootNodeType: details.rootNodeType } : {}),
      nodeTypes: details.nodeTypes,
      scriptPaths: details.scriptPaths,
      animationPlayers: details.animationPlayers,
    };
  });

  const signals = [...scriptDetails.values()].flatMap((details) => details.signals)
    .sort((a, b) => `${a.source}:${a.name}:${a.kind}`.localeCompare(`${b.source}:${b.name}:${b.kind}`));
  const animationPlayers: AnimationPlayerIndicator[] = sceneInventory.flatMap((scene) => (
    scene.animationPlayers.map((nodeName) => ({ scene: scene.path, nodeName }))
  ));
  const assets = buildAssets(inspection.resources);
  const genre = buildGenreAnalysis(inspection.project.name, sceneInventory, inspection.scripts, assets, { docs, scripts: scriptTexts });

  return {
    module: "game-studio",
    contractVersion: CONTRACT_VERSION,
    generatedAt: now().toISOString(),
    repoPath: inspection.repoPath,
    project: inspection.project,
    genre,
    sceneInventory,
    scripts: inspection.scripts,
    systems: {
      autoloads: inspection.project.autoloads,
      stateMachines: buildStateMachines(scriptDetails),
      inputActions: inspection.project.inputMap,
      inputUsage: buildInputUsage(scriptDetails),
      signals,
      animationPlayers,
    },
    assets,
    tests: inspection.tests,
    gapAnalysis: buildGaps(
      sceneInventory,
      inspection.scripts,
      inspection.tests,
      inspection.brokenReferences,
      scriptDetails,
      inspection.project.mainScene,
      inspection.project.autoloads.map((autoload) => autoload.path),
      genre,
    ),
  };
}

function bullet(values: readonly string[]): string[] {
  return values.length === 0 ? ["- (none)"] : values.map((value) => `- ${value}`);
}

export function renderGameBibleMarkdown(bible: GameBible): string {
  const lines: string[] = [
    `# Game Bible: ${bible.project.name ?? "(unnamed Godot project)"}`,
    "",
    `- repo: ${bible.repoPath}`,
    `- generated_at: ${bible.generatedAt}`,
    `- main_scene: ${bible.project.mainScene ?? "(missing)"}`,
    `- godot_features: ${bible.project.features.join(", ") || "(none)"}`,
    "",
    "## Genre Analysis",
    "",
    `- primary_genre: ${bible.genre.primaryGenre}`,
    `- confidence: ${bible.genre.confidence}`,
    "",
    "### Gameplay Model",
    ...bullet(bible.genre.gameplayModel),
    "",
    "### Genre Evidence",
    ...bullet(bible.genre.evidence),
    "",
    "### First Playable Milestone",
    ...bullet(bible.genre.firstPlayableMilestone),
    "",
    "### Milestone Blockers",
    ...bullet(bible.genre.milestoneBlockers.map((blocker) => `${blocker.area}: ${blocker.message} (${blocker.evidence.join("; ")})`)),
    "",
    "## Scene Inventory",
  ];

  for (const scene of bible.sceneInventory) {
    lines.push(
      `- ${scene.path} (${scene.rootNodeType ?? "unknown"}): ${scene.nodeCount} nodes, ${scene.extResourceCount} external resources`,
      `  - scripts: ${scene.scriptPaths.join(", ") || "(none)"}`,
      `  - animation_players: ${scene.animationPlayers.join(", ") || "(none)"}`,
    );
  }

  lines.push(
    "",
    "## Systems Detected",
    "",
    "### Autoloads",
    ...bullet(bible.systems.autoloads.map((autoload) => `${autoload.name}: ${autoload.path}${autoload.singleton ? " singleton" : ""}`)),
    "",
    "### Input Actions",
    ...bullet(bible.systems.inputActions.map((action) => action.name)),
    "",
    "### Input Usage",
    ...bullet(bible.systems.inputUsage.map((usage) => `${usage.action}: ${usage.sources.join(", ")}`)),
    "",
    "### Signals",
    ...bullet(bible.systems.signals.map((signal) => `${signal.kind}: ${signal.name} (${signal.source})`)),
    "",
    "### State Machines",
    ...bullet(bible.systems.stateMachines.map((machine) => `${machine.source}: ${machine.evidence.join(", ")}`)),
    "",
    "### Animation Players",
    ...bullet(bible.systems.animationPlayers.map((animation) => `${animation.scene}: ${animation.nodeName}`)),
    "",
    "## Assets",
    ...bullet(Object.entries(bible.assets.byType).map(([type, count]) => `${type}: ${count}`)),
    "",
    "## Tests",
    ...bullet(bible.tests),
    "",
    "## Gap Analysis",
  );

  for (const gap of bible.gapAnalysis) {
    lines.push(`- ${gap.severity.toUpperCase()} [${gap.area}] ${gap.message}`);
    for (const evidence of gap.evidence.slice(0, 8)) lines.push(`  - ${evidence}`);
    if (gap.evidence.length > 8) lines.push(`  - ... ${gap.evidence.length - 8} more`);
  }
  if (bible.gapAnalysis.length === 0) lines.push("- (none)");
  return `${lines.join("\n")}\n`;
}
