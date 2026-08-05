import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import {
  CONTRACT_VERSION,
  type AnimationPlayerIndicator,
  type GameBible,
  type GameBibleAssets,
  type GameBibleGap,
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

function buildGaps(
  scenes: readonly GameBibleScene[],
  scripts: readonly ScriptInventoryItem[],
  tests: readonly string[],
  brokenReferences: readonly { readonly source: string; readonly referencedPath: string }[],
  scriptDetails: ReadonlyMap<string, ScriptDetails>,
  mainScene: string | undefined,
  autoloadPaths: readonly string[],
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

  return {
    module: "game-studio",
    contractVersion: CONTRACT_VERSION,
    generatedAt: now().toISOString(),
    repoPath: inspection.repoPath,
    project: inspection.project,
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
    assets: buildAssets(inspection.resources),
    tests: inspection.tests,
    gapAnalysis: buildGaps(
      sceneInventory,
      inspection.scripts,
      inspection.tests,
      inspection.brokenReferences,
      scriptDetails,
      inspection.project.mainScene,
      inspection.project.autoloads.map((autoload) => autoload.path),
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
