"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const enMessages = require("../_locales/en/messages.json");
const zhMessages = require("../_locales/zh_TW/messages.json");

function emitter() {
  const callbacks = [];
  return {
    addListener(cb) { callbacks.push(cb); },
    async emit(...args) {
      return Promise.all(callbacks.map((fn) => Promise.resolve(fn(...args))));
    },
    emitResponse(...args) {
      for (const cb of callbacks) {
        const reply = cb(...args);
        if (reply !== undefined) return Promise.resolve(reply);
      }
      throw new Error("No listener handled this message");
    }
  };
}

function newFirefox(tabs = [{ id: 1, url: "https://mvnrepository.com/" }], persistentStorage = {}, locale = "en-US") {
  const visits = new Map();
  const actionState = new Map();
  const tabList = new Map(tabs.map((tab) => [tab.id, tab]));
  const events = {
    visited: emitter(), removed: emitter(), actionClick: emitter(), tabUpdated: emitter(),
    tabActivated: emitter(), tabCreated: emitter(), storageChanged: emitter(),
    message: emitter(), installed: emitter(), startup: emitter(), menuClick: emitter()
  };
  const menuEntries = [];
  const extensionId = "mock-extension@tests";
  function actionFor(id) {
    if (!actionState.has(id)) actionState.set(id, {});
    return actionState.get(id);
  }
  function seed(url, time = Date.now() - 1000) {
    const entry = visits.get(url) || [];
    entry.push(time);
    visits.set(url, entry);
  }
  function getVisitsRaw(url) { return visits.get(url) || []; }
  const browser = {
    i18n: {
      getUILanguage: () => locale,
      getMessage(key) {
        const lang = /^(zh-HK|zh-TW)$/.test(locale) ? zhMessages : enMessages;
        return (lang[key] || enMessages[key] || {}).message || "";
      }
    },
    runtime: {
      id: extensionId,
      onMessage: events.message,
      onInstalled: events.installed,
      onStartup: events.startup,
      openOptionsPage: async () => {}
    },
    history: {
      onVisited: events.visited,
      onVisitRemoved: events.removed,
      async addUrl({ url, visitTime = Date.now() }) {
        seed(url, visitTime);
        await events.visited.emit({ url, lastVisitTime: visitTime });
      },
      async getVisits({ url }) {
        return getVisitsRaw(url).map((visitTime) => ({ visitTime }));
      },
      async deleteUrl({ url }) {
        if (visits.delete(url)) {
          await events.removed.emit({ allHistory: false, urls: [url] });
        }
      },
      async search({ text, startTime = Date.now() - 86400000, endTime = Infinity, maxResults = 100 }) {
        return [...visits.entries()]
          .filter(([url, times]) => url.includes(text) && Math.max(...times) >= startTime && Math.max(...times) <= endTime)
          .map(([url, times]) => ({ url, lastVisitTime: Math.max(...times) }))
          .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
          .slice(0, maxResults);
      }
    },
    storage: {
      onChanged: events.storageChanged,
      local: {
        async get(key) { return { [key]: persistentStorage[key] }; },
        async set(obj) {
          for (const [key, newValue] of Object.entries(obj)) {
            const oldValue = persistentStorage[key];
            persistentStorage[key] = structuredClone(newValue);
            await events.storageChanged.emit({ [key]: { oldValue, newValue } }, "local");
          }
        }
      }
    },
    tabs: {
      onUpdated: events.tabUpdated,
      onActivated: events.tabActivated,
      onCreated: events.tabCreated,
      async get(id) { return tabList.get(id); },
      async query() { return [...tabList.values()]; }
    },
    action: {
      onClicked: events.actionClick,
      async setIcon({ tabId, path: iconPath }) { actionFor(tabId).icon = iconPath; },
      async setTitle({ tabId, title }) { actionFor(tabId).title = title; },
      async setBadgeText({ tabId, text }) { actionFor(tabId).badge = text; },
      async setBadgeBackgroundColor({ tabId, color }) { actionFor(tabId).color = color; },
      async enable(id) { actionFor(id).disabled = false; },
      async disable(id) { actionFor(id).disabled = true; }
    },
    menus: {
      onClicked: events.menuClick,
      async removeAll() { menuEntries.length = 0; },
      create(args) { menuEntries.push(args); return args.id; }
    }
  };
  const context = vm.createContext({ browser, console, URL, setTimeout, clearTimeout });
  vm.runInContext(script, context, { filename: "background.js" });

  async function settle() {
    for (let i = 0; i < 20; ++i) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  async function click(tabId = 1) {
    return message({ type: "save", tabId }); // Popup auto-saves with one toolbar click.
  }
  async function visit(url, time = Date.now()) {
    seed(url, time);
    await events.visited.emit({ url, lastVisitTime: time });
    await settle();
  }
  async function message(payload) {
    const reply = await events.message.emitResponse(payload, { id: extensionId });
    await settle();
    return reply;
  }
  return { browser, visits, tabList, actionState, persistentStorage, menuEntries, events,
    seed, click, visit, settle, message, getVisitsRaw };
}

test("one popup open protects current root URL and marks saved (without learning)", async () => {
  const f = newFirefox();
  await f.settle();
  assert.equal(f.actionState.get(1).badge, "");
  const firstSave = await f.click();
  assert.equal(firstSave.saved, true);
  assert.equal(firstSave.alreadySaved, false);
  assert.deepEqual(f.persistentStorage.protectedSites["mvnrepository.com"].entries[0].entryUrl, "https://mvnrepository.com/");
  assert.equal(f.getVisitsRaw("https://mvnrepository.com/").length, 1);
  assert.equal(f.actionState.get(1).badge, "✓");
  assert.equal(f.actionState.get(1).icon, "icons/saved.svg");
  const secondSave = await f.click();
  assert.equal(secondSave.alreadySaved, true);
  assert.equal(f.getVisitsRaw("https://mvnrepository.com/").length, 1, "second click is idempotent");
});

test("only protected host inner visits are auto-removed; unprotected visits stay", async () => {
  const f = newFirefox();
  await f.settle();
  await f.click();
  await f.visit("https://mvnrepository.com/artifact/log4j/log4j");
  await f.visit("https://mvnrepository.com/search?q=jackson");
  await f.visit("https://not-saved.example/a");
  await f.visit("https://not-saved.example/b?q=mvnrepository.com");
  await f.visit("http://mvnrepository.com/path");
  assert.equal(f.visits.has("https://mvnrepository.com/artifact/log4j/log4j"), false);
  assert.equal(f.visits.has("https://mvnrepository.com/search?q=jackson"), false);
  assert.equal(f.visits.has("http://mvnrepository.com/path"), false);
  assert.equal(f.visits.has("https://not-saved.example/a"), true);
  assert.equal(f.visits.has("https://not-saved.example/b?q=mvnrepository.com"), true);
  await f.visit("https://mvnrepository.com/");
  assert.equal(f.getVisitsRaw("https://mvnrepository.com/").length, 2);
});

test("Clean Now deletes only protected inner URLs across multiple search pages", async () => {
  const f = newFirefox();
  await f.settle();
  await f.click();
  f.seed("https://mvnrepository.com/", Date.now() - 20_000);
  const before = f.getVisitsRaw("https://mvnrepository.com/").length;
  const now = Date.now() - 200_000;
  for (let i = 0; i < 1223; ++i) {
    f.seed(`https://mvnrepository.com/artifact/product/${i}`, now + i * 2);
    f.seed(`https://unprotected.example/product/${i}`, now + i * 2 + 1);
  }
  f.seed("https://other.example/?ref=mvnrepository.com", now - 1000);
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 1223);
  assert.equal(result.failed, 0);
  assert.equal(result.saved, 1);
  assert.equal(f.getVisitsRaw("https://mvnrepository.com/").length, before);
  assert.equal(f.visits.size, 1225, "the protected root and 1224 unrelated URLs must remain");
  for (let i = 0; i < 1223; ++i) {
    assert.equal(f.visits.has(`https://mvnrepository.com/artifact/product/${i}`), false);
    assert.equal(f.visits.has(`https://unprotected.example/product/${i}`), true);
  }
  assert.equal(f.visits.has("https://other.example/?ref=mvnrepository.com"), true);
});

test("an empty whitelist never deletes existing or future browsing history", async () => {
  const f = newFirefox();
  await f.settle();
  f.seed("https://mvnrepository.com/a");
  f.seed("https://github.com/b");
  await f.visit("https://chatgpt.com/c/123");
  assert.equal(f.visits.size, 3);
  f.browser.history.search = () => { throw Error("No History search allowed with empty whitelist"); };
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.saved, 0);
  assert.equal(f.visits.size, 3);
});

