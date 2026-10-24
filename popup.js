/* global browser */
"use strict";

const resultEl = document.getElementById("result");
const statusEl = document.getElementById("status");
const siteHostEl = document.getElementById("site-host");
const siteUrlEl = document.getElementById("site-url");
const iconEl = document.getElementById("site-icon");
const ruleNoteEl = document.getElementById("rule-note");

function t(key) { return browser.i18n.getMessage(key) || key; }
function applyLocale() {
  const locale = browser.i18n.getUILanguage();
  document.documentElement.lang = /^(zh-HK|zh-TW)$/i.test(locale) ? "zh-Hant" : "en";
  document.title = t("popupPageTitle");
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.getAttribute("data-i18n"));
  }
}

function showState(state, status, host = "", url = "", note = "") {
  resultEl.className = `result ${state}`;
  statusEl.textContent = status;
  siteHostEl.textContent = host;
  siteUrlEl.textContent = url;
  ruleNoteEl.textContent = note;
  ruleNoteEl.hidden = !note;
  iconEl.src = state === "saved" ? "icons/saved.svg" :
    state === "excluded" ? "icons/excluded.svg" : "icons/unsaved.svg";
}

async function rememberCurrentSite() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number") {
      showState("error", t("popupNoTab"));
      return;
    }
    const saved = await browser.runtime.sendMessage({ type: "save", tabId: tab.id });
    if (saved?.excluded) {
      const scope = saved.includeSubdomains ? t("includeSubdomains") : t("onlyHostname");
      showState("excluded", t("popupExcluded"), saved.host, saved.hostname,
        `${t("popupRuleLabel")} ${t("excludeTitle")} · ${scope}`);
      return;
    }
    if (saved?.hostEntry) {
      const note = `${t("popupRuleLabel")} ${t("hostEntryTitle")} · ${saved.includeSubdomains ? t("includeSubdomains") : t("onlyHostname")}`;
      showState(saved.keepHistory ? "saved" : "excluded",
        t(saved.keepHistory ? "popupHostEntrySaved" : "popupHostEntryClean"),
        saved.host, saved.entryUrl, note);
      return;
    }
    if (!saved || !saved.saved) {
      showState("error", t("popupUnsupported"));
      return;
    }
    const note = saved.matchMode === "prefix"
      ? `${t("popupRuleLabel")} ${t("modePrefix")} · ${t(saved.historyMode === "all" ? "historyAll" : "historyEntry")}`
      : `${t("popupRuleLabel")} ${t("modeExact")}`;
    let status = t("popupSaved");
    if (saved.alreadySaved) {
      status = saved.matchMode === "prefix"
        ? t(saved.historyMode === "all" ? "popupMatchedAll" : "popupMatchedEntryOnly")
        : saved.keepHistory === false ? t("popupMatchedEntryOnly") : t("popupAlreadyProtected");
    }
    showState("saved", status, saved.host, saved.entryUrl, note);
  } catch (error) {
    showState("error", `${t("popupError")} ${error.message || String(error)}`);
  }
}

document.getElementById("manage").addEventListener("click", () => {
  void browser.runtime.openOptionsPage().catch((error) => {
    showState("error", `${t("popupOptionsError")} ${error.message || String(error)}`);
  });
});

applyLocale();
void rememberCurrentSite();
