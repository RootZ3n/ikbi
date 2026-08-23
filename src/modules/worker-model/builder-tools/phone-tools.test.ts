/**
 * ikbi phone_* tool group — governed Android device control.
 *
 * These tests drive the runners against a governed-exec SPY (no real Termux/ssh): they assert the
 * exact binary + literal args each tool sends, that captures are worktree-confined, that the tools
 * FAIL CLOSED without a parent identity, that a denied/failed ExecResult surfaces cleanly, and that
 * the ssh transport wraps commands for a remote phone. The device is never touched.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { labTempDir as tmpdir } from "../../../core/temp-root.js";
import { join } from "node:path";
import { test } from "node:test";

import type { OperationContext } from "../../../core/identity/index.js";
import type { ExecRequest, ExecResult } from "../../governed-exec/index.js";
import {
  resolvePhoneTransport,
  runPhoneBattery,
  runPhoneLocation,
  runPhoneNotify,
  runPhoneReadSensor,
  runPhoneReadText,
  runPhoneRecordAudio,
  runPhoneSpeak,
  runPhoneTakePhoto,
  runPhoneTorch,
  type PhoneDeps,
  type PhoneTransport,
} from "./phone-tools.js";

const FAKE_CTX = { requestId: "r" } as unknown as OperationContext;

/** A governed-exec spy: records each request, returns a configurable result. */
function execSpy(result: ExecResult = { executed: true, exitCode: 0, stdoutTail: "", stderrTail: "" }) {
  const calls: ExecRequest[] = [];
  return {
    calls,
    exec: { run: async (req: ExecRequest): Promise<ExecResult> => { calls.push(req); return result; } },
  };
}

function worktree(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "ikbi-phone-")));
}

function deps(spy: ReturnType<typeof execSpy>, wt: string, extra: Partial<PhoneDeps> = {}): PhoneDeps {
  return { governedExec: spy.exec, parentCtx: FAKE_CTX, worktreeReal: wt, ...extra };
}

// ── take_photo ────────────────────────────────────────────────────────────────

test("phone_take_photo: back lens → termux-camera-photo -c 0 <confined path>, with a vision hint", async () => {
  const wt = worktree();
  const spy = execSpy();
  const out = await runPhoneTakePhoto(deps(spy, wt), {});
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0]?.command, "termux-camera-photo");
  assert.equal(spy.calls[0]?.args[0], "-c");
  assert.equal(spy.calls[0]?.args[1], "0");
  assert.ok(spy.calls[0]?.args[2]?.startsWith(wt), "the save path is confined under the worktree");
  assert.match(out, /Saved photo \(lens=back\)/);
  assert.match(out, /vision_analyze/);
});

test("phone_take_photo: front lens selects camera 1", async () => {
  const wt = worktree();
  const spy = execSpy();
  await runPhoneTakePhoto(deps(spy, wt), { lens: "front" });
  assert.equal(spy.calls[0]?.args[1], "1");
});

test("phone_take_photo: a save_path that escapes the worktree is refused and never runs", async () => {
  const wt = worktree();
  const spy = execSpy();
  const out = await runPhoneTakePhoto(deps(spy, wt), { save_path: "../escape.jpg" });
  assert.match(out, /ERROR/);
  assert.equal(spy.calls.length, 0, "an escaping capture never reaches governed-exec");
});

test("phone_take_photo: fails closed without a parent identity", async () => {
  const wt = worktree();
  const spy = execSpy();
  const out = await runPhoneTakePhoto({ governedExec: spy.exec, worktreeReal: wt }, {});
  assert.match(out, /no parent identity/);
  assert.equal(spy.calls.length, 0);
});

test("phone_take_photo: ssh transport wraps the command for a remote phone", async () => {
  const wt = worktree();
  const spy = execSpy();
  const transport: PhoneTransport = { kind: "ssh", host: "pixel" };
  await runPhoneTakePhoto(deps(spy, wt, { transport }), {});
  assert.equal(spy.calls[0]?.command, "ssh");
  assert.equal(spy.calls[0]?.args[0], "pixel");
  assert.equal(spy.calls[0]?.args[1], "termux-camera-photo");
  assert.equal(spy.calls[0]?.args[2], "-c");
});

// ── record_audio ────────────────────────────────────────────────────────────────

test("phone_record_audio: clamps seconds and builds -l/-f", async () => {
  const wt = worktree();
  const spy = execSpy();
  await runPhoneRecordAudio(deps(spy, wt), { seconds: 9999 });
  assert.equal(spy.calls[0]?.command, "termux-microphone-record");
  assert.deepEqual(spy.calls[0]?.args.slice(0, 2), ["-l", "300"], "seconds clamps to the 300s ceiling");
  assert.equal(spy.calls[0]?.args[2], "-f");
  assert.ok(spy.calls[0]?.args[3]?.startsWith(wt));
});

test("phone_record_audio: default duration is 10s", async () => {
  const wt = worktree();
  const spy = execSpy();
  await runPhoneRecordAudio(deps(spy, wt), {});
  assert.equal(spy.calls[0]?.args[1], "10");
});

// ── read_sensor ────────────────────────────────────────────────────────────────

test("phone_read_sensor: a named sensor → -s <name> -n <samples>, echoing the JSON", async () => {
  const wt = worktree();
  const spy = execSpy({ executed: true, exitCode: 0, stdoutTail: '{"light":{"values":[42]}}' });
  const out = await runPhoneReadSensor(deps(spy, wt), { sensor: "light", samples: 3 });
  assert.deepEqual(spy.calls[0]?.args, ["-s", "light", "-n", "3"]);
  assert.match(out, /light/);
});

