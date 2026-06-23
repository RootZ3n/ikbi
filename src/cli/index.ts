#!/usr/bin/env node
/**
 * ikbi CLI — thin stub + module-command composer.
 *
 * Phase 0/1 placeholder for the operator-facing control surface. It exposes the
 * read path into the config-driven provider roster, and — via the command-registrar
 * SEAM (Step S) — composes whatever subcommands MODULES register from their own
 * files. Modules add commands by calling `registerCommand(...)` (see
 * `cli/registry.ts`); this file never names them. Importing the `src/modules`
 * barrel is what makes their commands available — no `cli/index.ts` edit.
 */

// BOOTSTRAP FIRST (before ANY config-loading import): autoload `.env`, and let read-only
// info commands (doctor/help/…) load even on a fresh shell. Imports only node builtins, so
// it cannot transitively pull in core/config — its side effects must land first.
import "./bootstrap.js";
// Side-effect import: load the modules barrel. egress's register() (fired on barrel import)
// installs the SSRF fetch guard, and the provider singleton constructs at module load via
// `resolveFetchGuard()` — so the barrel MUST precede the provider import below, or the CLI
// throws EgressGuardMissingError at startup. This matches the server entry's barrel-first
// ordering. (It also runs each module's command registrations, composing the subcommands.)
import "../modules/index.js";
import { config } from "../core/config.js";
import { registry } from "../core/provider/index.js";
import {
  fetchLuakLeaderboard,
  pickCheapestAboveThreshold,
  rankCandidates,
  type RosterModel,
} from "../modules/model-evaluation/index.js";
import { trust } from "../core/trust/index.js";
import { commands } from "./registry.js";
import { runDoctor, runDoctorFixCli } from "./doctor.js";
import { runInit } from "./init.js";
import { runSelfRepair } from "../modules/self-repair/index.js";
import { runCapabilities } from "./capabilities.js";
import { postureLines } from "./posture.js";
import { writeStderr, writeStdout } from "./io.js";
import { translateError, formatFriendlyError } from "../core/errors/index.js";
import { helpForTopic } from "./help-pages.js";
// Core-facing operator commands registered from their own files (read the receipt store /
// workspace manager). Imported here so registerCommand fires before dispatch.
import "./receipts.js";
import "./summary.js";
import "./cost.js";
import "./undo.js";
import "./clean.js";
import "./workspace.js";
import "./workspaces.js";
import "./serve.js";
import "./audit.js";
import "./fix.js";
import "./memory.js";
import "./review.js";
import "./agents.js";
import "./evaluate.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
// The DEFAULT router — no-args or bare text opens the interactive REPL (golden path).
// The cognition-layer router is still available behind `--headless` for headless/CI use.
// Imported AFTER the barrel so the egress guard is already registered.
import { createCognitionRouter } from "../modules/cognition-layer/index.js";
import { liveRepl } from "../modules/chat/cli.js";

/** Built-in command names — reserved, cannot be shadowed by a module command. */
const BUILTINS = new Set(["version", "models", "providers", "init", "doctor", "capabilities", "help"]);

/**
 * Does this arg list ask for a subcommand's help? (`--help`/`-h` anywhere in the args.)
 * Help must be answerable with NO provider init, NO trust preload, and NO network — so
 * the dispatcher consults this BEFORE the cold-start preload, and each subcommand's own
 * handler prints its usage and returns early. Keeping the check here means a missing/slow
 * model config can never make `ikbi <cmd> --help` hang.
 */
function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/**
 * Auto-run dispatcher for the cognition router: act on a recommendation by re-entering
 * the CLI's own command lookup (`commands.get`). Only KNOWN module commands are ever
 * dispatched — the recommendation maps to build/batch/classify/ask — so this can never
 * loop back into the cognition fallback. This is the seam that turns "recommend" into
 * "do it" while keeping the cognition LAYER itself non-executing.
 */