test("removing protection stops auto deletion and leaves old History untouched", async () => {
  const f = newFirefox();
  await f.settle();
  await f.click();
  f.seed("https://mvnrepository.com/artifact/old");
  const removed = await f.message({ type: "unprotectEntry", host: "mvnrepository.com", entryUrl: "https://mvnrepository.com/" });
  assert.equal(removed, true);
  assert.equal(f.actionState.get(1).badge, "");
  const result = await f.message({ type: "clean" });
  assert.equal(result.saved, 0);
  assert.equal(result.deleted, 0);
  assert.equal(f.visits.has("https://mvnrepository.com/artifact/old"), true);
  assert.equal(f.visits.has("https://mvnrepository.com/"), true);
  await f.visit("https://mvnrepository.com/artifact/new");
  assert.equal(f.visits.has("https://mvnrepository.com/artifact/new"), true);
});

test("externally removed protected root is restored from whitelist", async () => {
  const f = newFirefox();
  await f.settle();
  await f.click();
  await f.browser.history.deleteUrl({ url: "https://mvnrepository.com/" });
  await f.settle();
  assert.equal(f.getVisitsRaw("https://mvnrepository.com/").length, 1);
});

test("www hostname maps to same saved path; other paths and subdomains do not", async () => {
  const f = newFirefox([
    { id: 1, url: "https://www.example.com/a" },
    { id: 2, url: "https://example.com/a?variant=1" },
    { id: 4, url: "https://example.com/b" },
    { id: 3, url: "https://api.example.com/" }
  ]);
  await f.settle();
  await f.click(1);
  assert.equal(f.actionState.get(1).badge, "✓");
  assert.equal(f.actionState.get(2).badge, "✓");
  assert.equal(f.actionState.get(3).badge, "");
  assert.equal(f.actionState.get(4).badge, "", "another path is not yet saved");
  assert.equal(f.persistentStorage.protectedSites["example.com"].entries[0].entryUrl, "https://www.example.com/a");
});

test("internal browser pages still show a clickable button and an explicit unsupported result", async () => {
  const f = newFirefox([{ id: 1, url: "about:config" }]);
  await f.settle();
  assert.equal(f.actionState.get(1).disabled, false);
  const result = await f.click();
  assert.equal(result.saved, false);
  assert.equal(result.reason, "unsupported");
  assert.equal(Object.keys(f.persistentStorage.protectedSites || {}).length, 0);
});

test("protected sites persist across event page reload", async () => {
  const storage = {};
  const f = newFirefox(undefined, storage);
  await f.settle();
  await f.click();
  const reloaded = newFirefox(undefined, storage);
  await reloaded.settle();
  assert.equal(reloaded.actionState.get(1).badge, "✓");
  assert.equal(reloaded.getVisitsRaw("https://mvnrepository.com/").length, 1);
});

test("only exact protected hostname is cleaned, not similar or subdomains", async () => {
  const f = newFirefox([{ id: 1, url: "https://chatgpt.com/" }]);
  await f.settle();
  await f.click();
  const unrelated = [
    "https://help.chatgpt.com/article/12",
    "https://notchatgpt.com/path",
    "https://chatgpt.com.evil.test/login",
    "https://unprotected.example/search?q=chatgpt.com",
    "https://other.example/chatgpt.com/c/123",
    "https://github.com/issues/1"
  ];
  f.seed("https://chatgpt.com/c/old");
  f.seed("https://chatgpt.com/?q=history");
  for (const url of unrelated) f.seed(url);
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 2);
  assert.equal(result.saved, 1);
  assert.deepEqual(f.getVisitsRaw("https://chatgpt.com/").length, 1);
  for (const url of unrelated) assert.equal(f.visits.has(url), true, url);
  assert.equal(f.visits.has("https://chatgpt.com/c/old"), false);
  assert.equal(f.visits.has("https://chatgpt.com/?q=history"), false);
});

test("multiple protected hostnames are cleaned independently", async () => {
  const f = newFirefox([
    { id: 1, url: "https://chatgpt.com/" },
    { id: 2, url: "https://mvnrepository.com/" },
    { id: 3, url: "https://github.com/abc" }
  ]);
  await f.settle();
  await f.click(1);
  await f.click(2);
  f.seed("https://chatgpt.com/c/old");
  f.seed("https://mvnrepository.com/artifact/old");
  f.seed("https://github.com/abc");
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 2);
  assert.equal(result.saved, 2);
  assert.equal(f.visits.has("https://chatgpt.com/"), true);
  assert.equal(f.visits.has("https://mvnrepository.com/"), true);
  assert.equal(f.visits.has("https://github.com/abc"), true);
  assert.equal(f.actionState.get(3).badge, "");
});

test("Clean Now only deletes URL on protected host even when unrelated search result matches the host string", async () => {
  const f = newFirefox([{ id: 1, url: "https://chatgpt.com/" }]);
  await f.settle();
  await f.click();
  const now = Date.now() - 1_000_000;
  for (let i = 0; i < 615; i++) {
    f.seed(`https://other.example/article/chatgpt.com/${i}`, now + i * 2);
  }
  f.seed("https://chatgpt.com/c/very-old", now - 1000);
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 0);
  assert.equal(f.visits.has("https://chatgpt.com/c/very-old"), false);
  assert.equal(f.visits.size, 616, "all 615 unrelated matches and root remain");
});

test("Clean Now reports failure for protected URL while leaving unrelated History untouched", async () => {
  const f = newFirefox([{ id: 1, url: "https://chatgpt.com/" }]);
  await f.settle();
  await f.click();
  f.seed("https://chatgpt.com/c/denied");
  f.seed("https://github.com/other");
  const originalDelete = f.browser.history.deleteUrl;
  f.browser.history.deleteUrl = async ({url}) => {
    if (url === "https://chatgpt.com/c/denied") throw Error("Simulated permission failure");
    return originalDelete({url});
  };
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 0);
  assert.equal(result.failed, 1);
  assert.equal(f.visits.has("https://chatgpt.com/c/denied"), true);
  assert.equal(f.visits.has("https://github.com/other"), true);
});


test("Object.prototype-like hostnames never count as protected domains", async () => {
  const f = newFirefox([{ id: 1, url: "https://chatgpt.com/" }]);
  await f.settle();
  await f.click();
  for (const url of ["https://constructor/page", "https://toString/page", "https://__proto__/path"]) {
    await f.visit(url);
    assert.equal(f.visits.has(url), true, `unprotected special hostname ${url} must survive`);
  }
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 0);
  assert.equal(f.visits.size, 4);
});


test("v1.0.3 stores several exact protected paths under one hostname", async () => {
  const f = newFirefox([
    { id: 1, url: "https://humblebundle.com/" },
    { id: 2, url: "https://humblebundle.com/books" },
    { id: 3, url: "https://humblebundle.com/games" },
    { id: 4, url: "https://humblebundle.com/books/bundle-1" },
    { id: 5, url: "https://github.com/anything" }
  ]);
  await f.settle();
  assert.equal(f.actionState.get(2).badge, "");
  await f.click(2);
  assert.equal(f.actionState.get(2).badge, "✓");
  assert.equal(f.actionState.get(1).badge, "", "root not automatically protected");
  assert.equal(f.actionState.get(3).badge, "", "other path not automatically protected");
  assert.equal(f.actionState.get(4).badge, "", "child path is not protected by /books");
  await f.click(3);
  await f.click(1);
  const entries = f.persistentStorage.protectedSites["humblebundle.com"].entries;
  assert.deepEqual(entries.map((entry) => entry.entryUrl), [
    "https://humblebundle.com/books",
    "https://humblebundle.com/games",
    "https://humblebundle.com/"
  ]);
  for (const url of entries.map((entry) => entry.entryUrl)) {
    assert.equal(f.getVisitsRaw(url).length, 1);
  }
  const all = await f.message({ type: "list" });
  assert.equal(all.length, 3);
  for (const id of [1, 2, 3]) assert.equal(f.actionState.get(id).badge, "✓");
  for (const id of [4, 5]) assert.equal(f.actionState.get(id).badge, "");
});