test("phone_read_sensor: no sensor (or 'list') enumerates with -l", async () => {
  const wt = worktree();
  const spy = execSpy({ executed: true, exitCode: 0, stdoutTail: "accelerometer\nlight" });
  const listed = await runPhoneReadSensor(deps(spy, wt), {});
  assert.deepEqual(spy.calls[0]?.args, ["-l"]);
  assert.match(listed, /Available sensors/);
  const explicit = await runPhoneReadSensor(deps(spy, wt), { sensor: "list" });
  assert.deepEqual(spy.calls[1]?.args, ["-l"]);
  assert.match(explicit, /Available sensors/);
});

// ── read_text (OCR) ────────────────────────────────────────────────────────────

test("phone_read_text: OCRs a confined image path via `tesseract <path> stdout`, echoing the text", async () => {
  const wt = worktree();
  const spy = execSpy({ executed: true, exitCode: 0, stdoutTail: "How do I improve my homelab?" });
  const out = await runPhoneReadText(deps(spy, wt), { path: "phone-captures/upload-1.png" });
  assert.equal(spy.calls[0]?.command, "tesseract");
  assert.equal(spy.calls[0]?.args[1], "stdout");
  assert.ok(spy.calls[0]?.args[0]?.startsWith(wt), "the image path is confined under the worktree");
  assert.match(out, /improve my homelab/);
});

test("phone_read_text: a path escaping the worktree is refused and never runs", async () => {
  const wt = worktree();
  const spy = execSpy();
  const out = await runPhoneReadText(deps(spy, wt), { path: "../secret.png" });
  assert.match(out, /ERROR/);
  assert.equal(spy.calls.length, 0);
});

// ── location / battery ────────────────────────────────────────────────────────

test("phone_location: valid provider passes through, junk falls back to gps", async () => {
  const wt = worktree();
  const spy = execSpy({ executed: true, exitCode: 0, stdoutTail: '{"latitude":1}' });
  await runPhoneLocation(deps(spy, wt), { provider: "network" });
  assert.deepEqual(spy.calls[0]?.args, ["-p", "network"]);
  await runPhoneLocation(deps(spy, wt), { provider: "nonsense" });
  assert.deepEqual(spy.calls[1]?.args, ["-p", "gps"]);
});

test("phone_battery: no-arg status read, JSON echoed", async () => {
  const wt = worktree();
  const spy = execSpy({ executed: true, exitCode: 0, stdoutTail: '{"percentage":88,"temperature":31.2}' });
  const out = await runPhoneBattery(deps(spy, wt), {});
  assert.equal(spy.calls[0]?.command, "termux-battery-status");
  assert.deepEqual(spy.calls[0]?.args, []);
  assert.match(out, /percentage/);
});

// ── speak / notify / torch ────────────────────────────────────────────────────

test("phone_speak: passes text as a SINGLE literal arg (no shell splitting)", async () => {
  const wt = worktree();
  const spy = execSpy();
  await runPhoneSpeak(deps(spy, wt), { text: "hello there; rm -rf /" });
  assert.equal(spy.calls[0]?.command, "termux-tts-speak");
  assert.deepEqual(spy.calls[0]?.args, ["hello there; rm -rf /"], "the whole phrase is one argv entry — no metachar interpretation");
});

test("phone_speak: empty text is refused", async () => {
  const wt = worktree();
  const spy = execSpy();
  const out = await runPhoneSpeak(deps(spy, wt), { text: "  " });
  assert.match(out, /requires non-empty/);
  assert.equal(spy.calls.length, 0);
});

test("phone_notify: builds --title/--content, defaulting the title", async () => {
  const wt = worktree();
  const spy = execSpy();
  await runPhoneNotify(deps(spy, wt), { content: "build done" });
  assert.deepEqual(spy.calls[0]?.args, ["--title", "Pehlichi", "--content", "build done"]);
});

test("phone_torch: on by default, off when on=false", async () => {
  const wt = worktree();
  const spy = execSpy();
  await runPhoneTorch(deps(spy, wt), {});
  assert.deepEqual(spy.calls[0]?.args, ["on"]);
  await runPhoneTorch(deps(spy, wt), { on: false });
  assert.deepEqual(spy.calls[1]?.args, ["off"]);
});

// ── result formatting (denied / failed) ────────────────────────────────────────

test("formatting: a denied ExecResult surfaces DENIED", async () => {
  const wt = worktree();
  const spy = execSpy({ executed: false, denied: true, reason: "binary not allowlisted" });
  const out = await runPhoneBattery(deps(spy, wt), {});
  assert.match(out, /DENIED: binary not allowlisted/);
});

test("formatting: a non-zero exit is an ERROR with the stderr tail + a Termux:API hint", async () => {
  const wt = worktree();
  const spy = execSpy({ executed: true, exitCode: 1, stderrTail: "Permission denied" });
  const out = await runPhoneTakePhoto(deps(spy, wt), {});
  assert.match(out, /ERROR: phone command exited 1/);
  assert.match(out, /Permission denied/);
  assert.match(out, /Termux:API/);
});

// ── transport resolution ────────────────────────────────────────────────────────

test("resolvePhoneTransport: IKBI_PHONE_SSH_HOST → ssh transport; unset → undefined (local)", () => {
  assert.equal(resolvePhoneTransport({}), undefined);
  assert.equal(resolvePhoneTransport({ IKBI_PHONE_SSH_HOST: "  " }), undefined);
  assert.deepEqual(resolvePhoneTransport({ IKBI_PHONE_SSH_HOST: "user@100.1.2.3" }), { kind: "ssh", host: "user@100.1.2.3" });
});
