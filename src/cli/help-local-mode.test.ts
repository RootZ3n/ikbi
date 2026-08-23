/**
 * THE HELP MUST DOCUMENT THE FLAGS THE BUILD COMMAND ACTUALLY ACCEPTS.
 *
 * `--local-mode` and `--require-local-success` were accepted by the parser and absent from
 * `ikbi help build`, so the only way to discover supervised local work was to read the source or
 * `help --advanced`. An operator cannot be expected to opt into a governance mode nobody told them
 * about, and — worse — cannot be expected to know what it does NOT grant.
 *
 * These parse the REAL built CLI's output rather than the HELP_PAGES table, because the table
 * being right is not the same as the binary printing it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { HERMETIC_DEV_KEY_ENV } from "../test-support/hermetic-env.js";

const ENTRY = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

function help(args: readonly string[]): string {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...HERMETIC_DEV_KEY_ENV },
    encoding: "utf8",
    timeout: 30_000,
  });
  return `${res.stdout}\n${res.stderr}`;
}

test("`ikbi help build` documents the supervised local-mode flags", (t) => {
  if (!existsSync(ENTRY)) return t.skip("dist not built");
  const out = help(["help", "build"]);
  assert.match(out, /--local-mode/, "the flag the parser accepts must appear in its own help");
  assert.match(out, /--require-local-success/);
  assert.match(out, /off\|assist\|auto/, "the usage line must show the accepted values");
});

test("`ikbi help build` says the default is OFF and that Bokahli is optional", (t) => {
  if (!existsSync(ENTRY)) return t.skip("dist not built");
  const out = help(["help", "build"]);
  assert.match(out, /off \(DEFAULT\)/i, "an operator must be able to see which mode they get by default");
  assert.match(out, /ZERO local requests/i, "off must be documented as making no request at all");
  assert.match(out, /Bokahli is optional/i);
});

test("`ikbi help build` says local advice carries no authority", (t) => {
  if (!existsSync(ENTRY)) return t.skip("dist not built");
  const out = help(["help", "build"]);
  assert.match(out, /NEVER AUTHORITY|never authority/i);
  assert.match(out, /UNTRUSTED/, "advice must be described as fenced untrusted evidence");
  assert.match(out, /humanReviewRequired=true/);
  assert.match(out, /autonomousPromotionAllowed=false/);
});

test("`ikbi help build` discloses the structured-output limitation honestly", (t) => {
  if (!existsSync(ENTRY)) return t.skip("dist not built");
  const out = help(["help", "build"]);
  // Bokahli's OpenAI endpoint accepts response_format and ignores it. Help that omitted this
  // would let an operator believe a schema was enforced when it never was.
  assert.match(out, /response_format/);
  assert.match(out, /silently ignored/i);
});

test("`ikbi help build` points at the commands that inspect and reverse a run", (t) => {
  if (!existsSync(ENTRY)) return t.skip("dist not built");
  const out = help(["help", "build"]);
  assert.match(out, /ikbi inspect/);
  assert.match(out, /ikbi receipts/);
  assert.match(out, /ikbi undo/);
});

test("a local-mode value the CLI cannot read is refused, and the refusal names the option", (t) => {
  if (!existsSync(ENTRY)) return t.skip("dist not built");
  const res = spawnSync(process.execPath, [ENTRY, "build", "a goal", "--local-mode", "OFF"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...HERMETIC_DEV_KEY_ENV },
    encoding: "utf8", timeout: 30_000,
  });
  const out = `${res.stdout}\n${res.stderr}`;
  assert.notEqual(res.status, 0, "an unreadable mode must not be guessed into `off`");
  assert.match(out, /--local-mode/, "the refusal must name the option that was wrong");
});
