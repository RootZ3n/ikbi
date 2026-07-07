/**
 * ikbi builder/chat tool group — phone_* (GOVERNED Android device control).
 *
 * Gives the agent (Pehlichi) a governed BODY on an Android phone running Termux +
 * Termux:API: camera, microphone, sensors, GPS, battery/thermal, speech, notifications,
 * and torch. EVERY action runs through the SAME governed-exec path the `terminal` tool
 * uses — gate-walled, allowlisted (the termux-* binaries are on the default-deny list),
 * array-args only (execFile, NO shell metacharacters), worktree-confined, and receipted.
 * The capture tools write ONLY into the worktree (shared confinePath); a saved photo is
 * then perceived with `vision_analyze`, closing the perceive→reason loop on-device.
 *
 * TRANSPORT: by default commands run LOCALLY — ikbi hosted on the phone in Termux, the
 * Phase-A "phone stands alone" target (no PC, and with a local model, no network). A
 * remote { kind:"ssh", host } transport wraps each call as `ssh <host> termux-…` so a
 * PC-hosted ikbi can drive the phone during development. NOTE: the remote login shell
 * word-splits the joined command, so remote save paths must not contain spaces; the
 * LOCAL path is fully quote-safe via execFile.
 *
 * FAIL-CLOSED: without a parent identity (parentCtx) governed-exec cannot authorize, so
 * every tool refuses — exactly like terminal / run_checks. TRUST: all device output
 * (sensor JSON, a captured image, a location fix) is UNTRUSTED data → the caller feeds
 * the result string back through the neutralization chokepoint. This module only
 * PRODUCES result strings; it never builds a message and never throws past the boundary.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { OperationContext } from "../../../core/identity/index.js";
import type { ModelTool } from "../../../core/provider/contract.js";
import type { ExecResult, GovernedExec } from "../../governed-exec/index.js";
import { confinePath } from "./confine.js";

/** How a phone command reaches the device: LOCAL (ikbi on the phone) or over SSH (ikbi on a PC). */
export type PhoneTransport = { readonly kind: "local" } | { readonly kind: "ssh"; readonly host: string };

const LOCAL_TRANSPORT: PhoneTransport = { kind: "local" };

/** What the phone tools need: the governed executor, the run's identity, and the worktree. */
export interface PhoneDeps {
  readonly governedExec: Pick<GovernedExec, "run">;
  /** The run's validated OperationContext. Absent ⇒ the tool fails closed (cannot authorize). */
  readonly parentCtx?: OperationContext;
  /** The realpath'd worktree — captures are confined here and the OS sandbox keeps ONLY it writable. */
  readonly worktreeReal: string;
  /** Transport to the device. Absent ⇒ LOCAL (the on-device Phase-A target). */
  readonly transport?: PhoneTransport;
}

/** Default worktree-relative locations for captured media. */
const DEFAULT_PHOTO_PATH = "phone-captures/photo.jpg";
const DEFAULT_AUDIO_PATH = "phone-captures/audio.m4a";

/** Audio recording bounds (seconds) — a capture MUST be finite. */
const DEFAULT_RECORD_SECONDS = 10;
const MIN_RECORD_SECONDS = 1;
const MAX_RECORD_SECONDS = 300;

/** Sensor sampling bounds — a read MUST terminate (termux-sensor otherwise streams forever). */
const DEFAULT_SENSOR_SAMPLES = 1;
const MAX_SENSOR_SAMPLES = 20;

const NO_IDENTITY =
  "ERROR: phone tools are unavailable (no parent identity wired to authorize the governed device command).";

// ── argument coercion ─────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(hi, Math.max(lo, n));
}

// ── transport + execution ─────────────────────────────────────────────────────

/** Wrap a termux invocation for the configured transport into a governed { command, args }. */
function wrapExec(transport: PhoneTransport, binary: string, args: readonly string[]): { command: string; args: string[] } {
  if (transport.kind === "ssh") {
    // `ssh <host> termux-… arg …` — the remote login shell runs it (space-free paths only, see header).
    return { command: "ssh", args: [transport.host, binary, ...args] };
  }
  return { command: binary, args: [...args] };
}

/**
 * Ensure the parent directory of a LOCAL capture path exists (termux-* will not create it).
 * Remote transports own their own filesystem, so this is a no-op there. Best-effort — a real
 * failure surfaces as a non-zero exit from the device command, not a thrown error here.
 */
