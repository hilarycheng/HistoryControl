/* global browser */
"use strict";

// Firefox records visits before onVisited. This extension removes unwanted
// entries after they are recorded; it cannot prevent Firefox History writes.
// Only explicitly configured protected URLs, Host Entry and No History hosts are cleaned.
const STORE_KEY = "protectedSites"; // Unchanged since v1.0.2 for migrations.
const EXCLUSION_KEY = "excludedHosts"; // New, independent v1.0.5.1 storage key.
const HOST_ENTRY_KEY = "hostEntryRules";
const DAILY_STATS_KEY = "dailyDeletionStatsV1"; // Aggregate counts only; no URLs or hosts.
const FULL_BACKUP_FORMAT = "history-control-full-backup";
const FULL_BACKUP_VERSION = 1;
const FULL_BACKUP_MAX_BYTES = 4 * 1024 * 1024;

const MENU_ID = "minimal-history-manage"; // Keep old menu identifier for upgrade.
const CLEAN_BATCH_SIZE = 500;
const DELETE_CONCURRENCY = 10;
const MAX_CLEAN_PASSES = 100000;

let cachedSites = null;
let loadPromise = null;
let cachedExclusions = null;
let exclusionsLoadPromise = null;
let cachedHostEntries = null;
let hostEntriesLoadPromise = null;
let mutationQueue = Promise.resolve();
let cleanPromise = null;
let menuPromise = null;

function t(key, substitutions) {
  return browser.i18n.getMessage(key, substitutions) || key;
}

function siteForUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname ||
        url.username || url.password) return null;
    // www.example.com and example.com share a protected host. Other
    // subdomains (help.example.com) remain separate. Ports remain distinct.
    const bareHost = url.hostname.replace(/^www\./i, "");
    const host = `${bareHost}${url.port ? `:${url.port}` : ""}`;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return { host, path, origin: url.origin, originalPath: url.pathname };
  } catch (_) {
    return null;
  }
}

// Hostname-only exclusion: matches the apex alone, or the apex and any level
// of subdomains. Never use substring matching (lookalike hostnames are unrelated).
function historyHostname(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().replace(/\.+$/, "") || null;
  } catch (_) {
    return null;
  }
}

function normalizeExcludedHostname(raw) {
  if (typeof raw !== "string") return null;
  const input = raw.trim();
  if (!input) return null;
  try {
    // Allow either a bare hostname or a root URL. Never silently accept
    // path, query, port, credentials, or wildcard syntax as a hostname rule.
    const value = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password ||
        url.port || url.pathname !== "/" || url.search || url.hash) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    const labels = hostname.split(".");
    // Refuse overly broad single-label rules such as "com".
    if (labels.length < 2 || labels.some((label) =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    return hostname;
  } catch (_) {
    return null;
  }
}

function hostnameMatches(hostname, ruleHostname, includeSubdomains) {
  return hostname === ruleHostname ||
    (includeSubdomains && hostname.endsWith(`.${ruleHostname}`));
}

function exclusionForUrl(rawUrl, exclusions) {
  const hostname = historyHostname(rawUrl);
  if (!hostname) return null;
  let matched = null;
  for (const rule of Object.values(exclusions)) {
    if (hostnameMatches(hostname, rule.hostname, rule.includeSubdomains) &&
        (!matched || rule.hostname.length > matched.hostname.length)) matched = rule;
  }
  return matched;
}

function validateExcludedHosts(value) {
  const result = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, record] of Object.entries(value)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const hostname = normalizeExcludedHostname(record.hostname);
    if (!hostname || key !== hostname || typeof record.includeSubdomains !== "boolean") continue;
    result[hostname] = {
      hostname,
      includeSubdomains: record.includeSubdomains,
      savedAt: Number.isFinite(record.savedAt) ? record.savedAt : 0
    };
  }
  return result;
}

// A Host Entry rule keeps ONE literal, canonical URL and removes other visits
// on the hostname (+ optionally all subdomains), including protected paths.
function validateHostEntries(value) {
  const result = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, record] of Object.entries(value)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const hostname = normalizeExcludedHostname(record.hostname);
    const entryUrl = typeof record.entryUrl === "string" && normalizeEntryUrl(record.entryUrl, "exact");
    if (!hostname || key !== hostname || typeof record.includeSubdomains !== "boolean" ||
        !entryUrl || !hostnameMatches(historyHostname(entryUrl), hostname, record.includeSubdomains)) continue;
    result[hostname] = {
      hostname, entryUrl, includeSubdomains: record.includeSubdomains,
      savedAt: Number.isFinite(record.savedAt) ? record.savedAt : 0
    };
  }
  return result;
}

function hostEntryForUrl(rawUrl, hostEntries) {
  const hostname = historyHostname(rawUrl);
  if (!hostname) return null;
  let matched = null;
  for (const rule of Object.values(hostEntries)) {
    if (hostnameMatches(hostname, rule.hostname, rule.includeSubdomains) &&
        (!matched || rule.hostname.length > matched.hostname.length)) matched = rule;
  }
  return matched;
}

function hostEntryConflicts(hostname, entryUrl, includeSubdomains, sites, exclusions) {
  return {
    protected: conflictingProtectedUrls(hostname, includeSubdomains, sites)
      .filter((url) => url !== entryUrl),
    noHistory: Object.values(exclusions).filter((rule) =>
      hostnameMatches(historyHostname(entryUrl), rule.hostname, rule.includeSubdomains))
      .map((rule) => rule.hostname)
  };
}

function conflictingProtectedUrls(hostname, includeSubdomains, sites) {
  return Object.values(sites).flatMap((site) => site.entries
    .filter((entry) => hostnameMatches(historyHostname(entry.entryUrl) || "", hostname, includeSubdomains))
    .map((entry) => entry.entryUrl));
}

function normalizeEntryUrl(rawUrl, matchMode) {
  const parsed = siteForUrl(rawUrl);
  if (!parsed) return null;
  // Preserve a manually supplied trailing slash for prefix entry points
  // (e.g. /g/). Exact entries keep v1.0.3's canonical slash-stripping.
  const suffix = matchMode === "prefix" && parsed.path !== "/" &&
    parsed.originalPath.endsWith("/") ? "/" : "";
  return `${parsed.origin}${parsed.path === "/" ? "/" : parsed.path + suffix}`;
}

