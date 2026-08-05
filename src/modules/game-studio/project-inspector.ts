import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  CONTRACT_VERSION,
  type BrokenReferenceIndicator,
  type ExportPresetInventoryItem,
  type GodotAutoload,
  type GodotInputAction,
  type GodotProjectInspection,
  type GodotProjectSummary,
  type GodotScalar,
  type GodotValue,
  type SceneInventoryItem,
  type ScriptInventoryItem,
} from "./contract.js";

interface ParsedCfg {
  readonly root: Readonly<Record<string, GodotValue>>;
  readonly sections: ReadonlyMap<string, Readonly<Record<string, GodotValue>>>;
}

const SKIP_DIRS = new Set([".git", ".godot", ".venv", "node_modules", "dist", "build"]);
const RESOURCE_EXTENSIONS = new Set([
  ".cfg",
  ".import",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".tres",
  ".res",
  ".ogg",
  ".wav",
  ".mp3",
  ".ttf",
  ".otf",
]);

function rel(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function extension(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx).toLowerCase() : "";
}

function stripQuotes(raw: string): string {
  const v = raw.trim();
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

function parseValue(raw: string): GodotValue {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  const packed = /^PackedStringArray\((.*)\)$/.exec(v);
  if (packed !== null) {
    const inner = packed[1] ?? "";
    const matches = [...inner.matchAll(/"([^"]*)"/g)];
    return matches.map((m) => m[1] ?? "");
  }
  return stripQuotes(v);
}

function parseCfg(text: string): ParsedCfg {
  const root: Record<string, GodotValue> = {};
  const mutableSections = new Map<string, Record<string, GodotValue>>();
  let current: Record<string, GodotValue> = root;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith(";")) continue;
    const section = /^\[([^\]]+)\]$/.exec(trimmed);
    if (section !== null) {
      const name = section[1] ?? "";
      const next: Record<string, GodotValue> = {};
      mutableSections.set(name, next);
      current = next;
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    current[trimmed.slice(0, eq).trim()] = parseValue(trimmed.slice(eq + 1));
  }

  return { root, sections: mutableSections };
}

