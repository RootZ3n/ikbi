import assert from "node:assert/strict";
import { test } from "node:test";

import { SYSTEM_ERROR_CATALOG, translateSystemError, errorCode } from "./user-facing.js";
import { translateError, formatFriendlyError } from "./translator.js";

/** Build a Node-shaped syscall error. */
function sysError(code: string, opts: { message?: string; path?: string; syscall?: string } = {}): Error {
  const e = new Error(opts.message ?? `${code}: something`) as Error & { code: string; path?: string; syscall?: string };
  e.code = code;
  if (opts.path !== undefined) e.path = opts.path;
  if (opts.syscall !== undefined) e.syscall = opts.syscall;
  return e;
}

test("catalog covers at least 20 codes", () => {
  assert.ok(Object.keys(SYSTEM_ERROR_CATALOG).length >= 20);
});

test("every catalog entry has a cause and a suggestion", () => {
  for (const [code, entry] of Object.entries(SYSTEM_ERROR_CATALOG)) {
    assert.ok(entry.cause.length > 0, `${code} has a cause`);
    assert.ok(entry.suggestion.length > 0, `${code} has a suggestion`);
  }
});

test("errorCode reads the syscall code", () => {
  assert.equal(errorCode(sysError("ENOENT")), "ENOENT");
  assert.equal(errorCode(new Error("plain")), undefined);
  assert.equal(errorCode("a string"), undefined);
});

test("EACCES translates to a permission message with the path", () => {
  const fe = translateSystemError(sysError("EACCES", { path: "/etc/foo", syscall: "open" }));
  assert.ok(fe !== undefined);
  assert.match(fe!.message, /Permission denied/);
  assert.match(fe!.message, /\/etc\/foo/);
  assert.match(fe!.suggestion, /permission/i);
});

test("ENOENT suggests checking the path / doctor --fix", () => {
  const fe = translateSystemError(sysError("ENOENT", { path: "/missing" }));
  assert.match(fe!.suggestion, /doctor --fix|path/);
});

test("ENOSPC suggests freeing disk space", () => {
  const fe = translateSystemError(sysError("ENOSPC"));
  assert.match(fe!.suggestion, /space|clean/i);
});

test("an unknown code returns undefined (caller falls back)", () => {
  assert.equal(translateSystemError(sysError("EWEIRD")), undefined);
  assert.equal(translateSystemError(new Error("no code")), undefined);
});

test("translateError uses the catalog for raw OS errors (no stack)", () => {
  const fe = translateError(sysError("EACCES", { path: "/x", message: "EACCES: permission denied, open '/x'" }));
  assert.match(fe.message, /Permission denied/);
  const rendered = formatFriendlyError(fe);
  assert.ok(!rendered.includes("at "), "no stack frames in the default rendering");
});

test("translateError keeps provider-aware handling over the catalog", () => {
  // ETIMEDOUT also lives in the catalog, but a model timeout should keep its provider message.
  const fe = translateError(sysError("ETIMEDOUT", { message: "request timed out" }));
  assert.equal(fe.category, "model_timeout");
});