function validateStoredSites(value) {
  const result = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;

  for (const [, record] of Object.entries(value)) {
    if (!record || typeof record !== "object") continue;
    // Accept v1.0.2 {entryUrl}, v1.0.3 {entries:[{entryUrl}]}, and v1.0.4.
    const source = Array.isArray(record.entries)
      ? record.entries
      : typeof record.entryUrl === "string" ? [record] : [];
    for (const item of source) {
      if (!item || typeof item.entryUrl !== "string") continue;
      const matchMode = item.matchMode === "prefix" ? "prefix" : "exact";
      const historyMode = matchMode === "prefix" && item.historyMode === "all"
        ? "all" : "entry";
      const entryUrl = normalizeEntryUrl(item.entryUrl, matchMode);
      const parsed = entryUrl && siteForUrl(entryUrl);
      if (!parsed) continue;
      // Only trust a record whose declared hostname is consistent with URL.
      if (typeof record.host === "string" && record.host !== parsed.host) continue;
      if (!Object.hasOwn(result, parsed.host)) {
        result[parsed.host] = { host: parsed.host, entries: [] };
      }
      const entries = result[parsed.host].entries;
      // Deduplicate by normalized path, regardless of scheme/www/slash/mode.
      if (entries.some((saved) => siteForUrl(saved.entryUrl).path === parsed.path)) continue;
      entries.push({
        entryUrl,
        matchMode,
        historyMode,
        savedAt: Number.isFinite(item.savedAt) ? item.savedAt : 0
      });
    }
  }
  return result;
}

function matchingRule(site, parsedPage) {
  if (!site || !parsedPage) return null;
  let best = null;
  let bestLength = -1;
  for (const entry of site.entries) {
    const parsedEntry = siteForUrl(entry.entryUrl);
    if (!parsedEntry) continue;
    const exact = parsedPage.path === parsedEntry.path;
    const matches = exact || (entry.matchMode === "prefix" &&
      (parsedEntry.path === "/" || parsedPage.path.startsWith(`${parsedEntry.path}/`)));
    if (!matches) continue;
    // Most specific path wins. For same path, exact wins over prefix.
    const rank = parsedEntry.path.length * 2 + (entry.matchMode === "exact" ? 1 : 0);
    if (rank > bestLength) { best = entry; bestLength = rank; }
  }
  return best;
}

function pageMatch(rawUrl, sites) {
  const parsed = siteForUrl(rawUrl);
  if (!parsed || !Object.hasOwn(sites, parsed.host)) return null;
  const site = sites[parsed.host];
  const rule = matchingRule(site, parsed);
  if (!rule) return null;
  return {
    host: parsed.host,
    entryUrl: rule.entryUrl,
    matchMode: rule.matchMode,
    historyMode: rule.historyMode,
    keepHistory: site.entries.some((entry) => entry.entryUrl === rawUrl) ||
      (rule.matchMode === "prefix" && rule.historyMode === "all")
  };
}

function shouldDeleteUrl(rawUrl, sites, exclusions, hostEntries = {}) {
  if (exclusionForUrl(rawUrl, exclusions)) return true; // No History ALWAYS wins.
  const hostRule = hostEntryForUrl(rawUrl, hostEntries);
  if (hostRule) return rawUrl !== hostRule.entryUrl; // Entry URL only; all other URL records deleted.
  const parsed = siteForUrl(rawUrl);
  if (!parsed || !Object.hasOwn(sites, parsed.host)) return false;
  const match = pageMatch(rawUrl, sites);
  // Only clean protected hosts. Keep every saved entry's canonical URL;
  // otherwise keep prefix/all subpages and delete all other records.
  return !(match && match.keepHistory);
}

async function getSites() {
  if (cachedSites) return cachedSites;
  if (!loadPromise) {
    loadPromise = browser.storage.local.get(STORE_KEY).then((data) => {
      cachedSites = validateStoredSites(data[STORE_KEY]);
      return cachedSites;
    }).finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

async function getExclusions() {
  if (cachedExclusions) return cachedExclusions;
  if (!exclusionsLoadPromise) {
    exclusionsLoadPromise = browser.storage.local.get(EXCLUSION_KEY).then((data) => {
      cachedExclusions = validateExcludedHosts(data[EXCLUSION_KEY]);
      return cachedExclusions;
    }).finally(() => { exclusionsLoadPromise = null; });
  }
  return exclusionsLoadPromise;
}

async function getHostEntries() {
  if (cachedHostEntries) return cachedHostEntries;
  if (!hostEntriesLoadPromise) {
    hostEntriesLoadPromise = browser.storage.local.get(HOST_ENTRY_KEY).then((data) => {
      cachedHostEntries = validateHostEntries(data[HOST_ENTRY_KEY]);
      return cachedHostEntries;
    }).finally(() => { hostEntriesLoadPromise = null; });
  }
  return hostEntriesLoadPromise;
}

function serializeMutation(job) {
  const result = mutationQueue.then(job);
  mutationQueue = result.catch(() => {});
  return result;
}

// Dates are local calendar days at deletion time. Keep aggregates in a
// separate storage key so Import (including Replace) cannot wipe statistics.
function localStatsDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function validStatsDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [year, month, date] = day.split("-").map(Number);
  const check = new Date(year, month - 1, date);
  return check.getFullYear() === year && check.getMonth() + 1 === month && check.getDate() === date;
}

function validatedDailyStats(raw) {
  const result = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const [day, counts] of Object.entries(raw)) {
    if (!validStatsDay(day) || !counts || typeof counts !== "object" || Array.isArray(counts)) continue;
    const auto = counts.auto;
    const manual = counts.manual;
    if (!Number.isSafeInteger(auto) || auto < 0 || !Number.isSafeInteger(manual) || manual < 0) continue;
    result[day] = { auto, manual };
  }
  return result;
}

