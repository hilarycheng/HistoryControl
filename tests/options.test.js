"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(root, "options.js"), "utf8");
const page = fs.readFileSync(path.join(root, "options.html"), "utf8");
const en = require("../_locales/en/messages.json");
const zh = require("../_locales/zh_TW/messages.json");

function fakeElement() {
  return {
    textContent: "", disabled: false, hidden: false, checked: false, value: "", placeholder: "",
    children: [], listeners: {}, className: "", attributes: {},
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
  };
}
function optionsHarness(protectedSites, locale = "en-US", noHistoryRules = [], hostEntryRules = []) {
  const ids = ["site-list", "empty-message", "count", "status", "clean", "refresh",
    "add-status", "add-button", "add-form", "add-url", "add-match-mode",
    "add-history-mode", "add-history-row", "add-mode-help", "exclude-form",
    "exclude-hostname", "exclude-subdomains", "exclude-add-button", "exclude-status",
    "exclude-list", "exclude-empty", "exclude-count", "host-entry-form", "host-entry-hostname",
    "host-entry-url", "host-entry-subdomains", "host-entry-add", "host-entry-list",
    "host-entry-count", "host-entry-empty", "host-entry-status", "export-button",
    "import-button", "import-file", "import-mode", "backup-status",
    "full-export-button", "full-import-button", "full-import-file", "full-backup-status"];
  const elements = new Map(ids.map((id) => [id, fakeElement()]));
  elements.get("add-match-mode").value = "exact";
  elements.get("add-history-mode").value = "entry";
  elements.get("exclude-subdomains").checked = true;
  elements.get("host-entry-subdomains").checked = true;
  const i18nKeys = [...page.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
  const localizedElements = i18nKeys.map((key) => {
    const el = fakeElement(); el.attributes["data-i18n"] = key; return el;
  });
  const created = [];
  const messages = [];
  const confirms = [];
  const saved = [...protectedSites];
  const savedExcluded = [...noHistoryRules];
  const savedHosts = [...hostEntryRules];
  const translations = locale.startsWith("zh-") && locale !== "zh-CN" ? zh : en;
  const browser = {
    i18n: {
      getUILanguage() { return locale; },
      getMessage(key) { return (translations[key] || en[key] || {}).message || ""; }
    },
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        if (message.type === "list") return saved.map((site) => ({ ...site }));
        if (message.type === "listExcluded") return savedExcluded.map((item) => ({ ...item }));
        if (message.type === "listHostEntries") return savedHosts.map((item) => ({ ...item }));
        if (message.type === "checkHostEntry") {
          return { hostname: message.hostname, entryUrl: message.entryUrl || `https://${message.hostname}/`,
            includeSubdomains: message.includeSubdomains, conflicts: { protected: [], noHistory: [] } };
        }
        if (message.type === "addHostEntry") {
          const previous = savedHosts.find((item) => item.hostname === message.hostname);
          if (previous) return { ...previous, alreadySaved: true };
          const added = { hostname: message.hostname,
            entryUrl: message.entryUrl || `https://${message.hostname}/`,
            includeSubdomains: message.includeSubdomains,
            conflicts: { protected: [], noHistory: [] } };
          savedHosts.push(added);
          return { ...added, alreadySaved: false };
        }
        if (message.type === "updateHostEntry") {
          const rule = savedHosts.find((item) => item.hostname === message.hostname);
          if (!rule) return false;
          Object.assign(rule, { entryUrl: message.entryUrl, includeSubdomains: message.includeSubdomains });
          return true;
        }
        if (message.type === "removeHostEntry") {
          const index = savedHosts.findIndex((item) => item.hostname === message.hostname);
          if (index < 0) return false;
          savedHosts.splice(index, 1);
          return true;
        }
        if (message.type === "checkExcluded") {
          const hostname = message.hostname.replace(/^https?:\/\//, "").replace(/\/$/, "");
          if (hostname.includes("/")) throw Error("Invalid hostname");
          return { hostname, includeSubdomains: message.includeSubdomains,
            conflicts: saved.filter((item) => {
              const h = new URL(item.entryUrl).hostname;
              return h === hostname || (message.includeSubdomains && h.endsWith(`.${hostname}`));
            }).map((item) => item.entryUrl) };
        }
        if (message.type === "addExcluded") {
          const hostname = message.hostname;
          const old = savedExcluded.find((item) => item.hostname === hostname);
          if (old) return { ...old, alreadySaved: true };
          const result = { hostname, includeSubdomains: message.includeSubdomains, conflicts: [] };
          savedExcluded.push(result);
          return { ...result, alreadySaved: false };
        }
        if (message.type === "updateExcluded") {
          const found = savedExcluded.find((item) => item.hostname === message.hostname);
          if (!found) return false;
          found.includeSubdomains = message.includeSubdomains;
          return true;
        }
        if (message.type === "removeExcluded") {
          const i = savedExcluded.findIndex((item) => item.hostname === message.hostname);
          if (i < 0) return false;
          savedExcluded.splice(i, 1);
          return true;
        }
        if (message.type === "clean") return { deleted: 3, failed: 0, saved: saved.length };
        if (message.type === "add") {
          const host = new URL(message.url).hostname.replace(/^www\./, "");
          const entryUrl = message.url.replace(/\?.*$/, "");
          const old = saved.find((site) => site.entryUrl === entryUrl);
          if (old) return { ...old, alreadySaved: true };
          const result = { host, entryUrl, matchMode: message.matchMode,
            historyMode: message.matchMode === "exact" ? "entry" : message.historyMode };
          saved.push(result);
          return { ...result, alreadySaved: false };
        }
        if (message.type === "updateEntry") {
          const old = saved.find((site) => site.host === message.host && site.entryUrl === message.entryUrl);
          if (!old) return false;
          Object.assign(old, { matchMode: message.matchMode, historyMode: message.historyMode });
          return true;
        }
        if (message.type === "unprotectEntry") {
          const i = saved.findIndex((site) => site.host === message.host && site.entryUrl === message.entryUrl);
          if (i < 0) return false;
          saved.splice(i, 1);
          return true;
        }
        throw Error(`Unexpected message: ${message.type}`);
      }
    }
  };
  const document = {
    title: "", documentElement: { lang: "en" },
    getElementById(id) { return elements.get(id); },
    createElement() { const el = fakeElement(); created.push(el); return el; },
    querySelectorAll(selector) {
      if (selector === "[data-i18n]") return localizedElements;
      if (selector === ".rule-action, .rule-select, .exclude-action, .exclude-checkbox, .host-action, .host-checkbox, .host-url-editor") return created.filter((e) =>
        /rule-action|rule-select|exclude-action|exclude-checkbox|host-action|host-checkbox|host-url-editor/.test(e.className));
      throw Error(`Unexpected selector: ${selector}`);
    }
  };
  const window = { confirm(message) { confirms.push(message); return true; } };
  vm.runInNewContext(code, { browser, document, window, console, URL }, { filename: "options.js" });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
  return { elements, messages, confirms, saved, savedExcluded, savedHosts, document, localizedElements, settle,
    async clean() { await elements.get("clean").listeners.click(); },
    async exclude(hostname, includeSubdomains = true) {
      elements.get("exclude-hostname").value = hostname;
      elements.get("exclude-subdomains").checked = includeSubdomains;
      await elements.get("exclude-form").listeners.submit({ preventDefault() {} });
    },
    async addHost(hostname, url = "", includeSubdomains = true) {
      elements.get("host-entry-hostname").value = hostname;
      elements.get("host-entry-url").value = url;
      elements.get("host-entry-subdomains").checked = includeSubdomains;
      await elements.get("host-entry-form").listeners.submit({ preventDefault() {} });
    },
    hostEditor(i = 0) {
      const item = elements.get("host-entry-list").children[i];
      const editor = item.children[1];
      return { url: editor.children[0], checkbox: editor.children[1].children[0],
        save: editor.children[2], remove: editor.children[3] };
    },
    exclusionEditor(i = 0) {
      const li = elements.get("exclude-list").children[i];
      const editor = li.children[1];
      return { li, checkbox: editor.children[0].children[0],
        save: editor.children[1], remove: editor.children[2] };
    },
    async add(url, matchMode = "exact", historyMode = "entry") {
      elements.get("add-url").value = url;
      elements.get("add-match-mode").value = matchMode;
      elements.get("add-match-mode").listeners.change();
      elements.get("add-history-mode").value = historyMode;
      await elements.get("add-form").listeners.submit({ preventDefault() {} });
    },
    editor(i = 0) {
      const li = elements.get("site-list").children[i];
      const editor = li.children[1];
      return { li, match: editor.children[0], history: editor.children[1],
        save: editor.children[2], remove: editor.children[3] };
    }
  };
}