function ensureParentDir(transport: PhoneTransport, full: string): void {
  if (transport.kind !== "local") return;
  try {
    mkdirSync(dirname(full), { recursive: true });
  } catch {
    /* best-effort; the exec result reports the real failure */
  }
}

/** Run one governed termux command and return its raw ExecResult. Never throws past the boundary. */
async function execPhone(
  deps: PhoneDeps,
  ctx: OperationContext,
  binary: string,
  cmdArgs: readonly string[],
  purpose: string,
): Promise<ExecResult> {
  const transport = deps.transport ?? LOCAL_TRANSPORT;
  const wrapped = wrapExec(transport, binary, cmdArgs);
  try {
    return await deps.governedExec.run({
      parentCtx: ctx,
      command: wrapped.command,
      args: wrapped.args,
      cwd: deps.worktreeReal,
      worktreeRoot: deps.worktreeReal, // OS sandbox keeps ONLY the worktree writable (F1)
      purpose,
    });
  } catch (e) {
    return { executed: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Render a governed ExecResult into a bounded, model-readable string. */
function formatPhoneResult(result: ExecResult, successMsg: string, opts: { includeStdout?: boolean } = {}): string {
  if (result.denied === true) {
    return `DENIED: ${result.reason ?? "the governed executor refused the device command"}`;
  }
  if (!result.executed) {
    return `ERROR: phone command did not execute${result.reason !== undefined ? `: ${result.reason}` : ""}`;
  }
  if ((result.exitCode ?? 0) !== 0) {
    const err = result.stderrTail !== undefined && result.stderrTail.length > 0 ? `: ${result.stderrTail}` : "";
    return `ERROR: phone command exited ${result.exitCode ?? -1}${err} — is Termux:API installed and the permission granted for this capability?`;
  }
  if (opts.includeStdout === true && result.stdoutTail !== undefined && result.stdoutTail.length > 0) {
    return `${successMsg}\n${result.stdoutTail}`;
  }
  return successMsg;
}

// ── tool definitions ──────────────────────────────────────────────────────────

export const phoneTakePhotoTool: ModelTool = {
  name: "phone_take_photo",
  description:
    "Take a photo with the phone's camera (Termux:API). The image is saved into the working directory; then call vision_analyze with the returned path to SEE it. Choose the lens with `lens`.",
  parameters: {
    type: "object",
    properties: {
      lens: { type: "string", description: "'back' (default) or 'front'." },
      save_path: { type: "string", description: `Working-directory-relative path to save the JPEG. Default '${DEFAULT_PHOTO_PATH}'.` },
    },
    required: [],
  },
};

export const phoneRecordAudioTool: ModelTool = {
  name: "phone_record_audio",
  description:
    "Record audio from the phone's microphone for a fixed number of seconds (Termux:API). The recording is time-limited and the file completes after the limit elapses; then read/transcribe it. Returns the saved path.",
  parameters: {
    type: "object",
    properties: {
      seconds: { type: "number", description: `Recording length in seconds (${MIN_RECORD_SECONDS}-${MAX_RECORD_SECONDS}, default ${DEFAULT_RECORD_SECONDS}).` },
      save_path: { type: "string", description: `Working-directory-relative path to save the audio. Default '${DEFAULT_AUDIO_PATH}'.` },
    },
    required: [],
  },
};

export const phoneReadSensorTool: ModelTool = {
  name: "phone_read_sensor",
  description:
    "Read a hardware sensor (accelerometer, gyroscope, light, proximity, magnetometer, …) via Termux:API and return its JSON values. Pass sensor='list' (or omit it) to list the sensors the device exposes.",
  parameters: {
    type: "object",
    properties: {
      sensor: { type: "string", description: "Sensor name to read, or 'list' to enumerate available sensors." },
      samples: { type: "number", description: `Number of readings to take before stopping (1-${MAX_SENSOR_SAMPLES}, default ${DEFAULT_SENSOR_SAMPLES}).` },
    },
    required: [],
  },
};

export const phoneLocationTool: ModelTool = {
  name: "phone_location",
  description: "Get the phone's current location (GPS/network) via Termux:API and return the JSON fix (latitude, longitude, accuracy, …).",
  parameters: {
    type: "object",
    properties: {
      provider: { type: "string", description: "'gps' (default), 'network', or 'passive'." },
    },
    required: [],
  },
};

export const phoneBatteryTool: ModelTool = {
  name: "phone_battery",
  description: "Read the phone's battery + thermal status (percentage, charging state, temperature, health) via Termux:API. Returns JSON — useful for the agent to monitor its own device's health.",
  parameters: { type: "object", properties: {}, required: [] },
};

export const phoneSpeakTool: ModelTool = {
  name: "phone_speak",
  description: "Speak text aloud through the phone's speaker (Termux:API text-to-speech). The agent's voice OUT.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to speak." },
    },
    required: ["text"],
  },
};