// Called only within the serialized background mutation queue, so concurrent
// visit events and Clean Now cannot lose increments in a read/modify/write.
async function appendDailyDeletionCounts(incrementsByDay) {
  if (!Object.keys(incrementsByDay).length) return;
  const stored = await browser.storage.local.get(DAILY_STATS_KEY);
  const daily = validatedDailyStats(stored[DAILY_STATS_KEY]);
  for (const [day, delta] of Object.entries(incrementsByDay)) {
    if (!validStatsDay(day)) continue;
    const counts = daily[day] || { auto: 0, manual: 0 };
    daily[day] = { auto: counts.auto + (delta.auto || 0),
      manual: counts.manual + (delta.manual || 0) };
  }
  await browser.storage.local.set({ [DAILY_STATS_KEY]: daily });
}

async function commitSites(previous, next) {
  cachedSites = next;
  try {
    await browser.storage.local.set({ [STORE_KEY]: next });
  } catch (error) {
    cachedSites = previous;
    throw error;
  }
}

async function commitExclusions(previous, next) {
  cachedExclusions = next;
  try {
    await browser.storage.local.set({ [EXCLUSION_KEY]: next });
  } catch (error) {
    cachedExclusions = previous;
    throw error;
  }
}

async function commitHostEntries(previous, next) {
  cachedHostEntries = next;
  try {
    await browser.storage.local.set({ [HOST_ENTRY_KEY]: next });
  } catch (error) {
    cachedHostEntries = previous;
    throw error;
  }
}

function isCanonicalProtectedUrl(rawUrl, sites) {
  const parsed = siteForUrl(rawUrl);
  return parsed && Object.hasOwn(sites, parsed.host) &&
    sites[parsed.host].entries.some((entry) => entry.entryUrl === rawUrl);
}

async function ensureEntryExists(record) {
  const parsed = siteForUrl(record.entryUrl);
  if (!parsed || exclusionForUrl(record.entryUrl, await getExclusions())) return;
  const [sites, hostEntries] = await Promise.all([getSites(), getHostEntries()]);
  const hostRule = hostEntryForUrl(record.entryUrl, hostEntries);
  if ((hostRule && hostRule.entryUrl !== record.entryUrl) ||
      (!isCanonicalProtectedUrl(record.entryUrl, sites) &&
       !Object.values(hostEntries).some((rule) => rule.entryUrl === record.entryUrl))) {
    return; // Entry removed during an asynchronous operation.
  }
  const visits = await browser.history.getVisits({ url: record.entryUrl });
  if (visits.length === 0 && !exclusionForUrl(record.entryUrl, await getExclusions())) {
    await browser.history.addUrl({ url: record.entryUrl, transition: "typed" });
  }
}

async function ensureAllEntries() {
  const [sites, hostEntries] = await Promise.all([getSites(), getHostEntries()]);
  const allEntries = [...Object.values(sites).flatMap((site) => site.entries),
    ...Object.values(hostEntries)];
  const seen = new Set();
  for (const record of allEntries) {
    if (seen.has(record.entryUrl)) continue;
    seen.add(record.entryUrl);
      try {
        await ensureEntryExists(record);
      } catch (error) {
        console.error("History Control: cannot restore saved entry", record.entryUrl, error);
      }
  }
}

async function refreshTab(tab) {
  if (!tab || typeof tab.id !== "number") return;
  const [sites, exclusions, hostEntries] = await Promise.all([getSites(), getExclusions(), getHostEntries()]);
  const parsed = siteForUrl(tab.url);
  const excluded = exclusionForUrl(tab.url, exclusions);
  const hostRule = excluded ? null : hostEntryForUrl(tab.url, hostEntries);
  const hostEntryKeep = Boolean(hostRule && hostRule.entryUrl === tab.url);
  const hostEntryDelete = Boolean(hostRule && !hostEntryKeep);
  const match = excluded || hostRule ? null : parsed ? pageMatch(tab.url, sites) : null;
  const saved = hostEntryKeep || Boolean(match);
  const title = excluded ? `${t("toolbarExcluded")} ${excluded.hostname}`
    : hostEntryKeep ? `${t("toolbarHostEntrySaved")} ${hostRule.entryUrl}`
    : hostEntryDelete ? `${t("toolbarHostEntryClean")} ${hostRule.hostname}`
    : !parsed ? t("toolbarUnsupported")
    : !match ? t("toolbarUnsaved", [parsed.host + parsed.path])
    : match.keepHistory ? t("toolbarProtected", [match.entryUrl])
      : t("toolbarMatchedEntryOnly", [match.entryUrl]);
  try {
    await Promise.all([
      browser.action.setIcon({ tabId: tab.id, path: excluded || hostEntryDelete ? "icons/excluded.svg" : saved ? "icons/saved.svg" : "icons/unsaved.svg" }),
      browser.action.setTitle({ tabId: tab.id, title }),
      browser.action.setBadgeText({ tabId: tab.id, text: excluded || hostEntryDelete ? "×" : saved ? "✓" : "" }),
      browser.action.setBadgeBackgroundColor({ tabId: tab.id, color: excluded || hostEntryDelete ? "#a91b36" : "#138a62" }),
      browser.action.enable(tab.id)
    ]);
  } catch (error) {
    console.debug("History Control: cannot update toolbar icon", error);
  }
}

async function refreshAllTabs() {
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.map(refreshTab));
}

