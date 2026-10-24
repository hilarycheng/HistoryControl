"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const manifest = require("../manifest.json");
const en = require("../_locales/en/messages.json");
const zh = require("../_locales/zh_HK/messages.json");

function fakeElement() {
  return {
    textContent: "", className: "", hidden: false, src: "", listeners: {},
    getAttribute(name) { return this.attributes?.[name]; },
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
}
function renderPopup({ tab = { id: 1 }, result, error, locale = "en-US" } = {}) {
  const elements = new Map();
  for (const id of ["result", "status", "site-host", "site-url", "site-icon", "rule-note", "manage"]) {
    elements.set(id, fakeElement());
  }
  const localization = ["popupSubtitle", "popupLoading", "popupHint", "popupManage"].map((key) => {
    const el = fakeElement(); el.attributes = { "data-i18n": key }; return el;
  });
  const calls = [];
  const messages = /^(zh-HK|zh-TW)$/.test(locale) ? zh : en;
  const browser = {
    i18n: {
      getUILanguage() { return locale; },
      getMessage(key) { return (messages[key] || en[key] || {}).message || ""; }
    },
    tabs: { async query(query) {
      assert.deepEqual(Object.fromEntries(Object.entries(query)), { active: true, currentWindow: true });
      return tab ? [tab] : [];
    } },
    runtime: {
      async sendMessage(message) { calls.push(message); if (error) throw error; return result; },
      async openOptionsPage() { calls.push({ type: "options" }); }
    }
  };
  const document = {
    documentElement: { lang: "en" }, title: "",
    getElementById(id) { return elements.get(id); },
    querySelectorAll(selector) {
      if (selector !== "[data-i18n]") throw Error(`unexpected selector ${selector}`);
      return localization;
    }
  };
  vm.runInNewContext(script, { browser, document, console });
  return { elements, calls, localization, document,
    async settle() { for (let n = 0; n < 10; n++) await new Promise((resolve) => setImmediate(resolve)); },
    async openOptions() { await elements.get("manage").listeners.click(); }
  };
}

test("manifest contains the one-click popup and locale metadata", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.1.0");
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.name, "__MSG_extensionName__");
});

test("first toolbar click saves current exact URL and keeps Options available", async () => {
  const ui = renderPopup({ result: { saved: true, alreadySaved: false, host: "mvnrepository.com",
    entryUrl: "https://mvnrepository.com/", matchMode: "exact", historyMode: "entry" } });
  await ui.settle();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].type, "save");
  assert.equal(ui.calls[0].tabId, 1);
  assert.match(ui.elements.get("status").textContent, /URL saved/);
  assert.equal(ui.elements.get("result").className, "result saved");
  assert.equal(ui.elements.get("site-url").textContent, "https://mvnrepository.com/");
  assert.equal(ui.elements.get("site-icon").src, "icons/saved.svg");
  await ui.openOptions();
  assert.equal(ui.calls.at(-1).type, "options");
});

test("existing exact rule produces Done-style confirmation, without another action", async () => {
  const ui = renderPopup({ result: { saved: true, alreadySaved: true,
    host: "chatgpt.com", entryUrl: "https://chatgpt.com/", matchMode: "exact", historyMode: "entry" } });
  await ui.settle();
  assert.match(ui.elements.get("status").textContent, /Already protected/);
  assert.match(ui.elements.get("rule-note").textContent, /Exact Match/);
  assert.equal(ui.calls.length, 1);
});

test("prefix matched child displays Entry Only state and still opens Options", async () => {
  const ui = renderPopup({ locale: "zh-HK", result: { saved: true, alreadySaved: true, matched: true,
    host: "chatgpt.com", entryUrl: "https://chatgpt.com/g/", matchMode: "prefix",
    historyMode: "entry", keepHistory: false } });
  await ui.settle();
  assert.match(ui.elements.get("status").textContent, /符合保護規則/);
  assert.match(ui.elements.get("status").textContent, /僅保留入口網址/);
  assert.equal(ui.elements.get("site-url").textContent, "https://chatgpt.com/g/");
  assert.match(ui.elements.get("rule-note").textContent, /路徑前綴比對/);
  assert.equal(ui.document.documentElement.lang, "zh-Hant");
  await ui.openOptions();
  assert.equal(ui.calls.at(-1).type, "options");
});

test("prefix Keep All shows History retained in English", async () => {
  const ui = renderPopup({ result: { saved: true, alreadySaved: true,
    host: "chatgpt.com", entryUrl: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "all" } });
  await ui.settle();
  assert.match(ui.elements.get("status").textContent, /History retained/);
  assert.match(ui.elements.get("rule-note").textContent, /Keep All Matched URLs/);
});

test("English fallback is used for unsupported browser locale, never Simplified Chinese", async () => {
  const ui = renderPopup({ locale: "zh-CN", result: { saved: false, reason: "unsupported" } });
  await ui.settle();
  assert.equal(ui.document.documentElement.lang, "en");
  assert.match(ui.elements.get("status").textContent, /HTTP or HTTPS/);
});

test("popup provides visible errors and handles missing tab", async () => {
  const error = renderPopup({ error: new Error("Storage quota error") });
  await error.settle();
  assert.match(error.elements.get("status").textContent, /Storage quota error/);
  const empty = renderPopup({ tab: null, locale: "zh-TW" });
  await empty.settle();
  assert.equal(empty.calls.length, 0);
  assert.match(empty.elements.get("status").textContent, /找不到目前分頁/);
  assert.equal(empty.document.documentElement.lang, "zh-Hant");
});


test("No History popup shows excluded state and still opens Options", async () => {
  const ui = renderPopup({ locale: "zh-HK", result: { saved: false, excluded: true,
    host: "aaaa.example.org", hostname: "example.org", includeSubdomains: true } });
  await ui.settle();
  assert.match(ui.elements.get("status").textContent, /不保留瀏覽紀錄/);
  assert.equal(ui.elements.get("result").className, "result excluded");
  assert.equal(ui.elements.get("site-icon").src, "icons/excluded.svg");
  assert.equal(ui.elements.get("site-host").textContent, "aaaa.example.org");
  assert.match(ui.elements.get("rule-note").textContent, /包含所有子網域/);
  await ui.openOptions();
  assert.equal(ui.calls.at(-1).type, "options");
});

test("Host Entry retained URL is shown as saved with an Options entry", async () => {
  const ui = renderPopup({ locale: "zh-TW", result: {
    saved: true, hostEntry: true, keepHistory: true, hostname: "example.net",
    entryUrl: "https://example.net/", host: "example.net", includeSubdomains: true
  } });
  await ui.settle();
  assert.match(ui.elements.get("status").textContent, /已保留主機入口/);
  assert.equal(ui.elements.get("site-icon").src, "icons/saved.svg");
  await ui.openOptions();
  assert.equal(ui.calls.at(-1).type, "options");
});

test("Host Entry covered subpages display deletion state, without auto-saving", async () => {
  const ui = renderPopup({ result: {
    saved: false, hostEntry: true, keepHistory: false, hostname: "example.net",
    entryUrl: "https://example.net/", host: "www.example.net", includeSubdomains: true
  } });
  await ui.settle();
  assert.match(ui.elements.get("status").textContent, /only the entry URL is retained/);
  assert.equal(ui.elements.get("site-icon").src, "icons/excluded.svg");
  assert.equal(ui.calls.length, 1);
});
