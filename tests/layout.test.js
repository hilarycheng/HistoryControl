"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "options.css"), "utf8");
const manifest = require("../manifest.json");

const responsive = css.slice(css.indexOf("/* v1.0.8:"));

test("v1.0.9 changes the display version but retains the extension identity", () => {
  assert.equal(manifest.version, "1.1.0");
  assert.equal(manifest.browser_specific_settings.gecko.id,
    "{d573c284-f17e-4a66-9834-2cbf0477d960}");
});

test("wide Options content uses full window width and avoids forced row wrapping", () => {
  assert.match(responsive, /\.shell\s*\{\s*width:\s*calc\(100% - 32px\);\s*max-width:\s*none;/);
  assert.match(responsive, /\.options-content\s*\{[^}]*container-type:\s*inline-size;/s);
  assert.match(responsive, /\.options-content \.site-list li\s*\{[^}]*flex-wrap:\s*nowrap;/s);
  for (const group of ["rule-editor", "host-entry-editor", "exclude-editor"]) {
    assert.match(responsive, new RegExp(`\\.options-content \\.${group}`));
  }
});

test("long URL text is permitted to wrap, but controls keep their own labels intact", () => {
  assert.match(responsive, /\.options-content \.site-detail code\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(responsive, /\.options-content \.rule-editor button,[\s\S]*?white-space:\s*nowrap;/);
  assert.match(responsive, /\.options-content \.history-table\s*\{[^}]*min-width:\s*540px;/s);
});

test("narrow layout adapts to the content container and stacks the navigation", () => {
  assert.match(responsive, /@container options-pane \(max-width:\s*840px\)/);
  assert.match(responsive, /@container options-pane \(max-width:\s*840px\)[\s\S]*?\.options-content \.site-list li\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(responsive, /@container options-pane \(max-width:\s*840px\)[\s\S]*?\.options-content \.rule-editor,[^}]*flex-wrap:\s*wrap;/);
  assert.match(responsive, /@media \(max-width:\s*850px\)\s*\{\s*\.options-layout\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
});