test("Protected Domain auto delete keeps just canonical saved URL records", async () => {
  const f = newFirefox([
    { id: 1, url: "https://humblebundle.com/books" },
    { id: 2, url: "https://humblebundle.com/games" },
    { id: 3, url: "https://humblebundle.com/" }
  ]);
  await f.settle();
  for (let id = 1; id <= 3; id++) await f.click(id);
  for (const url of [
    "https://humblebundle.com/books/bundle-one",
    "https://humblebundle.com/games/offer",
    "https://humblebundle.com/store",
    "https://humblebundle.com/books/?utm=bookmark",
    "https://humblebundle.com/games/",
    "https://humblebundle.com/?ref=email",
    "http://humblebundle.com/books",
    "https://www.humblebundle.com/books",
  ]) {
    await f.visit(url);
    assert.equal(f.visits.has(url), false, `Only canonical entry survives: ${url}`);
  }
  for (const url of [
    "https://humblebundle.com/",
    "https://humblebundle.com/books",
    "https://humblebundle.com/games"
  ]) assert.equal(f.visits.has(url), true, `${url} must stay saved`);
  for (const url of [
    "https://github.com/example",
    "https://help.humblebundle.com/books/bundle",
    "https://humblebundle.com.evil.test/books",
    "https://other.example/?ref=humblebundle.com/books"
  ]) {
    await f.visit(url);
    assert.equal(f.visits.has(url), true, `Unprotected hostname must stay: ${url}`);
  }
});

test("Clean Now removes only other URLs under protected host, preserves three paths", async () => {
  const f = newFirefox([
    { id: 1, url: "https://humblebundle.com/" },
    { id: 2, url: "https://humblebundle.com/books" },
    { id: 3, url: "https://humblebundle.com/games" }
  ]);
  await f.settle();
  for (let id = 1; id <= 3; id++) await f.click(id);
  const otherPaths = [
    "https://humblebundle.com/games/promo-1",
    "https://humblebundle.com/books/offer-2",
    "https://humblebundle.com/store",
    "https://humblebundle.com/books?utm=ad",
    "https://humblebundle.com/books/",
    "https://humblebundle.com/?utm=ad"
  ];
  for (const url of otherPaths) f.seed(url, Date.now() - 10_000);
  f.seed("https://github.com/user/project");
  f.seed("https://help.humblebundle.com/books/offer-2");
  f.seed("https://humblebundle.com.evil.test/books");
  const clean = await f.message({ type: "clean" });
  assert.deepEqual({ deleted: clean.deleted, failed: clean.failed, saved: clean.saved },
    { deleted: otherPaths.length, failed: 0, saved: 3 });
  for (const url of otherPaths) assert.equal(f.visits.has(url), false, url);
  for (const url of [
    "https://humblebundle.com/",
    "https://humblebundle.com/books",
    "https://humblebundle.com/games",
    "https://github.com/user/project",
    "https://help.humblebundle.com/books/offer-2",
    "https://humblebundle.com.evil.test/books"
  ]) assert.equal(f.visits.has(url), true, url);
});

test("Toolbar deduplicates query, fragment and slash variants by path", async () => {
  const f = newFirefox([
    { id: 1, url: "https://humblebundle.com/books/?utm=store#section" },
    { id: 2, url: "https://humblebundle.com/books" },
    { id: 3, url: "http://www.humblebundle.com/books/?t=2" },
    { id: 4, url: "https://humblebundle.com/Books" },
    { id: 5, url: "https://humblebundle.com/books/games" },
  ]);
  await f.settle();
  const first = await f.click(1);
  assert.equal(first.entryUrl, "https://humblebundle.com/books");
  for (const id of [1, 2, 3]) assert.equal(f.actionState.get(id).badge, "✓");
  for (const id of [4, 5]) assert.equal(f.actionState.get(id).badge, "");
  const again = await f.click(3);
  assert.equal(again.alreadySaved, true);
  assert.equal(again.entryUrl, "https://humblebundle.com/books");
  assert.equal(f.persistentStorage.protectedSites["humblebundle.com"].entries.length, 1);
  await f.click(4);
  assert.equal(f.persistentStorage.protectedSites["humblebundle.com"].entries.length, 2,
    "paths are case sensitive");
});

test("individual entry can be unprotected while other entries remain protected", async () => {
  const f = newFirefox([
    { id: 1, url: "https://humblebundle.com/" },
    { id: 2, url: "https://humblebundle.com/books" },
    { id: 3, url: "https://humblebundle.com/games" }
  ]);
  await f.settle();
  for (let id = 1; id <= 3; ++id) await f.click(id);
  const ok = await f.message({ type: "unprotectEntry", host: "humblebundle.com", entryUrl: "https://humblebundle.com/books" });
  assert.equal(ok, true);
  assert.equal(f.actionState.get(1).badge, "✓");
  assert.equal(f.actionState.get(2).badge, "");
  assert.equal(f.actionState.get(3).badge, "✓");
  const oldEntry = "https://humblebundle.com/books";
  assert.equal(f.visits.has(oldEntry), true, "unprotect does not immediately delete existing History");
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 1);
  assert.equal(result.saved, 2);
  assert.equal(f.visits.has(oldEntry), false);
  await f.message({ type: "unprotectEntry", host: "humblebundle.com", entryUrl: "https://humblebundle.com/games" });
  await f.message({ type: "unprotectEntry", host: "humblebundle.com", entryUrl: "https://humblebundle.com/" });
  const noProtections = await f.message({ type: "list" });
  assert.equal(noProtections.length, 0);
  await f.visit(oldEntry);
  assert.equal(f.visits.has(oldEntry), true, "after final removal host is not cleaned");
  assert.equal((await f.message({ type: "clean" })).deleted, 0);
});

test("v1.0.2 whitelist migrates to multi-entry format without losing old homepage", async () => {
  const storage = {
    protectedSites: {
      "humblebundle.com": {
        host: "humblebundle.com", entryUrl: "https://humblebundle.com/", savedAt: 12345
      },
      "chatgpt.com": {
        host: "chatgpt.com", entryUrl: "https://chatgpt.com/", savedAt: 123456
      }
    }
  };
  const f = newFirefox([
    { id: 1, url: "https://humblebundle.com/books" },
    { id: 2, url: "https://chatgpt.com/" }
  ], storage);
  await f.settle();
  assert.equal(f.actionState.get(1).badge, "");
  assert.equal(f.actionState.get(2).badge, "✓");
  assert.equal(f.visits.has("https://humblebundle.com/"), true);
  assert.equal(f.visits.has("https://chatgpt.com/"), true);
  const old = await f.message({ type: "list" });
  assert.equal(old.length, 2);
  await f.click(1);
  const all = await f.message({ type: "list" });
  assert.equal(all.length, 3);
  assert.equal(storage.protectedSites["humblebundle.com"].entries.length, 2);
  assert.equal(storage.protectedSites["humblebundle.com"].entries[0].savedAt, 12345);
  assert.equal(storage.protectedSites["chatgpt.com"].entries[0].savedAt, 123456);
  assert.equal(f.visits.has("https://humblebundle.com/books"), true);
  assert.equal(f.visits.has("https://humblebundle.com/"), true);
});

test("deleting saved entries outside extension automatically restores each saved path", async () => {
  const f = newFirefox([
    { id: 1, url: "https://humblebundle.com/books" },
    { id: 2, url: "https://humblebundle.com/games" }
  ]);
  await f.settle();
  await f.click(1);
  await f.click(2);
  await f.browser.history.deleteUrl({ url: "https://humblebundle.com/games" });
  await f.settle();
  assert.equal(f.getVisitsRaw("https://humblebundle.com/games").length, 1);
  assert.equal(f.getVisitsRaw("https://humblebundle.com/books").length, 1);
  f.visits.clear();
  await f.events.removed.emit({ allHistory: true });
  await f.settle();
  assert.equal(f.getVisitsRaw("https://humblebundle.com/games").length, 1);
  assert.equal(f.getVisitsRaw("https://humblebundle.com/books").length, 1);
});

test("multiple protected paths survive restart in persistent storage", async () => {
  const storage = {};
  const f = newFirefox([
    { id: 1, url: "https://humblebundle.com/books" },
    { id: 2, url: "https://humblebundle.com/games" }
  ], storage);
  await f.settle();
  await f.click(1);
  await f.click(2);
  const restarted = newFirefox([
    { id: 1, url: "https://humblebundle.com/books?x=y" },
    { id: 2, url: "https://humblebundle.com/games/" },
    { id: 3, url: "https://humblebundle.com/" }
  ], storage);
  await restarted.settle();
  assert.equal(restarted.actionState.get(1).badge, "✓");
  assert.equal(restarted.actionState.get(2).badge, "✓");
  assert.equal(restarted.actionState.get(3).badge, "");
  assert.equal(restarted.visits.has("https://humblebundle.com/books"), true);
  assert.equal(restarted.visits.has("https://humblebundle.com/games"), true);
});

