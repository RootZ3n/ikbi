/**
 * ikbi project-index — the deterministic engine.
 *
 * No model calls, no network, no clock-derived data in the persisted shape (mtime is real
 * file metadata). Safe on large repos: a single bounded walk that skips skip-dirs + .gitignore'd
 * paths and never follows symlinks; files are read one at a time (no whole-repo buffering); a
 * maxFiles cap guards pathological trees. Persisted as JSON under <stateRoot>/index/<repoHash>/.
 *
 * Import resolution is regex-based and resolved against the KNOWN file set — boring and correct
 * for the common cases (relative paths, workspace-package names). It is not an AST and makes no
 * type/semantic claims.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";

import { config as coreConfig } from "../../core/config.js";
import { projectIndexConfig, type ProjectIndexConfig } from "./config.js";
import {
  PROJECT_INDEX_VERSION,
  type FileEntry,
  type GitProvenance,
  type ImportEdge,
  type Language,
  type PackageEntry,
  type PackageManager,
  type ProjectIndexApi,
  type ProjectIndexData,
  type QueryResultItem,
  type QuerySpec,
  type ReasonTag,
  type RefreshResult,
} from "./contract.js";

// ── git provenance (R-A) ─────────────────────────────────────────────────────────

/** A git-provenance reader: HEAD/branch/dirty for a repo root, or undefined when not a git root. */
export type GitProvenanceReader = (repoAbs: string) => GitProvenance | undefined;

/**
 * The default reader: shells `git` (deterministic given repo state, no model calls). Fully guarded —
 * any failure (no git binary, not a repo, timeout, output overflow) yields undefined or a partial
 * record. It only stamps provenance when `repoAbs` is the git TOP-LEVEL, so a tmp dir that merely
 * sits under some ancestor repo never leaks that ancestor's HEAD.
 */
export function readGitProvenanceReal(repoAbs: string): GitProvenance | undefined {
  const run = (args: readonly string[]): string =>
    execFileSync("git", ["-C", repoAbs, ...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 8_000_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (resolve(run(["rev-parse", "--show-toplevel"])) !== resolve(repoAbs)) return undefined; // repoAbs is not its OWN repo root
    const head = run(["rev-parse", "HEAD"]);
    if (head.length === 0) return undefined;
    let branch: string | undefined;
    try {
      const b = run(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (b.length > 0 && b !== "HEAD") branch = b;
    } catch {
      /* detached / unborn — leave branch undefined */
    }
    let dirty: boolean | undefined;
    let changedFiles: number | undefined;
    try {
      const porcelain = run(["status", "--porcelain"]);
      const lines = porcelain.length === 0 ? [] : porcelain.split("\n").filter((l) => l.length > 0);
      dirty = lines.length > 0;
      changedFiles = lines.length;
    } catch {
      /* status too large / slow — leave dirty unknown */
    }
    return {
      head,
      ...(branch !== undefined ? { branch } : {}),
      ...(dirty !== undefined ? { dirty, ...(changedFiles !== undefined ? { changedFiles } : {}) } : {}),
    };
  } catch {
    return undefined; // not a git repo (or git unavailable)
  }
}

// ── path helpers ───────────────────────────────────────────────────────────────

/** Absolute FS path → repo-relative POSIX path. */
function toRel(repoAbs: string, abs: string): string {
  return relative(repoAbs, abs).split(sep).join("/");
}

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const;

function detectLang(relPath: string): Language {
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts")) return "ts";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "js";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "md";
  return "other";
}

function isJsLike(lang: Language): boolean {
  return lang === "ts" || lang === "tsx" || lang === "js" || lang === "jsx";
}

/** Test-file detection by convention (name suffix or a `__tests__/` segment). */
export function isTestPath(relPath: string): boolean {
  if (/(^|\/)__tests__\//.test(relPath)) return true;
  const base = posix.basename(relPath);
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

/** Stem of a source basename (drop the final extension): "foo.ts" → "foo". */
function sourceStem(relPath: string): string {
  const base = posix.basename(relPath);
  return base.replace(/\.[^.]+$/, "");
}

/** Stem of a test basename (drop `.test`/`.spec` + ext): "foo.test.ts" → "foo". */
function testStem(relPath: string): string {
  const base = posix.basename(relPath);
  return base.replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "");
}

// ── .gitignore matching (pragmatic, deterministic subset) ───────────────────────

interface IgnoreRule {
  /** Repo-relative POSIX dir the rule is scoped to ("" = repo root). */
  readonly base: string;
  readonly re: RegExp;
  readonly negate: boolean;
  readonly dirOnly: boolean;
}

/** Translate a gitignore glob to a RegExp over the path relative to the rule's base dir. */
function globToRegExp(glob: string, anchored: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  const body = anchored ? `^${re}` : `(?:^|.*/)${re}`;
  // A match also covers everything under a matched directory.
  return new RegExp(`${body}(?:/.*)?$`);
}

/** Parse one .gitignore file's text into scoped rules. */
export function parseGitignore(baseDir: string, text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.length === 0 || line.startsWith("#")) continue;
    let pat = line;
    let negate = false;
    if (pat.startsWith("!")) {
      negate = true;
      pat = pat.slice(1);
    }
    let dirOnly = false;
    if (pat.endsWith("/")) {
      dirOnly = true;
      pat = pat.slice(0, -1);
    }
    let anchored = pat.startsWith("/");
    if (anchored) pat = pat.slice(1);
    if (pat.includes("/")) anchored = true; // a mid-pattern slash anchors to the base dir
    if (pat.length === 0) continue;
    rules.push({ base: baseDir, re: globToRegExp(pat, anchored), negate, dirOnly });
  }
  return rules;
}

/** Is `relPath` ignored by the accumulated rules? Last matching rule wins (git semantics). */
function isIgnored(relPath: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    let sub = relPath;
    if (rule.base !== "") {
      if (relPath !== rule.base && !relPath.startsWith(`${rule.base}/`)) continue;
      sub = relPath.slice(rule.base.length + 1);
    }
    if (rule.re.test(sub)) ignored = !rule.negate;
  }
  return ignored;
}

