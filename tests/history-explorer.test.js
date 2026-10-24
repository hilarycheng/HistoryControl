"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "history-explorer.js"), "utf8");
const en = require("../_locales/en/messages.json");
const zh = require("../_locales/zh_TW/messages.json");

function element() {
  return {
    value: "", textContent: "", disabled: false, hidden: false, className: "",
    children: [], callbacks: {}, classList: { toggle() {} },
    addEventListener(name, cb) { this.callbacks[name] = cb; },
    append(...els) { this.children.push(...els); },
    replaceChildren(...els) { this.children = [...els]; },
    click() { return this.callbacks.click?.(); }
  };
}
function harness(items, locale = "en-US") {
  const ids = ["explorer-scan", "explorer-cancel", "explorer-progress", "explorer-filter",
    "explorer-min-urls", "explorer-sort", "explorer-hosts", "explorer-summary", "explorer-empty", "explorer-host-body",
    "explorer-detail", "explorer-back", "explorer-detail-title", "explorer-url-sort",
    "explorer-url-body", "explorer-more"];
  const nodes = Object.fromEntries(ids.map((id) => [id, element()]));
  nodes["explorer-sort"].value = "urls";
  nodes["explorer-min-urls"].value = "2";
  nodes["explorer-url-sort"].value = "visits";
  const queryLog = [];
  const dictionary = locale.startsWith("zh-") ? zh : en;
  const browser = {
    i18n: { getUILanguage: () => locale,
      getMessage: (name) => (dictionary[name] || en[name])?.message || "" },
    history: { async search(query) {
      queryLog.push(query);
      return items.filter((item) => item.lastVisitTime >= query.startTime && item.lastVisitTime <= query.endTime)
        .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
        .slice(0, query.maxResults);
    } }
  };
  const document = { getElementById: (id) => nodes[id], createElement: element };
  vm.runInNewContext(source, { browser, document, URL, Intl, Date, console, setTimeout },
    { filename: "history-explorer.js" });
  return {
    nodes, queryLog,
    async scan() {
      nodes["explorer-scan"].click();
      for (let n = 0; n < 200 && nodes["explorer-scan"].disabled; n++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(nodes["explorer-scan"].disabled, false);
    },
    filter(value) { nodes["explorer-filter"].value = value; nodes["explorer-filter"].callbacks.input(); },
    minimum(value) { nodes["explorer-min-urls"].value = value; nodes["explorer-min-urls"].callbacks.input(); },
    sortHosts(value) { nodes["explorer-sort"].value = value; nodes["explorer-sort"].callbacks.change(); },
    clickHost(index = 0) { nodes["explorer-host-body"].children[index].children[0].children[0].click(); },
    urlAt(i = 0) { return nodes["explorer-url-body"].children[i].children[0].children[0].textContent; },
    hostAt(i = 0) { return nodes["explorer-host-body"].children[i].children[0].children[0].textContent; }
  };
}

function record(url, visitCount, lastVisitTime) {
  return { url, visitCount, lastVisitTime };
}

test("History Explorer counts full history across the 1,500-result query limit", async () => {
  const base = Date.now() - 8_000_000;
  const items = Array.from({ length: 1800 }, (_, n) => record(
    `https://${n < 1100 ? "many.example.net" : "few.example.net"}/path/${n}`,
    n < 1100 ? 1 : 2, base + n * 2000));
  const h = harness(items);
  await h.scan();
  assert.ok(h.queryLog.length > 1, "adaptive search must paginate");
  assert.match(h.nodes["explorer-summary"].textContent, /1,800/);
  assert.equal(h.hostAt(0), "many.example.net");
  assert.equal(h.hostAt(1), "few.example.net");
  assert.equal(h.nodes["explorer-host-body"].children[0].children[1].textContent, "1,100");
  h.sortHosts("visits");
  assert.equal(h.hostAt(0), "few.example.net", "1400 visits outranks 1100 visits");
  h.filter("/path/19");
  assert.match(h.nodes["explorer-summary"].textContent, /URLs: 11/);
});

test("Host drill-down sorts by visit count descending, supports last visit and 100-row paging", async () => {
  const base = Date.now() - 8_000_000;
  const items = Array.from({ length: 225 }, (_, n) => record(
    `https://www.example.net/item/${n}`, n % 12 + 1, base + n * 2000));
  const h = harness(items);
  await h.scan();
  h.clickHost();
  assert.equal(h.nodes["explorer-detail"].hidden, false);
  assert.equal(h.nodes["explorer-url-body"].children.length, 100);
  assert.equal(h.nodes["explorer-more"].hidden, false);
  assert.ok(h.urlAt(0).endsWith("/215"), "visit count 12, latest visit on tie first");
  h.nodes["explorer-more"].click();
  assert.equal(h.nodes["explorer-url-body"].children.length, 200);
  h.nodes["explorer-url-sort"].value = "last";
  h.nodes["explorer-url-sort"].callbacks.change();
  assert.ok(h.urlAt(0).endsWith("/224"));
  h.nodes["explorer-back"].click();
  assert.equal(h.nodes["explorer-detail"].hidden, true);
  assert.equal(h.nodes["explorer-hosts"].hidden, false);
});

test("History Explorer does not silently show incomplete results when timestamps overflow", async () => {
  const time = Date.now() - 1234567;
  const items = Array.from({ length: 1501 }, (_, n) => record(`https://big.example.net/${n}`, 1, time));
  const h = harness(items);
  await h.scan();
  assert.match(h.nodes["explorer-progress"].textContent, /too large/);
  assert.equal(h.nodes["explorer-host-body"].children.length, 0);
});

test("History Explorer provides formal Traditional Chinese and filters on URL content", async () => {
  const h = harness([
    record("https://example.net/books/one", 4, Date.now() - 10000),
    record("https://example.net/games/two", 8, Date.now() - 9000),
    record("file:///foo/private", 77, Date.now() - 8000)
  ], "zh-HK");
  assert.match(h.nodes["explorer-progress"].textContent, /分析瀏覽紀錄/);
  await h.scan();
  h.filter("games");
  assert.equal(h.nodes["explorer-host-body"].children.length, 0, "one matching URL is below default minimum");
  h.minimum("1");
  assert.equal(h.nodes["explorer-host-body"].children.length, 1);
  h.clickHost();
  assert.match(h.urlAt(0), /games/);
  assert.equal(h.nodes["explorer-url-body"].children.length, 1);
});


test("minimum URL count defaults to 2 and filters hosts without changing History", async () => {
  const now = Date.now() - 30000;
  const items = [
    record("https://one.example.invalid/a", 55, now),
    record("https://two.example.invalid/a", 4, now + 1),
    record("https://two.example.invalid/b", 6, now + 2),
    record("https://three.example.invalid/a", 2, now + 3),
    record("https://three.example.invalid/b", 3, now + 4),
    record("https://three.example.invalid/c", 1, now + 5)
  ];
  const h = harness(items);
  assert.equal(h.nodes["explorer-min-urls"].value, "2");
  await h.scan();
  assert.deepEqual([h.hostAt(0), h.hostAt(1)], ["three.example.invalid", "two.example.invalid"]);
  assert.equal(h.nodes["explorer-host-body"].children.length, 2);
  assert.match(h.nodes["explorer-summary"].textContent, /Hosts: 2 \/ 3/);
  assert.match(h.nodes["explorer-summary"].textContent, /URLs: 5/);
  h.minimum("1");
  assert.equal(h.nodes["explorer-host-body"].children.length, 3);
  h.sortHosts("visits");
  assert.equal(h.hostAt(0), "one.example.invalid", "sort still uses visit count");
  h.minimum("4");
  assert.equal(h.nodes["explorer-host-body"].children.length, 0);
  assert.equal(h.nodes["explorer-empty"].hidden, false);
  h.minimum("0");
  assert.equal(h.nodes["explorer-host-body"].children.length, 3);
  assert.equal(h.nodes["explorer-empty"].hidden, true);
  assert.equal(items.length, 6, "rendering does not mutate original History data");
});

test("minimum threshold applies after keyword filter and closes an excluded host detail", async () => {
  const now = Date.now() - 100000;
  const h = harness([
    record("https://path.example.invalid/books/a", 10, now),
    record("https://path.example.invalid/books/b", 4, now + 1),
    record("https://path.example.invalid/games/c", 1, now + 2),
    record("https://other.example.invalid/one", 5, now + 3)
  ]);
  await h.scan();
  h.clickHost();
  assert.equal(h.nodes["explorer-detail"].hidden, false);
  h.filter("games");
  assert.equal(h.nodes["explorer-host-body"].children.length, 0);
  assert.equal(h.nodes["explorer-detail"].hidden, true, "hidden host detail must close");
  h.filter("books");
  assert.equal(h.hostAt(), "path.example.invalid");
  h.minimum("3");
  assert.equal(h.nodes["explorer-host-body"].children.length, 0);
  h.minimum("2");
  assert.equal(h.nodes["explorer-host-body"].children.length, 1);
});
