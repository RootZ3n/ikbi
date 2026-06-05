/**
 * ikbi kill-switch — operator CLI: `ikbi kill` / `ikbi unkill` / `ikbi kill-status`.
 *
 * `kill` and `unkill` are OPERATOR-GATED (resolve IKBI_OPERATOR_TOKEN → operator
 * identity; a non-operator kill is rejected by the kill-switch authorization).
 * `kill-status` is read-only. Registers at module-import time (the barrel loads
 * kill-switch so the latch is read at startup and a persisted kill is honored on boot).
 */

import { registerCommand } from "../../cli/registry.js";
import { config } from "../../core/config.js";
import { resolveIdentity as coreResolveIdentity } from "../../core/identity/index.js";
import type { IdentityClaim, ValidatedIdentity } from "../../core/identity/index.js";
import type { KillScope, KillSignal } from "../../core/kill-switch.js";
import { killSwitch as coreKillSwitch } from "./killswitch.js";
import type { KillSwitch } from "./contract.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Parse `--hard`, `--agent <id>`, `--run <id>`, `--note <text>`. */
export function parseKillArgs(argv: readonly string[]): { hard: boolean; agent?: string; run?: string; note?: string } {
  let hard = false;
  let agent: string | undefined;
  let run: string | undefined;
  let note: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--hard") hard = true;
    else if (a === "--agent") { agent = argv[i + 1]; i += 1; }
    else if (a === "--run") { run = argv[i + 1]; i += 1; }
    else if (a === "--note") { note = argv[i + 1]; i += 1; }
  }
  return { hard, ...(agent !== undefined ? { agent } : {}), ...(run !== undefined ? { run } : {}), ...(note !== undefined ? { note } : {}) };
}

export interface KillCliDeps {
  readonly killSwitch?: KillSwitch;
  readonly resolveIdentity?: (claim: IdentityClaim) => ValidatedIdentity;
  readonly operatorToken?: string | undefined;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly setExit?: (code: number) => void;
}

export function createKillCli(deps: KillCliDeps = {}) {
  const ks = deps.killSwitch ?? coreKillSwitch;
  const resolveIdentity = deps.resolveIdentity ?? coreResolveIdentity;
  const operatorToken = "operatorToken" in deps ? deps.operatorToken : config.identity.operatorToken;
  const out = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => void process.stderr.write(s));
  const setExit = deps.setExit ?? ((c: number) => void (process.exitCode = c));

  function operator(): ValidatedIdentity | undefined {
    if (operatorToken === undefined || operatorToken.length === 0) {
      err("ikbi: no operator identity — set IKBI_OPERATOR_TOKEN\n");
      setExit(1);
      return undefined;
    }
    try {
      return resolveIdentity({ token: operatorToken });
    } catch (e) {
      err(`ikbi: operator identity resolution failed: ${errMsg(e)}\n`);
      setExit(1);
      return undefined;
    }
  }

  async function kill(argv: readonly string[]): Promise<void> {
    const { hard, agent, run, note } = parseKillArgs(argv);
    const who = operator();
    if (who === undefined) return;
    const scope: KillScope = agent !== undefined ? "agent" : run !== undefined ? "run" : "engine";
    const signal: KillSignal = { reason: "operator", mode: hard ? "hard" : "soft", scope, ...(agent !== undefined ? { target: agent } : run !== undefined ? { target: run } : {}), ...(note !== undefined ? { note } : {}) };
    const r = await ks.kill(signal, who);
    if (r.engaged) {
      out(`engine kill ENGAGED — reason=operator mode=${signal.mode} scope=${scope}${signal.target !== undefined ? ` target=${signal.target}` : ""}\n`);
    } else {
      err(`ikbi: kill rejected: ${r.reason}\n`);
      setExit(1);
    }
  }

  async function unkill(): Promise<void> {
    const who = operator();
    if (who === undefined) return;
    const r = await ks.clear(who);
    if (r.cleared) out("kill latch CLEARED — engine un-killed\n");
    else {
      err(`ikbi: unkill rejected: ${r.reason}\n`);
      setExit(1);
    }
  }

  async function status(): Promise<void> {
    const s = await ks.status();
    out(`${JSON.stringify({ killed: s.killed, signals: s.signals.map((x) => ({ reason: x.reason, mode: x.mode, scope: x.scope, ...(x.target !== undefined ? { target: x.target } : {}) })) }, null, 2)}\n`);
  }

  return { kill, unkill, status };
}

const live = createKillCli();
registerCommand({ name: "kill", summary: "Engage the engine kill-switch (operator)", usage: "ikbi kill [--hard] [--agent <id> | --run <id>] [--note <text>]", run: (argv) => live.kill(argv) });
registerCommand({ name: "unkill", summary: "Clear the kill-switch latch (operator)", usage: "ikbi unkill", run: () => live.unkill() });
registerCommand({ name: "kill-status", summary: "Show the current kill-switch state", usage: "ikbi kill-status", run: () => live.status() });