// ── the bounded walk ─────────────────────────────────────────────────────────────

interface RawFile {
  readonly rel: string;
  readonly abs: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Walk the repo deterministically, honoring skip-dirs + nested .gitignore; never follow symlinks. */
function walk(repoAbs: string, cfg: ProjectIndexConfig): { files: RawFile[]; truncated: boolean } {
  const skip = new Set(cfg.skipDirs);
  const files: RawFile[] = [];
  let truncated = false;

  const recur = (dirAbs: string, dirRel: string, inherited: readonly IgnoreRule[]): void => {
    if (truncated) return;
    let rules = inherited;
    const giPath = posix.join(dirRel === "" ? "." : dirRel, ".gitignore");
    const giAbs = dirRel === "" ? `${repoAbs}${sep}.gitignore` : `${dirAbs}${sep}.gitignore`;
    if (existsSync(giAbs)) {
      try {
        rules = [...inherited, ...parseGitignore(dirRel, readFileSync(giAbs, "utf8"))];
      } catch {
        /* unreadable .gitignore — ignore it, keep walking (fail-soft) */
      }
    }
    void giPath;

    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip (fail-soft)
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const e of entries) {
      if (truncated) return;
      if (e.isSymbolicLink()) continue; // never follow symlinks (loops / escapes)
      const childRel = dirRel === "" ? e.name : `${dirRel}/${e.name}`;
      const childAbs = `${dirAbs}${sep}${e.name}`;
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        if (isIgnored(childRel, true, rules)) continue;
        recur(childAbs, childRel, rules);
      } else if (e.isFile()) {
        if (isIgnored(childRel, false, rules)) continue;
        let st;
        try {
          st = statSync(childAbs);
        } catch {
          continue;
        }
        if (st.size > cfg.maxFileBytes) continue;
        files.push({ rel: childRel, abs: childAbs, size: st.size, mtimeMs: st.mtimeMs });
        if (files.length >= cfg.maxFiles) {
          truncated = true;
          return;
        }
      }
    }
  };

  recur(repoAbs, "", []);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, truncated };
}

// ── package detection ───────────────────────────────────────────────────────────

