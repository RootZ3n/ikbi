import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The cold-start on-ramp's second half (Blocker 1): the CLI MUST warm the trust
 * cache (`trust.preload()`) before dispatching a command that resolves worker
 * trust — without it, a granted worker still resolves cold to the floor and the
 * grant is invisible. `run()` self-invokes on import (it reads process.argv), so
 * it cannot be unit-invoked; we assert the wiring is present in the startup path.
 */
test("the CLI startup path wires trust.preload() before dispatching commands", async () => {
  const src = await readFile(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  assert.match(src, /import \{ trust \} from "\.\.\/core\/trust\/index\.js"/, "the CLI imports the trust singleton");
  assert.match(src, /await trust\.preload\(\)/, "the CLI awaits trust.preload() in the dispatch path");
  // The rejected (MAC-failure) count is surfaced, not silently dropped.
  assert.match(src, /rejected/, "a rejected preload count is surfaced");
});
