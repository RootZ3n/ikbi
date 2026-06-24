/**
 * ikbi project-detection — public surface.
 *
 * Auto-detects a repo's language(s), framework(s), test runner(s), and build tool from its
 * on-disk marker files. Used by `ikbi detect`, `ikbi doctor` (project-type line), and the
 * REPL welcome banner. No network, no process spawn — pure over an injectable fs port.
 */

export {
  detectProject,
  detectLiveProject,
  liveDetectPorts,
  summarize,
  type DetectPorts,
  type ProjectDetection,
} from "./detect.js";
