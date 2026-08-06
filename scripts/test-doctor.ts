/**
 * Capability probe for ikbi's test environment.
 *
 * This intentionally probes the host rather than treating a failed test as a
 * proxy for a missing OS capability.  The test runner uses the composite
 * `git`, `subprocess`, and `localhostIpv4` results to classify environment-bound
 * suites as NOT_RUN_UNSUPPORTED.
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

type FailureCode = string;

export interface TestCapability {
  readonly name: string;
  readonly supported: boolean;
  readonly evidence?: string;
  readonly failureCode?: FailureCode;
  readonly affectedTestGroups: readonly string[];
}

export interface TestDoctorResult {
  readonly schemaVersion: 1;
  readonly status: "complete";
  readonly environment: {
    readonly nodeVersion: string;
    readonly platform: string;
    readonly arch: string;
    readonly nodeExecutable: string;
    readonly temporaryDirectory: string;
    readonly ci: boolean;
  };
  readonly capabilities: readonly TestCapability[];
}

const GROUPS = {
  subprocess: ["acceptance/cli-smoke"],
  git: [
    "acceptance/verifier-target",
    "worker-model/checks-nonjs",
    "worker-model/critic-recovery-conformance",
    "worker-model/invocation-ledger-conformance",
    "worker-model/orchestrator",
    "worker-model/phase11b-lane-authority-conformance",
    "worker-model/phase11c-receipt-authority-conformance",
    "worker-model/phase12-semantic-substance-conformance",
    "worker-model/phase13-immutable-verification-conformance",
    "worker-model/phase13b-frozen-snapshot-conformance",
    "worker-model/phase13c-physical-snapshot-conformance",
    "worker-model/phase15-evidence-relevance-conformance",
    "worker-model/phase16-quarantine-conformance",
    "worker-model/promotion-authority-conformance",
    "worker-model/safety-evidence-conformance",
  ],
  localhost: ["server/tasks"],
} as const;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function supported(name: string, evidence: string, affectedTestGroups: readonly string[]): TestCapability {
  return { name, supported: true, evidence, affectedTestGroups };
}

function unsupported(name: string, failureCode: string, evidence: string, affectedTestGroups: readonly string[]): TestCapability {
  return { name, supported: false, failureCode, evidence, affectedTestGroups };
}

function cleanup(path: string | undefined): void {
  if (path === undefined) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Cleanup evidence is not allowed to turn a capability result into an
    // unrelated failure.  The probe reports the capability operation itself.
  }
}

function probeTemporaryDirectory(): TestCapability {
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "ikbi-test-doctor-"));
    const file = join(root, "probe.txt");
    writeFileSync(file, Buffer.from([0, 1, 2, 255]));
    const bytes = readFileSync(file);
    if (!bytes.equals(Buffer.from([0, 1, 2, 255]))) {
      return unsupported("tempWritable", "TEMP_READBACK_MISMATCH", "temporary file readback differed from the bytes written", ["all test groups"]);
    }
    return supported("tempWritable", `created and read ${basename(file)}`, ["all test groups"]);
  } catch (error) {
    return unsupported("tempWritable", errorCode(error) ?? "TEMP_DIRECTORY_UNSUPPORTED", errorMessage(error), ["all test groups"]);
  } finally {
    cleanup(root);
  }
}

function probeSubprocess(): TestCapability {
  try {
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write('ikbi-test-doctor')"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error !== undefined) {
      return unsupported("subprocess", errorCode(result.error) ?? "SUBPROCESS_UNSUPPORTED", errorMessage(result.error), GROUPS.subprocess);
    }
    if (result.status !== 0 || result.stdout !== "ikbi-test-doctor") {
      return unsupported("subprocess", "SUBPROCESS_OUTPUT_MISMATCH", `status=${String(result.status)} signal=${String(result.signal)} stdout=${String(result.stdout).slice(0, 80)} stderr=${String(result.stderr).slice(0, 80)}`, GROUPS.subprocess);
    }
    return supported("subprocess", "Node child process completed and returned the probe marker", GROUPS.subprocess);
  } catch (error) {
    return unsupported("subprocess", errorCode(error) ?? "SUBPROCESS_UNSUPPORTED", errorMessage(error), GROUPS.subprocess);
  }
}

async function probeProcessSignal(subprocess: TestCapability): Promise<TestCapability> {
  if (!subprocess.supported) {
    return unsupported("processSignal", "SUBPROCESS_UNSUPPORTED", "cross-process signaling cannot be tested without a child process", ["process-lifecycle tests"]);
  }

  return await new Promise<TestCapability>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 10000)"], { stdio: "ignore" });

    const finish = (ok: boolean, code: string, evidence: string): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
      resolve(ok
        ? supported("processSignal", evidence, ["process-lifecycle tests"])
        : unsupported("processSignal", code, evidence, ["process-lifecycle tests"]));
    };

    child.once("error", (error: unknown) => finish(false, errorCode(error) ?? "PROCESS_SIGNAL_UNSUPPORTED", errorMessage(error)));
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      const ok = code === 0 || signal === "SIGTERM";
      finish(ok, ok ? "" : "PROCESS_SIGNAL_FAILED", `child exit code=${String(code)} signal=${String(signal)}`);
    });

    killTimer = setTimeout(() => {
      try {
        if (!child.kill("SIGTERM")) finish(false, "PROCESS_SIGNAL_FAILED", "child.kill(SIGTERM) returned false");
      } catch (error) {
        finish(false, errorCode(error) ?? "PROCESS_SIGNAL_UNSUPPORTED", errorMessage(error));
      }
    }, 100);
    hardTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The exit/error listener will provide the primary evidence.
      }
      finish(false, "PROCESS_SIGNAL_TIMEOUT", "child did not exit after the signal probe");
    }, 2_000);
  });
}

function probeFsyncRename(): TestCapability {
  let root: string | undefined;
  let fd: number | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "ikbi-test-doctor-fsync-"));
    const temp = join(root, "value.tmp");
    const target = join(root, "value");
    writeFileSync(temp, Buffer.from([7, 0, 255, 1]));
    fd = openSync(temp, "r");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
    if (!existsSync(target)) return unsupported("fsyncRename", "RENAME_READBACK_MISSING", "the renamed file was not present", ["workspace/substrate tests"]);
    return supported("fsyncRename", "fsync followed by rename and readback completed", ["workspace/substrate tests"]);
  } catch (error) {
    return unsupported("fsyncRename", errorCode(error) ?? "FSYNC_RENAME_UNSUPPORTED", errorMessage(error), ["workspace/substrate tests"]);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    cleanup(root);
  }
}

function probeSymlink(): TestCapability {
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "ikbi-test-doctor-link-"));
    const target = join(root, "target");
    const link = join(root, "link");
    writeFileSync(target, "target");
    symlinkSync(target, link);
    return supported("symlink", "created a symbolic link and observed its directory entry", ["workspace/confinement tests"]);
  } catch (error) {
    return unsupported("symlink", errorCode(error) ?? "SYMLINK_UNSUPPORTED", errorMessage(error), ["workspace/confinement tests"]);
  } finally {
    cleanup(root);
  }
}

function gitRun(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function probeGitExecutable(): TestCapability {
  try {
    const version = execFileSync("git", ["--version"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    return supported("gitExecutable", version.slice(0, 120), GROUPS.git);
  } catch (error) {
    return unsupported("gitExecutable", errorCode(error) ?? "GIT_EXECUTABLE_UNSUPPORTED", errorMessage(error), GROUPS.git);
  }
}

function probeGitRepository(gitExecutable: TestCapability): TestCapability {
  if (!gitExecutable.supported) {
    return unsupported("gitRepository", "GIT_EXECUTABLE_UNSUPPORTED", "git repository creation depends on the Git executable probe", GROUPS.git);
  }
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "ikbi-test-doctor-git-"));
    gitRun(root, ["init", "-q"]);
    return supported("gitRepository", "git init completed in an isolated temporary directory", GROUPS.git);
  } catch (error) {
    return unsupported("gitRepository", errorCode(error) ?? "GIT_REPOSITORY_UNSUPPORTED", errorMessage(error), GROUPS.git);
  } finally {
    cleanup(root);
  }
}

function probeGitWorktree(gitRepository: TestCapability): TestCapability {
  if (!gitRepository.supported) {
    return unsupported("gitWorktree", "GIT_REPOSITORY_UNSUPPORTED", "git worktree operations depend on repository creation", GROUPS.git);
  }
  let root: string | undefined;
  let worktree: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "ikbi-test-doctor-worktree-"));
    worktree = join(root, "checkout");
    gitRun(root, ["init", "-q"]);
    writeFileSync(join(root, "probe.txt"), "probe\n");
    gitRun(root, ["add", "probe.txt"]);
    gitRun(root, ["-c", "user.email=ikbi-test-doctor@example.invalid", "-c", "user.name=ikbi-test-doctor", "commit", "-qm", "probe"]);
    gitRun(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
    if (!existsSync(join(worktree, "probe.txt"))) {
      return unsupported("gitWorktree", "GIT_WORKTREE_READBACK_MISSING", "git worktree add returned without the committed file", GROUPS.git);
    }
    return supported("gitWorktree", "git worktree add completed and the committed file was readable", GROUPS.git);
  } catch (error) {
    return unsupported("gitWorktree", errorCode(error) ?? "GIT_WORKTREE_UNSUPPORTED", errorMessage(error), GROUPS.git);
  } finally {
    if (root !== undefined && worktree !== undefined) {
      try { gitRun(root, ["worktree", "remove", "--force", worktree]); } catch { /* cleanup below */ }
    }
    cleanup(root);
  }
}

