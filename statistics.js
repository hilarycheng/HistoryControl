/* global browser */
"use strict";

// Only aggregate dates/counts arrive from the background; no History URLs.
const statsPanel = document.getElementById("section-statistics");
const statsButton = document.getElementById("stats-refresh");
const statsStatus = document.getElementById("stats-status");
const statsTable = document.getElementById("stats-daily-body");
const statsNav = document.querySelector('[data-section-target="statistics"]');
const statsNumberFormat = new Intl.NumberFormat(/^(zh-HK|zh-TW)$/i.test(browser.i18n.getUILanguage())
  ? "zh-HK" : "en-US");
let statsLoadingPromise = null;

function statsDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Use calendar-day subtraction rather than subtracting 24 hours across DST.
function recentStatsDates(today, count) {
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dates = [];
  for (let i = 0; i < count; i++) {
    dates.push(statsDayKey(day));
    day.setDate(day.getDate() - 1);
  }
  return dates;
}

function renderDailyStatistics(data, today = new Date()) {
  const dayKeys = recentStatsDates(today, 30);
  const get = (day, type) => {
    const n = data?.[day]?.[type];
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  };
  const sum = (days, type) => days.reduce((total, date) => total + get(date, type), 0);
  const format = (n) => statsNumberFormat.format(n);
  document.getElementById("stats-today-auto").textContent = format(get(dayKeys[0], "auto"));
  document.getElementById("stats-seven-auto").textContent = format(sum(dayKeys.slice(0, 7), "auto"));
  document.getElementById("stats-thirty-auto").textContent = format(sum(dayKeys, "auto"));
  document.getElementById("stats-thirty-manual").textContent = format(sum(dayKeys, "manual"));

  const rows = document.createDocumentFragment();
  for (const day of dayKeys) {
    const tr = document.createElement("tr");
    for (const value of [day, format(get(day, "auto")), format(get(day, "manual"))]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    rows.append(tr);
  }
  statsTable.replaceChildren(rows);
}

async function loadDailyStatistics() {
  if (statsLoadingPromise) return statsLoadingPromise;
  statsButton.disabled = true;
  statsStatus.textContent = browser.i18n.getMessage("statsLoading");
  statsLoadingPromise = (async () => {
    try {
      const data = await browser.runtime.sendMessage({ type: "getDailyStatistics" });
      renderDailyStatistics(data);
      statsStatus.textContent = "";
    } catch (error) {
      statsStatus.textContent = `${browser.i18n.getMessage("statsError")} ${error.message || String(error)}`;
    } finally {
      statsButton.disabled = false;
      statsLoadingPromise = null;
    }
  })();
  return statsLoadingPromise;
}

statsButton.addEventListener("click", () => { void loadDailyStatistics(); });
statsNav.addEventListener("click", () => { void loadDailyStatistics(); });
// Statistics update while Options is open if auto-clean or Clean Now writes.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.dailyDeletionStatsV1 && !statsPanel.hidden) {
    void loadDailyStatistics();
  }
});
void loadDailyStatistics();