test("failed second path save does not destroy existing protected entry", async () => {
  const f = newFirefox([
    { id: 1, url: "https://humblebundle.com/books" },
    { id: 2, url: "https://humblebundle.com/games" }
  ]);
  await f.settle();
  await f.click(1);
  const initialAdd = f.browser.history.addUrl;
  f.browser.history.addUrl = async ({ url, ...rest }) => {
    if (url === "https://humblebundle.com/games") throw new Error("Mock addUrl failure");
    return initialAdd({ url, ...rest });
  };
  await assert.rejects(() => f.click(2), /Mock addUrl failure/);
  assert.equal((await f.message({ type: "list" })).length, 1);
  assert.equal(f.persistentStorage.protectedSites["humblebundle.com"].entries[0].entryUrl, "https://humblebundle.com/books");
  assert.equal(f.actionState.get(1).badge, "✓");
  assert.equal(f.actionState.get(2).badge, "");
});

test("saving /books alone does not implicitly save the website homepage", async () => {
  const f = newFirefox([{ id: 1, url: "https://humblebundle.com/books" }]);
  await f.settle();
  await f.click();
  await f.visit("https://humblebundle.com/");
  assert.equal(f.visits.has("https://humblebundle.com/"), false);
  assert.equal(f.visits.has("https://humblebundle.com/books"), true);
  await f.visit("https://github.com/");
  assert.equal(f.visits.has("https://github.com/"), true);
});

test("v1.0.4 manually adds an exact URL, normalizes query/slash, and leaves other hosts untouched", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.com/help" }]);
  await f.settle();
  const added = await f.message({ type: "add", url: "https://chatgpt.com/books/?utm=1#top", matchMode: "exact", historyMode: "all" });
  assert.equal(added.alreadySaved, false);
  assert.equal(added.entryUrl, "https://chatgpt.com/books");
  assert.equal(added.matchMode, "exact");
  assert.equal(added.historyMode, "entry", "exact ignores requested keep-all");
  assert.equal(f.visits.has("https://chatgpt.com/books"), true);
  await f.visit("https://chatgpt.com/books/details");
  await f.visit("https://chatgpt.com/books?ref=1");
  await f.visit("https://example.com/help");
  assert.equal(f.visits.has("https://chatgpt.com/books/details"), false);
  assert.equal(f.visits.has("https://chatgpt.com/books?ref=1"), false);
  assert.equal(f.visits.has("https://example.com/help"), true);
});

test("prefix entry-only matches descendants in toolbar, retains only saved entry URL", async () => {
  const f = newFirefox([
    { id: 1, url: "https://chatgpt.com/g/abc" },
    { id: 2, url: "https://chatgpt.com/games" },
    { id: 3, url: "https://chatgpt.com/g/" },
    { id: 4, url: "https://other.example/g/abc" }
  ]);
  await f.settle();
  const added = await f.message({ type: "add", url: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "entry" });
  assert.equal(added.entryUrl, "https://chatgpt.com/g/", "trailing slash remains an entry URL");
  const result = await f.click(1);
  assert.equal(result.alreadySaved, true);
  assert.equal(result.matched, true);
  assert.equal(result.matchMode, "prefix");
  assert.equal(result.historyMode, "entry");
  assert.equal(result.keepHistory, false);
  assert.equal(f.persistentStorage.protectedSites["chatgpt.com"].entries.length, 1);
  assert.equal(f.actionState.get(1).badge, "✓");
  assert.equal(f.actionState.get(2).badge, "");
  assert.equal(f.actionState.get(3).badge, "✓");
  assert.equal(f.actionState.get(4).badge, "");
  for (const url of ["https://chatgpt.com/g/abc", "https://chatgpt.com/g/def?q=hi", "https://chatgpt.com/games"]) {
    await f.visit(url);
    assert.equal(f.visits.has(url), false, url);
  }
  await f.visit("https://other.example/g/abc");
  assert.equal(f.visits.has("https://other.example/g/abc"), true);
  assert.equal(f.visits.has("https://chatgpt.com/g/"), true);
});

test("prefix keep-all retains descendants including query variants; cleans other paths", async () => {
  const f = newFirefox([{ id: 1, url: "https://chatgpt.com/g/abc" }]);
  await f.settle();
  await f.message({ type: "add", url: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "all" });
  for (const url of [
    "https://chatgpt.com/g/abc", "https://chatgpt.com/g/abc?utm=ad",
    "https://chatgpt.com/g/", "https://chatgpt.com/g", "http://www.chatgpt.com/g/q"
  ]) {
    await f.visit(url);
    assert.equal(f.visits.has(url), true, url);
  }
  for (const url of ["https://chatgpt.com/games", "https://chatgpt.com/c/xyz"]) {
    await f.visit(url);
    assert.equal(f.visits.has(url), false, url);
  }
  f.seed("https://chatgpt.com/g/old?ref=z");
  f.seed("https://chatgpt.com/c/old");
  f.seed("https://other.example/?source=chatgpt.com/g/");
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 1);
  assert.equal(result.saved, 1);
  assert.equal(f.visits.has("https://chatgpt.com/g/old?ref=z"), true);
  assert.equal(f.visits.has("https://chatgpt.com/c/old"), false);
  assert.equal(f.visits.has("https://other.example/?source=chatgpt.com/g/"), true);
});

test("updating one rule switches prefix behavior without changing other protected entries", async () => {
  const f = newFirefox([{ id: 1, url: "https://chatgpt.com/g/abc" }]);
  await f.settle();
  await f.message({ type: "add", url: "https://chatgpt.com/", matchMode: "exact", historyMode: "entry" });
  await f.message({ type: "add", url: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "entry" });
  const edited = await f.message({ type: "updateEntry", host: "chatgpt.com", entryUrl: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "all" });
  assert.equal(edited, true);
  const list = await f.message({ type: "list" });
  assert.equal(list.length, 2);
  assert.equal(list.find((item) => item.entryUrl.endsWith("/g/")).historyMode, "all");
  assert.equal(list.find((item) => item.entryUrl === "https://chatgpt.com/").matchMode, "exact");
  await f.visit("https://chatgpt.com/g/abc");
  assert.equal(f.visits.has("https://chatgpt.com/g/abc"), true);
  const reverted = await f.message({ type: "updateEntry", host: "chatgpt.com", entryUrl: "https://chatgpt.com/g/", matchMode: "exact", historyMode: "all" });
  assert.equal(reverted, true);
  await f.visit("https://chatgpt.com/g/def");
  assert.equal(f.visits.has("https://chatgpt.com/g/def"), false);
  assert.equal(f.visits.has("https://chatgpt.com/"), true);
});

test("most-specific rule wins, and all explicitly saved entry URLs always survive", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "add", url: "https://chatgpt.com/", matchMode: "prefix", historyMode: "all" });
  await f.message({ type: "add", url: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "entry" });
  await f.message({ type: "add", url: "https://chatgpt.com/g/important", matchMode: "exact", historyMode: "entry" });
  await f.visit("https://chatgpt.com/c/1");
  await f.visit("https://chatgpt.com/g/sub/1");
  await f.visit("https://chatgpt.com/g/important");
  await f.visit("https://chatgpt.com/g/important?ref=ad");
  assert.equal(f.visits.has("https://chatgpt.com/c/1"), true);
  assert.equal(f.visits.has("https://chatgpt.com/g/sub/1"), false);
  assert.equal(f.visits.has("https://chatgpt.com/g/important"), true);
  assert.equal(f.visits.has("https://chatgpt.com/g/important?ref=ad"), false);
  assert.equal(f.visits.has("https://chatgpt.com/g/"), true);
});

test("manual duplicate path cannot overwrite an existing rule, and allows exact child beneath prefix", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "add", url: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "entry" });
  const duplicate = await f.message({ type: "add", url: "http://www.chatgpt.com/g?x=1", matchMode: "prefix", historyMode: "all" });
  assert.equal(duplicate.alreadySaved, true);
  assert.equal(duplicate.historyMode, "entry");
  assert.equal((await f.message({ type: "list" })).length, 1);
  const child = await f.message({ type: "add", url: "https://chatgpt.com/g/important", matchMode: "exact", historyMode: "entry" });
  assert.equal(child.alreadySaved, false);
  await f.visit("https://chatgpt.com/g/important");
  await f.visit("https://chatgpt.com/g/unimportant");
  assert.equal(f.visits.has("https://chatgpt.com/g/important"), true);
  assert.equal(f.visits.has("https://chatgpt.com/g/unimportant"), false);
});