export const phoneNotifyTool: ModelTool = {
  name: "phone_notify",
  description: "Post an Android notification on the phone (Termux:API). Use to surface something to the human holding the device.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "The notification body." },
      title: { type: "string", description: "The notification title. Default 'Pehlichi'." },
    },
    required: ["content"],
  },
};

export const phoneTorchTool: ModelTool = {
  name: "phone_torch",
  description: "Turn the phone's camera flashlight (torch) on or off via Termux:API.",
  parameters: {
    type: "object",
    properties: {
      on: { type: "boolean", description: "true to turn the torch ON (default), false to turn it OFF." },
    },
    required: [],
  },
};

export const phoneReadTextTool: ModelTool = {
  name: "phone_read_text",
  description:
    "Extract text from an image using FAST on-device OCR (tesseract). Best for SCREENSHOTS, documents, receipts, or any text-heavy image — far faster and cheaper than vision_analyze. Give a working-directory-relative image path (e.g. an uploaded screenshot). Returns the recognized text.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Working-directory-relative path to the image to read (e.g. 'phone-captures/upload-1.png')." },
    },
    required: ["path"],
  },
};

/** Every phone tool definition — spread into the chat/builder tool arrays. */
export const PHONE_TOOLS: readonly ModelTool[] = [
  phoneTakePhotoTool,
  phoneRecordAudioTool,
  phoneReadSensorTool,
  phoneReadTextTool,
  phoneLocationTool,
  phoneBatteryTool,
  phoneSpeakTool,
  phoneNotifyTool,
  phoneTorchTool,
];

/** The set of phone tool names — for permission gating + dispatch routing. */
export const PHONE_TOOL_NAMES: ReadonlySet<string> = new Set(PHONE_TOOLS.map((t) => t.name));

// ── runners ───────────────────────────────────────────────────────────────────

export async function runPhoneTakePhoto(deps: PhoneDeps, args: Record<string, unknown>): Promise<string> {
  if (deps.parentCtx === undefined) return NO_IDENTITY;
  const lens = str(args.lens) === "front" ? "front" : "back";
  const cameraId = lens === "front" ? "1" : "0";
  const save = str(args.save_path) || DEFAULT_PHOTO_PATH;
  const c = confinePath(deps.worktreeReal, save);
  if (!c.ok) return `ERROR: ${c.error}`;
  ensureParentDir(deps.transport ?? LOCAL_TRANSPORT, c.full);
  const r = await execPhone(deps, deps.parentCtx, "termux-camera-photo", ["-c", cameraId, c.full], `phone_take_photo (${lens})`);
  return formatPhoneResult(r, `Saved photo (lens=${lens}) to ${c.rel}. Use vision_analyze with image_url="${c.rel}" to see it.`);
}

export async function runPhoneRecordAudio(deps: PhoneDeps, args: Record<string, unknown>): Promise<string> {
  if (deps.parentCtx === undefined) return NO_IDENTITY;
  const seconds = clampInt(args.seconds, DEFAULT_RECORD_SECONDS, MIN_RECORD_SECONDS, MAX_RECORD_SECONDS);
  const save = str(args.save_path) || DEFAULT_AUDIO_PATH;
  const c = confinePath(deps.worktreeReal, save);
  if (!c.ok) return `ERROR: ${c.error}`;
  ensureParentDir(deps.transport ?? LOCAL_TRANSPORT, c.full);
  const r = await execPhone(deps, deps.parentCtx, "termux-microphone-record", ["-l", String(seconds), "-f", c.full], `phone_record_audio (${seconds}s)`);
  return formatPhoneResult(
    r,
    `Recording ~${seconds}s of audio to ${c.rel}. The file completes after the limit elapses — read or transcribe it after that.`,
  );
}

