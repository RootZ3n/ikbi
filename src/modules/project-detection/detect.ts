/**
 * ikbi project detection — infer a repo's language(s), framework(s), test runner(s),
 * and build tool from its on-disk marker files, with NO network and NO process spawn.
 *
 * The detector is PURE over an injectable filesystem PORT (`DetectPorts`): it reads marker
 * files (package.json, pyproject.toml, go.mod, …) and dependency lists, and returns a
 * `ProjectDetection`. `liveDetectPorts()` wires the real synchronous filesystem; tests
 * inject an in-memory map so the whole detector is unit-testable with no real I/O.
 *
 * Best-effort by design: an unreadable/ malformed marker is skipped (fail-soft), never thrown.
 * The result is additive — multiple languages/frameworks can be reported for a polyglot repo.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The filesystem surface the detector reads. Synchronous + injectable for tests. */
export interface DetectPorts {
  /** True iff a file or directory exists at `path`. */
  exists(path: string): boolean;
  /** Read a UTF-8 file, or `undefined` if it is missing/unreadable (never throws). */
  readText(path: string): string | undefined;
}

/** What detection found about a repository. All fields are best-effort. */
export interface ProjectDetection {
  /** Languages detected, most-specific first (e.g. ["TypeScript", "Python"]). */
  readonly languages: readonly string[];
  /** The primary language (first of `languages`), or undefined when nothing matched. */
  readonly primaryLanguage: string | undefined;
  /** Application/web frameworks detected (e.g. ["Next.js", "React"]). */
  readonly frameworks: readonly string[];
  /** Test runners detected (e.g. ["vitest"], ["pytest"], ["go test"]). */
  readonly testRunners: readonly string[];
  /** Build tools detected (e.g. ["pnpm"], ["cargo"]). */
  readonly buildTools: readonly string[];
  /** The resolved package manager for a Node repo (pnpm/yarn/npm/bun), or undefined. */
  readonly packageManager: string | undefined;
  /** True iff the directory is a git working tree (`.git` present). */
  readonly hasGit: boolean;
  /** True iff the repo ships container config (Dockerfile / docker-compose). */
  readonly hasDocker: boolean;
  /** The indicator files that drove the detection (for transparency/`ikbi detect`). */
  readonly markers: readonly string[];
}

/** A one-line, human-readable summary of a detection (for banners / doctor). */
export function summarize(d: ProjectDetection): string {
  if (d.primaryLanguage === undefined) return "unrecognized project (no language markers found)";
  const parts: string[] = [d.languages.join(" + ")];
  if (d.frameworks.length > 0) parts.push(d.frameworks.join(", "));
  const tooling: string[] = [];
  if (d.packageManager !== undefined) tooling.push(d.packageManager);
  else if (d.buildTools.length > 0) tooling.push(d.buildTools[0]!);
  if (d.testRunners.length > 0) tooling.push(`tests: ${d.testRunners.join("/")}`);
  if (tooling.length > 0) parts.push(`(${tooling.join(", ")})`);
  return parts.join(" — ");
}

/** Parse a package.json's merged dependency names (deps + devDeps + peerDeps). */
function packageDeps(pkg: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = pkg[key];
    if (block !== null && typeof block === "object") {
      for (const name of Object.keys(block as Record<string, unknown>)) names.add(name);
    }
  }
  return names;
}

/** Safe JSON parse → object, or undefined on missing/malformed input. */
function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect the project at `root` using the supplied ports. Pure: it performs no real I/O of
 * its own, never throws, and returns the same result for the same filesystem snapshot.
 */