function detectManager(repoAbs: string, pkgRootRel: string): PackageManager {
  const dirs = pkgRootRel === "" ? [repoAbs] : [`${repoAbs}${sep}${pkgRootRel.split("/").join(sep)}`, repoAbs];
  for (const d of dirs) {
    if (existsSync(`${d}${sep}pnpm-lock.yaml`) || existsSync(`${d}${sep}pnpm-workspace.yaml`)) return "pnpm";
    if (existsSync(`${d}${sep}yarn.lock`)) return "yarn";
    if (existsSync(`${d}${sep}package-lock.json`)) return "npm";
  }
  return "unknown";
}

/** Minimal pnpm-workspace.yaml `packages:` list extraction (no full YAML parser). */
function parsePnpmWorkspaceMembers(text: string): string[] {
  const members: string[] = [];
  let inPackages = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
      if (m) members.push((m[1] as string).trim());
      else if (/^\S/.test(line)) inPackages = false; // a new top-level key ends the list
    }
  }
  return members;
}

interface RawPackage {
  readonly root: string;
  readonly name: string;
  readonly manager: PackageManager;
  readonly scripts: Record<string, string>;
  readonly main?: string;
  readonly module?: string;
  readonly members?: string[];
}

function readPackages(repoAbs: string, files: readonly RawFile[]): RawPackage[] {
  const pkgs: RawPackage[] = [];
  for (const f of files) {
    if (posix.basename(f.rel) !== "package.json") continue;
    const root = posix.dirname(f.rel) === "." ? "" : posix.dirname(f.rel);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(readFileSync(f.abs, "utf8")) as Record<string, unknown>;
    } catch {
      continue; // malformed package.json — skip (fail-soft)
    }
    const scriptsRaw = (json.scripts ?? {}) as Record<string, unknown>;
    const scripts: Record<string, string> = {};
    for (const k of Object.keys(scriptsRaw).sort()) {
      if (typeof scriptsRaw[k] === "string") scripts[k] = scriptsRaw[k] as string;
    }
    // workspace members: package.json `workspaces` (array | {packages}) or pnpm-workspace.yaml
    let members: string[] | undefined;
    const ws = json.workspaces;
    if (Array.isArray(ws)) members = ws.filter((x): x is string => typeof x === "string");
    else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
      members = ((ws as { packages: unknown[] }).packages).filter((x): x is string => typeof x === "string");
    }
    const pnpmWsAbs = `${root === "" ? repoAbs : `${repoAbs}${sep}${root.split("/").join(sep)}`}${sep}pnpm-workspace.yaml`;
    if (members === undefined && existsSync(pnpmWsAbs)) {
      try {
        members = parsePnpmWorkspaceMembers(readFileSync(pnpmWsAbs, "utf8"));
      } catch {
        /* ignore */
      }
    }
    pkgs.push({
      root,
      name: typeof json.name === "string" && json.name.length > 0 ? json.name : root === "" ? posix.basename(repoAbs) : root,
      manager: detectManager(repoAbs, root),
      scripts,
      ...(typeof json.main === "string" ? { main: json.main } : {}),
      ...(typeof json.module === "string" ? { module: json.module } : {}),
      ...(members !== undefined ? { members } : {}),
    });
  }
  pkgs.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  return pkgs;
}

/** The nearest enclosing package root for a file (longest matching root; "" matches all). */
function assignPackage(relPath: string, rootsDescByLen: readonly string[]): string | undefined {
  for (const root of rootsDescByLen) {
    if (root === "") return "";
    if (relPath === root || relPath.startsWith(`${root}/`)) return root;
  }
  return undefined;
}

// ── import extraction + resolution ───────────────────────────────────────────────

/** Extract module specifiers from JS/TS source via scoped regex (deduped). */
export function extractImportSpecifiers(content: string): string[] {
  const out = new Set<string>();
  const patterns: RegExp[] = [
    /\bimport\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.add(m[1] as string);
  }
  return [...out];
}

/** Resolve a target path (no extension assumed) against the known file set: try ext + /index. */
function resolveModuleFile(targetRel: string, fileSet: ReadonlySet<string>): string | undefined {
  if (fileSet.has(targetRel)) return targetRel;
  for (const ext of JS_EXTS) if (fileSet.has(targetRel + ext)) return targetRel + ext;
  for (const ext of JS_EXTS) if (fileSet.has(`${targetRel}/index${ext}`)) return `${targetRel}/index${ext}`;
  return undefined;
}

