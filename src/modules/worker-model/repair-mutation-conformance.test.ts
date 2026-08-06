import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migrated = ["fix.ts", "patchsmith.ts", "consult-apply.ts", "tournament.ts", "orchestrator.ts"] as const;

test("Phase 3 repair families contain no direct candidate writer or git-apply call", async () => {
  for (const name of migrated) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /writeFileSync\s*\(|fs\.writeFile\s*\(|writeConfinedFile\s*\(/, `${name} must use the mutation core for candidate bytes`);
    assert.doesNotMatch(source, /\[\s*["']apply["']\s*,/, `${name} must not invoke git apply for candidate replay`);
  }
});

test("patchsmith's exact hunk applicator exposes no relocation fallback", async () => {
  const source = await readFile(new URL("./patchsmith.ts", import.meta.url), "utf8");
  assert.match(source, /relocation is not implicit/);
  assert.doesNotMatch(source, /git\s+apply/);
});