test("all UI labels referenced by options HTML exist in each locale and no colloquial Chinese", () => {
  const keys = [...page.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  const h = require("../_locales/zh_HK/messages.json");
  for (const key of keys) {
    assert.ok(en[key], `Missing English ${key}`);
    assert.ok(zh[key], `Missing zh_TW ${key}`);
    assert.ok(h[key], `Missing zh_HK ${key}`);
  }
  assert.doesNotMatch(JSON.stringify(zh), /唔|冇|係咪|咗|嘅/);
  assert.match(zh.cleanDescription.message, /其他網站完全不受影響/);
});

test("no protected rules disables Clean Now", async () => {
  const ui = optionsHarness([]);
  await ui.settle();
  assert.equal(ui.elements.get("clean").disabled, true);
  await ui.clean();
  assert.deepEqual(ui.messages.map((m) => m.type), ["list", "listExcluded", "listHostEntries"]);
  assert.equal(ui.confirms.length, 0);
  assert.match(ui.elements.get("status").textContent, /Nothing to clean/);
});

test("Options follow zh-TW Firefox locale, with traditional written Chinese", async () => {
  const ui = optionsHarness([], "zh-TW");
  await ui.settle();
  assert.equal(ui.document.documentElement.lang, "zh-Hant");
  assert.equal(ui.document.title, "History Control — 設定");
  assert.match(ui.localizedElements.find((x) => x.attributes["data-i18n"] === "addTitle").textContent, /新增受保護網址/);
  assert.equal(ui.elements.get("add-history-row").hidden, true);
  assert.equal(ui.elements.get("add-url").placeholder, "請輸入完整網址");
});

test("manually adding a prefix URL enables Keep All mode and lists new rule", async () => {
  const ui = optionsHarness([]);
  await ui.settle();
  await ui.add("https://chatgpt.com/g/", "prefix", "all");
  assert.equal(ui.elements.get("add-history-row").hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.find((m) => m.type === "add"))), {
    type: "add", url: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "all"
  });
  assert.equal(ui.elements.get("count").textContent, "1");
  assert.match(ui.elements.get("add-status").textContent, /Added protected URL/);
  assert.equal(ui.editor().match.value, "prefix");
  assert.equal(ui.editor().history.value, "all");
  assert.equal(ui.editor().history.hidden, false);
});

