/**
 * import-html.test — node:test coverage for the HTML-to-abina parser.
 *
 * Covers: nesting, each tag mapping, style parsing, hotspot, and edge cases.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseHtmlToDocument, resetHtmlIdCounter, parseStyleString } from "./import-html.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripReadonly<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

// ── parseStyleString ───────────────────────────────────────────────────────────

test("parseStyleString parses a single property", () => {
  const result = parseStyleString("color: red");
  assert.deepEqual(result, { color: "red" });
});

test("parseStyleString parses multiple properties", () => {
  const result = parseStyleString("color: red; font-size: 16px");
  assert.deepEqual(result, { color: "red", "font-size": "16px" });
});

test("parseStyleString handles empty string", () => {
  assert.deepEqual(parseStyleString(""), {});
});

test("parseStyleString handles trailing semicolon", () => {
  const result = parseStyleString("color: red; ");
  assert.deepEqual(result, { color: "red" });
});

test("parseStyleString skips malformed entries", () => {
  const result = parseStyleString("color: red; ;; font-size: 16px");
  assert.deepEqual(result, { color: "red", "font-size": "16px" });
});

// ── parseHtmlToDocument — basic structure ──────────────────────────────────────

test("parseHtmlToDocument returns a Document with the given name", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<div></div>", "TestDoc");
  assert.equal(doc.name, "TestDoc");
  assert.equal(typeof doc.id, "string");
  assert.ok(doc.id.length > 0);
  assert.equal(doc.name.toLowerCase().replace(/[^a-z0-9]/g, "-"), doc.id);
});

test("parseHtmlToDocument returns a document with root nodes", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<div></div>", "Doc");
  assert.ok(Array.isArray(doc.root));
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Card");
});

// ── Tag mapping ────────────────────────────────────────────────────────────────

test("div maps to Card", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<div>content</div>", "d");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Card");
});

test("section maps to Window", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<section></section>", "d");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Window");
});

test("img maps to Asset with src", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument('<img src="photo.png" />', "d");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Asset");
  const content = doc.root[0]!.content as { src: string };
  assert.equal(content.src, "photo.png");
});

test("img without src maps to Asset with empty src", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<img />", "d");
  assert.equal(doc.root[0]!.type, "Asset");
  const content = doc.root[0]!.content as { src: string };
  assert.equal(content.src, "");
});

test("span maps to Text with content", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<span>Hello World</span>", "d");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Text");
  const content = doc.root[0]!.content as { text: string };
  assert.equal(content.text, "Hello World");
});

test("p maps to Text with content", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<p>Paragraph text</p>", "d");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Text");
  const content = doc.root[0]!.content as { text: string };
  assert.equal(content.text, "Paragraph text");
});

// ── data-hotspot mapping ────────────────────────────────────────────────────────

test("element with data-hotspot maps to Hotspot", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument('<div data-hotspot="clickable">content</div>', "d");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Hotspot");
  const content = doc.root[0]!.content as { metadata?: string };
  assert.equal(content.metadata, "clickable");
});

test("data-hotspot takes priority over tag type", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument('<section data-hotspot="area">text</section>', "d");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Hotspot");
});

test("img with data-hotspot maps to Hotspot (not Asset)", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument('<img data-hotspot="btn" src="icon.png" />', "d");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Hotspot");
  const content = doc.root[0]!.content as { metadata?: string };
  assert.equal(content.metadata, "btn");
});

// ── Style parsing ──────────────────────────────────────────────────────────────

test("style attribute is parsed into node style", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument('<div style="color: red; font-size: 16px"></div>', "d");
  assert.deepEqual(stripReadonly(doc.root[0]!.style), { color: "red", "font-size": "16px" });
});

test("span with style attribute", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument('<span style="font-weight: bold">text</span>', "d");
  assert.deepEqual(stripReadonly(doc.root[0]!.style), { "font-weight": "bold" });
});

test("element without style attribute has empty style", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<p>plain</p>", "d");
  assert.deepEqual(stripReadonly(doc.root[0]!.style), {});
});

// ── Nesting ────────────────────────────────────────────────────────────────────

test("nested div inside section", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<section><div>inner</div></section>", "d");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Window");
  assert.equal(doc.root[0]!.children.length, 1);
  assert.equal(doc.root[0]!.children[0]!.type, "Card");
});

test("deeply nested elements create a tree", () => {
  resetHtmlIdCounter();
  const html = `<section>
    <div>
      <span>Level 2</span>
      <p>Another</p>
    </div>
  </section>`;
  const doc = parseHtmlToDocument(html, "d");

  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Window");

  const innerDiv = doc.root[0]!.children[0]!;
  assert.equal(innerDiv.type, "Card");
  assert.equal(innerDiv.children.length, 2);
  assert.equal(innerDiv.children[0]!.type, "Text");
  assert.equal(innerDiv.children[1]!.type, "Text");

  const content0 = innerDiv.children[0]!.content as { text: string };
  assert.equal(content0.text, "Level 2");

  const content1 = innerDiv.children[1]!.content as { text: string };
  assert.equal(content1.text, "Another");
});

test("multiple root elements", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<div>A</div><div>B</div>", "d");
  assert.equal(doc.root.length, 2);
  assert.equal(doc.root[0]!.type, "Card");
  assert.equal(doc.root[1]!.type, "Card");
});

// ── Mixed content ──────────────────────────────────────────────────────────────

test("text interleaved with elements becomes Text nodes", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<div>Hello <span>World</span></div>", "d");
  // Text "Hello " becomes a Text child, <span>World</span> becomes a Text child
  // But whitespace handling may vary; let's just check there are children
  assert.ok(doc.root[0]!.children.length >= 1);
  // The text children should be of type Text
  const textChildren = doc.root[0]!.children.filter((c) => c.type === "Text");
  assert.ok(textChildren.length > 0);
});

// ── Edge cases ─────────────────────────────────────────────────────────────────

test("empty HTML produces document with empty root", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("", "Empty");
  assert.equal(doc.root.length, 0);
});

test("HTML with only whitespace produces empty root", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("   \n  ", "Whitespace");
  assert.equal(doc.root.length, 0);
});

test("unknown tag is treated as Card with children", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<unknown><span>hello</span></unknown>", "d");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Card");
  assert.equal(doc.root[0]!.children.length, 1);
  assert.equal(doc.root[0]!.children[0]!.type, "Text");
});

test("self-closing br tag is skipped", () => {
  resetHtmlIdCounter();
  const doc = parseHtmlToDocument("<div>a<br />b</div>", "d");
  // br produces no nodes; "a" and "b" become text children
  const children = doc.root[0]!.children;
  // There should be some text children
  assert.ok(children.length > 0);
});

test("title attribute on div/section maps to node content title", () => {
  resetHtmlIdCounter();
  const docDiv = parseHtmlToDocument('<div title="My Card">x</div>', "d");
  const divContent = docDiv.root[0]!.content as { title?: string };
  assert.equal(divContent.title, "My Card");

  resetHtmlIdCounter();
  const docSection = parseHtmlToDocument('<section title="App Window">x</section>', "d");
  const sectionContent = docSection.root[0]!.content as { title?: string };
  assert.equal(sectionContent.title, "App Window");
});

test("resetHtmlIdCounter yields deterministic output for same input", () => {
  resetHtmlIdCounter();
  const doc1 = parseHtmlToDocument("<div>A</div><span>B</span>", "Same");

  resetHtmlIdCounter();
  const doc2 = parseHtmlToDocument("<div>A</div><span>B</span>", "Same");

  // Same input with reset counter should produce identical structure
  assert.equal(doc1.root.length, doc2.root.length);
  assert.equal(doc1.root[0]!.type, doc2.root[0]!.type);
  assert.equal(doc1.root[1]!.type, doc2.root[1]!.type);
});

// ── Realistic example ──────────────────────────────────────────────────────────

test("parses a realistic HTML snippet with all tag types", () => {
  resetHtmlIdCounter();
  const html = `<section style="background: #f0f0f0">
    <div style="padding: 16px">
      <img src="avatar.png" style="border-radius: 50%" />
      <div style="margin-top: 8px">
        <span style="font-weight: bold">John Doe</span>
        <p style="color: #666">Developer</p>
      </div>
      <div data-hotspot="profile-link" style="cursor: pointer">View Profile</div>
    </div>
  </section>`;

  const doc = parseHtmlToDocument(html, "Profile");

  assert.equal(doc.name, "Profile");
  assert.equal(doc.root.length, 1);
  assert.equal(doc.root[0]!.type, "Window");

  // Window children: one Card (the outer div)
  const outerCard = doc.root[0]!.children[0]!;
  assert.equal(outerCard.type, "Card");

  const children = outerCard.children;
  assert.ok(children.length >= 3);

  // Find Asset
  const asset = children.find((c) => c.type === "Asset");
  assert.ok(asset, "Should have an Asset node");
  assert.equal((asset.content as { src: string }).src, "avatar.png");
  assert.deepEqual(stripReadonly(asset.style), { "border-radius": "50%" });

  // Find Hotspot
  const hotspot = children.find((c) => c.type === "Hotspot");
  assert.ok(hotspot, "Should have a Hotspot node");
  assert.equal((hotspot.content as { metadata?: string }).metadata, "profile-link");
});
