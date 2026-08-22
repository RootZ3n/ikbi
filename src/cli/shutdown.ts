/**
 * SIGNAL SHUTDOWN — one bounded path, shared by SIGINT and SIGTERM.
 *
 * Both signals want the same thing: retain the in-progress workspaces so an interrupt never
 * abandons on-disk work or leaks an allocation bound, reclaim the children we started, and get out.
 * They differ only in their exit code and in what an operator is told.
 *
 * WHY ONE OWNER. They were two inline handlers, written months apart, and they drifted exactly
 * where it mattered: SIGTERM bounded its retain with a forced-exit timer, SIGINT bounded its retain
 * with nothing at all. `retainAllLive` takes the per-workspace lock, sequentially, and that lock
 * waits up to `IKBI_LOCK_TIMEOUT_MS` per workspace when a peer process holds it — so Ctrl-C during
 * verification sat unresponsive for the whole lock timeout, once per live workspace, while SIGTERM
 * on the identical state was out in three seconds. A bound that only one of two copies enforces is
 * not a bound, so there is now one copy.
 *
 * WHY THE WINDOW IS THE SAME FOR BOTH. The window exists because retention is BEST EFFORT: it is
 * worth a few seconds and never worth an operator's patience. Nothing about which key was pressed
 * changes how long that is, and two different numbers would only be two things to keep in step.
 *
 * WHAT IS REPORTED. Graceful retention and forced termination are different outcomes, and an
 * operator who is told "retained" when the retain in fact timed out will go looking for work that
 * was never marked. So the forced path says so, and says what it could not finish.
 */

/** The bounded window for best-effort retention, for EVERY signal. See the note above. */
export const SHUTDOWN_RETAIN_WINDOW_MS = 3000;

/** How a shutdown actually ended. This is the distinction the operator is entitled to. */
export type ShutdownOutcome =
  /** Retention completed inside the window. `retained` counts the workspaces marked. */
  | { readonly kind: "retained"; readonly retained: number; readonly childrenKilled: number }
  /** Retention did not finish inside the window; the process was terminated anyway. */
  | { readonly kind: "forced"; readonly childrenKilled: number }
  /** Retention threw. The work is still on disk; the record may not have been marked. */
  | { readonly kind: "failed"; readonly childrenKilled: number };

export interface ShutdownDeps {
  /** Mark every still-live workspace terminal-`failed` but KEEP its worktree. Returns the count. */
  retainAllLive(reason: string): Promise<number>;
  /** Kill every governed exec child this process started. Returns how many were signalled. */
  terminateChildren(): number;
  write(line: string): void;
  exit(code: number): void;
  /** Schedule the forced exit. Injected so a test does not have to wait three real seconds. */
  setTimer(fn: () => void, ms: number): { unref?: () => unknown };
  /** The bounded window. Defaults to `SHUTDOWN_RETAIN_WINDOW_MS`. */
  windowMs?: number;
}

/**
 * Run one bounded shutdown for `signal`, exiting with `exitCode`.
 *
 * Returns a function that handles a REPEAT of the same signal: an operator pressing Ctrl-C a second
 * time is saying they are done waiting, and is owed an immediate exit rather than a second polite
 * attempt. Retention is already best-effort; a second one would add nothing but delay.
 */
export function runBoundedShutdown(
  signal: string,
  exitCode: number,
  deps: ShutdownDeps,
): void {
  const windowMs = deps.windowMs ?? SHUTDOWN_RETAIN_WINDOW_MS;
  let settled = false;

  /**
   * Report and exit, exactly once.
   *
   * CHILDREN ARE KILLED ON EVERY PATH, including the forced one. A verification child outlives its
   * parent by default — it is reparented, not stopped — so an interrupt that skipped this would
   * leave a `pnpm test` compiling in a worktree the operator has already walked away from.
   */
  const settle = (outcome: (childrenKilled: number) => ShutdownOutcome): void => {
    if (settled) return;
    settled = true;
    const childrenKilled = deps.terminateChildren();
    const result = outcome(childrenKilled);
    const children = childrenKilled > 0 ? ` Killed ${childrenKilled} running child process(es).` : "";
    if (result.kind === "retained") {
      deps.write(
        result.retained > 0
          ? `ikbi: retained ${result.retained} in-progress workspace(s) — inspect with \`ikbi workspace ls\`.${children}\n`
          : `ikbi: nothing in progress to retain.${children}\n`,
      );
    } else if (result.kind === "forced") {
      // NOT "retained". The window expired with the retain still running, so some workspace may
      // still be recorded `allocated` with its worktree on disk. Naming the reclaim command is the
      // difference between an operator who knows what to do and one who finds a mystery later.
      deps.write(
        `ikbi: ${signal} — retention did not finish within ${windowMs}ms; forcing exit.${children}\n` +
          `ikbi: some workspaces may still be recorded in progress — reconcile with \`ikbi workspace ls\` / \`ikbi clean\`.\n`,
      );
    } else {
      deps.write(
        `ikbi: ${signal} — retention failed; exiting.${children}\n` +
          `ikbi: work is still on disk — inspect with \`ikbi workspace ls\`.\n`,
      );
    }
    deps.exit(exitCode);
  };

  const forceTimer = deps.setTimer(() => settle((childrenKilled) => ({ kind: "forced", childrenKilled })), windowMs);
  // Unref'd so the timer itself never keeps an otherwise-finished process alive for the full window.
  forceTimer.unref?.();

  void deps
    .retainAllLive(`interrupted by ${signal}`)
    .then((retained) => {
      settle((childrenKilled) => ({ kind: "retained", retained, childrenKilled }));
    })
    .catch(() => {
      settle((childrenKilled) => ({ kind: "failed", childrenKilled }));
    });
}

export interface InstallSignalShutdownDeps extends ShutdownDeps {
  /** Register the handler. Injected so a test never installs a real process-wide handler. */
  on(signal: string, handler: () => void): void;
}

/**
 * Install the bounded handler for `signal`.
 *
 * The FIRST signal announces itself and starts the bounded retention. A SECOND one exits at once —
 * the operator has said they are done waiting, and the announcement promised exactly that.
 */
export function installSignalShutdown(
  signal: string,
  exitCode: number,
  announce: string,
  deps: InstallSignalShutdownDeps,
): void {
  let shuttingDown = false;
  deps.on(signal, () => {
    if (shuttingDown) {
      deps.exit(exitCode);
      return;
    }
    shuttingDown = true;
    if (announce.length > 0) deps.write(announce);
    runBoundedShutdown(signal, exitCode, deps);
  });
}