function packageEntryFile(pkg: RawPackage, fileSet: ReadonlySet<string>): string | undefined {
  const candidates = [
    pkg.main,
    pkg.module,
    "src/index.ts",
    "src/index.tsx",
    "src/index.js",
    "src/index.jsx",
    "index.ts",
    "index.tsx",
    "index.js",
    "index.jsx",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const c of candidates) {
    const target = pkg.root === "" ? posix.normalize(c) : posix.join(pkg.root, c);
    const r = resolveModuleFile(target.replace(/\.[cm]?[jt]sx?$/, ""), fileSet) ?? (fileSet.has(target) ? target : undefined);
    if (r) return r;
  }
  return undefined;
}

function resolveSpecifier(
  fromRel: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
  pkgByName: ReadonlyMap<string, { root: string; entry?: string }>,
): { kind: ImportEdge["kind"]; to?: string } {
  if (specifier.startsWith(".")) {
    const target = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
    const r = resolveModuleFile(target, fileSet);
    return r ? { kind: "relative", to: r } : { kind: "unresolved" };
  }
  if (specifier.startsWith("/")) return { kind: "unresolved" };
  const pkgName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] as string);
  const pkg = pkgByName.get(pkgName);
  if (pkg === undefined) return { kind: "external" };
  const subpath = specifier.slice(pkgName.length).replace(/^\//, "");
  if (subpath.length > 0) {
    const r = resolveModuleFile(posix.join(pkg.root, subpath), fileSet);
    return { kind: "package", ...(r !== undefined ? { to: r } : pkg.entry !== undefined ? { to: pkg.entry } : {}) };
  }
  return { kind: "package", ...(pkg.entry !== undefined ? { to: pkg.entry } : {}) };
}

// ── assembly ─────────────────────────────────────────────────────────────────────

function buildFileEntry(raw: RawFile, pkgRootsDescByLen: readonly string[]): { entry: FileEntry; content: string | null } {
  const buf = readFileSync(raw.abs);
  const hash = createHash("sha256").update(buf).digest("hex");
  const lang = detectLang(raw.rel);
  const pkg = assignPackage(raw.rel, pkgRootsDescByLen);
  const entry: FileEntry = {
    path: raw.rel,
    lang,
    size: raw.size,
    mtimeMs: raw.mtimeMs,
    hash,
    isTest: isTestPath(raw.rel),
    ...(pkg !== undefined ? { package: pkg } : {}),
  };
  const content = isJsLike(lang) ? buf.toString("utf8") : null;
  return { entry, content };
}

function edgesForFile(
  fromRel: string,
  content: string,
  cfg: ProjectIndexConfig,
  fileSet: ReadonlySet<string>,
  pkgByName: ReadonlyMap<string, { root: string; entry?: string }>,
): ImportEdge[] {
  const text = content.length > cfg.maxParseBytes ? content.slice(0, cfg.maxParseBytes) : content;
  const edges: ImportEdge[] = [];
  for (const specifier of extractImportSpecifiers(text)) {
    const r = resolveSpecifier(fromRel, specifier, fileSet, pkgByName);
    edges.push({ from: fromRel, specifier, kind: r.kind, ...(r.to !== undefined ? { to: r.to } : {}) });
  }
  return edges;
}

/** source file → colocated tests (same package, matching stem). Deterministic, sorted. */
function buildFileToTests(files: readonly FileEntry[]): Record<string, string[]> {
  const tests = files.filter((f) => f.isTest);
  const map: Record<string, string[]> = {};
  for (const src of files) {
    if (src.isTest) continue;
    const stem = sourceStem(src.path);
    const matched = tests
      .filter((t) => t.package === src.package && testStem(t.path) === stem)
      .map((t) => t.path)
      .sort();
    if (matched.length > 0) map[src.path] = matched;
  }
  const sorted: Record<string, string[]> = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k] as string[];
  return sorted;
}

function sortEdges(edges: ImportEdge[]): ImportEdge[] {
  return edges.sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.specifier !== b.specifier) return a.specifier < b.specifier ? -1 : 1;
    return (a.to ?? "") < (b.to ?? "") ? -1 : (a.to ?? "") > (b.to ?? "") ? 1 : 0;
  });
}

