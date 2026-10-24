/* global browser */
"use strict";

// Read-only explorer. Uses the native HistoryItem visitCount/lastVisitTime.
// Adaptive time windows avoid history.search()'s default 100-result cap and
// avoid truncating records that share a hostname or search term.
const EXPLORER_PAGE_SIZE = 1500;
const EXPLORER_URL_PAGE = 100;
const EXPLORER_MAX_QUERIES = 12000;
const explorerElements = Object.fromEntries([
  "explorer-scan", "explorer-cancel", "explorer-progress", "explorer-filter",
  "explorer-min-urls", "explorer-sort", "explorer-hosts", "explorer-summary", "explorer-empty", "explorer-host-body",
  "explorer-detail", "explorer-back", "explorer-detail-title", "explorer-url-sort",
  "explorer-url-body", "explorer-more"
].map((id) => [id, document.getElementById(id)]));
const explorerT = (key) => browser.i18n.getMessage(key) || key;
let explorerRecords = [];
let explorerSelectedHost = null;
let explorerDetailLimit = EXPLORER_URL_PAGE;
let explorerRun = null;
let explorerReady = false;
const explorerLocale = /^(zh-HK|zh-TW)$/i.test(browser.i18n.getUILanguage()) ? "zh-Hant" : "en";
const explorerNumbers = new Intl.NumberFormat(explorerLocale);
const explorerDates = new Intl.DateTimeFormat(explorerLocale, { dateStyle: "medium", timeStyle: "short" });

function explorerHostOf(url) {
  try {
    const parsed = new URL(url);
    if (!(["https:", "http:"].includes(parsed.protocol))) return null;
    return parsed.hostname.toLowerCase();
  } catch (_) { return null; }
}

function explorerSetStatus(message, isError = false) {
  explorerElements["explorer-progress"].textContent = message;
  explorerElements["explorer-progress"].classList.toggle("error", isError);
}