export async function runPhoneReadSensor(deps: PhoneDeps, args: Record<string, unknown>): Promise<string> {
  if (deps.parentCtx === undefined) return NO_IDENTITY;
  const sensor = str(args.sensor);
  if (sensor === "" || sensor.toLowerCase() === "list") {
    const r = await execPhone(deps, deps.parentCtx, "termux-sensor", ["-l"], "phone_read_sensor (list)");
    return formatPhoneResult(r, "Available sensors:", { includeStdout: true });
  }
  const samples = clampInt(args.samples, DEFAULT_SENSOR_SAMPLES, 1, MAX_SENSOR_SAMPLES);
  const r = await execPhone(deps, deps.parentCtx, "termux-sensor", ["-s", sensor, "-n", String(samples)], `phone_read_sensor (${sensor})`);
  return formatPhoneResult(r, `Sensor '${sensor}' (${samples} sample${samples === 1 ? "" : "s"}):`, { includeStdout: true });
}

export async function runPhoneLocation(deps: PhoneDeps, args: Record<string, unknown>): Promise<string> {
  if (deps.parentCtx === undefined) return NO_IDENTITY;
  const raw = str(args.provider).toLowerCase();
  const provider = raw === "network" || raw === "passive" ? raw : "gps";
  const r = await execPhone(deps, deps.parentCtx, "termux-location", ["-p", provider], `phone_location (${provider})`);
  return formatPhoneResult(r, `Location (provider=${provider}):`, { includeStdout: true });
}

export async function runPhoneBattery(deps: PhoneDeps, _args: Record<string, unknown>): Promise<string> {
  if (deps.parentCtx === undefined) return NO_IDENTITY;
  const r = await execPhone(deps, deps.parentCtx, "termux-battery-status", [], "phone_battery");
  return formatPhoneResult(r, "Battery/thermal status:", { includeStdout: true });
}

export async function runPhoneSpeak(deps: PhoneDeps, args: Record<string, unknown>): Promise<string> {
  if (deps.parentCtx === undefined) return NO_IDENTITY;
  const text = str(args.text);
  if (text === "") return "ERROR: phone_speak requires non-empty 'text'";
  const r = await execPhone(deps, deps.parentCtx, "termux-tts-speak", [text], "phone_speak");
  return formatPhoneResult(r, `Spoke: "${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`);
}

export async function runPhoneNotify(deps: PhoneDeps, args: Record<string, unknown>): Promise<string> {
  if (deps.parentCtx === undefined) return NO_IDENTITY;
  const content = str(args.content);
  if (content === "") return "ERROR: phone_notify requires non-empty 'content'";
  const title = str(args.title) || "Pehlichi";
  const r = await execPhone(deps, deps.parentCtx, "termux-notification", ["--title", title, "--content", content], "phone_notify");
  return formatPhoneResult(r, `Posted notification "${title}".`);
}

export async function runPhoneTorch(deps: PhoneDeps, args: Record<string, unknown>): Promise<string> {
  if (deps.parentCtx === undefined) return NO_IDENTITY;
  const on = args.on !== false; // default ON
  const r = await execPhone(deps, deps.parentCtx, "termux-torch", [on ? "on" : "off"], `phone_torch (${on ? "on" : "off"})`);
  return formatPhoneResult(r, `Torch ${on ? "ON" : "OFF"}.`);
}

export async function runPhoneReadText(deps: PhoneDeps, args: Record<string, unknown>): Promise<string> {
  if (deps.parentCtx === undefined) return NO_IDENTITY;
  const path = str(args.path);
  if (path === "") return "ERROR: phone_read_text requires a non-empty 'path'";
  const c = confinePath(deps.worktreeReal, path);
  if (!c.ok) return `ERROR: ${c.error}`;
  // `tesseract <image> stdout` prints the recognized text to stdout. The OCR'd text is UNTRUSTED
  // (an image can carry adversarial text) → the caller re-neutralizes it at the chokepoint.
  const r = await execPhone(deps, deps.parentCtx, "tesseract", [c.full, "stdout"], `phone_read_text (${c.rel})`);
  return formatPhoneResult(r, `Text extracted from ${c.rel}:`, { includeStdout: true });
}

/**
 * Resolve the device transport from the environment. Set IKBI_PHONE_SSH_HOST to drive a
 * REMOTE phone over SSH from a PC-hosted ikbi (e.g. a Tailscale host `phone` or `user@100.x.y.z`).
 * Unset ⇒ LOCAL (undefined here; runners default to on-device local execution).
 */
export function resolvePhoneTransport(env: NodeJS.ProcessEnv): PhoneTransport | undefined {
  const host = typeof env.IKBI_PHONE_SSH_HOST === "string" ? env.IKBI_PHONE_SSH_HOST.trim() : "";
  return host.length > 0 ? { kind: "ssh", host } : undefined;
}