export function detectProject(root: string, ports: DetectPorts): ProjectDetection {
  const has = (rel: string): boolean => ports.exists(join(root, rel));
  const read = (rel: string): string | undefined => ports.readText(join(root, rel));

  const languages: string[] = [];
  const frameworks: string[] = [];
  const testRunners: string[] = [];
  const buildTools: string[] = [];
  const markers: string[] = [];
  const mark = (rel: string): void => { if (!markers.includes(rel)) markers.push(rel); };
  const add = (arr: string[], v: string): void => { if (!arr.includes(v)) arr.push(v); };

  // --- Node.js / TypeScript / JavaScript -----------------------------------
  const pkg = parseJson(read("package.json"));
  let packageManager: string | undefined;
  if (pkg !== undefined) {
    mark("package.json");
    const deps = packageDeps(pkg);
    const isTs = has("tsconfig.json") || deps.has("typescript");
    if (has("tsconfig.json")) mark("tsconfig.json");
    add(languages, isTs ? "TypeScript" : "JavaScript");

    // package manager (lockfile, then a `packageManager` field hint)
    if (has("pnpm-lock.yaml")) { packageManager = "pnpm"; mark("pnpm-lock.yaml"); }
    else if (has("bun.lockb")) { packageManager = "bun"; mark("bun.lockb"); }
    else if (has("yarn.lock")) { packageManager = "yarn"; mark("yarn.lock"); }
    else if (has("package-lock.json")) { packageManager = "npm"; mark("package-lock.json"); }
    else {
      const pmField = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
      packageManager = pmField !== undefined && pmField.length > 0 ? pmField : "npm";
    }
    if (packageManager !== undefined) add(buildTools, packageManager);

    // frameworks from deps
    const fw: Array<[string, string]> = [
      ["next", "Next.js"], ["nuxt", "Nuxt"], ["@angular/core", "Angular"], ["svelte", "Svelte"],
      ["react", "React"], ["vue", "Vue"], ["@nestjs/core", "NestJS"], ["fastify", "Fastify"],
      ["express", "Express"], ["koa", "Koa"], ["@remix-run/react", "Remix"], ["astro", "Astro"],
      ["solid-js", "SolidJS"], ["electron", "Electron"], ["react-native", "React Native"],
    ];
    for (const [dep, name] of fw) if (deps.has(dep)) add(frameworks, name);

    // test runners from deps + config files
    if (deps.has("vitest") || has("vitest.config.ts") || has("vitest.config.js")) add(testRunners, "vitest");
    if (deps.has("jest") || has("jest.config.js") || has("jest.config.ts")) add(testRunners, "jest");
    if (deps.has("mocha")) add(testRunners, "mocha");
    if (deps.has("@playwright/test")) add(testRunners, "playwright");
    if (deps.has("ava")) add(testRunners, "ava");
    // node:test — inferable only from a `test` script that invokes it
    const scripts = pkg.scripts;
    if (testRunners.length === 0 && scripts !== null && typeof scripts === "object") {
      const testScript = (scripts as Record<string, unknown>).test;
      if (typeof testScript === "string" && /node\s+--test|node:test/.test(testScript)) add(testRunners, "node:test");
    }
  }

  // --- Python --------------------------------------------------------------
  const pyproject = read("pyproject.toml");
  if (pyproject !== undefined || has("requirements.txt") || has("setup.py") || has("Pipfile")) {
    add(languages, "Python");
    const pyText = `${pyproject ?? ""}\n${read("requirements.txt") ?? ""}\n${read("Pipfile") ?? ""}`.toLowerCase();
    if (pyproject !== undefined) {
      mark("pyproject.toml");
      if (/\[tool\.poetry\]/.test(pyproject)) add(buildTools, "poetry");
      else if (/\[tool\.pdm\]/.test(pyproject)) add(buildTools, "pdm");
      else if (/\[tool\.hatch/.test(pyproject)) add(buildTools, "hatch");
      else add(buildTools, "pip");
    } else if (has("requirements.txt")) { mark("requirements.txt"); add(buildTools, "pip"); }
    else if (has("Pipfile")) { mark("Pipfile"); add(buildTools, "pipenv"); }
    else if (has("setup.py")) { mark("setup.py"); add(buildTools, "pip"); }

    const pyFw: Array<[string, string]> = [
      ["fastapi", "FastAPI"], ["django", "Django"], ["flask", "Flask"], ["streamlit", "Streamlit"],
    ];
    for (const [dep, name] of pyFw) if (pyText.includes(dep)) add(frameworks, name);
    if (pyText.includes("pytest") || has("pytest.ini") || has("tox.ini")) add(testRunners, "pytest");
    else if (pyText.includes("unittest")) add(testRunners, "unittest");
  }

  // --- Go ------------------------------------------------------------------
  if (has("go.mod")) {
    mark("go.mod");
    add(languages, "Go");
    add(buildTools, "go");
    add(testRunners, "go test");
    const goMod = (read("go.mod") ?? "").toLowerCase();
    if (goMod.includes("gin-gonic/gin")) add(frameworks, "Gin");
    if (goMod.includes("labstack/echo")) add(frameworks, "Echo");
    if (goMod.includes("gofiber/fiber")) add(frameworks, "Fiber");
  }

  // --- Rust ----------------------------------------------------------------
  if (has("Cargo.toml")) {
    mark("Cargo.toml");
    add(languages, "Rust");
    add(buildTools, "cargo");
    add(testRunners, "cargo test");
    const cargo = (read("Cargo.toml") ?? "").toLowerCase();
    if (cargo.includes("actix-web")) add(frameworks, "Actix");
    if (cargo.includes("\naxum") || cargo.includes("axum =") || cargo.includes("axum=")) add(frameworks, "Axum");
    if (cargo.includes("rocket")) add(frameworks, "Rocket");
  }

  // --- JVM (Java / Kotlin) -------------------------------------------------
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) {
    add(languages, has("build.gradle.kts") ? "Kotlin" : "Java");
    if (has("pom.xml")) { mark("pom.xml"); add(buildTools, "maven"); add(testRunners, "maven test"); }
    else { mark(has("build.gradle.kts") ? "build.gradle.kts" : "build.gradle"); add(buildTools, "gradle"); add(testRunners, "gradle test"); }
    const jvm = `${read("pom.xml") ?? ""}${read("build.gradle") ?? ""}${read("build.gradle.kts") ?? ""}`.toLowerCase();
    if (jvm.includes("spring-boot") || jvm.includes("springframework")) add(frameworks, "Spring");
  }

  // --- Ruby ----------------------------------------------------------------
  if (has("Gemfile")) {
    mark("Gemfile");
    add(languages, "Ruby");
    add(buildTools, "bundler");
    const gem = (read("Gemfile") ?? "").toLowerCase();
    if (gem.includes("rails")) add(frameworks, "Rails");
    if (gem.includes("sinatra")) add(frameworks, "Sinatra");
    if (gem.includes("rspec")) add(testRunners, "rspec");
  }

  // --- PHP -----------------------------------------------------------------
  const composer = parseJson(read("composer.json"));
  if (composer !== undefined) {
    mark("composer.json");
    add(languages, "PHP");
    add(buildTools, "composer");
    const deps = packageDeps(composer);
    if ([...deps].some((d) => d.startsWith("laravel/"))) add(frameworks, "Laravel");
    if ([...deps].some((d) => d.startsWith("symfony/"))) add(frameworks, "Symfony");
    if (deps.has("phpunit/phpunit")) add(testRunners, "phpunit");
  }

  // --- generic build tool: Makefile ----------------------------------------
  if (has("Makefile")) { mark("Makefile"); add(buildTools, "make"); }

  // --- container + git -----------------------------------------------------
  const hasDocker = has("Dockerfile") || has("docker-compose.yml") || has("docker-compose.yaml") || has("compose.yaml");
  if (hasDocker) {
    if (has("Dockerfile")) mark("Dockerfile");
    if (has("docker-compose.yml")) mark("docker-compose.yml");
    if (has("docker-compose.yaml")) mark("docker-compose.yaml");
    if (has("compose.yaml")) mark("compose.yaml");
  }
  const hasGit = has(".git");
  if (hasGit) mark(".git");

  return {
    languages,
    primaryLanguage: languages[0],
    frameworks,
    testRunners,
    buildTools,
    packageManager,
    hasGit,
    hasDocker,
    markers,
  };
}

/** Wire the production filesystem ports (real synchronous fs, fail-soft reads). */
export function liveDetectPorts(): DetectPorts {
  return {
    exists: (p) => existsSync(p),
    readText: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/** Detect the project at `root` (defaults to cwd) using the live filesystem ports. */
export function detectLiveProject(root: string = process.cwd()): ProjectDetection {
  return detectProject(root, liveDetectPorts());
}
