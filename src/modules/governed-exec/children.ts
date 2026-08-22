/**
 * The LIVE EXEC CHILDREN registry.
 *
 * A governed exec is a child process this process started and is responsible for. While ikbi is
 * running, each one ends on its own or is killed by its timeout. On SHUTDOWN neither happens: the
 * parent exits, the child is reparented to init, and a `pnpm test` or a compile keeps burning CPU
 * in a worktree nobody is watching any more — after the operator asked ikbi to stop.
 *
 * WHY A REGISTRY AND NOT THE PROCESS GROUP. The two exec primitives sit on opposite sides of that
 * question. The streaming primitive spawns `detached`, deliberately, so a runaway tree can be
 * killed whole — which also means a terminal's Ctrl-C, delivered to the foreground process GROUP,
 * never reaches it. The buffered primitive does not detach, so a TTY Ctrl-C does reach it, but a
 * signal sent to the pid alone (systemd, `kill -INT`, an orchestrator, a supervisor) does not.
 * There is no single group whose members are exactly "the children ikbi owns", so ikbi tracks them.
 *
 * DELIBERATELY MODULE-LEVEL. Every exec in a process must be reachable from the one shutdown path,
 * and an executor-instance registry would only cover the children that one instance spawned —
 * which is the gap that let the streaming jobs' own kill facility miss the verification children.
 */

/** The slice of a child process this registry needs. Structural, so a fake can stand in. */
export interface TrackedChild {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** How a live child is to be signalled: its own group, or just itself. */
interface Entry {
  readonly child: TrackedChild;
  readonly detached: boolean;
}

const live = new Set<Entry>();

/**
 * Track `child` until `release()` is called.
 *
 * `detached` must say truthfully whether the child leads its own process group, because that
 * decides whether its grandchildren can be reached. Guessing here would mean either failing to
 * kill a tree or signalling a group that includes US.
 */
export function trackExecChild(child: TrackedChild, opts: { detached: boolean }): () => void {
  const entry: Entry = { child, detached: opts.detached };
  live.add(entry);
  return () => {
    live.delete(entry);
  };
}

/** How many governed exec children are live right now. For assertions and shutdown reporting. */
export function liveExecChildCount(): number {
  return live.size;
}

/**
 * Kill every live governed exec child and forget them. Returns how many were signalled.
 *
 * SIGKILL, not SIGTERM: this runs inside a shutdown that is already bounded and about to call
 * `process.exit`, so there is no window in which a child could honor a polite signal, and a
 * graceful request nobody waits for is just a leak with better manners.
 *
 * Never throws. A child that died between the check and the kill is the ordinary case, not an
 * error, and a shutdown that failed because cleanup was too slow is worse than a missed kill.
 */
export function terminateLiveExecChildren(
  killGroup: (pid: number) => void = (pid) => process.kill(-pid, "SIGKILL"),
): number {
  let signalled = 0;
  for (const entry of [...live]) {
    live.delete(entry);
    const { child, detached } = entry;
    try {
      if (detached && child.pid !== undefined) killGroup(child.pid);
      else child.kill("SIGKILL");
      signalled += 1;
    } catch {
      // Already gone, or the group vanished mid-kill. Best effort by construction.
      try {
        child.kill("SIGKILL");
        signalled += 1;
      } catch {
        /* nothing left to reclaim */
      }
    }
  }
  return signalled;
}

/** Drop every tracked child WITHOUT killing it. Tests only — keeps suites from leaking into each other. */
export function resetExecChildRegistry(): void {
  live.clear();
}