async function dispatchCommand(argv: readonly string[]): Promise<void> {
  const name = argv[0];
  const sub = name !== undefined ? commands.get(name) : undefined;
  if (sub === undefined) {
    writeStderr(`ikbi: cannot auto-run unrecognized command "${name ?? ""}"\n`);
    return;
  }
  await sub.run(argv.slice(1));
}

/** The cognition router (behind --headless), with auto-dispatch wired (cli owns the command registry). */
const cognitionRouter = createCognitionRouter({ dispatch: dispatchCommand });

function printUsage(argv: readonly string[] = []): void {
  // `ikbi help <command>` → that command's detailed page. The topic is the first non-flag
  // argument after `help`/`--help`/`-h` (so `ikbi help build` and `ikbi build --help`-style
  // `help` invocations both resolve). Unknown topics fall through to the general usage.
  const topic = argv.find((a, i) => i > 0 && !a.startsWith("-"));
  if (topic !== undefined) {
    const page = helpForTopic(topic);
    if (page !== undefined) {
      writeStdout(page);
      return;
    }
  }

  const showAdvanced = argv.includes("--advanced");
  const allModuleCmds = commands.all().filter((c) => !BUILTINS.has(c.name));

  if (showAdvanced) {
    const lines = [
      `ikbi v${config.version} — governed build/repair engine`,
      "",
      "Usage: ikbi                Start interactive coding session",
      "       ikbi \"fix the bug\"  Start session with a prompt",
      "       ikbi build <goal>   Headless build/repair",
      "       ikbi init           First-run guided setup",
      "       ikbi doctor         Check configuration health",
      "",
      "Core commands:",
      "  version            Print the ikbi version",
      "  models [list]      List the model roster (id, role, cost, provider chain)",
      "  models --rank      Rank the roster by Luak benchmark score",
      "  providers [list]   List the registered providers",
      "  init               Guided first-run setup",
      "  doctor             Report bootstrap config",
      "  doctor --fix       Repair common gaps",
      "  doctor --self-repair  Run the self-monitor",
      "  capabilities       List the builder + chat tool inventory",
    ];
    if (allModuleCmds.length > 0) {
      lines.push("", "All registered commands:");
      const width = Math.max(...allModuleCmds.map((c) => c.name.length));
      for (const c of allModuleCmds) {
        const usage = c.usage ? ` ${c.usage}` : "";
        lines.push(`  ${(c.name + usage).padEnd(width + 11)}${c.summary}`);
      }
    }
    lines.push(
      "",
      `Roster file: ${config.provider.rosterFile}`,
      "(Edit that JSON file to add/remove models & providers — no code change.)",
      "",
    );
    writeStdout(lines.join("\n"));
  } else {
    // Focused default help: the handful of commands a first-time user actually needs.
    // Everything else (repl/build flags, doctor, capabilities, workspaces, receipts,
    // every module command) lives behind `ikbi help --advanced`. Deliberately does NOT
    // enumerate the registered module commands — that breadth is what `--advanced` is for.
    const lines = [
      `ikbi v${config.version} — governed build/repair engine`,
      "",
      "  ikbi                      Start interactive REPL (default)",
      "  ikbi init                 Guided first-run setup",
      "  ikbi build <description>  Build/repair code",
      "  ikbi models               Show model configuration",
      "  ikbi serve                Start HTTP server",
      "  ikbi help                 Show this help",
      "",
      "Type `ikbi help <command>` for detailed usage (e.g. `ikbi help build`).",
      "Type `ikbi help --advanced` for all commands and flags.",
      "",
    ];
    writeStdout(lines.join("\n"));
  }
}

/** Blessed model profiles for `ikbi models --recommend`. */
interface RecommendProfile {
  label: string;
  builder: string;
  critic: string;
  fallback?: string;
  caveats: string;
}