async function addProtectedUrl(rawUrl, requestedMode = "exact", requestedHistoryMode = "entry") {
  if (typeof rawUrl !== "string" || !["exact", "prefix"].includes(requestedMode) ||
      !["entry", "all"].includes(requestedHistoryMode)) {
    throw new Error(t("errorInvalidRule"));
  }
  const entryUrl = normalizeEntryUrl(rawUrl.trim(), requestedMode);
  const parsed = entryUrl && siteForUrl(entryUrl);
  if (!parsed) throw new Error(t("errorInvalidUrl"));
  const historyMode = requestedMode === "prefix" ? requestedHistoryMode : "entry";

  return serializeMutation(async () => {
    const sites = await getSites();
    const previous = Object.hasOwn(sites, parsed.host) ? sites[parsed.host] : null;
    const existing = previous?.entries.find((entry) =>
      siteForUrl(entry.entryUrl).path === parsed.path);
    if (existing) {
      return { saved: true, alreadySaved: true, host: parsed.host,
        entryUrl: existing.entryUrl, matchMode: existing.matchMode,
        historyMode: existing.historyMode, keepHistory: true };
    }
    const entry = { entryUrl, matchMode: requestedMode, historyMode, savedAt: Date.now() };
    const next = Object.assign(Object.create(null), sites);
    next[parsed.host] = { host: parsed.host,
      entries: [...(previous ? previous.entries : []), entry] };
    await commitSites(sites, next);
    try {
      await ensureEntryExists(entry);
    } catch (error) {
      // Restore the previous whitelist if we cannot restore the entry.
      // No unrelated history is touched.
      await commitSites(next, sites).catch((rollbackError) =>
        console.error("History Control: could not roll back save", rollbackError));
      throw error;
    }
    await refreshAllTabs();
    return { saved: true, alreadySaved: false, host: parsed.host,
      entryUrl, matchMode: requestedMode, historyMode, keepHistory: true };
  });
}

async function saveSiteFromTab(tab) {
  const parsed = siteForUrl(tab?.url);
  if (!parsed) return { saved: false, reason: "unsupported" };
  // A matching prefix rule is already protection. Never create a duplicate
  // Exact rule just because the user opened the toolbar on a matching child.
  return serializeMutation(async () => {
    const [sites, exclusions, hostEntries] = await Promise.all([getSites(), getExclusions(), getHostEntries()]);
    const excluded = exclusionForUrl(tab.url, exclusions);
    if (excluded) {
      await refreshTab(tab);
      return { saved: false, excluded: true, host: historyHostname(tab.url),
        hostname: excluded.hostname, includeSubdomains: excluded.includeSubdomains };
    }
    const hostRule = hostEntryForUrl(tab.url, hostEntries);
    if (hostRule) {
      await refreshTab(tab);
      return { saved: hostRule.entryUrl === tab.url, hostEntry: true,
        hostname: hostRule.hostname, host: historyHostname(tab.url),
        entryUrl: hostRule.entryUrl, includeSubdomains: hostRule.includeSubdomains,
        keepHistory: hostRule.entryUrl === tab.url, alreadySaved: true };
    }
    const match = pageMatch(tab.url, sites);
    if (match) {
      await refreshTab(tab);
      return { saved: true, alreadySaved: true, matched: true, ...match };
    }
    // Avoid nested serializeMutation deadlock: check and release queue, then
    // call addProtectedUrl (which performs a fresh duplicate check).
    return null;
  }).then((result) => result || addProtectedUrl(tab.url, "exact", "entry"));
}

function normalizeNewHostEntry(rawHostname, rawEntryUrl, includeSubdomains) {
  const hostname = normalizeExcludedHostname(rawHostname);
  if (!hostname || typeof includeSubdomains !== "boolean") throw new Error(t("errorInvalidHostname"));
  const sourceUrl = (typeof rawEntryUrl === "string" && rawEntryUrl.trim()) || `https://${hostname}/`;
  const entryUrl = normalizeEntryUrl(sourceUrl, "exact");
  if (!entryUrl || !hostnameMatches(historyHostname(entryUrl), hostname, includeSubdomains)) {
    throw new Error(t("errorInvalidHostEntry"));
  }
  return { hostname, entryUrl, includeSubdomains };
}

async function checkHostEntry(rawHostname, rawEntryUrl, includeSubdomains) {
  const rule = normalizeNewHostEntry(rawHostname, rawEntryUrl, includeSubdomains);
  const [sites, exclusions] = await Promise.all([getSites(), getExclusions()]);
  return { ...rule, conflicts: hostEntryConflicts(rule.hostname, rule.entryUrl,
    rule.includeSubdomains, sites, exclusions) };
}

async function addHostEntry(rawHostname, rawEntryUrl, includeSubdomains) {
  const rule = normalizeNewHostEntry(rawHostname, rawEntryUrl, includeSubdomains);
  return serializeMutation(async () => {
    const [previous, sites, exclusions] = await Promise.all([getHostEntries(), getSites(), getExclusions()]);
    if (Object.hasOwn(previous, rule.hostname)) return { ...previous[rule.hostname], alreadySaved: true };
    const next = Object.assign(Object.create(null), previous);
    next[rule.hostname] = { ...rule, savedAt: Date.now() };
    await commitHostEntries(previous, next);
    await ensureAllEntries();
    await refreshAllTabs();
    return { ...next[rule.hostname], alreadySaved: false,
      conflicts: hostEntryConflicts(rule.hostname, rule.entryUrl, rule.includeSubdomains, sites, exclusions) };
  });
}

async function updateHostEntry(rawHostname, rawEntryUrl, includeSubdomains) {
  const rule = normalizeNewHostEntry(rawHostname, rawEntryUrl, includeSubdomains);
  return serializeMutation(async () => {
    const previous = await getHostEntries();
    if (!Object.hasOwn(previous, rule.hostname)) return false;
    const next = Object.assign(Object.create(null), previous);
    next[rule.hostname] = { ...rule, savedAt: previous[rule.hostname].savedAt };
    await commitHostEntries(previous, next);
    await ensureAllEntries();
    await refreshAllTabs();
    return true;
  });
}

async function removeHostEntry(rawHostname) {
  const hostname = normalizeExcludedHostname(rawHostname);
  if (!hostname) throw new Error(t("errorInvalidHostname"));
  return serializeMutation(async () => {
    const previous = await getHostEntries();
    if (!Object.hasOwn(previous, hostname)) return false;
    const next = Object.assign(Object.create(null), previous);
    delete next[hostname];
    await commitHostEntries(previous, next);
    await ensureAllEntries();
    await refreshAllTabs();
    // Removing a rule does not restore History deleted earlier.
    return true;
  });
}