test("per-URL editor updates prefix mode then saves to backend", async () => {
  const ui = optionsHarness([
    { host: "chatgpt.com", entryUrl: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "entry" },
    { host: "chatgpt.com", entryUrl: "https://chatgpt.com/", matchMode: "exact", historyMode: "entry" }
  ]);
  await ui.settle();
  const editor = ui.editor();
  editor.history.value = "all";
  await editor.save.listeners.click();
  const request = ui.messages.find((m) => m.type === "updateEntry");
  assert.equal(request.entryUrl, "https://chatgpt.com/g/");
  assert.equal(request.matchMode, "prefix");
  assert.equal(request.historyMode, "all");
  assert.equal(ui.saved[1].matchMode, "exact");
  assert.match(ui.elements.get("status").textContent, /Updated rule/);
});

test("switching Exact mode hides Keep All choice and submits entry-only", async () => {
  const ui = optionsHarness([{ host: "chatgpt.com", entryUrl: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "all" }]);
  await ui.settle();
  const editor = ui.editor();
  editor.match.value = "exact";
  editor.match.listeners.change();
  assert.equal(editor.history.hidden, true);
  assert.equal(editor.history.value, "entry");
  await editor.save.listeners.click();
  assert.equal(ui.messages.find((m) => m.type === "updateEntry").historyMode, "entry");
});

test("Options preserve remove-one behavior with three URLs on the same domain", async () => {
  const ui = optionsHarness([
    { host: "humblebundle.com", entryUrl: "https://humblebundle.com/", matchMode: "exact", historyMode: "entry" },
    { host: "humblebundle.com", entryUrl: "https://humblebundle.com/books", matchMode: "exact", historyMode: "entry" },
    { host: "humblebundle.com", entryUrl: "https://humblebundle.com/games", matchMode: "exact", historyMode: "entry" }
  ]);
  await ui.settle();
  await ui.editor(1).remove.listeners.click();
  assert.equal(ui.elements.get("count").textContent, "2");
  assert.equal(ui.saved.find((x) => x.entryUrl.endsWith("/books")), undefined);
  assert.equal(ui.saved.length, 2);
  await ui.clean();
  assert.match(ui.confirms.at(-1), /Only selected hosts will be affected/);
  assert.match(ui.elements.get("status").textContent, /Deleted URL records: 3/);
});

test("zh-CN UI locale falls back to English (no Simplified Chinese)", async () => {
  const ui = optionsHarness([], "zh-CN");
  await ui.settle();
  assert.equal(ui.document.documentElement.lang, "en");
  assert.equal(ui.document.title, "History Control — Options");
});