test("legacy v1.0.3 entries migrate to exact/entry and survive adding a prefix", async () => {
  const storage = { protectedSites: {
    "humblebundle.com": { host: "humblebundle.com", entries: [
      { entryUrl: "https://humblebundle.com/books", savedAt: 20 },
      { entryUrl: "https://humblebundle.com/games", savedAt: 21 }
    ] }
  } };
  const f = newFirefox([{ id: 1, url: "https://humblebundle.com/books" }], storage);
  await f.settle();
  const before = await f.message({ type: "list" });
  assert.deepEqual(JSON.parse(JSON.stringify(before.map((item) => [item.matchMode, item.historyMode]))), [["exact", "entry"], ["exact", "entry"]]);
  await f.message({ type: "add", url: "https://humblebundle.com/", matchMode: "prefix", historyMode: "entry" });
  const after = await f.message({ type: "list" });
  assert.equal(after.length, 3);
  assert.equal(after.find((item) => item.entryUrl.endsWith("/books")).savedAt, 20);
  await f.visit("https://humblebundle.com/books");
  await f.visit("https://humblebundle.com/books/child");
  assert.equal(f.visits.has("https://humblebundle.com/books"), true);
  assert.equal(f.visits.has("https://humblebundle.com/books/child"), false);
});

test("invalid/manual URLs and invalid rule changes fail closed", async () => {
  const f = newFirefox();
  await f.settle();
  for (const url of ["file:///Users/secret", "about:config", "javascript:alert(1)", "not a url", "https://user:pass@example.com/"]) {
    await assert.rejects(f.message({ type: "add", url, matchMode: "exact", historyMode: "entry" }));
  }
  await assert.rejects(f.message({ type: "add", url: "https://example.com", matchMode: "regex", historyMode: "entry" }));
  assert.equal((await f.message({ type: "list" })).length, 0);
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 0);
});

test("background tooltip uses Firefox locale, with English default and Traditional Chinese", async () => {
  const en = newFirefox();
  await en.settle();
  assert.match(en.actionState.get(1).title, /Click to protect/);
  const zh = newFirefox(undefined, {}, "zh-HK");
  await zh.settle();
  assert.match(zh.actionState.get(1).title, /按一下以保護/);
  await zh.click();
  assert.match(zh.actionState.get(1).title, /已保護網址/);
});

test("No History matches apex, www, and deeply nested subdomains, never unrelated sites", async () => {
  const f = newFirefox([
    { id: 1, url: "https://example.org/" },
    { id: 2, url: "https://aaaa.example.org/checkout" },
    { id: 3, url: "https://github.com/repo" }
  ]);
  await f.settle();
  const rule = await f.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: true });
  assert.equal(rule.alreadySaved, false);
  assert.equal(rule.hostname, "example.org");
  assert.equal(rule.includeSubdomains, true);
  for (const url of [
    "https://example.org/", "http://example.org/path", "https://www.example.org/",
    "https://aaaa.example.org/pay", "https://x.y.example.org/abc?q=1",
    "https://example.org/UPPER", "https://user:pass@example.org/secret"
  ]) {
    await f.visit(url);
    assert.equal(f.visits.has(url), false, `Excluded host must be deleted: ${url}`);
  }
  for (const url of [
    "https://notexample.org/", "https://example.org.evil.test/path", "https://github.com/example.org",
    "https://evil.example/?q=aaaa.example.org", "https://unrelated.com/"
  ]) {
    await f.visit(url);
    assert.equal(f.visits.has(url), true, `Unrelated URLs must remain: ${url}`);
  }
  assert.equal(f.actionState.get(1).badge, "×");
  assert.equal(f.actionState.get(2).badge, "×");
  assert.equal(f.actionState.get(1).icon, "icons/excluded.svg");
  assert.equal(f.actionState.get(3).badge, "");
  const click = await f.click(2);
  assert.equal(click.excluded, true);
  assert.equal(click.saved, false);
  assert.equal(click.hostname, "example.org");
  assert.equal((await f.message({ type: "list" })).length, 0, "popup must not auto-protect excluded URLs");
});

test("No History with Include Subdomains off only deletes the exact hostname", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: false });
  const urls = [
    "https://example.org/", "https://example.org/books", "https://www.example.org/",
    "https://aaaa.example.org/", "https://y.x.example.org/", "https://example.org.evil.test/"
  ];
  for (const url of urls) await f.visit(url);
  for (const url of urls.slice(0, 2)) assert.equal(f.visits.has(url), false, url);
  for (const url of urls.slice(2)) assert.equal(f.visits.has(url), true, url);
  const list = await f.message({ type: "listExcluded" });
  assert.equal(list.length, 1);
  assert.equal(list[0].includeSubdomains, false);
});

test("No History precedence stops restore of saved entry after visit deletion and Clean Now", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await f.settle();
  await f.click();
  assert.equal(f.getVisitsRaw("https://example.org/").length, 1);
  const preview = await f.message({ type: "checkExcluded", hostname: "example.org", includeSubdomains: true });
  assert.deepEqual(JSON.parse(JSON.stringify(preview.conflicts)), ["https://example.org/"]);
  const added = await f.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: true });
  assert.deepEqual(JSON.parse(JSON.stringify(added.conflicts)), ["https://example.org/"]);
  const listProtected = await f.message({ type: "list" });
  assert.equal(listProtected[0].excluded, true);
  assert.equal(f.actionState.get(1).badge, "×");
  assert.equal(f.actionState.get(1).icon, "icons/excluded.svg");
  assert.equal((await f.click()).excluded, true);
  // Before explicit Clean Now, pre-existing records are still on disk.
  assert.equal(f.visits.has("https://example.org/"), true);
  await f.visit("https://example.org/");
  assert.equal(f.visits.has("https://example.org/"), false, "deleted entry must NOT be resurrected");
  assert.equal((await f.message({ type: "list" })).length, 1, "protected rule stays stored but inactive");
  f.seed("https://example.org/");
  const cleanup = await f.message({ type: "clean" });
  assert.equal(cleanup.deleted, 1);
  assert.equal(cleanup.saved, 0);
  assert.equal(f.visits.has("https://example.org/"), false);
});

test("No History wins over Prefix Keep All and does not affect other protected domains", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "add", url: "https://chatgpt.com/g/", matchMode: "prefix", historyMode: "all" });
  await f.message({ type: "add", url: "https://github.com/", matchMode: "exact", historyMode: "entry" });
  await f.message({ type: "addExcluded", hostname: "chatgpt.com", includeSubdomains: true });
  for (const url of ["https://chatgpt.com/g/123", "https://chatgpt.com/g/xyz", "https://chatgpt.com/"] ) {
    await f.visit(url);
    assert.equal(f.visits.has(url), false, `No History overrides Prefix Keep All: ${url}`);
  }
  assert.equal(f.visits.has("https://github.com/"), true);
  await f.visit("https://other.example/g/123");
  assert.equal(f.visits.has("https://other.example/g/123"), true);
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 1, "pre-existing saved /g/ is removed");
  assert.equal(result.saved, 1, "only Github entry remains active");
  assert.equal(f.visits.has("https://chatgpt.com/g/"), false);
  assert.equal(f.visits.has("https://github.com/"), true);
});

test("Clean Now with only No History rules deletes all historic subdomains across pages", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: true });
  const now = Date.now() - 2_000_000;
  for (let i = 0; i < 730; ++i) {
    f.seed(`https://aaa.example.org/pay/${i}`, now + i * 3);
    f.seed(`https://other.example/ref/example.org/${i}`, now + i * 3 + 1);
  }
  for (let i = 0; i < 230; ++i) f.seed(`https://example.org/old/${i}`, now - 500_000 + i * 3);
  f.seed("https://notexample.org/random", now - 100_000);
  f.seed("https://github.com/random", now - 100_000);
  const cleanup = await f.message({ type: "clean" });
  assert.equal(cleanup.deleted, 960);
  assert.equal(cleanup.failed, 0);
  assert.equal(cleanup.saved, 0);
  assert.equal(f.visits.size, 732, "only 730 unrelated references and 2 other sites remain");
  assert.equal(f.visits.has("https://notexample.org/random"), true);
  assert.equal(f.visits.has("https://github.com/random"), true);
});

