"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(root, "navigation.js"), "utf8");
const page = fs.readFileSync(path.join(root, "options.html"), "utf8");
const sections = ["overview", "protected", "host-entry", "no-history", "explorer", "statistics", "backup", "cleanup"];

function fakeElement(dataset = {}) {
  const attributes = new Map();
  const names = new Set();
  return {
    dataset, hidden: false, focused: false, listeners: {},
    classList: {
      toggle(name, force) { if (force) names.add(name); else names.delete(name); },
      contains(name) { return names.has(name); }
    },
    addEventListener(event, callback) { this.listeners[event] = callback; },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    focus() { this.focused = true; },
    click() { this.listeners.click?.(); }
  };
}

function navHarness(isMobile = false) {
  const buttons = sections.map((sectionTarget) => fakeElement({ sectionTarget }));
  const panels = sections.map((historySection) => fakeElement({ historySection }));
  const navigation = fakeElement();
  const toggle = fakeElement();
  toggle.setAttribute("aria-expanded", "false");
  const document = {
    querySelectorAll(selector) {
      if (selector === "[data-section-target]") return buttons;
      if (selector === "[data-history-section]") return panels;
      throw new Error(selector);
    },
    getElementById(id) { return { "nav-items": navigation, "nav-toggle": toggle }[id]; }
  };
  const window = { matchMedia() { return { matches: isMobile }; } };
  vm.runInNewContext(code, { document, window }, { filename: "navigation.js" });
  return { buttons, panels, navigation, toggle };
}

test("left navigation has eight sections and labels in every locale", () => {
  for (const section of sections) {
    assert.match(page, new RegExp(`data-section-target="${section}"`));
    assert.match(page, new RegExp(`id="section-${section}"`));
    assert.match(page, new RegExp(`data-history-section="${section}"`));
  }
  assert.match(page, /<script src="navigation\.js" defer><\/script>/);
  for (const loc of ["en", "zh_HK", "zh_TW"]) {
    const messages = require(`../_locales/${loc}/messages.json`);
    for (const key of ["navTitle", "navToggle", "navOverview", "navProtected", "navHostEntry",
      "navNoHistory", "navExplorer", "navStatistics", "navBackup", "navCleanup"]) assert.ok(messages[key]?.message);
  }
});

test("selecting a section hides all other panels without reloading or mutating settings", () => {
  const nav = navHarness();
  assert.equal(nav.panels[0].hidden, false);
  assert.equal(nav.buttons[0].getAttribute("aria-current"), "page");
  for (let i = 1; i < sections.length; i++) {
    nav.buttons[i].click();
    assert.deepEqual(nav.panels.map((p) => p.hidden), sections.map((_, j) => i !== j));
    assert.equal(nav.buttons[i].classList.contains("active"), true);
    assert.equal(nav.buttons[i].getAttribute("aria-current"), "page");
    assert.equal(nav.buttons[0].getAttribute("aria-current"), null);
  }
});

test("small viewport provides collapsible menu and selection returns focus to toggle", () => {
  const nav = navHarness(true);
  assert.equal(nav.toggle.getAttribute("aria-expanded"), "false");
  assert.equal(nav.toggle.focused, false, "initial load does not move keyboard focus");
  nav.toggle.click();
  assert.equal(nav.toggle.getAttribute("aria-expanded"), "true");
  assert.equal(nav.navigation.classList.contains("is-open"), true);
  nav.buttons[4].click();
  assert.equal(nav.panels[4].hidden, false);
  assert.equal(nav.toggle.getAttribute("aria-expanded"), "false");
  assert.equal(nav.navigation.classList.contains("is-open"), false);
  assert.equal(nav.toggle.focused, true);
});