function finalizePackages(raws: readonly RawPackage[], fileSet: ReadonlySet<string>): PackageEntry[] {
  return raws.map((p) => {
    const entry = packageEntryFile(p, fileSet);
    const cmd = (script: string, run: boolean): string => `${p.manager === "unknown" ? "npm" : p.manager} ${run ? "run " : ""}${script}`;
    return {
      root: p.root,
      name: p.name,
      manager: p.manager,
      scripts: p.scripts,
      ...(p.scripts.test !== undefined ? { testCommand: cmd("test", false) } : {}),
      ...(p.scripts.build !== undefined ? { buildCommand: cmd("build", true) } : {}),
      ...(p.members !== undefined ? { members: p.members } : {}),
      ...(entry !== undefined ? { entry } : {}),
    } satisfies PackageEntry;
  });
}

// ── persistence ─────────────────────────────────────────────────────────────────

function repoHashOf(repoPath: string): string {
  return createHash("sha256").update(resolve(repoPath)).digest("hex").slice(0, 16);
}

// ── the factory ─────────────────────────────────────────────────────────────────

export interface ProjectIndexDeps {
  /** Persistence root. Default `<coreConfig.stateRoot>`; index lives under `<stateRoot>/index/`. */
  readonly stateRoot?: string;
  readonly config?: ProjectIndexConfig;
  /** Git-provenance reader (R-A). Default: the real `git`-shelling reader. Tests inject a stub. */
  readonly git?: GitProvenanceReader;
  /** Clock for the `builtAtMs` racy-clean reference. Default `Date.now`. */
  readonly now?: () => number;
}