test("Clean Now handles both protected-host and No History rules without deleting unrelated pages", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "add", url: "https://mvnrepository.com/", matchMode: "exact", historyMode: "entry" });
  await f.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: true });
  f.seed("https://mvnrepository.com/artifact/log4j");
  f.seed("https://example.org/");
  f.seed("https://aaa.example.org/pay");
  f.seed("https://example.org.evil.test/pay");
  f.seed("https://github.com/source?ref=example.org");
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 3);
  assert.equal(result.saved, 1);
  assert.equal(f.visits.has("https://mvnrepository.com/"), true);
  assert.equal(f.visits.has("https://example.org/"), false);
  assert.equal(f.visits.has("https://aaa.example.org/pay"), false);
  assert.equal(f.visits.has("https://github.com/source?ref=example.org"), true);
  assert.equal(f.visits.has("https://example.org.evil.test/pay"), true);
});

test("Removing No History reactivates protected entry without recovering unrelated visits", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await f.settle();
  await f.click();
  await f.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: true });
  f.seed("https://example.org/pay/old");
  await f.message({ type: "clean" });
  assert.equal(f.visits.has("https://example.org/"), false);
  assert.equal(f.visits.has("https://example.org/pay/old"), false);
  const removed = await f.message({ type: "removeExcluded", hostname: "example.org" });
  assert.equal(removed, true);
  assert.equal(f.visits.has("https://example.org/"), true, "formerly protected entry resumes protection");
  assert.equal(f.visits.has("https://example.org/pay/old"), false, "deleted ordinary visits are NOT recovered");
  assert.equal(f.actionState.get(1).badge, "✓");
  assert.equal((await f.message({ type: "listExcluded" })).length, 0);
});

test("Updating includeSubdomains flag narrows exclusion and restores now-active protected www entry", async () => {
  const f = newFirefox([{ id: 1, url: "https://www.example.org/books" }]);
  await f.settle();
  await f.click();
  await f.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: true });
  await f.message({ type: "clean" });
  assert.equal(f.visits.has("https://www.example.org/books"), false);
  await f.message({ type: "updateExcluded", hostname: "example.org", includeSubdomains: false });
  assert.equal(f.visits.has("https://www.example.org/books"), true);
  assert.equal(f.actionState.get(1).badge, "✓");
  await f.visit("https://abc.example.org/payment");
  assert.equal(f.visits.has("https://abc.example.org/payment"), true);
  await f.visit("https://example.org/payment");
  assert.equal(f.visits.has("https://example.org/payment"), false);
});

test("Conflicting exclusions prioritize most-specific hostname; removing root keeps child rule", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: true });
  await f.message({ type: "addExcluded", hostname: "www.example.org", includeSubdomains: false });
  assert.equal((await f.message({ type: "listExcluded" })).length, 2);
  await f.message({ type: "removeExcluded", hostname: "example.org" });
  await f.visit("https://www.example.org/p");
  await f.visit("https://www2.example.org/p");
  await f.visit("https://example.org/p");
  assert.equal(f.visits.has("https://www.example.org/p"), false);
  assert.equal(f.visits.has("https://www2.example.org/p"), true);
  assert.equal(f.visits.has("https://example.org/p"), true);
});

test("Rejected No History rule hostnames cannot accidentally widen deletion scope", async () => {
  const f = newFirefox();
  await f.settle();
  for (const hostname of ["com", "*.example.org", "example.org/private", "example.org:8080",
    "https://example.org/path", "https://example.org?q=foo", "example.org@evil.example",
    "example..com", "not a domain", "javascript:alert(1)", ""] ) {
    await assert.rejects(f.message({ type: "addExcluded", hostname, includeSubdomains: true }),
      undefined, `Invalid hostname should reject: ${hostname}`);
  }
  await assert.rejects(f.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: "yes" }));
  assert.equal((await f.message({ type: "listExcluded" })).length, 0);
  await f.visit("https://example.org/keep");
  assert.equal(f.visits.has("https://example.org/keep"), true);
});

test("No History storage persists across restart independently of protectedSites", async () => {
  const original = newFirefox();
  await original.settle();
  await original.message({ type: "add", url: "https://github.com/", matchMode: "exact", historyMode: "entry" });
  await original.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: true });
  const storage = original.persistentStorage;
  const restarted = newFirefox([{ id: 1, url: "https://aaaa.example.org/pay" }], storage);
  await restarted.settle();
  assert.equal((await restarted.message({ type: "listExcluded" })).length, 1);
  assert.equal((await restarted.message({ type: "list" })).length, 1);
  assert.equal(restarted.actionState.get(1).badge, "×");
  await restarted.visit("https://aaaa.example.org/pay");
  assert.equal(restarted.visits.has("https://aaaa.example.org/pay"), false);
  assert.equal(restarted.visits.has("https://github.com/"), true);
});

test("Malformed excludedHosts storage entries are ignored rather than wiping arbitrary domains", async () => {
  const initial = {
    excludedHosts: {
      "com": { hostname: "com", includeSubdomains: true },
      "example.org": { hostname: "github.com", includeSubdomains: true },
      "evil.com": { hostname: "evil.com", includeSubdomains: "true" }
    }
  };
  const f = newFirefox([], initial);
  await f.settle();
  assert.equal((await f.message({ type: "listExcluded" })).length, 0);
  await f.visit("https://example.org/keep");
  await f.visit("https://github.com/keep");
  assert.equal(f.visits.size, 2);
});

test("No History remains active after external storage changes and does not alter other domains", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.org/" }, { id: 2, url: "https://github.com/" }]);
  await f.settle();
  await f.browser.storage.local.set({ excludedHosts: {
    "example.org": { hostname: "example.org", includeSubdomains: true, savedAt: Date.now() }
  } });
  await f.settle();
  assert.equal(f.actionState.get(1).badge, "×");
  assert.equal(f.actionState.get(2).badge, "");
  await f.visit("https://pay.example.org/transaction");
  await f.visit("https://github.com/transaction");
  assert.equal(f.visits.has("https://pay.example.org/transaction"), false);
  assert.equal(f.visits.has("https://github.com/transaction"), true);
});

test("Duplicate No History addition remains idempotent and updating requires explicit action", async () => {
  const f = newFirefox();
  await f.settle();
  const first = await f.message({ type: "addExcluded", hostname: "https://EXAMPLE.ORG/", includeSubdomains: true });
  assert.equal(first.hostname, "example.org");
  const second = await f.message({ type: "addExcluded", hostname: "example.org", includeSubdomains: false });
  assert.equal(second.alreadySaved, true);
  assert.equal(second.includeSubdomains, true, "duplicate must NOT implicitly change the rule");
  assert.equal((await f.message({ type: "listExcluded" })).length, 1);
  const update = await f.message({ type: "updateExcluded", hostname: "example.org", includeSubdomains: false });
  assert.equal(update, true);
  assert.equal((await f.message({ type: "listExcluded" }))[0].includeSubdomains, false);
});

// v1.0.6 regressions: hostname scope, precedence, clean-up isolation,
// import/export and migration from the original persistent storage keys.
test("Host Entry retains exactly one homepage, deleting same hostname and all selected subdomains", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.net/" }]);
  await f.settle();
  const added = await f.message({ type: "addHostEntry", hostname: "example.net", entryUrl: "", includeSubdomains: true });
  assert.equal(added.entryUrl, "https://example.net/");
  assert.equal(f.getVisitsRaw("https://example.net/").length, 1);
  for (const url of ["https://example.net/path", "https://example.net/?foo=1",
    "https://www.example.net/", "https://a.b.example.net/child"]) {
    await f.visit(url);
    assert.equal(f.getVisitsRaw(url).length, 0, url);
  }
  await f.visit("https://unrelated.net/a");
  await f.visit("https://notexample.net/a");
  assert.equal(f.getVisitsRaw("https://unrelated.net/a").length, 1);
  assert.equal(f.getVisitsRaw("https://notexample.net/a").length, 1);
  assert.equal(f.actionState.get(1).badge, "✓");
  const saved = await f.click();
  assert.equal(saved.hostEntry, true);
  assert.equal(saved.keepHistory, true);
});

