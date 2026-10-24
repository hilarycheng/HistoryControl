"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const manifest = require("../manifest.json");
const locales = Object.fromEntries(["en", "zh_TW", "zh_HK"].map((locale) =>
  [locale, JSON.parse(fs.readFileSync(path.join(root, "_locales", locale, "messages.json"), "utf8"))]));

test("every locale contains all strings and manifest metadata is localized", () => {
  assert.equal(manifest.default_locale, "en");
  for (const field of ["name", "description"]) {
    assert.match(manifest[field], /^__MSG_[A-Za-z]+__$/);
    const key = manifest[field].slice(6, -2);
    for (const locale of Object.values(locales)) assert.ok(locale[key], key);
  }
  const names = Object.keys(locales.en).sort();
  for (const [locale, messages] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(messages).sort(), names, `${locale} missing keys`);
    for (const [key, val] of Object.entries(messages)) {
      assert.equal(typeof val.message, "string", `${locale}:${key}`);
      assert.ok(val.message.trim(), `${locale}:${key}`);
    }
  }
});

test("all t() and data-i18n keys are present in every locale", () => {
  const names = ["background.js", "popup.js", "options.js", "popup.html", "options.html"];
  const keys = new Set();
  for (const file of names) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const [, key] of source.matchAll(/\bt\(["']([\w]+)["']/g)) keys.add(key);
    for (const [, key] of source.matchAll(/data-i18n="([\w]+)"/g)) keys.add(key);
  }
  for (const key of keys) {
    for (const [locale, messages] of Object.entries(locales)) {
      assert.ok(messages[key], `${locale} missing referenced key: ${key}`);
    }
  }
});

test("Traditional Chinese labels use formal writing, no Cantonese or Simplified Chinese", () => {
  for (const locale of ["zh_TW", "zh_HK"]) {
    const all = Object.values(locales[locale]).map((x) => x.message).join("\n");
    assert.doesNotMatch(all, /唔|冇|嘅|咗|係咪|點樣/);
    assert.match(all, /瀏覽紀錄/);
    assert.match(all, /受保護網址/);
    assert.doesNotMatch(all, /浏览|网址|设置|保存|删除/);
  }
});


test("v1.1.0 Full Backup UI and Firefox AMO manifest data disclosures are present", () => {
  const options = fs.readFileSync(path.join(root, "options.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "options.js"), "utf8");
  assert.match(options, /id="full-export-button"/);
  assert.match(options, /id="full-import-button"/);
  assert.match(options, /id="full-import-file"/);
  assert.match(js, /type: "exportFullBackup"/);
  assert.match(js, /type: "importFullBackup"/);
  assert.equal(manifest.browser_specific_settings.gecko.id, "firefox-minimal-history@local-extension.example");
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);
  assert.equal(manifest.version, "1.1.0");
});