const RECOMMENDED: RecommendProfile[] = [
  {
    label: "Budget",
    builder: "deepseek-v4-flash",
    critic: "deepseek-v4-flash",
    caveats: "Fastest/cheapest. Good for experiments and low-stakes work. May miss complex patterns.",
  },
  {
    label: "Balanced",
    builder: "claude-sonnet-4",
    critic: "deepseek-v4-pro",
    fallback: "deepseek-v4-pro",
    caveats: "Best quality-to-price. Recommended for daily use. Critic catches most issues.",
  },
  {
    label: "Max Quality",
    builder: "claude-opus-4",
    critic: "claude-sonnet-4",
    caveats: "Strongest models. Best for complex multi-file refactors. Higher cost and latency.",
  },
  {
    label: "Local Only",
    builder: "ollama:qwen3",
    critic: "ollama:qwen3",
    caveats: "No API keys needed. Runs on your machine. Slower, less capable than cloud models.",
  },
];

function printRecommendations(): void {
  writeStdout("Blessed model configurations (ikbi models --recommend)\n");
  writeStdout("=====================================================\n\n");
  for (let i = 0; i < RECOMMENDED.length; i++) {
    const r = RECOMMENDED[i]!;
    writeStdout(`[${i + 1}] ${r.label}\n`);
    writeStdout(`    Builder:    ${r.builder}\n`);
    writeStdout(`    Critic:     ${r.critic}\n`);
    if (r.fallback) writeStdout(`    Fallback:   ${r.fallback}\n`);
    writeStdout(`    Caveats:    ${r.caveats}\n\n`);
  }
  writeStdout("Apply with: ikbi models --set-recommend <n>\n");
  writeStdout("  (writes IKBI_BUILDER_MODEL + IKBI_CRITIC_MODEL to .env)\n");
}

function listModels(): void {
  const models = registry.listModels();
  if (models.length === 0) {
    writeStdout("(no models in roster)\n");
    return;
  }
  for (const m of models) {
    const chain = m.providers
      .map((r) => {
        const rate = r.cost ?? m.cost;
        const price = rate ? ` ($${rate.promptPerMTok}/$${rate.completionPerMTok}/Mtok)` : "";
        return `${r.provider}:${r.providerModelId}${price}`;
      })
      .join(" -> ");
    const role = m.role ? ` [${m.role}]` : "";
    writeStdout(`${m.id}${role}  chain=${chain}\n`);
  }
}

/** A blended $/Mtok for a roster model (the cheaper of the route/model cost), or undefined. */
function blendedCost(m: ReturnType<typeof registry.listModels>[number]): number | undefined {
  const rate = m.providers[0]?.cost ?? m.cost;
  if (rate === undefined) return undefined;
  return (rate.promptPerMTok + rate.completionPerMTok) / 2;
}

/** Map the provider registry's roster into the ranking adapter's RosterModel shape. */
function rosterForRanking(): RosterModel[] {
  return registry.listModels().map((m) => ({
    id: m.id,
    role: m.role,
    costPerMTok: blendedCost(m),
    providerModelIds: m.providers.map((r) => r.providerModelId),
  }));
}

/**
 * `ikbi models --rank` — pull Luak's leaderboard and rank the roster by measured quality, so
 * cold model selection is benchmark-driven instead of hand-tuned. `--min-score N` additionally
 * picks the CHEAPEST roster model at or above that quality bar (the competitive-race seed).
 */