test("Host Entry restricted to exact hostname leaves subdomain and unrelated sites untouched", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "addHostEntry", hostname: "example.net", entryUrl: "https://example.net/start", includeSubdomains: false });
  await f.visit("https://example.net/else");
  await f.visit("https://foo.example.net/else");
  assert.equal(f.getVisitsRaw("https://example.net/else").length, 0);
  assert.equal(f.getVisitsRaw("https://foo.example.net/else").length, 1);
  assert.equal(f.getVisitsRaw("https://example.net/start").length, 1);
});

test("Host Entry overrides Protected URL but No History overrides Host Entry and blocks restore", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "add", url: "https://example.net/books", matchMode: "exact", historyMode: "entry" });
  await f.message({ type: "addHostEntry", hostname: "example.net", entryUrl: "https://example.net/", includeSubdomains: true });
  await f.visit("https://example.net/books");
  assert.equal(f.getVisitsRaw("https://example.net/books").length, 0);
  // Do not recreate a supposedly protected entry once Host Entry takes priority.
  await f.settle();
  assert.equal(f.getVisitsRaw("https://example.net/books").length, 0);
  await f.message({ type: "addExcluded", hostname: "example.net", includeSubdomains: true });
  await f.visit("https://example.net/");
  assert.equal(f.getVisitsRaw("https://example.net/").length, 0);
  await f.settle();
  assert.equal(f.getVisitsRaw("https://example.net/").length, 0);
});

test("Host Entry Clean Now scans more than two batches without touching any unrelated history", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "addHostEntry", hostname: "example.net", entryUrl: "https://example.net/", includeSubdomains: true });
  const base = Date.now() - 2_000_000;
  for (let n = 0; n < 1255; n++) {
    f.seed(`https://a.example.net/${n}`, base + n * 3);
    f.seed(`https://unrelated.net/${n}`, base + n * 3);
  }
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 1255);
  assert.equal(result.failed, 0);
  assert.equal(f.getVisitsRaw("https://example.net/").length, 1);
  assert.equal(f.getVisitsRaw("https://unrelated.net/99").length, 1);
  assert.equal(f.visits.size, 1256);
});

test("Host Entry saved URL is restored when user clears History; removal stops auto-clean", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "addHostEntry", hostname: "example.net", entryUrl: "", includeSubdomains: true });
  await f.browser.history.deleteUrl({ url: "https://example.net/" });
  await f.settle();
  assert.equal(f.getVisitsRaw("https://example.net/").length, 1);
  await f.message({ type: "removeHostEntry", hostname: "example.net" });
  await f.visit("https://foo.example.net/path");
  assert.equal(f.getVisitsRaw("https://foo.example.net/path").length, 1);
});

test("Export/import merge preserves original storage and does not delete existing history", async () => {
  const previousStorage = { protectedSites: {
    "example.org": { host: "example.org", entries: [{ entryUrl: "https://example.org/", savedAt: 99 }] }
  } };
  const f = newFirefox(undefined, previousStorage);
  await f.settle();
  await f.message({ type: "addExcluded", hostname: "private.net", includeSubdomains: true });
  await f.message({ type: "addHostEntry", hostname: "example.net", entryUrl: "", includeSubdomains: true });
  const exported = await f.message({ type: "exportSettings" });
  assert.equal(exported.format, "history-control-settings");
  assert.equal(exported.formatVersion, 1);
  assert.ok(exported.protectedSites["example.org"]);
  assert.ok(exported.excludedHosts["private.net"]);
  assert.ok(exported.hostEntryRules["example.net"]);
  f.seed("https://unrelated.net/a");
  const merged = await f.message({ type: "importSettings", payload: exported, mode: "merge" });
  assert.equal(merged.added, 0);
  assert.equal(merged.skipped, 3);
  assert.equal(f.getVisitsRaw("https://unrelated.net/a").length, 1);
  const empty = { format: "history-control-settings", formatVersion: 1,
    protectedSites: {}, excludedHosts: {}, hostEntryRules: {} };
  const replaced = await f.message({ type: "importSettings", payload: empty, mode: "replace" });
  assert.equal(replaced.added, 0);
  assert.equal(f.getVisitsRaw("https://unrelated.net/a").length, 1);
  await f.visit("https://foo.example.net/new");
  assert.equal(f.getVisitsRaw("https://foo.example.net/new").length, 1);
});

test("Import rejects invalid data and never changes existing records", async () => {
  const f = newFirefox();
  await f.settle();
  await f.message({ type: "addHostEntry", hostname: "example.net", entryUrl: "", includeSubdomains: true });
  const bad = { format: "history-control-settings", formatVersion: 1,
    protectedSites: {}, excludedHosts: {}, hostEntryRules: {
      "com": { hostname: "com", entryUrl: "https://com/", includeSubdomains: true }
    } };
  await assert.rejects(f.message({ type: "importSettings", payload: bad, mode: "replace" }), /Invalid|inconsistent/i);
  assert.equal((await f.message({ type: "listHostEntries" })).length, 1);
  await assert.rejects(f.message({ type: "importSettings", payload: { format: "history-control-settings", formatVersion: 3 }, mode: "replace" }), /Unsupported/);
});

test("Import accepts legacy v1.0.3 stored shape as Exact protected URLs", async () => {
  const f = newFirefox();
  await f.settle();
  const legacy = { protectedSites: { "example.org": { host: "example.org",
    entries: [{ entryUrl: "https://example.org/books", savedAt: 4 }] } }, excludedHosts: {} };
  const result = await f.message({ type: "importSettings", payload: legacy, mode: "merge" });
  assert.equal(result.added, 1);
  const [site] = await f.message({ type: "list" });
  assert.equal(site.matchMode, "exact");
  assert.equal(site.historyMode, "entry");
});

test("v1.0.9 records automatic deletions by local day without collecting URLs", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await f.settle();
  await f.click();
  await f.visit("https://example.org/section/a");
  await f.visit("https://example.org/section/b");
  await f.visit("https://unrestricted.test/not-a-rule");
  const stats = await f.message({ type: "getDailyStatistics" });
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  assert.equal(stats[day].auto, 2);
  assert.equal(stats[day].manual, 0);
  assert.equal(f.visits.has("https://unrestricted.test/not-a-rule"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.persistentStorage.dailyDeletionStatsV1)), {
    [day]: { auto: 2, manual: 0 }
  });
  const storedText = JSON.stringify(f.persistentStorage.dailyDeletionStatsV1);
  assert.doesNotMatch(storedText, /https?:|example\\.org|unrestricted\\.test/);
});

test("v1.0.9 tracks Clean Now separately and counts URLs rather than visits", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await f.settle();
  await f.click();
  f.seed("https://example.org/item/one");
  f.seed("https://example.org/item/one"); // Two visits to the same URL.
  f.seed("https://example.org/item/two");
  f.seed("https://unrestricted.test/keep");
  const result = await f.message({ type: "clean" });
  assert.equal(result.deleted, 2);
  await f.visit("https://example.org/item/three");
  const stats = await f.message({ type: "getDailyStatistics" });
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  assert.equal(stats[day].manual, 2);
  assert.equal(stats[day].auto, 1);
  assert.equal(f.visits.has("https://unrestricted.test/keep"), true);
});

test("v1.0.9 does not count unsuccessful deletion calls", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await f.settle();
  await f.click();
  const original = f.browser.history.deleteUrl;
  f.browser.history.deleteUrl = async ({ url }) => {
    if (url.endsWith("/fail")) throw new Error("synthetic deletion failure");
    return original({ url });
  };
  await f.visit("https://example.org/fail");
  const initial = await f.message({ type: "getDailyStatistics" });
  assert.equal(Object.keys(initial).length, 0);
  f.seed("https://example.org/okay");
  const clean = await f.message({ type: "clean" });
  assert.equal(clean.deleted, 1);
  assert.equal(clean.failed, 1);
  const after = await f.message({ type: "getDailyStatistics" });
  assert.equal(Object.values(after)[0].manual, 1);
  assert.equal(Object.values(after)[0].auto, 0);
});