async function readCompleteHistory(run) {
  const results = new Map();
  const ranges = [[0, Date.now() + 86400000]];
  let queries = 0;
  while (ranges.length) {
    if (run.cancelled) return null;
    const [startTime, endTime] = ranges.pop();
    if (++queries > EXPLORER_MAX_QUERIES) throw new Error(explorerT("explorerTooLarge"));
    const batch = await browser.history.search({ text: "", startTime, endTime,
      maxResults: EXPLORER_PAGE_SIZE });
    if (run.cancelled) return null;
    if (batch.length >= EXPLORER_PAGE_SIZE) {
      // Split inclusive windows. Duplicates at boundaries are deduplicated by URL.
      // Do not show incomplete statistics if an individual millisecond overflows.
      if (endTime - startTime <= 1) throw new Error(explorerT("explorerTooLarge"));
      const middle = Math.floor((startTime + endTime) / 2);
      ranges.push([startTime, middle], [middle, endTime]);
    } else {
      for (const item of batch) {
        const host = item.url && explorerHostOf(item.url);
        if (!host) continue;
        const record = {
          url: item.url, host,
          visits: Number.isFinite(item.visitCount) ? Math.max(0, item.visitCount) : 0,
          last: Number.isFinite(item.lastVisitTime) ? item.lastVisitTime : 0
        };
        const previous = results.get(item.url);
        if (!previous || record.last > previous.last) results.set(item.url, record);
      }
    }
    if (queries % 12 === 0) {
      explorerSetStatus(`${explorerT("explorerProgress")} ${explorerNumbers.format(results.size)} / ${queries}`);
      // Allow drawing between batches and let Cancel respond in a busy profile.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return [...results.values()];
}

function explorerMatchedRecords() {
  const term = explorerElements["explorer-filter"].value.trim().toLowerCase();
  if (!term) return explorerRecords;
  return explorerRecords.filter((item) => item.url.toLowerCase().includes(term) || item.host.includes(term));
}

function explorerHostStats(records) {
  const map = new Map();
  for (const record of records) {
    const host = map.get(record.host) || { host: record.host, urls: 0, visits: 0 };
    host.urls++;
    host.visits += record.visits;
    map.set(record.host, host);
  }
  const stats = [...map.values()];
  const byVisits = explorerElements["explorer-sort"].value === "visits";
  stats.sort((a, b) => (byVisits ? b.visits - a.visits || b.urls - a.urls :
    b.urls - a.urls || b.visits - a.visits) || a.host.localeCompare(b.host));
  return stats;
}

function explorerMinimumUrls() {
  // Empty means no minimum. The input only accepts non-negative whole numbers,
  // but clamp pasted or programmatically assigned values defensively.
  const input = explorerElements["explorer-min-urls"].value;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? Math.max(0, Math.ceil(parsed)) : Number.MAX_SAFE_INTEGER;
}

function explorerCell(text, tag = "td") {
  const el = document.createElement(tag);
  el.textContent = String(text);
  return el;
}

function renderExplorerHosts() {
  const table = explorerElements["explorer-host-body"];
  table.replaceChildren();
  if (!explorerReady) return;
  const matches = explorerMatchedRecords();
  const allHosts = explorerHostStats(matches);
  // Apply the text filter first, then exclude hosts with too few distinct URLs.
  // The threshold is display-only: the snapshot and native History are unchanged.
  const hosts = allHosts.filter((host) => host.urls >= explorerMinimumUrls());
  const urls = hosts.reduce((total, host) => total + host.urls, 0);
  const visits = hosts.reduce((total, host) => total + host.visits, 0);
  explorerElements["explorer-summary"].textContent =
    `${explorerT("explorerSummaryHosts")} ${explorerNumbers.format(hosts.length)} / ${explorerNumbers.format(allHosts.length)} · ` +
    `${explorerT("explorerSummaryUrls")} ${explorerNumbers.format(urls)} · ` +
    `${explorerT("explorerSummaryVisits")} ${explorerNumbers.format(visits)}`;
  explorerElements["explorer-empty"].hidden = hosts.length > 0;
  for (const host of hosts) {
    const tr = document.createElement("tr");
    const nameCell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-host-button";
    button.textContent = host.host;
    button.addEventListener("click", () => openExplorerHost(host.host));
    nameCell.append(button);
    tr.append(nameCell, explorerCell(explorerNumbers.format(host.urls)),
      explorerCell(explorerNumbers.format(host.visits)));
    table.append(tr);
  }
  if (explorerSelectedHost && !hosts.some((host) => host.host === explorerSelectedHost)) {
    explorerSelectedHost = null;
    explorerElements["explorer-detail"].hidden = true;
    explorerElements["explorer-hosts"].hidden = false;
  }
  if (explorerSelectedHost) renderExplorerUrls();
}

function renderExplorerUrls() {
  if (!explorerSelectedHost) return;
  const data = explorerMatchedRecords().filter((record) => record.host === explorerSelectedHost);
  const byLast = explorerElements["explorer-url-sort"].value === "last";
  data.sort((a, b) => (byLast ? b.last - a.last || b.visits - a.visits :
    b.visits - a.visits || b.last - a.last) || a.url.localeCompare(b.url));
  explorerElements["explorer-detail-title"].textContent =
    `${explorerSelectedHost} — ${explorerNumbers.format(data.length)} ${explorerT("explorerColUrls")}`;
  const body = explorerElements["explorer-url-body"];
  body.replaceChildren();
  for (const item of data.slice(0, explorerDetailLimit)) {
    const tr = document.createElement("tr");
    const urlCell = document.createElement("td");
    const anchor = document.createElement("a");
    anchor.href = item.url; // item.url was checked to be http(s).
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = item.url;
    urlCell.append(anchor);
    tr.append(urlCell, explorerCell(explorerNumbers.format(item.visits)),
      explorerCell(item.last ? explorerDates.format(new Date(item.last)) : "—"));
    body.append(tr);
  }
  explorerElements["explorer-more"].hidden = explorerDetailLimit >= data.length;
}

function openExplorerHost(host) {
  explorerSelectedHost = host;
  explorerDetailLimit = EXPLORER_URL_PAGE;
  explorerElements["explorer-url-sort"].value = "visits";
  explorerElements["explorer-hosts"].hidden = true;
  explorerElements["explorer-detail"].hidden = false;
  renderExplorerUrls();
}

async function scanExplorerHistory() {
  if (explorerRun) return;
  const run = { cancelled: false };
  explorerRun = run;
  explorerElements["explorer-scan"].disabled = true;
  explorerElements["explorer-cancel"].hidden = false;
  explorerSetStatus(explorerT("explorerScanning"));
  try {
    const records = await readCompleteHistory(run);
    if (run.cancelled || !records) {
      explorerSetStatus(explorerT("explorerCancelled"));
      return;
    }
    explorerRecords = records;
    explorerReady = true;
    explorerSelectedHost = null;
    explorerElements["explorer-detail"].hidden = true;
    explorerElements["explorer-hosts"].hidden = false;
    explorerSetStatus(explorerT("explorerDone"));
    renderExplorerHosts();
  } catch (error) {
    explorerSetStatus(`${explorerT("explorerError")} ${error.message || String(error)}`, true);
    // Keep a previous complete snapshot instead of displaying incomplete data.
  } finally {
    explorerRun = null;
    explorerElements["explorer-scan"].disabled = false;
    explorerElements["explorer-cancel"].hidden = true;
  }
}

explorerElements["explorer-scan"].addEventListener("click", () => { void scanExplorerHistory(); });
explorerElements["explorer-cancel"].addEventListener("click", () => { if (explorerRun) explorerRun.cancelled = true; });
explorerElements["explorer-filter"].addEventListener("input", () => { renderExplorerHosts(); });
explorerElements["explorer-min-urls"].addEventListener("input", () => { renderExplorerHosts(); });
explorerElements["explorer-sort"].addEventListener("change", () => { renderExplorerHosts(); });
explorerElements["explorer-url-sort"].addEventListener("change", () => { explorerDetailLimit = EXPLORER_URL_PAGE; renderExplorerUrls(); });
explorerElements["explorer-more"].addEventListener("click", () => { explorerDetailLimit += EXPLORER_URL_PAGE; renderExplorerUrls(); });
explorerElements["explorer-back"].addEventListener("click", () => {
  explorerSelectedHost = null;
  explorerElements["explorer-detail"].hidden = true;
  explorerElements["explorer-hosts"].hidden = false;
});
explorerElements["explorer-filter"].placeholder = explorerT("explorerFilterPlaceholder");
explorerSetStatus(explorerT("explorerReady"));