test("No History form defaults to including subdomains and enables Clean Now by itself", async () => {
  const ui = optionsHarness([]);
  await ui.settle();
  assert.equal(ui.elements.get("exclude-subdomains").checked, true);
  await ui.exclude("example.org");
  assert.equal(ui.savedExcluded.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.find((m) => m.type === "addExcluded"))),
    { type: "addExcluded", hostname: "example.org", includeSubdomains: true });
  assert.equal(ui.elements.get("exclude-count").textContent, "1");
  assert.equal(ui.elements.get("clean").disabled, false);
  assert.match(ui.elements.get("exclude-status").textContent, /Added No History rule/);
});

test("No History conflict asks confirmation with affected protected entry before saving", async () => {
  const ui = optionsHarness([{ host: "example.org", entryUrl: "https://example.org/", matchMode: "exact", historyMode: "entry" }]);
  await ui.settle();
  await ui.exclude("example.org");
  assert.match(ui.confirms[0], /protected entry points/);
  assert.match(ui.confirms[0], /https:\/\/example.org\//);
  assert.equal(ui.savedExcluded.length, 1);
});

test("No History rule can be edited to exclude only the apex and removed", async () => {
  const ui = optionsHarness([], "zh-TW", [{ hostname: "example.org", includeSubdomains: true, conflicts: [] }]);
  await ui.settle();
  const editor = ui.exclusionEditor();
  editor.checkbox.checked = false;
  await editor.save.listeners.click();
  assert.equal(ui.savedExcluded[0].includeSubdomains, false);
  assert.equal(ui.messages.find((m) => m.type === "updateExcluded").includeSubdomains, false);
  await ui.exclusionEditor().remove.listeners.click();
  assert.equal(ui.savedExcluded.length, 0);
  assert.equal(ui.elements.get("clean").disabled, true);
  assert.match(ui.elements.get("exclude-status").textContent, /已移除不保留紀錄規則/);
});

test("No History conflicts remain visible in both protected and excluded lists", async () => {
  const ui = optionsHarness([
    { host: "example.org", entryUrl: "https://example.org/", matchMode: "exact", historyMode: "entry", excluded: true }
  ], "en-US", [{ hostname: "example.org", includeSubdomains: true, conflicts: ["https://example.org/"] }]);
  await ui.settle();
  assert.match(ui.elements.get("site-list").children[0].children[0].children[2].textContent, /Overridden/);
  assert.match(ui.elements.get("exclude-list").children[0].children[0].children[1].textContent, /Overrides/);
});

test("Host Entry form allows a blank entry URL and includes subdomains by default", async () => {
  const ui = optionsHarness([]);
  await ui.settle();
  assert.equal(ui.elements.get("host-entry-url").placeholder, "Enter the URL to keep");
  await ui.addHost("example.net");
  assert.equal(ui.savedHosts.length, 1);
  assert.equal(ui.savedHosts[0].entryUrl, "https://example.net/");
  assert.equal(ui.savedHosts[0].includeSubdomains, true);
  assert.equal(ui.elements.get("host-entry-count").textContent, "1");
  assert.equal(ui.elements.get("clean").disabled, false);
});

test("Host Entry editing, subdomain toggle and individual removal work in Options", async () => {
  const ui = optionsHarness([], "zh-TW", [], [{
    hostname: "example.net", entryUrl: "https://example.net/",
    includeSubdomains: true, conflicts: { protected: [], noHistory: [] }
  }]);
  await ui.settle();
  const editor = ui.hostEditor();
  editor.url.value = "https://example.net/start";
  editor.checkbox.checked = false;
  await editor.save.listeners.click();
  assert.equal(ui.savedHosts[0].entryUrl, "https://example.net/start");
  assert.equal(ui.savedHosts[0].includeSubdomains, false);
  assert.match(ui.elements.get("host-entry-status").textContent, /已更新主機入口規則/);
  await ui.hostEditor().remove.listeners.click();
  assert.equal(ui.savedHosts.length, 0);
  assert.equal(ui.elements.get("clean").disabled, true);
});

test("No site-name examples appear in input field placeholders of either locale", () => {
  const zhTw = require("../_locales/zh_TW/messages.json");
  const zhHk = require("../_locales/zh_HK/messages.json");
  const fields = ["hostnamePlaceholder", "urlPlaceholder", "hostEntryUrlPlaceholder", "explorerFilterPlaceholder"];
  for (const dictionary of [en, zhTw, zhHk]) {
    for (const key of fields) {
      assert.ok(dictionary[key]);
      assert.doesNotMatch(dictionary[key].message, /https?:\/\/|\b[a-z0-9-]+\.(?:com|org|net|io)\b/i);
    }
  }
});