async function runModelsRank(argv: readonly string[]): Promise<void> {
  const roster = rosterForRanking();
  if (roster.length === 0) {
    writeStdout("(no models in roster)\n");
    return;
  }
  const lb = await fetchLuakLeaderboard();
  if (!lb.ok) {
    writeStderr(`ikbi models --rank: ${lb.error}\n  (set IKBI_MODEL_EVALUATION_LUAK_URL if Luak is elsewhere; ensure its host is egress-allowlisted)\n`);
    process.exitCode = 1;
    return;
  }
  const ranked = rankCandidates(roster, lb.entries);
  writeStdout(`Roster ranked by Luak benchmark score (${lb.entries.length} leaderboard row(s)):\n`);
  let rank = 1;
  for (const c of ranked) {
    const role = c.role ? ` [${c.role}]` : "";
    const score = typeof c.score === "number" ? c.score.toFixed(2) : "—  (no Luak data)";
    const cost = typeof c.costPerMTok === "number" ? `  $${c.costPerMTok.toFixed(2)}/Mtok` : "";
    const via = c.matched?.model ? `  via luak:${c.matched.model}` : "";
    writeStdout(`  ${String(rank).padStart(2)}. ${c.id}${role}  score=${score}${cost}${via}\n`);
    rank += 1;
  }

  // `--min-score N` → the cheapest model above the quality bar (per role when roles are set).
  const idx = argv.indexOf("--min-score");
  const minRaw = idx >= 0 ? argv[idx + 1] : undefined;
  if (minRaw !== undefined) {
    const min = Number(minRaw);
    if (!Number.isFinite(min)) {
      writeStderr(`ikbi models --rank: --min-score expects a number (got "${minRaw}")\n`);
      process.exitCode = 1;
      return;
    }
    const cheapest = pickCheapestAboveThreshold(ranked, min);
    writeStdout(
      cheapest !== undefined
        ? `\nCheapest model with score ≥ ${min}: ${cheapest.id} (score=${cheapest.score?.toFixed(2)}${typeof cheapest.costPerMTok === "number" ? `, $${cheapest.costPerMTok.toFixed(2)}/Mtok` : ""})\n`
        : `\nNo roster model has a Luak score ≥ ${min} — keep the static pick (IKBI_MODEL_BUILDER/etc.).\n`,
    );
  }
}

function listProviders(): void {
  const providers = registry.listProviders();
  if (providers.length === 0) {
    writeStdout("(no providers registered)\n");
    return;
  }
  for (const p of providers) writeStdout(`${p.id}\n`);
}

/**
 * Run a read-only info command, turning any failure into a friendly ONE-LINE config error
 * (never a raw stack). The bootstrap already lets these commands load on a fresh shell; this
 * is the belt-and-suspenders for any other config-shaped error during their execution.
 */
function runInfo(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeStderr(`ikbi ${name}: configuration error — ${msg}\n  (set the required IKBI_* env vars or add them to a .env file; see README.md / SECURITY.md)\n`);
    process.exitCode = 1;
  }
}

/**
 * The cold-start on-ramp: warm the trust cache from durable state (so a granted worker resolves
 * correctly instead of cold-flooring), then best-effort prune the receipt store. Both are silent
 * on the happy path — only MAC-rejected state docs surface a (fail-closed) warning. Shared by the
 * no-args REPL launch and the module-command dispatch path.
 */