function settingsSnapshot(sites, exclusions, hostEntries) {
  return {
    format: "history-control-settings", formatVersion: 1,
    exportedAt: new Date().toISOString(),
    protectedSites: sites, excludedHosts: exclusions, hostEntryRules: hostEntries
  };
}

function strictImportedRules(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(t("importInvalid"));
  if (JSON.stringify(payload).length > 1024 * 1024) throw new Error(t("importTooLarge"));
  if (payload.format !== undefined &&
      (payload.format !== "history-control-settings" || payload.formatVersion !== 1)) {
    throw new Error(t("importUnsupported"));
  }
  // Also accept raw legacy storage backups (before v1.0.6).
  const required = ["protectedSites", "excludedHosts"];
  if (![...required, "hostEntryRules"].some((key) => Object.hasOwn(payload, key))) {
    throw new Error(t("importInvalid"));
  }
  for (const key of required) {
    if (payload[key] === undefined && payload.format !== undefined) throw new Error(t("importInvalid"));
  }
  const sourceSites = payload.protectedSites ?? {};
  const sourceExclusions = payload.excludedHosts ?? {};
  const sourceHostEntries = payload.hostEntryRules ?? {};
  for (const obj of [sourceSites, sourceExclusions, sourceHostEntries]) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(t("importInvalid"));
  }
  const inputSites = Object.values(sourceSites).reduce((count, record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(t("importInvalid"));
    if (Array.isArray(record.entries)) {
      if (!record.entries.length) throw new Error(t("importInvalid"));
      return count + record.entries.length;
    }
    if (typeof record.entryUrl !== "string") throw new Error(t("importInvalid"));
    return count + 1;
  }, 0);
  const inputExclusions = Object.keys(sourceExclusions).length;
  const inputHostEntries = Object.keys(sourceHostEntries).length;
  if (inputSites + inputExclusions + inputHostEntries > 10000) throw new Error(t("importTooLarge"));
  const sites = validateStoredSites(sourceSites);
  const exclusions = validateExcludedHosts(sourceExclusions);
  const hostEntries = validateHostEntries(sourceHostEntries);
  const validSites = Object.values(sites).reduce((count, site) => count + site.entries.length, 0);
  if (validSites !== inputSites || Object.keys(exclusions).length !== inputExclusions ||
      Object.keys(hostEntries).length !== inputHostEntries) throw new Error(t("importInvalid"));
  return { sites, exclusions, hostEntries };
}

// Full Backup is for moving from a temporary debugging installation to a
// Mozilla-signed Listed installation, including permanent daily aggregates.
// All operations use the same mutation queue as History cleanup so that a
// backup represents a consistent set of settings and daily counters.
async function exportFullBackup() {
  return serializeMutation(async () => {
    const [sites, exclusions, hostEntries] = await Promise.all([
      getSites(), getExclusions(), getHostEntries()
    ]);
    const raw = await browser.storage.local.get(DAILY_STATS_KEY);
    return {
      format: FULL_BACKUP_FORMAT,
      formatVersion: FULL_BACKUP_VERSION,
      extensionId: browser.runtime.id,
      exportedAt: new Date().toISOString(),
      protectedSites: sites,
      excludedHosts: exclusions,
      hostEntryRules: hostEntries,
      dailyDeletionStatsV1: validatedDailyStats(raw[DAILY_STATS_KEY])
    };
  });
}

function validateFullBackup(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(t("fullBackupInvalid"));
  if (JSON.stringify(payload).length > FULL_BACKUP_MAX_BYTES) throw new Error(t("fullBackupTooLarge"));
  if (payload.format !== FULL_BACKUP_FORMAT || payload.formatVersion !== FULL_BACKUP_VERSION ||
      payload.extensionId !== browser.runtime.id ||
      !["protectedSites", "excludedHosts", "hostEntryRules", "dailyDeletionStatsV1"].every(
        (key) => Object.hasOwn(payload, key))) throw new Error(t("fullBackupInvalid"));
  const incoming = strictImportedRules({
    format: "history-control-settings", formatVersion: 1,
    protectedSites: payload.protectedSites,
    excludedHosts: payload.excludedHosts,
    hostEntryRules: payload.hostEntryRules
  });
  const rawStats = payload.dailyDeletionStatsV1;
  if (!rawStats || typeof rawStats !== "object" || Array.isArray(rawStats)) throw new Error(t("fullBackupInvalid"));
  if (Object.keys(rawStats).length > 50000) throw new Error(t("fullBackupTooLarge"));
  const daily = validatedDailyStats(rawStats);
  // Reject malformed data instead of silently throwing away deletion counts.
  if (Object.keys(daily).length !== Object.keys(rawStats).length) throw new Error(t("fullBackupInvalid"));
  return { ...incoming, daily };
}

async function importFullBackup(payload) {
  const incoming = validateFullBackup(payload);
  return serializeMutation(async () => {
    const [previousSites, previousExclusions, previousHostEntries] = await Promise.all([
      getSites(), getExclusions(), getHostEntries()
    ]);
    cachedSites = incoming.sites;
    cachedExclusions = incoming.exclusions;
    cachedHostEntries = incoming.hostEntries;
    try {
      await browser.storage.local.set({
        [STORE_KEY]: incoming.sites,
        [EXCLUSION_KEY]: incoming.exclusions,
        [HOST_ENTRY_KEY]: incoming.hostEntries,
        [DAILY_STATS_KEY]: incoming.daily
      });
    } catch (error) {
      cachedSites = previousSites;
      cachedExclusions = previousExclusions;
      cachedHostEntries = previousHostEntries;
      throw error;
    }
    // Restore protected entry points without triggering Clean Now.
    await ensureAllEntries();
    await refreshAllTabs();
    return {
      protectedCount: Object.values(incoming.sites).reduce((n, site) => n + site.entries.length, 0),
      exclusionCount: Object.keys(incoming.exclusions).length,
      hostEntryCount: Object.keys(incoming.hostEntries).length,
      statisticsDays: Object.keys(incoming.daily).length
    };
  });
}

