import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("core provider index does not import the cache module directly", async () => {
  const src = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /modules\/cache/, "cache must register through the provider wrapper seam");
});
