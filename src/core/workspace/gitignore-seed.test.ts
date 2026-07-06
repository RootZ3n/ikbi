/**
 * commitAll seeds a default .gitignore when a worktree has NONE, so a greenfield build that runs a
 * toolchain (cargo → target/, npm → node_modules/) does not commit build artifacts on promote (the
 * O3 papercut, found live in the Rust roman-numeral E2E). An EXISTING .gitignore is never touched.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { commitAll, runGit } from "./git.js";

async function freshRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "ikbi-gitignore-seed-"));
  await runGit(repo, ["init", "-b", "main", "--quiet"]);
  await runGit(repo, ["config", "user.email", "t@t"]);
  await runGit(repo, ["config", "user.name", "t"]);
  return repo;
}

test("commitAll seeds a .gitignore that excludes target/ when the repo has none", async () => {
  const repo = await freshRepo();
  try {
    // simulate a greenfield Rust build: a source file plus a cargo build-output dir
    await writeFile(join(repo, "Cargo.toml"), "[package]\nname='x'\n");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "lib.rs"), "pub fn f() {}\n");
    await mkdir(join(repo, "target", "debug"), { recursive: true });
    await writeFile(join(repo, "target", "debug", "artifact.o"), "binary junk");

    const committed = await commitAll(repo, "build: roman");
    assert.equal(committed, true);

    const tracked = (await runGit(repo, ["ls-files"])).stdout.split("\n").filter(Boolean);
    assert.ok(tracked.includes(".gitignore"), "the seeded .gitignore is itself committed");
    assert.ok(tracked.includes("src/lib.rs"), "source IS committed");
    assert.ok(tracked.includes("Cargo.toml"), "manifest IS committed");
    assert.ok(!tracked.some((f) => f.startsWith("target/")), `no target/ artifacts committed, got: ${tracked.join(",")}`);

    const gi = await readFile(join(repo, ".gitignore"), "utf8");
    assert.match(gi, /target\//);
    assert.match(gi, /node_modules\//);
    assert.match(gi, /\*\.class/, "JVM .class output is excluded (Java artifact hygiene)");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("commitAll NEVER overwrites an existing .gitignore", async () => {
  const repo = await freshRepo();
  try {
    const original = "# my rules\nsecret.txt\n";
    await writeFile(join(repo, ".gitignore"), original);
    await writeFile(join(repo, "app.js"), "console.log(1)\n");
    await writeFile(join(repo, "secret.txt"), "shh");

    await commitAll(repo, "build");

    const gi = await readFile(join(repo, ".gitignore"), "utf8");
    assert.equal(gi, original, "the operator's .gitignore is left byte-for-byte intact");

    const tracked = (await runGit(repo, ["ls-files"])).stdout.split("\n").filter(Boolean);
    assert.ok(tracked.includes("app.js"));
    assert.ok(!tracked.includes("secret.txt"), "the operator's own ignore rule still holds");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