async function importSettings(payload, mode) {
  if (!["merge", "replace"].includes(mode)) throw new Error(t("importInvalid"));
  const incoming = strictImportedRules(payload);
  return serializeMutation(async () => {
    const [currentSites, currentExclusions, currentHostEntries] = await Promise.all([
      getSites(), getExclusions(), getHostEntries()
    ]);
    let sites, exclusions, hostEntries;
    let added = 0;
    let skipped = 0;
    if (mode === "replace") {
      ({ sites, exclusions, hostEntries } = incoming);
      added = Object.values(sites).reduce((n, site) => n + site.entries.length, 0) +
        Object.keys(exclusions).length + Object.keys(hostEntries).length;
    } else {
      sites = Object.assign(Object.create(null), currentSites);
      exclusions = Object.assign(Object.create(null), currentExclusions);
      hostEntries = Object.assign(Object.create(null), currentHostEntries);
      for (const site of Object.values(incoming.sites)) {
        const present = sites[site.host]
          ? { host: site.host, entries: [...sites[site.host].entries] }
          : { host: site.host, entries: [] };
        for (const entry of site.entries) {
          if (present.entries.some((old) => siteForUrl(old.entryUrl).path === siteForUrl(entry.entryUrl).path)) {
            skipped++;
          } else { present.entries.push(entry); added++; }
        }
        sites[site.host] = present;
      }
      for (const [key, record] of Object.entries(incoming.exclusions)) {
        if (Object.hasOwn(exclusions, key)) skipped++;
        else { exclusions[key] = record; added++; }
      }
      for (const [key, record] of Object.entries(incoming.hostEntries)) {
        if (Object.hasOwn(hostEntries, key)) skipped++;
        else { hostEntries[key] = record; added++; }
      }
    }
    // One storage transaction writes the three independent rule sets together.
    cachedSites = sites;
    cachedExclusions = exclusions;
    cachedHostEntries = hostEntries;
    try {
      await browser.storage.local.set({
        [STORE_KEY]: sites, [EXCLUSION_KEY]: exclusions, [HOST_ENTRY_KEY]: hostEntries
      });
    } catch (error) {
      cachedSites = currentSites;
      cachedExclusions = currentExclusions;
      cachedHostEntries = currentHostEntries;
      throw error;
    }
    await ensureAllEntries(); // Import does not call Clean Now or delete History.
    await refreshAllTabs();
    return { added, skipped, mode };
  });
}

async function updateEntry(host, entryUrl, matchMode, historyMode) {
  if (typeof host !== "string" || typeof entryUrl !== "string" ||
      !["exact", "prefix"].includes(matchMode) || !["entry", "all"].includes(historyMode)) {
    throw new Error(t("errorInvalidRule"));
  }
  return serializeMutation(async () => {
    const sites = await getSites();
    if (!Object.hasOwn(sites, host)) return false;
    const old = sites[host];
    const existing = old.entries.find((entry) => entry.entryUrl === entryUrl);
    if (!existing) return false;
    // An exact entry uses the v1.0.3 canonical URL without trailing slash.
    // Switching from prefix to exact is normalized immediately, not on restart.
    const normalizedUrl = normalizeEntryUrl(entryUrl, matchMode);
    if (!normalizedUrl || siteForUrl(normalizedUrl).host !== host) return false;
    const updated = {
      ...existing, entryUrl: normalizedUrl, matchMode,
      historyMode: matchMode === "prefix" ? historyMode : "entry"
    };
    const next = Object.assign(Object.create(null), sites);
    next[host] = {
      host, entries: old.entries.map((entry) => entry.entryUrl !== entryUrl ? entry : updated)
    };
    await commitSites(sites, next);
    try {
      await ensureEntryExists(updated);
    } catch (error) {
      await commitSites(next, sites).catch((rollbackError) =>
        console.error("History Control: could not roll back rule update", rollbackError));
      throw error;
    }
    await refreshAllTabs();
    return true;
  });
}

async function unprotectEntry(host, entryUrl) {
  return serializeMutation(async () => {
    const sites = await getSites();
    if (!Object.hasOwn(sites, host)) return false;
    const old = sites[host];
    if (!old.entries.some((entry) => entry.entryUrl === entryUrl)) return false;
    const next = Object.assign(Object.create(null), sites);
    const remaining = old.entries.filter((entry) => entry.entryUrl !== entryUrl);
    if (remaining.length) next[host] = { host, entries: remaining };
    else delete next[host];
    await commitSites(sites, next);
    await refreshAllTabs();
    // Removing a rule does NOT immediately delete any existing History.
    return true;
  });
}

async function checkExcludedHost(rawHostname, includeSubdomains) {
  const hostname = normalizeExcludedHostname(rawHostname);
  if (!hostname || typeof includeSubdomains !== "boolean") throw new Error(t("errorInvalidHostname"));
  const sites = await getSites();
  return { hostname, includeSubdomains,
    conflicts: conflictingProtectedUrls(hostname, includeSubdomains, sites) };
}

async function addExcludedHost(rawHostname, includeSubdomains) {
  const hostname = normalizeExcludedHostname(rawHostname);
  if (!hostname || typeof includeSubdomains !== "boolean") throw new Error(t("errorInvalidHostname"));
  return serializeMutation(async () => {
    const [previous, sites] = await Promise.all([getExclusions(), getSites()]);
    const conflicts = conflictingProtectedUrls(hostname, includeSubdomains, sites);
    if (Object.hasOwn(previous, hostname)) return { ...previous[hostname], alreadySaved: true,
      conflicts: conflictingProtectedUrls(hostname, previous[hostname].includeSubdomains, sites) };
    const rule = { hostname, includeSubdomains, savedAt: Date.now() };
    const next = Object.assign(Object.create(null), previous, { [hostname]: rule });
    await commitExclusions(previous, next);
    await refreshAllTabs();
    return { ...rule, alreadySaved: false, conflicts };
  });
}

