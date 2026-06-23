/**
 * ikbi notebook_edit tool tests — read / insert / edit / delete over .ipynb, confinement, errors.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runNotebookEdit } from "./notebook-tools.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ikbi-nb-"));
}

function sampleNotebook(): string {
  return JSON.stringify({
    cells: [
      { cell_type: "markdown", metadata: {}, source: ["# Title\n"] },
      { cell_type: "code", metadata: {}, execution_count: 1, outputs: [{ output_type: "stream", name: "stdout", text: ["hello\n"] }], source: ["print('hello')\n"] },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
}

test("read: lists cells with index, type, source, and outputs", () => {
  const dir = tmp();
  writeFileSync(join(dir, "nb.ipynb"), sampleNotebook());
  const res = runNotebookEdit(dir, { path: "nb.ipynb", operation: "read" });
  assert.equal(res.rejection, undefined);
  assert.match(res.output, /2 cell\(s\)/);
  assert.match(res.output, /cell \[0\] \(markdown\)/);
  assert.match(res.output, /cell \[1\] \(code\)/);
  assert.match(res.output, /print\('hello'\)/);
  assert.match(res.output, /\[stream:stdout\] hello/);
});

test("insert: appends a code cell when cell_index omitted", () => {
  const dir = tmp();
  writeFileSync(join(dir, "nb.ipynb"), sampleNotebook());
  const res = runNotebookEdit(dir, { path: "nb.ipynb", operation: "insert", source: "x = 1" });
  assert.equal(res.wrote, "nb.ipynb");
  const nb = JSON.parse(readFileSync(join(dir, "nb.ipynb"), "utf8"));
  assert.equal(nb.cells.length, 3);
  assert.equal(nb.cells[2].cell_type, "code");
  assert.deepEqual(nb.cells[2].source, ["x = 1"]);
  assert.deepEqual(nb.cells[2].outputs, []);
});

test("insert: positions a markdown cell at an index", () => {
  const dir = tmp();
  writeFileSync(join(dir, "nb.ipynb"), sampleNotebook());
  runNotebookEdit(dir, { path: "nb.ipynb", operation: "insert", cell_index: 0, cell_type: "markdown", source: "## intro\nmore" });
  const nb = JSON.parse(readFileSync(join(dir, "nb.ipynb"), "utf8"));
  assert.equal(nb.cells.length, 3);
  assert.equal(nb.cells[0].cell_type, "markdown");
  assert.deepEqual(nb.cells[0].source, ["## intro\n", "more"]);
});

test("insert: creates a fresh notebook when file does not exist", () => {
  const dir = tmp();
  const res = runNotebookEdit(dir, { path: "new.ipynb", operation: "insert", source: "print(1)" });
  assert.equal(res.wrote, "new.ipynb");
  const nb = JSON.parse(readFileSync(join(dir, "new.ipynb"), "utf8"));
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.cells.length, 1);
});

test("edit: replaces source and clears stale code outputs", () => {
  const dir = tmp();
  writeFileSync(join(dir, "nb.ipynb"), sampleNotebook());
  const res = runNotebookEdit(dir, { path: "nb.ipynb", operation: "edit", cell_index: 1, source: "print('bye')" });
  assert.equal(res.wrote, "nb.ipynb");
  const nb = JSON.parse(readFileSync(join(dir, "nb.ipynb"), "utf8"));
  assert.deepEqual(nb.cells[1].source, ["print('bye')"]);
  assert.deepEqual(nb.cells[1].outputs, []);
  assert.equal(nb.cells[1].execution_count, null);
});

test("edit: out-of-range index is rejected", () => {
  const dir = tmp();
  writeFileSync(join(dir, "nb.ipynb"), sampleNotebook());
  const res = runNotebookEdit(dir, { path: "nb.ipynb", operation: "edit", cell_index: 9, source: "x" });
  assert.notEqual(res.rejection, undefined);
  assert.match(res.output, /out of range/);
});

test("delete: removes the cell at an index", () => {
  const dir = tmp();
  writeFileSync(join(dir, "nb.ipynb"), sampleNotebook());
  const res = runNotebookEdit(dir, { path: "nb.ipynb", operation: "delete", cell_index: 0 });
  assert.equal(res.wrote, "nb.ipynb");
  const nb = JSON.parse(readFileSync(join(dir, "nb.ipynb"), "utf8"));
  assert.equal(nb.cells.length, 1);
  assert.equal(nb.cells[0].cell_type, "code");
});

test("rejects a non-.ipynb path", () => {
  const dir = tmp();
  const res = runNotebookEdit(dir, { path: "notebook.txt", operation: "read" });
  assert.notEqual(res.rejection, undefined);
  assert.match(res.output, /only operates on \.ipynb/);
});

test("rejects a path escaping the worktree", () => {
  const dir = tmp();
  const res = runNotebookEdit(dir, { path: "../escape.ipynb", operation: "read" });
  assert.notEqual(res.rejection, undefined);
  assert.match(res.output, /escapes the worktree/);
});

test("rejects a missing operation", () => {
  const dir = tmp();
  const res = runNotebookEdit(dir, { path: "nb.ipynb" });
  assert.notEqual(res.rejection, undefined);
  assert.match(res.output, /requires an 'operation'/);
});

test("read: corrupt JSON is reported, not thrown", () => {
  const dir = tmp();
  writeFileSync(join(dir, "bad.ipynb"), "{ not json");
  const res = runNotebookEdit(dir, { path: "bad.ipynb", operation: "read" });
  assert.notEqual(res.rejection, undefined);
  assert.match(res.output, /not a valid \.ipynb/);
});

test("edit: changing cell_type code→markdown drops code-only fields", () => {
  const dir = tmp();
  writeFileSync(join(dir, "nb.ipynb"), sampleNotebook());
  runNotebookEdit(dir, { path: "nb.ipynb", operation: "edit", cell_index: 1, cell_type: "markdown", source: "# now md" });
  const nb = JSON.parse(readFileSync(join(dir, "nb.ipynb"), "utf8"));
  assert.equal(nb.cells[1].cell_type, "markdown");
  assert.equal(nb.cells[1].outputs, undefined);
  assert.equal(nb.cells[1].execution_count, undefined);
});