async function coldStartPreload(): Promise<void> {
  try {
    const { rejected } = await trust.preload();
    if (rejected > 0) {
      writeStderr(`ikbi: trust preload rejected ${rejected} unreadable/forged state doc(s) (fail-closed)\n`);
    }
  } catch (err) {
    writeStderr(`ikbi: trust preload failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  try {
    const { receipts } = await import("../core/receipt/index.js");
    await receipts.prune();
  } catch { /* non-fatal — receipt pruning is housekeeping, not a startup gate */ }
}

async function run(argv: readonly string[]): Promise<void> {
  const cmd = argv[0];
  switch (cmd) {
    case "version":
    case "--version":
    case "-V":
      // `--version`/`-V` are aliases for `version` — handled here as builtins so they never
      // fall through to the cognition router (which would make a model call to "deliberate"
      // a version request). Pure, offline, no provider init.
      writeStdout(`${config.version}\n`);
      return;
    case "models": {
      const modelsArgs = argv.slice(1);
      if (modelsArgs.includes("--recommend")) {
        printRecommendations();
        return;
      }
      if (modelsArgs.includes("--set-recommend")) {
        const idx = modelsArgs.indexOf("--set-recommend");
        const n = parseInt(modelsArgs[idx + 1] ?? "", 10);
        if (n < 1 || n > RECOMMENDED.length || !Number.isFinite(n)) {
          writeStderr(`ikbi models --set-recommend: need 1-${RECOMMENDED.length}\n`);
          process.exitCode = 1;
          return;
        }
        const r = RECOMMENDED[n - 1]!;
        const envPath = require("node:path").join(process.cwd(), ".env");
        const { existsSync, readFileSync, writeFileSync } = require("node:fs");
        let env = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
        const append = (key: string, val: string): void => {
          const re = new RegExp(`^${key}=.*$`, "m");
          if (re.test(env)) env = env.replace(re, `${key}=${val}`);
          else env += `\n${key}=${val}\n`;
        };
        append("IKBI_BUILDER_MODEL", r.builder);
        append("IKBI_CRITIC_MODEL", r.critic);
        if (r.fallback) append("IKBI_FALLBACK_MODEL", r.fallback);
        writeFileSync(envPath, env);
        writeStdout(`Applied profile [${n}] ${r.label} to ${envPath}\n`);
        writeStdout(`  IKBI_BUILDER_MODEL=${r.builder}\n`);
        writeStdout(`  IKBI_CRITIC_MODEL=${r.critic}\n`);
        if (r.fallback) writeStdout(`  IKBI_FALLBACK_MODEL=${r.fallback}\n`);
        return;
      }
      if (modelsArgs.includes("--rank")) {
        await runModelsRank(modelsArgs);
        return;
      }
      listModels();
      return;
    }
    case "providers":
      listProviders();
      return;
    case "init": {
      if (wantsHelp(argv.slice(1))) {
        writeStdout(
          "Usage: ikbi init\n\n" +
            "Guided first-run setup: detects API keys, recommends model profiles,\n" +
            "and writes a working .env and .ikbi/ config. Answer 2-3 prompts and\n" +
            "ikbi is ready to use.\n\n" +
            "Options: none (fully interactive)\n",
        );
        return;
      }
      await runInit();
      return;
    }
    case "doctor": {
      const doctorArgs = argv.slice(1);
      // `--help` prints usage and exits 0 — it must NOT run the report (which reads config).
      if (wantsHelp(doctorArgs)) {
        writeStdout(
          "Usage: ikbi doctor [--fix] [--force] [--self-repair]\n\n" +
            "Report bootstrap config: what's set, what's missing for a build, and how to fix each gap.\n" +
            "Read-only by default (no identity, no network).\n\n" +
            "Options:\n" +
            "  --fix          Repair common gaps (.env / state dirs / deps); creates/repairs only\n" +
            "  --force        With --fix, also reclaim stale + aged workspaces\n" +
            "  --self-repair  Run the self-monitor: health/test/workspace/dependency checks;\n" +
            "                 file a work order for each problem found (does not promote/fix)\n",
        );
        return;
      }
      // `--self-repair` runs ikbi's self-monitor (Part 1): cheap read-only checks that
      // file work orders to the shared queue for the mechanic (the Mechanic) to drain. It mints
      // no fix and promotes nothing — it only reports + records.
      if (doctorArgs.includes("--self-repair")) {
        const report = await runSelfRepair(writeStdout);
        // Non-zero whenever ikbi is not actually healthy — a problem that already has an
        // open work order (de-duped) is still unhealthy, so it must not exit 0.
        if (!report.healthy) process.exitCode = 1;
        return;
      }
      // `--fix` is the opt-in side-effecting twin of the read-only report: it repairs
      // common gaps (create/repair only; `--force` reclaims stale + aged workspaces) and
      // sets a non-zero exit code if any repair failed.
      if (doctorArgs.includes("--fix")) {
        const code = await runDoctorFixCli(doctorArgs);
        if (code !== 0) process.exitCode = code;
        return;
      }
      runInfo("doctor", () => writeStdout(`${runDoctor().lines.join("\n")}\n`));
      return;
    }
    case "capabilities":
      // Tool inventory + the shared product posture: which surfaces are core/experimental/dormant,
      // and which lifecycle guarantees each editing surface actually provides (no overstatement).
      runInfo("capabilities", () => writeStdout(`${runCapabilities().lines.join("\n")}\n\n${postureLines().join("\n")}\n`));
      return;
    case "help":
    case "--help":
    case "-h":
      // `ikbi help <command>` prints that command's detailed page; bare `ikbi help` prints
      // the focused usage. Either way: no provider init, no trust preload, no network.
      runInfo("help", () => printUsage(argv));
      return;
    case undefined: {
      // GOLDEN PATH (no args): open the interactive REPL with zero startup noise — the prompt is
      // the first thing the user sees. Warm the trust cache silently first (so a granted worker
      // resolves correctly), then hand off to the REPL.
      await coldStartPreload();
      await liveRepl([], undefined);
      return;
    }
    default: {
      // A subcommand `--help`/`-h` is answered by the command's own handler with NO
      // side effects: skip the cold-start preload + receipt prune entirely so help can
      // never block on durable state, and dispatch straight to the handler (which prints
      // its usage and returns). This is what keeps `ikbi build --help` fast and offline.
      const sawHelp = wantsHelp(argv.slice(1));
      if (!sawHelp) {
        // STARTUP PRELOAD (the cold-start on-ramp): warm the trust cache from durable state
        // BEFORE any command resolves worker trust, then prune receipts. Skipped for the
        // pure-info builtins above (no trust path) and for subcommand --help.
        await coldStartPreload();
      }
      // Module commands compose via the command-registrar seam. Built-ins above
      // take precedence (a module cannot shadow a core command).
      const moduleCmd = commands.get(cmd);
      if (moduleCmd !== undefined) {
        await moduleCmd.run(argv.slice(1));
        return;
      }
      // GOLDEN PATH: not a known command ⇒ launch the interactive REPL.
      // Bare text (`ikbi fix the bug`) seeds the first turn. The `--headless` flag
      // restores the old cognition-router behavior for CI/scripting use.
      const headlessIdx = argv.indexOf("--headless");
      if (headlessIdx >= 0) {
        // Strip --headless and route through cognition-layer (old behavior)
        const cleanArgv = argv.filter((_, i) => i !== headlessIdx);
        await cognitionRouter.route(cleanArgv);
      } else {
        // Default: REPL with bare text as initial message (empty string if no args)
        const initialMessage = argv.join(" ");
        await liveRepl([], initialMessage || undefined);
      }
    }
  }
}

// SIGINT (Ctrl-C): RETAIN cleanly. An interrupt mid-build would otherwise leave the allocated
// workspace leaking the bound and silently abandon whatever the builder had written. On the first
// Ctrl-C we mark every still-live ALLOCATED workspace as retained-failed (keeping its worktree) so
// the work survives and is inspectable (`ikbi workspace ls` / `ikbi diff <id>`); a second Ctrl-C
// force-exits immediately. (PROMOTING workspaces are left for crash-reconcile.)
let interrupting = false;
process.on("SIGINT", () => {
  if (interrupting) process.exit(130); // second Ctrl-C — force quit
  interrupting = true;
  writeStderr("\nikbi: interrupted — retaining in-progress workspaces (Ctrl-C again to force quit)…\n");
  void coreWorkspaces
    .retainAllLive("interrupted by SIGINT")
    .then((n) => {
      if (n > 0) writeStderr(`ikbi: retained ${n} in-progress workspace(s) — inspect with \`ikbi workspace ls\`.\n`);
      process.exit(130);
    })
    .catch(() => process.exit(130));
});

run(process.argv.slice(2)).catch((err: unknown) => {
  // A broken pipe (reader closed early — e.g. `ikbi models | head`) is normal, not a failure:
  // exit quietly rather than translating it into a confusing "something went wrong".
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EPIPE") {
    process.exit(0);
  }
  // Translate the raw failure to a friendly message + suggested action. The full technical
  // detail (and stack) is shown only under --verbose/--debug (bootstrap raised the log level).
  const verbose = process.argv.includes("--verbose") || process.argv.includes("--debug");
  const fe = translateError(err);
  const stack = err instanceof Error ? err.stack : undefined;
  writeStderr(`ikbi: ${formatFriendlyError(fe, { verbose, ...(stack !== undefined ? { stack } : {}) })}\n`);
  process.exitCode = 1;
});