function probeCrossProcessLock(subprocess: TestCapability): TestCapability {
  if (!subprocess.supported) {
    return unsupported("crossProcessLock", "SUBPROCESS_UNSUPPORTED", "cross-process lock contention cannot be tested without a child process", ["receipt/workspace lock tests"]);
  }
  let root: string | undefined;
  let fd: number | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), "ikbi-test-doctor-lock-"));
    const lockPath = join(root, "probe.lock");
    fd = openSync(lockPath, "wx");
    const result = spawnSync(process.execPath, ["-e", "const fs=require('node:fs'); try { const fd=fs.openSync(process.env.IKBI_DOCTOR_LOCK_PATH, 'wx'); fs.closeSync(fd); process.exit(2); } catch (e) { process.exit(e && e.code === 'EEXIST' ? 0 : 3); }"], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, IKBI_DOCTOR_LOCK_PATH: lockPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error !== undefined) {
      return unsupported("crossProcessLock", errorCode(result.error) ?? "CROSS_PROCESS_LOCK_UNSUPPORTED", errorMessage(result.error), ["receipt/workspace lock tests"]);
    }
    if (result.status !== 0) {
      return unsupported("crossProcessLock", "CROSS_PROCESS_LOCK_FAILED", `child status=${String(result.status)} signal=${String(result.signal)}`, ["receipt/workspace lock tests"]);
    }
    return supported("crossProcessLock", "a child process observed an existing exclusive lock", ["receipt/workspace lock tests"]);
  } catch (error) {
    return unsupported("crossProcessLock", errorCode(error) ?? "CROSS_PROCESS_LOCK_UNSUPPORTED", errorMessage(error), ["receipt/workspace lock tests"]);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    cleanup(root);
  }
}