async function updateExcludedHost(rawHostname, includeSubdomains) {
  const hostname = normalizeExcludedHostname(rawHostname);
  if (!hostname || typeof includeSubdomains !== "boolean") throw new Error(t("errorInvalidHostname"));
  return serializeMutation(async () => {
    const previous = await getExclusions();
    if (!Object.hasOwn(previous, hostname)) return false;
    const next = Object.assign(Object.create(null), previous);
    next[hostname] = { ...previous[hostname], includeSubdomains };
    await commitExclusions(previous, next);
    await ensureAllEntries(); // Restore saved entries no longer excluded after narrowing.
    await refreshAllTabs();
    return true;
  });
}

async function removeExcludedHost(rawHostname) {
  const hostname = normalizeExcludedHostname(rawHostname);
  if (!hostname) throw new Error(t("errorInvalidHostname"));
  return serializeMutation(async () => {
    const previous = await getExclusions();
    if (!Object.hasOwn(previous, hostname)) return false;
    const next = Object.assign(Object.create(null), previous);
    delete next[hostname];
    await commitExclusions(previous, next);
    await ensureAllEntries(); // Protected URLs become active again.
    await refreshAllTabs();
    // Removing an exclusion does not resurrect other old History records.
    return true;
  });
}

async function performCleanNow() {
  // Runs under mutationQueue; rules cannot be modified during cleanup.
  const [sites, exclusions, hostEntries] = await Promise.all([getSites(), getExclusions(), getHostEntries()]);
  const protectedSites = Object.values(sites);
  const exclusionRules = Object.values(exclusions);
  const hostRules = Object.values(hostEntries);
  const retained = new Set([...protectedSites.flatMap((site) => site.entries.map((entry) => entry.entryUrl)),
    ...hostRules.map((rule) => rule.entryUrl)]);
  const savedCount = [...retained].filter((url) =>
    !shouldDeleteUrl(url, sites, exclusions, hostEntries)).length;
  if (protectedSites.length === 0 && exclusionRules.length === 0 && hostRules.length === 0) {
    return { deleted: 0, failed: 0, saved: 0 };
  }

  // A History text search also searches page titles. Always independently
  // check the URL's hostname against the specific scope before deletion.
  const scopes = [
    ...protectedSites.map((site) => ({
      search: site.host,
      contains: (url) => siteForUrl(url)?.host === site.host
    })),
    ...exclusionRules.map((rule) => ({
      search: rule.hostname,
      contains: (url) => hostnameMatches(historyHostname(url) || "", rule.hostname, rule.includeSubdomains)
    })),
    ...hostRules.map((rule) => ({
      search: rule.hostname,
      contains: (url) => hostnameMatches(historyHostname(url) || "", rule.hostname, rule.includeSubdomains)
    }))
  ];
  let deleted = 0;
  let failed = 0;
  const processed = new Set();
  const dailyDeltas = Object.create(null);
  try {
    for (const scope of scopes) {
      let passes = 0;
      let cursorTime = Date.now() + 60 * 1000;
      const failedUrls = new Set();
      while (passes < MAX_CLEAN_PASSES) {
        passes++;
        const batch = await browser.history.search({
          text: scope.search, startTime: 0, endTime: cursorTime, maxResults: CLEAN_BATCH_SIZE
        });
        if (batch.length === 0) break;
        const targets = batch
          .filter((item) => item.url && scope.contains(item.url) &&
            shouldDeleteUrl(item.url, sites, exclusions, hostEntries) &&
            !processed.has(item.url) && !failedUrls.has(item.url))
          .map((item) => item.url);
        if (targets.length) {
          let success = 0;
          let localFailures = 0;
          let index = 0;
          const workers = Array.from({ length: Math.min(DELETE_CONCURRENCY, targets.length) }, async () => {
            while (index < targets.length) {
              const url = targets[index++];
              try {
                await browser.history.deleteUrl({ url });
                processed.add(url);
                success++;
                // A successful deleteUrl call counts once, not once per visit.
                const day = localStatsDay();
                if (!Object.hasOwn(dailyDeltas, day)) dailyDeltas[day] = { auto: 0, manual: 0 };
                dailyDeltas[day].manual++;
              } catch (error) {
                failedUrls.add(url);
                localFailures++;
                console.error("History Control: Clean Now failed", error);
              }
            }
          });
          await Promise.all(workers);
          deleted += success;
          failed += localFailures;
          if (success > 0) continue;
        }
        if (batch.length < CLEAN_BATCH_SIZE) break;
        const oldest = Math.min(...batch.map((item) => Number(item.lastVisitTime)));
        if (!Number.isFinite(oldest) || oldest <= 0) throw new Error(t("errorPaging"));
        const nextCursor = Math.floor(oldest) - 1;
        if (nextCursor <= 0 || nextCursor >= cursorTime) break;
        cursorTime = nextCursor;
      }
      if (passes >= MAX_CLEAN_PASSES) throw new Error(t("errorCleanLimit"));
    }
  } finally {
    // Persist successful deletions even if a later search pass fails.
    // A statistics storage error must not conceal the cleanup result.
    try { await appendDailyDeletionCounts(dailyDeltas); }
    catch (error) { console.error("History Control: Clean Now statistics failed", error); }
  }
  await ensureAllEntries();
  return { deleted, failed, saved: savedCount };
}

// History listeners are registered synchronously for Firefox MV3 event pages.
browser.history.onVisited.addListener((item) => {
  if (!item.url) return;
  void serializeMutation(async () => {
    const [sites, exclusions, hostEntries] = await Promise.all([getSites(), getExclusions(), getHostEntries()]);
    if (!shouldDeleteUrl(item.url, sites, exclusions, hostEntries)) return;
    try {
      await browser.history.deleteUrl({ url: item.url });
    } catch (error) {
      console.error("History Control: Auto Delete failed", error);
      return;
    }
    try {
      await appendDailyDeletionCounts({ [localStatsDay()]: { auto: 1, manual: 0 } });
    } catch (error) {
      console.error("History Control: Auto Delete statistics failed", error);
    }
  }).catch((error) => console.error("History Control: visit handler failed", error));
});

