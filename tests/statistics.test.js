"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(root, "statistics.js"), "utf8");
const html = fs.readFileSync(path.join(root, "options.html"), "utf8");

function element() {
  const handlers = {};
  return {
    textContent: "", children: [], hidden: false, disabled: false, handlers,
    addEventListener(name, cb) { handlers[name] = cb; },
    append(...nodes) {
      for (const node of nodes) {
        if (node.fragment) this.children.push(...node.children);
        else this.children.push(node);
      }
    },
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
  };
}

async function harness(history = {}, locale = "en-US") {
  const ids = ["section-statistics", "stats-refresh", "stats-status", "stats-daily-body",
    "stats-today-auto", "stats-seven-auto", "stats-thirty-auto", "stats-thirty-manual"];
  const nodes = new Map(ids.map((id) => [id, element()]));
  const nav = element();
  const messages = require(`../_locales/${/^(zh-HK|zh-TW)$/.test(locale) ? "zh_HK" : "en"}/messages.json`);
  let statistics = history;
  let reads = 0;
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!nodes.has(id)) throw new Error(`Missing ID: ${id}`);
        return nodes.get(id);
      },
      querySelector(sel) {
        assert.equal(sel, '[data-section-target="statistics"]');
        return nav;
      },
      createElement: () => element(),
      createDocumentFragment: () => ({ fragment: true, children: [], append(...els) { this.children.push(...els); } })
    },
    browser: {
      i18n: {
        getUILanguage() { return locale; },
        getMessage(key) { return messages[key]?.message || key; }
      },
      runtime: {
        async sendMessage(request) {
          assert.equal(request.type, "getDailyStatistics");
          reads++;
          return statistics;
        }
      },
      storage: { onChanged: { addListener() {} } }
    },
    Intl, Date, Number, String, console
  });
  vm.runInContext(code, context, { filename: "statistics.js" });
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  return {
    nodes, nav, context,
    setStatistics(data) { statistics = data; },
    renderFor(date, data) {
      context.statsForTest = data;
      context.dateForTest = date;
      vm.runInContext("renderDailyStatistics(statsForTest, dateForTest)", context);
    },
    get reads() { return reads; }
  };
}

test("v1.0.9 Statistics sidebar and all messages exist in both languages", () => {
  assert.match(html, /data-section-target="statistics"/);
  assert.match(html, /data-history-section="statistics"/);
  assert.match(html, /<script src="statistics\.js" defer><\/script>/);
  assert.match(html, /id="stats-daily-body"/);
  for (const locale of ["en", "zh_HK", "zh_TW"]) {
    const messages = require(`../_locales/${locale}/messages.json`);
    for (const key of ["navStatistics", "statsTitle", "statsDescription", "statsRefresh",
      "statsTodayAuto", "statsSevenAuto", "statsThirtyAuto", "statsThirtyManual",
      "statsDailyHeading", "statsDateCol", "statsAutoCol", "statsManualCol",
      "statsNotes", "statsLoading", "statsError"]) {
      assert.ok(messages[key]?.message, `${locale} missing ${key}`);
    }
  }
});

test("v1.0.9 daily summary counts auto and Clean Now independently", async () => {
  const ui = await harness();
  ui.renderFor(new Date(2026, 9, 20), {
    "2026-10-20": { auto: 5, manual: 1 },
    "2026-10-19": { auto: 8, manual: 3 },
    "2026-10-15": { auto: 9, manual: 0 },
    "2026-09-22": { auto: 12, manual: 7 },
    "2026-09-19": { auto: 50, manual: 90 }
  });
  assert.equal(ui.nodes.get("stats-today-auto").textContent, "5");
  assert.equal(ui.nodes.get("stats-seven-auto").textContent, "22");
  assert.equal(ui.nodes.get("stats-thirty-auto").textContent, "34");
  assert.equal(ui.nodes.get("stats-thirty-manual").textContent, "11");
  const rows = ui.nodes.get("stats-daily-body").children;
  assert.equal(rows.length, 30);
  assert.deepEqual(rows[0].children.map((el) => el.textContent), ["2026-10-20", "5", "1"]);
  assert.deepEqual(rows[1].children.map((el) => el.textContent), ["2026-10-19", "8", "3"]);
  assert.equal(rows[29].children[0].textContent, "2026-09-21");
});

test("v1.0.9 date ranges cross month and daylight saving time using calendar days", async () => {
  const ui = await harness();
  ui.renderFor(new Date(2026, 2, 9), {
    "2026-03-09": { auto: 1, manual: 0 },
    "2026-03-08": { auto: 2, manual: 1 },
    "2026-03-07": { auto: 3, manual: 0 },
    "2026-03-03": { auto: 4, manual: 0 },
    "2026-02-28": { auto: 5, manual: 2 }
  });
  assert.equal(ui.nodes.get("stats-seven-auto").textContent, "10");
  assert.equal(ui.nodes.get("stats-thirty-auto").textContent, "15");
  assert.equal(ui.nodes.get("stats-thirty-manual").textContent, "3");
  assert.equal(ui.nodes.get("stats-daily-body").children[9].children[0].textContent, "2026-02-28");
});

test("v1.0.9 clicking Statistics and Refresh fetches updated data", async () => {
  const ui = await harness();
  const initialReads = ui.reads;
  ui.setStatistics({});
  await ui.nav.handlers.click();
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.reads, initialReads + 1);
  await ui.nodes.get("stats-refresh").handlers.click();
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.reads, initialReads + 2);
});
