import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { commands, registerCommand } from "./registry.js";

afterEach(() => commands.reset());

test("a module registers a CLI command and it composes into the registry", async () => {
  const seen: string[] = [];
  // The sample module — touches only the command-registrar seam.
  registerCommand({
    name: "sample",
    summary: "A sample module command",
    usage: "[arg]",
    run: async (argv) => {
      seen.push(...argv);
    },
  });

  assert.equal(commands.has("sample"), true);
  const cmd = commands.get("sample");
  assert.ok(cmd);
  await cmd.run(["x", "y"]);
  assert.deepEqual(seen, ["x", "y"], "command runs with args after the subcommand token");
});

test("commands list is sorted by name (stable help output)", () => {
  registerCommand({ name: "zeta", summary: "z", run: () => {} });
  registerCommand({ name: "alpha", summary: "a", run: () => {} });
  assert.deepEqual(
    commands.all().map((c) => c.name),
    ["alpha", "zeta"],
  );
});

test("duplicate and invalid command names are rejected", () => {
  registerCommand({ name: "ok", summary: "", run: () => {} });
  assert.throws(() => registerCommand({ name: "ok", summary: "", run: () => {} }), /already registered/);
  assert.throws(() => registerCommand({ name: "Bad Name", summary: "", run: () => {} }), /invalid CLI command name/);
});