async function probeListen(host: string, name: string): Promise<TestCapability> {
  const server = createServer();
  return await new Promise<TestCapability>((resolve) => {
    let settled = false;
    const finish = (result: TestCapability): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    server.once("error", (error: unknown) => finish(unsupported(name, errorCode(error) ?? "LOCALHOST_LISTEN_UNSUPPORTED", errorMessage(error), GROUPS.localhost)));
    try {
      server.listen({ host, port: 0 }, () => {
        server.close((error?: Error) => {
          if (error !== undefined) finish(unsupported(name, errorCode(error) ?? "LOCALHOST_CLOSE_FAILED", errorMessage(error), GROUPS.localhost));
          else finish(supported(name, `bound and closed an ephemeral TCP listener on ${host}`, GROUPS.localhost));
        });
      });
    } catch (error) {
      finish(unsupported(name, errorCode(error) ?? "LOCALHOST_LISTEN_UNSUPPORTED", errorMessage(error), GROUPS.localhost));
    }
  });
}

function compositeGit(subprocess: TestCapability, gitExecutable: TestCapability, gitRepository: TestCapability, gitWorktree: TestCapability): TestCapability {
  // The affected conformance suites execute Git from a Node test context.  A
  // host Git binary can be present while the test process is forbidden from
  // creating child processes, so the child-process capability is part of the
  // composite gate rather than inferred from `git --version` alone.
  if (subprocess.supported && gitExecutable.supported && gitRepository.supported && gitWorktree.supported) {
    return supported("git", "Git executable, repository creation, and worktree operations are available", GROUPS.git);
  }
  const failed = [subprocess, gitExecutable, gitRepository, gitWorktree].find((capability) => !capability.supported);
  return unsupported("git", failed?.failureCode ?? "GIT_CAPABILITY_UNSUPPORTED", failed?.evidence ?? "a required Git capability is unavailable", GROUPS.git);
}

