/**
 * REPL FIX 6: shell integration — `ikbi setup` installs an executable launcher so the CLI
 * runs from any directory. We install into a tmp bin dir and assert the file, its exec bit,
 * and its contents (no global filesystem writes).
 */

import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildLauncherScript, installLauncher, setupInstructions } from "./shell-integration.js";

test("FIX6: installLauncher writes an executable launcher referencing the CLI entry", () => {
  const binDir = mkdtempSync(join(tmpdir(), "ikbi-bin-"));
  const root = "/pehverse/repos/ecosystem/ikbi";
  const install = installLauncher(binDir, root);

  assert.equal(install.path, join(binDir, "ikbi"));
  assert.equal(install.created, true);

  const st = statSync(install.path);
  assert.ok(st.isFile(), "the launcher is a regular file");
  assert.ok((st.mode & 0o111) !== 0, "the launcher is executable (any exec bit set)");

  const script = buildLauncherScript(root);
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.ok(script.includes(join(root, "dist", "cli", "index.js")), "references the built CLI entry");
  assert.ok(script.includes(join(root, "src", "cli", "index.ts")), "falls back to the tsx source entry");
});

test("FIX6: setup instructions cover both on-PATH and PATH-needed cases", () => {
  const onPath = setupInstructions({ path: "/home/u/.local/bin/ikbi", created: true, onPath: true });
  assert.match(onPath, /already on your PATH/);

  const needsPath = setupInstructions({ path: "/home/u/.local/bin/ikbi", created: true, onPath: false });
  assert.match(needsPath, /Add its directory to your PATH/);
  assert.ok(needsPath.includes("/home/u/.local/bin"), "names the directory to add");
});