browser.history.onVisitRemoved.addListener((detail) => {
  void (async () => {
    const [sites, hostEntries] = await Promise.all([getSites(), getHostEntries()]);
    if (detail.allHistory) { await ensureAllEntries(); return; }
    const removed = new Set(detail.urls || []);
    for (const entry of [...Object.values(sites).flatMap((site) => site.entries),
        ...Object.values(hostEntries)]) {
        if (!removed.has(entry.entryUrl)) continue;
        try { await ensureEntryExists(entry); }
        catch (error) { console.error("History Control: restore entry failed", error); }
    }
  })().catch(console.error);
});

browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") void refreshTab(tab);
});
browser.tabs.onActivated.addListener(({ tabId }) => {
  void browser.tabs.get(tabId).then(refreshTab).catch(() => {});
});
browser.tabs.onCreated.addListener((tab) => { void refreshTab(tab); });

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes[STORE_KEY] && !changes[EXCLUSION_KEY] && !changes[HOST_ENTRY_KEY])) return;
  if (changes[STORE_KEY]) cachedSites = validateStoredSites(changes[STORE_KEY].newValue);
  if (changes[EXCLUSION_KEY]) cachedExclusions = validateExcludedHosts(changes[EXCLUSION_KEY].newValue);
  if (changes[HOST_ENTRY_KEY]) cachedHostEntries = validateHostEntries(changes[HOST_ENTRY_KEY].newValue);
  void refreshAllTabs().catch(console.error);
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== browser.runtime.id || !message || typeof message !== "object") return;
  if (message.type === "save" && Number.isInteger(message.tabId)) {
    return browser.tabs.get(message.tabId).then(saveSiteFromTab);
  }
  if (message.type === "add" && typeof message.url === "string") {
    return addProtectedUrl(message.url, message.matchMode, message.historyMode);
  }
  if (message.type === "list") {
    return Promise.all([getSites(), getExclusions(), getHostEntries()]).then(([sites, exclusions, hostEntries]) => Object.values(sites)
      .flatMap((site) => site.entries.map((entry) => ({ host: site.host, ...entry,
        excluded: Boolean(exclusionForUrl(entry.entryUrl, exclusions)),
        overridden: shouldDeleteUrl(entry.entryUrl, sites, exclusions, hostEntries) })))
      .sort((a, b) => a.host.localeCompare(b.host) || a.entryUrl.localeCompare(b.entryUrl)));
  }
  if (message.type === "listExcluded") {
    return Promise.all([getSites(), getExclusions()]).then(([sites, exclusions]) =>
      Object.values(exclusions).map((rule) => ({ ...rule,
        conflicts: conflictingProtectedUrls(rule.hostname, rule.includeSubdomains, sites) }))
        .sort((a, b) => a.hostname.localeCompare(b.hostname)));
  }
  if (message.type === "checkExcluded") {
    return checkExcludedHost(message.hostname, message.includeSubdomains);
  }
  if (message.type === "addExcluded") {
    return addExcludedHost(message.hostname, message.includeSubdomains);
  }
  if (message.type === "updateExcluded") {
    return updateExcludedHost(message.hostname, message.includeSubdomains);
  }
  if (message.type === "removeExcluded") {
    return removeExcludedHost(message.hostname);
  }
  if (message.type === "listHostEntries") {
    return Promise.all([getSites(), getExclusions(), getHostEntries()]).then(([sites, exclusions, hostEntries]) =>
      Object.values(hostEntries).map((rule) => ({ ...rule,
        conflicts: hostEntryConflicts(rule.hostname, rule.entryUrl, rule.includeSubdomains, sites, exclusions) }))
        .sort((a, b) => a.hostname.localeCompare(b.hostname)));
  }
  if (message.type === "checkHostEntry") {
    return checkHostEntry(message.hostname, message.entryUrl, message.includeSubdomains);
  }
  if (message.type === "addHostEntry") {
    return addHostEntry(message.hostname, message.entryUrl, message.includeSubdomains);
  }
  if (message.type === "updateHostEntry") {
    return updateHostEntry(message.hostname, message.entryUrl, message.includeSubdomains);
  }
  if (message.type === "removeHostEntry") {
    return removeHostEntry(message.hostname);
  }
  if (message.type === "getDailyStatistics") {
    return browser.storage.local.get(DAILY_STATS_KEY)
      .then((stored) => validatedDailyStats(stored[DAILY_STATS_KEY]));
  }
  if (message.type === "exportFullBackup") {
    return exportFullBackup();
  }
  if (message.type === "importFullBackup") {
    return importFullBackup(message.payload);
  }
  if (message.type === "exportSettings") {
    return Promise.all([getSites(), getExclusions(), getHostEntries()])
      .then(([sites, exclusions, hostEntries]) => settingsSnapshot(sites, exclusions, hostEntries));
  }
  if (message.type === "importSettings") {
    return importSettings(message.payload, message.mode);
  }
  if (message.type === "updateEntry") {
    return updateEntry(message.host, message.entryUrl, message.matchMode, message.historyMode);
  }
  if (message.type === "unprotectEntry" &&
      typeof message.host === "string" && typeof message.entryUrl === "string") {
    return unprotectEntry(message.host, message.entryUrl);
  }
  if (message.type === "clean") {
    if (!cleanPromise) {
      cleanPromise = serializeMutation(performCleanNow).finally(() => { cleanPromise = null; });
    }
    return cleanPromise;
  }
});

browser.menus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_ID) void browser.runtime.openOptionsPage();
});

function registerMenu() {
  if (menuPromise) return menuPromise;
  menuPromise = browser.menus.removeAll().then(() => {
    browser.menus.create({ id: MENU_ID, contexts: ["action"], title: t("menuManage") });
  }).catch((error) => console.error("History Control: menu failed", error))
    .finally(() => { menuPromise = null; });
  return menuPromise;
}

browser.runtime.onInstalled.addListener(() => {
  registerMenu();
  void ensureAllEntries();
  void refreshAllTabs();
});
browser.runtime.onStartup.addListener(() => {
  registerMenu();
  void ensureAllEntries();
  void refreshAllTabs();
});
void Promise.all([getSites(), getExclusions(), getHostEntries()]).then(ensureAllEntries).then(refreshAllTabs).catch(console.error);
registerMenu();