test("v1.0.9 serializes concurrent visit statistics writes and persists across reload", async () => {
  const stored = {};
  const f = newFirefox([{ id: 1, url: "https://example.org/" }], stored);
  await f.settle();
  await f.click();
  const targets = Array.from({ length: 30 }, (_, i) => `https://example.org/fast/${i}`);
  await Promise.all(targets.map(async (url) => {
    f.seed(url);
    await f.events.visited.emit({ url, lastVisitTime: Date.now() });
  }));
  await f.settle();
  const stats = await f.message({ type: "getDailyStatistics" });
  assert.equal(Object.values(stats)[0].auto, 30);
  const restored = newFirefox([{ id: 1, url: "https://example.org/" }], stored);
  await restored.settle();
  const again = await restored.message({ type: "getDailyStatistics" });
  assert.equal(Object.values(again)[0].auto, 30);
  const snapshot = await restored.message({ type: "exportSettings" });
  assert.equal("dailyDeletionStatsV1" in snapshot, false, "Export remains rules-only");
  await restored.message({ type: "importSettings", payload: snapshot, mode: "replace" });
  assert.equal(Object.values(await restored.message({ type: "getDailyStatistics" }))[0].auto, 30,
    "Import Replace does not reset saved statistics");
});

test("v1.0.9 sanitizes malformed persisted statistics without affecting rules", async () => {
  const f = newFirefox([], {
    dailyDeletionStatsV1: {
      "not-a-date": { auto: 800, manual: 5 },
      "2026-02-30": { auto: 7, manual: 7 },
      "2026-10-20": { auto: -1, manual: 5 },
      "2026-10-19": { auto: 4, manual: 3 }
    }
  });
  await f.settle();
  const stats = await f.message({ type: "getDailyStatistics" });
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), { "2026-10-19": { auto: 4, manual: 3 } });
});

test("v1.0.9 Clean Now saves completed counts even when a later search fails", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await f.settle();
  await f.click();
  for (let i = 0; i < 500; i++) f.seed(`https://example.org/bulk/${i}`);
  const oldSearch = f.browser.history.search;
  let searches = 0;
  f.browser.history.search = async (query) => {
    if (++searches > 1) throw new Error("simulated paged search error");
    return oldSearch(query);
  };
  await assert.rejects(f.message({ type: "clean" }), /simulated paged search error/);
  const stats = await f.message({ type: "getDailyStatistics" });
  assert.equal(Object.values(stats)[0].manual, 499, "the retained entry occupies one of the 500 results");
});

test("v1.1.0 Full Backup contains all three rule sets and every daily aggregate", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await f.settle();
  await f.click();
  await f.message({ type: "addExcluded", hostname: "private.test", includeSubdomains: true });
  await f.message({ type: "addHostEntry", hostname: "landing.test", entryUrl: "", includeSubdomains: false });
  await f.visit("https://example.org/items/123");
  const full = await f.message({ type: "exportFullBackup" });
  const settingsOnly = await f.message({ type: "exportSettings" });
  assert.equal(full.format, "history-control-full-backup");
  assert.equal(full.formatVersion, 1);
  assert.equal(full.extensionId, f.browser.runtime.id);
  assert.equal(full.exportedAt.length > 0, true);
  assert.ok(full.protectedSites["example.org"]);
  assert.ok(full.excludedHosts["private.test"]);
  assert.ok(full.hostEntryRules["landing.test"]);
  assert.equal(Object.values(full.dailyDeletionStatsV1)[0].auto, 1);
  assert.equal("dailyDeletionStatsV1" in settingsOnly, false, "old rules-only export still works");
  assert.doesNotMatch(JSON.stringify(full.dailyDeletionStatsV1), /example\.org|items/);
});

test("v1.1.0 Full Backup restores all rules, stats, and does not delete unrelated History", async () => {
  const previous = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await previous.settle();
  await previous.click();
  await previous.message({ type: "addExcluded", hostname: "private.test", includeSubdomains: true });
  await previous.message({ type: "addHostEntry", hostname: "landing.test", entryUrl: "", includeSubdomains: true });
  await previous.visit("https://example.org/inner");
  const backup = JSON.parse(JSON.stringify(await previous.message({ type: "exportFullBackup" })));

  // Simulate a fresh signed installation with an empty storage.local.
  const installed = newFirefox([{ id: 2, url: "https://unrelated.test/page" }], {});
  await installed.settle();
  installed.seed("https://unrelated.test/keep-me");
  const restored = await installed.message({ type: "importFullBackup", payload: backup });
  assert.equal(restored.protectedCount, 1);
  assert.equal(restored.exclusionCount, 1);
  assert.equal(restored.hostEntryCount, 1);
  assert.equal(restored.statisticsDays, 1);
  assert.equal(installed.visits.has("https://unrelated.test/keep-me"), true);
  assert.equal(installed.visits.has("https://example.org/"), true);
  const imported = await installed.message({ type: "exportFullBackup" });
  for (const key of ["protectedSites", "excludedHosts", "hostEntryRules", "dailyDeletionStatsV1"]) {
    assert.deepEqual(JSON.parse(JSON.stringify(imported[key])), JSON.parse(JSON.stringify(backup[key])));
  }
  await installed.visit("https://more.private.test/page");
  assert.equal(installed.visits.has("https://more.private.test/page"), false, "No History rules operate after restore");
  await installed.visit("https://unrelated.test/new");
  assert.equal(installed.visits.has("https://unrelated.test/new"), true);
});

test("v1.1.0 signed add-on accepts original debug Full Backup after ID migration", async () => {
  const oldDebug = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await oldDebug.settle();
  await oldDebug.click();
  await oldDebug.message({ type: "addExcluded", hostname: "private.test", includeSubdomains: true });
  await oldDebug.visit("https://example.org/temporary");
  const backup = JSON.parse(JSON.stringify(await oldDebug.message({ type: "exportFullBackup" })));
  backup.extensionId = "firefox-minimal-history@local-extension.example";

  // The released extension uses a distinct Gecko ID. A backup from the old
  // Debug extension still needs to migrate without manually editing JSON.
  const newSigned = newFirefox([{ id: 2, url: "https://unrelated.test/" }], {});
  await newSigned.settle();
  const restored = await newSigned.message({ type: "importFullBackup", payload: backup });
  assert.equal(restored.protectedCount, 1);
  assert.equal(restored.exclusionCount, 1);
  assert.equal(restored.statisticsDays, 1);
  const exported = await newSigned.message({ type: "exportFullBackup" });
  assert.deepEqual(JSON.parse(JSON.stringify(exported.protectedSites)), backup.protectedSites);
  assert.deepEqual(JSON.parse(JSON.stringify(exported.dailyDeletionStatsV1)), backup.dailyDeletionStatsV1);
  assert.equal(newSigned.visits.has("https://unrelated.test/"), false);
});

test("v1.1.0 invalid Full Backups cannot alter existing rules or statistics", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await f.settle();
  await f.click();
  await f.visit("https://example.org/one");
  const before = await f.message({ type: "exportFullBackup" });
  const variants = [
    { ...before, extensionId: "foreign-addon@invalid.test" },
    { ...before, formatVersion: 2 },
    { ...before, dailyDeletionStatsV1: null },
    { format: before.format, formatVersion: before.formatVersion,
      extensionId: before.extensionId, dailyDeletionStatsV1: {} },
    { ...before, dailyDeletionStatsV1: { "2026-02-30": { auto: 3, manual: 5 } } },
    { ...before, dailyDeletionStatsV1: { "2026-10-19": { auto: -4, manual: 5 } } },
    { ...before, dailyDeletionStatsV1: { "2026-10-19": { auto: 0.5, manual: 5 } } },
    { ...before, protectedSites: { bad: { host: "bad", entries: [] } } },
  ];
  for (const payload of variants) {
    await assert.rejects(f.message({ type: "importFullBackup", payload }), /Invalid|inconsistent|file/i);
    const after = await f.message({ type: "exportFullBackup" });
    for (const key of ["protectedSites", "excludedHosts", "hostEntryRules", "dailyDeletionStatsV1"]) {
      assert.deepEqual(JSON.parse(JSON.stringify(after[key])), JSON.parse(JSON.stringify(before[key])));
    }
  }
});

test("v1.1.0 Full Backup restore replaces statistics and existing rules rather than merging", async () => {
  const f = newFirefox([{ id: 1, url: "https://example.org/" }]);
  await f.settle();
  await f.click();
  await f.visit("https://example.org/old");
  const original = await f.message({ type: "exportFullBackup" });
  await f.message({ type: "addExcluded", hostname: "not-in-backup.test", includeSubdomains: true });
  await f.visit("https://example.org/new");
  const newerStats = await f.message({ type: "getDailyStatistics" });
  assert.equal(Object.values(newerStats)[0].auto, 2);
  await f.message({ type: "importFullBackup", payload: original });
  const restoredStats = await f.message({ type: "getDailyStatistics" });
  assert.equal(Object.values(restoredStats)[0].auto, 1);
  assert.equal((await f.message({ type: "listExcluded" })).length, 0);
});