function stringValue(v: GodotValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function numberValue(v: GodotValue | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function boolValue(v: GodotValue | undefined): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function scalarEntries(section: Readonly<Record<string, GodotValue>> | undefined): Record<string, GodotScalar> {
  const out: Record<string, GodotScalar> = {};
  if (section === undefined) return out;
  for (const [key, value] of Object.entries(section)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

function parseAutoloads(section: Readonly<Record<string, GodotValue>> | undefined): GodotAutoload[] {
  if (section === undefined) return [];
  return Object.entries(section)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, raw]) => {
      const singleton = raw.startsWith("*");
      return { name, path: singleton ? raw.slice(1) : raw, singleton };
    });
}

function parseInputMap(section: Readonly<Record<string, GodotValue>> | undefined): GodotInputAction[] {
  if (section === undefined) return [];
  return Object.entries(section).map(([name, value]) => ({ name, value }));
}

async function walk(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function inspectScene(root: string, file: string): Promise<SceneInventoryItem> {
  const text = await readFile(file, "utf-8");
  const referencedPaths = [...new Set([...text.matchAll(/path="(res:\/\/[^"]+)"/g)].map((m) => m[1] ?? ""))].sort();
  return {
    path: rel(root, file),
    nodeCount: (text.match(/^\[node\b/gm) ?? []).length,
    extResourceCount: (text.match(/^\[ext_resource\b/gm) ?? []).length,
    referencedPaths,
  };
}

async function inspectScript(root: string, file: string): Promise<ScriptInventoryItem> {
  const text = await readFile(file, "utf-8");
  const classMatch = /^class_name\s+([A-Za-z_][A-Za-z0-9_]*)/m.exec(text);
  const extendsMatch = /^extends\s+([A-Za-z_][A-Za-z0-9_./"]*)/m.exec(text);
  return {
    path: rel(root, file),
    lineCount: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    ...(classMatch?.[1] !== undefined ? { className: classMatch[1] } : {}),
    ...(extendsMatch?.[1] !== undefined ? { extendsName: stripQuotes(extendsMatch[1]) } : {}),
  };
}

async function findBrokenReferences(root: string, scenes: readonly SceneInventoryItem[]): Promise<BrokenReferenceIndicator[]> {
  const indicators: BrokenReferenceIndicator[] = [];
  for (const scene of scenes) {
    for (const referencedPath of scene.referencedPaths) {
      const exists = await stat(resolve(root, referencedPath.slice("res://".length))).then(() => true, () => false);
      if (!exists) indicators.push({ source: scene.path, referencedPath, reason: "missing-resource" });
    }
  }
  return indicators;
}

function parseExportPresets(text: string): ExportPresetInventoryItem[] {
  const parsed = parseCfg(text);
  const presets: ExportPresetInventoryItem[] = [];
  for (const [section, values] of parsed.sections) {
    const match = /^preset\.(\d+)$/.exec(section);
    if (match === null) continue;
    const index = Number(match[1]);
    const name = stringValue(values.name);
    const platform = stringValue(values.platform);
    const runnable = boolValue(values.runnable);
    const exportPath = stringValue(values.export_path);
    presets.push({
      index,
      ...(name !== undefined ? { name } : {}),
      ...(platform !== undefined ? { platform } : {}),
      ...(runnable !== undefined ? { runnable } : {}),
      ...(exportPath !== undefined ? { exportPath } : {}),
    });
  }
  return presets.sort((a, b) => a.index - b.index);
}

async function readOptionalText(path: string): Promise<string | undefined> {
  return readFile(path, "utf-8").then((text) => text, () => undefined);
}

export async function inspectGodotProject(repoPath: string, now: () => Date = () => new Date()): Promise<GodotProjectInspection> {
  const root = isAbsolute(repoPath) ? repoPath : resolve(process.cwd(), repoPath);
  const projectPath = join(root, "project.godot");
  const projectText = await readOptionalText(projectPath);
  const projectParsed = projectText !== undefined ? parseCfg(projectText) : { root: {}, sections: new Map<string, Record<string, GodotValue>>() };
  const application = projectParsed.sections.get("application");
  const configVersion = numberValue(projectParsed.root.config_version);
  const name = stringValue(application?.["config/name"]);
  const mainScene = stringValue(application?.["run/main_scene"]);
  const rawFeatures = application?.["config/features"];
  const files = await walk(root).catch(() => []);

  const scenes = (await Promise.all(files.filter((f) => f.endsWith(".tscn")).map((f) => inspectScene(root, f)))).sort((a, b) => a.path.localeCompare(b.path));
  const scripts = (await Promise.all(files.filter((f) => f.endsWith(".gd")).map((f) => inspectScript(root, f)))).sort((a, b) => a.path.localeCompare(b.path));
  const resources = files
    .filter((f) => {
      const r = rel(root, f);
      if (r === "project.godot" || r === "export_presets.cfg" || r.endsWith(".tscn") || r.endsWith(".gd")) return false;
      return RESOURCE_EXTENSIONS.has(extension(r));
    })
    .map((f) => rel(root, f))
    .sort();

  const exportText = await readOptionalText(join(root, "export_presets.cfg"));
  const project: GodotProjectSummary = {
    path: "project.godot",
    exists: projectText !== undefined,
    ...(configVersion !== undefined ? { configVersion } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(mainScene !== undefined ? { mainScene } : {}),
    features: Array.isArray(rawFeatures) ? rawFeatures : [],
    autoloads: parseAutoloads(projectParsed.sections.get("autoload")),
    inputMap: parseInputMap(projectParsed.sections.get("input")),
    display: scalarEntries(projectParsed.sections.get("display")),
  };

  return {
    module: "game-studio",
    contractVersion: CONTRACT_VERSION,
    inspectedAt: now().toISOString(),
    repoPath: root,
    project,
    scenes,
    scripts,
    resources,
    exportPresets: exportText !== undefined ? parseExportPresets(exportText) : [],
    tests: scripts.filter((s) => s.path.includes("/test") || s.path.startsWith("test") || s.path.startsWith("tests/")).map((s) => s.path),
    brokenReferences: await findBrokenReferences(root, scenes),
  };
}
