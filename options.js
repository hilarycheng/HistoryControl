/* global browser */
"use strict";

const listEl = document.getElementById("site-list");
const emptyEl = document.getElementById("empty-message");
const countEl = document.getElementById("count");
const statusEl = document.getElementById("status");
const addStatusEl = document.getElementById("add-status");
const cleanBtn = document.getElementById("clean");
const refreshBtn = document.getElementById("refresh");
const addBtn = document.getElementById("add-button");
const addForm = document.getElementById("add-form");
const addUrl = document.getElementById("add-url");
const addMatch = document.getElementById("add-match-mode");
const addHistory = document.getElementById("add-history-mode");
const addHistoryRow = document.getElementById("add-history-row");
const addModeHelp = document.getElementById("add-mode-help");
const excludeForm = document.getElementById("exclude-form");
const excludeHostname = document.getElementById("exclude-hostname");
const excludeSubdomains = document.getElementById("exclude-subdomains");
const excludeAddBtn = document.getElementById("exclude-add-button");
const excludeStatus = document.getElementById("exclude-status");
const excludeList = document.getElementById("exclude-list");
const excludeEmpty = document.getElementById("exclude-empty");
const excludeCount = document.getElementById("exclude-count");
const hostForm = document.getElementById("host-entry-form");
const hostHostname = document.getElementById("host-entry-hostname");
const hostUrl = document.getElementById("host-entry-url");
const hostSubdomains = document.getElementById("host-entry-subdomains");
const hostAddBtn = document.getElementById("host-entry-add");
const hostList = document.getElementById("host-entry-list");
const hostCount = document.getElementById("host-entry-count");
const hostEmpty = document.getElementById("host-entry-empty");
const hostStatus = document.getElementById("host-entry-status");
const exportBtn = document.getElementById("export-button");
const importBtn = document.getElementById("import-button");
const importFile = document.getElementById("import-file");
const importMode = document.getElementById("import-mode");
const backupStatus = document.getElementById("backup-status");
const fullExportBtn = document.getElementById("full-export-button");
const fullImportBtn = document.getElementById("full-import-button");
const fullImportFile = document.getElementById("full-import-file");
const fullBackupStatus = document.getElementById("full-backup-status");

let sites = [];
let exclusions = [];
let hostEntries = [];
let busy = false;
function t(key) { return browser.i18n.getMessage(key) || key; }

function applyLocale() {
  const locale = browser.i18n.getUILanguage();
  document.documentElement.lang = /^(zh-HK|zh-TW)$/i.test(locale) ? "zh-Hant" : "en";
  document.title = t("pageTitle");
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.getAttribute("data-i18n"));
  }
  addUrl.placeholder = t("urlPlaceholder");
  excludeHostname.placeholder = t("hostnamePlaceholder");
  hostHostname.placeholder = t("hostnamePlaceholder");
  hostUrl.placeholder = t("hostEntryUrlPlaceholder");
}

function showStatus(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("error", isError);
}

function syncAddMode() {
  addHistoryRow.hidden = addMatch.value !== "prefix";
  if (addMatch.value !== "prefix") addHistory.value = "entry";
  addModeHelp.textContent = t(addMatch.value === "prefix" ? "helpPrefix" : "helpExact");
}

function selectBox(values, current, name) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", t(name));
  for (const [value, labelKey] of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = t(labelKey);
    select.append(option);
  }
  select.value = current;
  return select;
}

function setBusy(value) {
  busy = value;
  cleanBtn.disabled = busy || (sites.length === 0 && exclusions.length === 0 && hostEntries.length === 0);
  refreshBtn.disabled = busy;
  addBtn.disabled = busy;
  addUrl.disabled = busy;
  addMatch.disabled = busy;
  addHistory.disabled = busy;
  excludeHostname.disabled = busy;
  excludeSubdomains.disabled = busy;
  excludeAddBtn.disabled = busy;
  hostHostname.disabled = busy;
  hostUrl.disabled = busy;
  hostSubdomains.disabled = busy;
  hostAddBtn.disabled = busy;
  exportBtn.disabled = busy;
  importBtn.disabled = busy;
  importFile.disabled = busy;
  importMode.disabled = busy;
  fullExportBtn.disabled = busy;
  fullImportBtn.disabled = busy;
  fullImportFile.disabled = busy;
  for (const el of document.querySelectorAll(".rule-action, .rule-select, .exclude-action, .exclude-checkbox, .host-action, .host-checkbox, .host-url-editor")) el.disabled = busy;
}