export function createProjectIndex(deps: ProjectIndexDeps = {}): ProjectIndexApi {
  const stateRoot = deps.stateRoot ?? coreConfig.stateRoot;
  const cfg = deps.config ?? projectIndexConfig;
  const gitReader = deps.git ?? readGitProvenanceReal;
  const nowMs = deps.now ?? Date.now;

  /** Attach git provenance + the racy-clean reference stamp. */
  const stampMeta = (data: ProjectIndexData, git: GitProvenance | undefined): ProjectIndexData => ({
    ...data,
    ...(git !== undefined ? { git } : {}),
    builtAtMs: nowMs(),
  });

  const indexDirFor = (repoPath: string): string => `${stateRoot}${sep}index${sep}${repoHashOf(repoPath)}`;
  const indexFileFor = (repoPath: string): string => `${indexDirFor(repoPath)}${sep}index.json`;

  function persist(repoPath: string, data: ProjectIndexData): void {
    const dir = indexDirFor(repoPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(indexFileFor(repoPath), JSON.stringify(data, null, 2));
  }

  async function load(repoPath: string): Promise<ProjectIndexData | undefined> {
    const file = indexFileFor(repoPath);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as ProjectIndexData;
    } catch {
      return undefined;
    }
  }

  function assemble(repoAbs: string, raws: readonly RawFile[], truncated: boolean): ProjectIndexData {
    const rawPkgs = readPackages(repoAbs, raws);
    const pkgRootsDescByLen = rawPkgs.map((p) => p.root).sort((a, b) => b.length - a.length);
    const fileSet = new Set(raws.map((r) => r.rel));

    const files: FileEntry[] = [];
    const contentByRel = new Map<string, string>();
    for (const raw of raws) {
      const { entry, content } = buildFileEntry(raw, pkgRootsDescByLen);
      files.push(entry);
      if (content !== null) contentByRel.set(raw.rel, content);
    }
    const packages = finalizePackages(rawPkgs, fileSet);
    const pkgByName = new Map(packages.map((p) => [p.name, { root: p.root, ...(p.entry !== undefined ? { entry: p.entry } : {}) }]));

    const imports: ImportEdge[] = [];
    for (const f of files) {
      const content = contentByRel.get(f.path);
      if (content !== undefined) imports.push(...edgesForFile(f.path, content, cfg, fileSet, pkgByName));
    }

    return {
      version: PROJECT_INDEX_VERSION,
      repoPath: repoAbs,
      repoHash: repoHashOf(repoAbs),
      files,
      packages,
      imports: sortEdges(imports),
      fileToTests: buildFileToTests(files),
      truncated,
    };
  }

  async function build(repoPath: string): Promise<ProjectIndexData> {
    const repoAbs = resolve(repoPath);
    const { files: raws, truncated } = walk(repoAbs, cfg);
    const data = stampMeta(assemble(repoAbs, raws, truncated), gitReader(repoAbs));
    persist(repoPath, data);
    return data;
  }

  async function refresh(repoPath: string): Promise<RefreshResult> {
    const repoAbs = resolve(repoPath);
    const old = await load(repoPath);
    if (old === undefined) {
      const data = await build(repoPath);
      const all = data.files.map((f) => f.path);
      return { added: all, reparsed: all, removed: [], unchanged: 0, data, rebuilt: false, headChanged: false };
    }

    // R-A: a HEAD change is the one case the cheap incremental path cannot safely reconcile
    // (renamed targets, deleted files, mass content moves, stale cross-file edges). Take the
    // SAFE-AND-SIMPLE option: a full rebuild. Bounded — this only triggers on an actual HEAD
    // change, never on ordinary working-tree edits (those go through the incremental probe).
    const git = gitReader(repoAbs);
    const headChanged = (old.git?.head ?? undefined) !== (git?.head ?? undefined);
    if (headChanged) {
      const data = await build(repoPath);
      const newPaths = new Set(data.files.map((f) => f.path));
      const oldPaths = old.files.map((f) => f.path);
      return {
        added: data.files.map((f) => f.path).filter((p) => !oldPaths.includes(p)).sort(),
        reparsed: data.files.map((f) => f.path),
        removed: oldPaths.filter((p) => !newPaths.has(p)).sort(),
        unchanged: 0,
        data,
        rebuilt: true,
        headChanged: true,
      };
    }

    const { files: raws, truncated } = walk(repoAbs, cfg);
    const oldByPath = new Map(old.files.map((f) => [f.path, f]));
    const currentPaths = new Set(raws.map((r) => r.rel));
    const rawPkgs = readPackages(repoAbs, raws);
    const pkgRootsDescByLen = rawPkgs.map((p) => p.root).sort((a, b) => b.length - a.length);
    const fileSet = currentPaths;
    const packages = finalizePackages(rawPkgs, fileSet);
    const pkgByName = new Map(packages.map((p) => [p.name, { root: p.root, ...(p.entry !== undefined ? { entry: p.entry } : {}) }]));

    // R-B: racy-clean reference. A file whose mtime sits within the racy window of the LAST index
    // write could have been edited in-place (same size, same mtime tick), so we re-hash it even
    // when the cheap probe says "unchanged". Files modified well before the last index are trusted
    // on size+mtime alone — so this is NOT a full re-hash every time, only for recently-touched files.
    const racyFloor = (old.builtAtMs ?? 0) - cfg.racyWindowMs;

    const added: string[] = [];
    const reparsed: string[] = [];
    let unchanged = 0;

    const files: FileEntry[] = [];
    const newEdges: ImportEdge[] = [];
    // Keep edges from files that survive unchanged; re-resolve only changed/added files.
    const reusableEdges = old.imports.filter((e) => currentPaths.has(e.from));

    for (const raw of raws) {
      const prev = oldByPath.get(raw.rel);
      const probeUnchanged = prev !== undefined && prev.size === raw.size && prev.mtimeMs === raw.mtimeMs;
      if (probeUnchanged) {
        const racy = raw.mtimeMs >= racyFloor;
        if (!racy) {
          // confidently unchanged → reuse stored entry + edges (refresh pkg assignment only).
          const pkg = assignPackage(raw.rel, pkgRootsDescByLen);
          files.push({ ...prev, ...(pkg !== undefined ? { package: pkg } : {}) });
          unchanged += 1;
          continue;
        }
        // racy → re-hash to be sure (catches same-size/same-mtime in-place edits).
        const { entry, content } = buildFileEntry(raw, pkgRootsDescByLen);
        if (entry.hash === prev.hash) {
          files.push({ ...prev, ...(entry.package !== undefined ? { package: entry.package } : {}) });
          unchanged += 1;
        } else {
          files.push(entry);
          reparsed.push(raw.rel);
          if (content !== null) newEdges.push(...edgesForFile(raw.rel, content, cfg, fileSet, pkgByName));
        }
        continue;
      }
      // probe says maybe-changed (size/mtime differ) or new → read + hash to confirm.
      const { entry, content } = buildFileEntry(raw, pkgRootsDescByLen);
      const contentChanged = prev === undefined || prev.hash !== entry.hash;
      files.push(entry);
      if (prev === undefined) added.push(raw.rel);
      if (contentChanged) {
        reparsed.push(raw.rel);
        if (content !== null) newEdges.push(...edgesForFile(raw.rel, content, cfg, fileSet, pkgByName));
      } else {
        // mtime moved but content identical → not a reparse; reuse stored edges for this file.
        unchanged += 1;
      }
    }

    const removed = old.files.map((f) => f.path).filter((p) => !currentPaths.has(p));
    const reparsedSet = new Set(reparsed);
    const keptEdges = reusableEdges.filter((e) => !reparsedSet.has(e.from));
    const imports = sortEdges([...keptEdges, ...newEdges]);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const data = stampMeta(
      {
        version: PROJECT_INDEX_VERSION,
        repoPath: repoAbs,
        repoHash: repoHashOf(repoAbs),
        files,
        packages,
        imports,
        fileToTests: buildFileToTests(files),
        truncated,
      },
      git,
    );
    persist(repoPath, data);
    return { added: added.sort(), reparsed: reparsed.sort(), removed: removed.sort(), unchanged, data, rebuilt: false, headChanged: false };
  }

  async function query(repoPath: string, spec: QuerySpec): Promise<readonly QueryResultItem[]> {
    const data = await load(repoPath);
    if (data === undefined) return [];
    const repoAbs = data.repoPath;
    const want = spec.want ?? "related";
    const limit = spec.limit ?? 50;

    // normalize seeds → repo-relative POSIX, keep only known files
    const fileSet = new Set(data.files.map((f) => f.path));
    const seeds = [
      ...new Set(
        spec.seeds.map((s) => {
          const rel = s.includes(sep) || s.startsWith("/") ? toRel(repoAbs, resolve(repoAbs, s)) : s.replace(/^\.\//, "");
          return rel;
        }),
      ),
    ].filter((s) => fileSet.has(s));
    if (seeds.length === 0) return [];
    const seedSet = new Set(seeds);

    const importersOf = new Map<string, string[]>();
    const importsOf = new Map<string, string[]>();
    for (const e of data.imports) {
      if (e.to === undefined) continue;
      (importsOf.get(e.from) ?? importsOf.set(e.from, []).get(e.from)!).push(e.to);
      (importersOf.get(e.to) ?? importersOf.set(e.to, []).get(e.to)!).push(e.from);
    }
    const pkgOf = new Map(data.files.map((f) => [f.path, f.package]));

    const WEIGHT: Record<ReasonTag, number> = {
      "imported-by-seed": 5,
      "imports-seed": 4,
      "test-of-seed": 4,
      "name-match": 2,
      "same-package": 1,
      seed: 0,
    };
    const acc = new Map<string, Set<ReasonTag>>();
    const add = (path: string, tag: ReasonTag): void => {
      if (seedSet.has(path)) return; // never return a seed as its own result
      const set = acc.get(path) ?? acc.set(path, new Set()).get(path)!;
      set.add(tag);
    };

    const doCallers = want === "callers" || want === "related";
    const doImports = want === "imports" || want === "related";
    const doTests = want === "tests" || want === "related";

    for (const seed of seeds) {
      if (doCallers) for (const f of importersOf.get(seed) ?? []) add(f, "imported-by-seed");
      if (doImports) for (const t of importsOf.get(seed) ?? []) add(t, "imports-seed");
      if (doTests) for (const t of data.fileToTests[seed] ?? []) add(t, "test-of-seed");
      if (want === "related") {
        const seedPkg = pkgOf.get(seed);
        const stem = sourceStem(seed);
        for (const f of data.files) {
          if (f.path === seed) continue;
          if (seedPkg !== undefined && f.package === seedPkg) add(f.path, "same-package");
          if (sourceStem(f.path) === stem) add(f.path, "name-match");
        }
      }
    }

    const results: QueryResultItem[] = [...acc.entries()].map(([path, reasons]) => {
      const tags = [...reasons].sort();
      return { path, reasons: tags, score: tags.reduce((s, r) => s + WEIGHT[r], 0) };
    });
    results.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return results.slice(0, limit);
  }

  return { build, refresh, load, query };
}

/** The process-wide project-index (persists under the core state root). */
export const projectIndex: ProjectIndexApi = createProjectIndex();
