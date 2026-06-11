import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRepoRegistry, resetRepoRegistry } from "./repo-registry.js";

function setupState(reposJson: object): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-reg-"));
  writeFileSync(join(dir, "repos.json"), JSON.stringify(reposJson, null, 2));
  resetRepoRegistry();
  return dir;
}

function teardown(): void {
  resetRepoRegistry();
}

test("resolve a registered repo name to its path", () => {
  const dir = setupState({ repos: { toba: { path: "/pehverse/repos/toba", description: "career" } } });
  try {
    const reg = loadRepoRegistry(dir);
    assert.equal(reg.resolve("toba"), "/pehverse/repos/toba");
    assert.equal(reg.resolve("Toba"), "/pehverse/repos/toba"); // case-insensitive
  } finally {
    teardown();
  }
});

test("resolve passes through absolute paths", () => {
  const dir = setupState({ repos: {} });
  try {
    const reg = loadRepoRegistry(dir);
    assert.equal(reg.resolve("/some/absolute/path"), "/some/absolute/path");
  } finally {
    teardown();
  }
});

test("resolve returns undefined for unknown names", () => {
  const dir = setupState({ repos: { toba: { path: "/pehverse/repos/toba", description: "career" } } });
  try {
    const reg = loadRepoRegistry(dir);
    assert.equal(reg.resolve("nonexistent"), undefined);
  } finally {
    teardown();
  }
});

test("list returns all registered repos", () => {
  const dir = setupState({
    repos: {
      toba: { path: "/pehverse/repos/toba", description: "career", port: 18815 },
      ikbi: { path: "/pehverse/repos/ikbi", description: "builder" },
    },
  });
  try {
    const reg = loadRepoRegistry(dir);
    const list = reg.list();
    assert.equal(list.length, 2);
    const names = list.map((r) => r.name).sort();
    assert.deepEqual(names, ["ikbi", "toba"]);
  } finally {
    teardown();
  }
});

test("has() checks existence", () => {
  const dir = setupState({ repos: { toba: { path: "/pehverse/repos/toba", description: "career" } } });
  try {
    const reg = loadRepoRegistry(dir);
    assert.equal(reg.has("toba"), true);
    assert.equal(reg.has("Toba"), true);
    assert.equal(reg.has("nope"), false);
  } finally {
    teardown();
  }
});

test("missing repos.json returns empty registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-reg-"));
  resetRepoRegistry();
  try {
    const reg = loadRepoRegistry(dir);
    assert.equal(reg.list().length, 0);
    assert.equal(reg.resolve("toba"), undefined);
  } finally {
    teardown();
  }
});

test("entries with empty path are skipped", () => {
  const dir = setupState({ repos: { bad: { path: "", description: "no path" }, good: { path: "/repo", description: "ok" } } });
  try {
    const reg = loadRepoRegistry(dir);
    assert.equal(reg.list().length, 1);
    assert.equal(reg.has("bad"), false);
    assert.equal(reg.has("good"), true);
  } finally {
    teardown();
  }
});

test("relative repo paths are rejected at load time", () => {
  const dir = setupState({ repos: { bad: { path: "../relative", description: "unsafe" } } });
  try {
    const reg = loadRepoRegistry(dir);
    assert.equal(reg.list().length, 0);
    assert.equal(reg.resolve("bad"), undefined);
  } finally {
    teardown();
  }
});