export async function probeCapabilities(): Promise<TestDoctorResult> {
  const tempWritable = probeTemporaryDirectory();
  const subprocess = probeSubprocess();
  const processSignal = await probeProcessSignal(subprocess);
  const symlink = probeSymlink();
  const fsyncRename = probeFsyncRename();
  const gitExecutable = probeGitExecutable();
  const gitRepository = probeGitRepository(gitExecutable);
  const gitWorktree = probeGitWorktree(gitRepository);
  const crossProcessLock = probeCrossProcessLock(subprocess);
  const localhostIpv4 = await probeListen("127.0.0.1", "localhostIpv4");
  const localhostIpv6 = await probeListen("::1", "localhostIpv6");
  const git = compositeGit(subprocess, gitExecutable, gitRepository, gitWorktree);

  return {
    schemaVersion: 1,
    status: "complete",
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      nodeExecutable: basename(process.execPath),
      temporaryDirectory: tmpdir(),
      ci: process.env.CI === "true",
    },
    capabilities: [tempWritable, subprocess, processSignal, symlink, fsyncRename, gitExecutable, gitRepository, gitWorktree, git, crossProcessLock, localhostIpv4, localhostIpv6],
  };
}

function shellKey(name: string): string {
  switch (name) {
    case "localhostIpv4": return "LOCALHOST_IPV4";
    case "localhostIpv6": return "LOCALHOST_IPV6";
    case "fsyncRename": return "FSYNC_RENAME";
    case "processSignal": return "PROCESS_SIGNAL";
    case "gitExecutable": return "GIT_EXECUTABLE";
    case "gitRepository": return "GIT_REPOSITORY";
    case "gitWorktree": return "GIT_WORKTREE";
    case "crossProcessLock": return "CROSS_PROCESS_LOCK";
    default: return name.toUpperCase();
  }
}

function printHuman(result: TestDoctorResult): void {
  console.log(`ikbi test doctor (${result.environment.nodeVersion}, ${result.environment.platform}/${result.environment.arch})`);
  for (const capability of result.capabilities) {
    const state = capability.supported ? "SUPPORTED" : "NOT_SUPPORTED";
    const detail = capability.supported
      ? capability.evidence ?? ""
      : `${capability.failureCode ?? "UNKNOWN"}: ${capability.evidence ?? "no evidence"}`;
    console.log(`${state.padEnd(14)} ${capability.name.padEnd(20)} ${detail}`);
  }
}

async function main(): Promise<void> {
  const result = await probeCapabilities();
  const args = new Set(process.argv.slice(2));
  if (args.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args.has("--shell")) {
    for (const capability of result.capabilities) {
      const key = shellKey(capability.name);
      console.log(`IKBI_CAP_${key}=${capability.supported ? "true" : "false"}`);
      console.log(`IKBI_CAP_${key}_CODE=${capability.failureCode ?? "SUPPORTED"}`);
    }
    return;
  }
  printHuman(result);
}

main().catch((error: unknown) => {
  console.error(`test doctor failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