async function loadSites() {
  [sites, exclusions, hostEntries] = await Promise.all([
    browser.runtime.sendMessage({ type: "list" }),
    browser.runtime.sendMessage({ type: "listExcluded" }),
    browser.runtime.sendMessage({ type: "listHostEntries" })
  ]);
  countEl.textContent = String(sites.length);
  cleanBtn.disabled = busy || (sites.length === 0 && exclusions.length === 0 && hostEntries.length === 0);
  listEl.replaceChildren();
  emptyEl.hidden = sites.length > 0;

  for (const site of sites) {
    const item = document.createElement("li");
    const details = document.createElement("div");
    details.className = "site-detail";
    const host = document.createElement("strong");
    host.textContent = site.host;
    const entry = document.createElement("code");
    entry.textContent = site.entryUrl;
    details.append(host, entry);
    if (site.overridden || site.excluded) {
      const warning = document.createElement("span");
      warning.className = "conflict-tag";
      warning.textContent = t("conflictBadge");
      details.append(warning);
    }

    const editor = document.createElement("div");
    editor.className = "rule-editor";
    const matchSelect = selectBox([["exact", "modeExact"], ["prefix", "modePrefix"]], site.matchMode, "fieldMatchMode");
    const historySelect = selectBox([["entry", "historyEntry"], ["all", "historyAll"]], site.historyMode, "fieldHistoryMode");
    matchSelect.className = historySelect.className = "rule-select";
    historySelect.hidden = site.matchMode !== "prefix";
    matchSelect.addEventListener("change", () => {
      historySelect.hidden = matchSelect.value !== "prefix";
      if (matchSelect.value === "exact") historySelect.value = "entry";
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "quiet rule-action";
    saveBtn.textContent = t("editSave");
    saveBtn.addEventListener("click", async () => {
      if (busy) return;
      setBusy(true);
      try {
        const success = await browser.runtime.sendMessage({
          type: "updateEntry", host: site.host, entryUrl: site.entryUrl,
          matchMode: matchSelect.value, historyMode: matchSelect.value === "prefix" ? historySelect.value : "entry"
        });
        if (!success) throw new Error(t("listEmpty"));
        await loadSites();
        showStatus(statusEl, `${t("editSaved")} ${site.entryUrl}`);
      } catch (error) {
        showStatus(statusEl, `${t("editError")} ${error.message || String(error)}`, true);
      } finally { setBusy(false); }
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "quiet rule-action";
    removeBtn.type = "button";
    removeBtn.textContent = t("remove");
    removeBtn.addEventListener("click", async () => {
      if (busy || !window.confirm(`${t("removeConfirm")} ${site.entryUrl}`)) return;
      setBusy(true);
      try {
        const success = await browser.runtime.sendMessage({
          type: "unprotectEntry", host: site.host, entryUrl: site.entryUrl
        });
        if (!success) throw new Error(t("listEmpty"));
        await loadSites();
        showStatus(statusEl, `${t("removeSaved")} ${site.entryUrl}`);
      } catch (error) {
        showStatus(statusEl, `${t("removeError")} ${error.message || String(error)}`, true);
      } finally { setBusy(false); }
    });

    editor.append(matchSelect, historySelect, saveBtn, removeBtn);
    item.append(details, editor);
    listEl.append(item);
  }

  hostCount.textContent = String(hostEntries.length);
  hostList.replaceChildren();
  hostEmpty.hidden = hostEntries.length > 0;
  for (const rule of hostEntries) {
    const item = document.createElement("li");
    const details = document.createElement("div");
    details.className = "site-detail";
    const title = document.createElement("strong");
    title.textContent = rule.hostname;
    const url = document.createElement("code");
    url.textContent = rule.entryUrl;
    details.append(title, url);
    if (rule.conflicts?.noHistory?.length || rule.conflicts?.protected?.length) {
      const warning = document.createElement("span");
      warning.className = "conflict-tag";
      warning.textContent = t("hostEntryConflictTag");
      details.append(warning);
    }
    const editor = document.createElement("div");
    editor.className = "host-entry-editor";
    const editorUrl = document.createElement("input");
    editorUrl.type = "url";
    editorUrl.className = "host-url-editor";
    editorUrl.value = rule.entryUrl;
    editorUrl.setAttribute("aria-label", t("hostEntryUrlLabel"));
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = rule.includeSubdomains;
    checkbox.className = "host-checkbox";
    const labelText = document.createElement("span");
    labelText.textContent = t("includeSubdomains");
    label.append(checkbox, labelText);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "quiet host-action";
    saveBtn.textContent = t("editSave");
    saveBtn.addEventListener("click", async () => {
      if (busy) return;
      setBusy(true);
      try {
        if (!(await confirmHostEntryConflicts(rule.hostname, editorUrl.value, checkbox.checked))) return;
        const updated = await browser.runtime.sendMessage({ type: "updateHostEntry",
          hostname: rule.hostname, entryUrl: editorUrl.value, includeSubdomains: checkbox.checked });
        if (!updated) throw new Error(t("hostEntryEmpty"));
        await loadSites();
        showStatus(hostStatus, `${t("hostEntryUpdated")} ${rule.hostname}`);
      } catch (error) {
        showStatus(hostStatus, `${t("hostEntryError")} ${error.message || String(error)}`, true);
      } finally { setBusy(false); }
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "quiet host-action";
    removeBtn.textContent = t("remove");
    removeBtn.addEventListener("click", async () => {
      if (busy || !window.confirm(`${t("hostEntryRemoveConfirm")} ${rule.hostname}`)) return;
      setBusy(true);
      try {
        const removed = await browser.runtime.sendMessage({ type: "removeHostEntry", hostname: rule.hostname });
        if (!removed) throw new Error(t("hostEntryEmpty"));
        await loadSites();
        showStatus(hostStatus, `${t("hostEntryRemoved")} ${rule.hostname}`);
      } catch (error) {
        showStatus(hostStatus, `${t("hostEntryError")} ${error.message || String(error)}`, true);
      } finally { setBusy(false); }
    });
    editor.append(editorUrl, label, saveBtn, removeBtn);
    item.append(details, editor);
    hostList.append(item);
  }

  excludeCount.textContent = String(exclusions.length);
  excludeList.replaceChildren();
  excludeEmpty.hidden = exclusions.length > 0;
  for (const rule of exclusions) {
    const item = document.createElement("li");
    const details = document.createElement("div");
    details.className = "exclude-detail";
    const host = document.createElement("strong");
    host.textContent = rule.hostname;
    details.append(host);
    if (rule.conflicts?.length) {
      const conflict = document.createElement("span");
      conflict.className = "conflict-tag";
      conflict.textContent = `${t("excludeConflictTag")} (${rule.conflicts.length})`;
      details.append(conflict);
    }

    const editor = document.createElement("div");
    editor.className = "exclude-editor";
    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "exclude-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "exclude-checkbox";
    checkbox.checked = rule.includeSubdomains;
    const labelText = document.createElement("span");
    labelText.textContent = t("includeSubdomains");
    checkboxLabel.append(checkbox, labelText);

    const updateBtn = document.createElement("button");
    updateBtn.type = "button";
    updateBtn.className = "quiet exclude-action";
    updateBtn.textContent = t("editSave");
    updateBtn.addEventListener("click", async () => {
      if (busy) return;
      setBusy(true);
      try {
        if (rule.includeSubdomains !== checkbox.checked &&
            !(await confirmExclusionConflicts(rule.hostname, checkbox.checked))) return;
        const success = await browser.runtime.sendMessage({ type: "updateExcluded",
          hostname: rule.hostname, includeSubdomains: checkbox.checked });
        if (!success) throw new Error(t("excludeEmpty"));
        await loadSites();
        showStatus(excludeStatus, `${t("excludeUpdated")} ${rule.hostname}`);
      } catch (error) {
        showStatus(excludeStatus, `${t("excludeError")} ${error.message || String(error)}`, true);
      } finally { setBusy(false); }
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "quiet exclude-action";
    removeBtn.textContent = t("remove");
    removeBtn.addEventListener("click", async () => {
      if (busy || !window.confirm(`${t("excludeRemoveConfirm")} ${rule.hostname}`)) return;
      setBusy(true);
      try {
        const success = await browser.runtime.sendMessage({ type: "removeExcluded", hostname: rule.hostname });
        if (!success) throw new Error(t("excludeEmpty"));
        await loadSites();
        showStatus(excludeStatus, `${t("excludeRemoved")} ${rule.hostname}`);
      } catch (error) {
        showStatus(excludeStatus, `${t("excludeError")} ${error.message || String(error)}`, true);
      } finally { setBusy(false); }
    });
    editor.append(checkboxLabel, updateBtn, removeBtn);
    item.append(details, editor);
    excludeList.append(item);
  }
}

async function confirmHostEntryConflicts(hostname, entryUrl, includeSubdomains) {
  const preview = await browser.runtime.sendMessage({
    type: "checkHostEntry", hostname, entryUrl, includeSubdomains
  });
  const conflicts = [...preview.conflicts.protected, ...preview.conflicts.noHistory];
  return conflicts.length === 0 || window.confirm(
    `${t("hostEntryConflictConfirm")}\n\n${conflicts.slice(0, 6).join("\n")}`);
}

hostForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  try {
    if (!(await confirmHostEntryConflicts(hostHostname.value.trim(), hostUrl.value.trim(), hostSubdomains.checked))) return;
    const result = await browser.runtime.sendMessage({
      type: "addHostEntry", hostname: hostHostname.value.trim(),
      entryUrl: hostUrl.value.trim(), includeSubdomains: hostSubdomains.checked
    });
    await loadSites();
    showStatus(hostStatus, `${t(result.alreadySaved ? "hostEntryExists" : "hostEntryAdded")} ${result.hostname}`);
    if (!result.alreadySaved) { hostHostname.value = ""; hostUrl.value = ""; }
  } catch (error) {
    showStatus(hostStatus, `${t("hostEntryError")} ${error.message || String(error)}`, true);
  } finally { setBusy(false); }
});

async function confirmExclusionConflicts(hostname, includeSubdomains) {
  const preview = await browser.runtime.sendMessage({
    type: "checkExcluded", hostname, includeSubdomains
  });
  if (!preview.conflicts.length) return true;
  const examples = preview.conflicts.slice(0, 4).join("\n");
  return window.confirm(`${t("excludeConflictConfirm")}\n\n${examples}`);
}

excludeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  try {
    if (!(await confirmExclusionConflicts(excludeHostname.value.trim(), excludeSubdomains.checked))) return;
    const result = await browser.runtime.sendMessage({
      type: "addExcluded", hostname: excludeHostname.value.trim(),
      includeSubdomains: excludeSubdomains.checked
    });
    await loadSites();
    showStatus(excludeStatus, `${t(result.alreadySaved ? "excludeExists" : "excludeAdded")} ${result.hostname}`);
    if (!result.alreadySaved) excludeHostname.value = "";
  } catch (error) {
    showStatus(excludeStatus, `${t("excludeError")} ${error.message || String(error)}`, true);
  } finally { setBusy(false); }
});

addMatch.addEventListener("change", syncAddMode);
addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  try {
    const result = await browser.runtime.sendMessage({
      type: "add", url: addUrl.value.trim(), matchMode: addMatch.value,
      historyMode: addMatch.value === "prefix" ? addHistory.value : "entry"
    });
    await loadSites();
    showStatus(addStatusEl, `${t(result.alreadySaved ? "addExists" : "addSuccess")} ${result.entryUrl}`);
    if (!result.alreadySaved) addUrl.value = "";
  } catch (error) {
    showStatus(addStatusEl, `${t("addError")} ${error.message || String(error)}`, true);
  } finally { setBusy(false); }
});

refreshBtn.addEventListener("click", () => {
  if (busy) return;
  void loadSites().catch((error) => showStatus(statusEl, `${t("listError")} ${error.message}`, true));
});

cleanBtn.addEventListener("click", async () => {
  if (busy) return;
  if (sites.length === 0 && exclusions.length === 0 && hostEntries.length === 0) { showStatus(statusEl, t("cleanEmpty")); return; }
  if (!window.confirm(t("cleanConfirm"))) return;
  setBusy(true);
  showStatus(statusEl, t("cleanProgress"));
  try {
    const result = await browser.runtime.sendMessage({ type: "clean" });
    if (result.failed > 0) {
      showStatus(statusEl, `${t("cleanSuccess")} ${result.deleted}. ${t("cleanFailure")} ${result.failed}.`, true);
    } else {
      showStatus(statusEl, `${t("cleanSuccess")} ${result.deleted}. ${t("cleanSavedCount")} ${result.saved}.`);
    }
  } catch (error) {
    showStatus(statusEl, `${t("cleanError")} ${error.message || String(error)}`, true);
  } finally {
    setBusy(false);
    try { await loadSites(); }
    catch (error) { showStatus(statusEl, `${t("listError")} ${error.message}`, true); }
  }
});

exportBtn.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    const payload = await browser.runtime.sendMessage({ type: "exportSettings" });
    const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json" });
    const fileUrl = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = fileUrl;
      link.download = `history-control-settings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      showStatus(backupStatus, t("exportSuccess"));
    } finally {
      // Keep the Blob URL available until the browser starts the download.
      setTimeout(() => URL.revokeObjectURL(fileUrl), 60000);
    }
  } catch (error) {
    showStatus(backupStatus, `${t("exportError")} ${error.message || String(error)}`, true);
  } finally { setBusy(false); }
});

importBtn.addEventListener("click", async () => {
  if (busy) return;
  const file = importFile.files?.[0];
  if (!file) { showStatus(backupStatus, t("importNoFile"), true); return; }
  if (file.size > 1024 * 1024) { showStatus(backupStatus, t("importTooLarge"), true); return; }
  const mode = importMode.value;
  if (!window.confirm(t(mode === "replace" ? "importReplaceConfirm" : "importMergeConfirm"))) return;
  setBusy(true);
  try {
    const contents = await file.text();
    const payload = JSON.parse(contents);
    const result = await browser.runtime.sendMessage({ type: "importSettings", payload, mode });
    await loadSites();
    showStatus(backupStatus,
      `${t("importSuccess")} ${t("importAdded")} ${result.added}; ${t("importSkipped")} ${result.skipped}.`);
    importFile.value = "";
  } catch (error) {
    showStatus(backupStatus, `${t("importError")} ${error.message || String(error)}`, true);
  } finally { setBusy(false); }
});

// Keep rules-only Export/Import unchanged for compatibility. These separate
// controls back up ALL user configuration and daily statistics for migration.
fullExportBtn.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    const payload = await browser.runtime.sendMessage({ type: "exportFullBackup" });
    const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json" });
    const fileUrl = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = fileUrl;
      link.download = `history-control-full-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      showStatus(fullBackupStatus, t("fullBackupExportSuccess"));
    } finally {
      setTimeout(() => URL.revokeObjectURL(fileUrl), 60000);
    }
  } catch (error) {
    showStatus(fullBackupStatus, `${t("fullBackupExportError")} ${error.message || String(error)}`, true);
  } finally { setBusy(false); }
});

fullImportBtn.addEventListener("click", async () => {
  if (busy) return;
  const file = fullImportFile.files?.[0];
  if (!file) { showStatus(fullBackupStatus, t("importNoFile"), true); return; }
  if (file.size > 4 * 1024 * 1024) { showStatus(fullBackupStatus, t("fullBackupTooLarge"), true); return; }
  if (!window.confirm(t("fullBackupRestoreConfirm"))) return;
  setBusy(true);
  try {
    const payload = JSON.parse(await file.text());
    const result = await browser.runtime.sendMessage({ type: "importFullBackup", payload });
    await loadSites();
    showStatus(fullBackupStatus, `${t("fullBackupRestoreSuccess")} ${result.protectedCount} / ${result.exclusionCount} / ${result.hostEntryCount} / ${result.statisticsDays}`);
    fullImportFile.value = "";
  } catch (error) {
    showStatus(fullBackupStatus, `${t("fullBackupRestoreError")} ${error.message || String(error)}`, true);
  } finally { setBusy(false); }
});

applyLocale();
syncAddMode();
void loadSites().catch((error) => showStatus(statusEl, `${t("listError")} ${error.message}`, true));
