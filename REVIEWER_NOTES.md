# Notes for Mozilla Add-ons (AMO) reviewers — History Control 1.1.0

Distribution: **Listed / On this site**.

This is a Firefox Manifest V3 extension. The ZIP contains unminified, human-readable JavaScript, local HTML/CSS and SVG icons. There are no build-time transformations and no runtime downloads of executable code.

**Permissions**
- `history`: read history for the History Explorer, remove only URLs that match explicit user-defined rules, and restore canonical protected entry-point URLs.
- `storage`: store user-configured rules and date-only deletion statistics locally; imported JSON remains local.
- `tabs`: identify the active tab URL and reflect current matching state in the toolbar.
- `menus`: provide an Options entry in the toolbar context menu.

No remote requests are made by the extension. `browser_specific_settings.gecko.data_collection_permissions.required` is `["none"]`; the application does not transmit personal data outside the browser.

**Steps to test**
1. Open Options, confirm the Protected URLs, Host Entry, No History, History Explorer, Statistics, and Export / Import sections.
2. Choose a test URL under your control. Add an Exact protected entry using Options or the toolbar popup.
3. Visit another path under the same protected hostname, then examine history. The protected entry remains and the other matching path is removed.
4. Create and remove a No History hostname rule. With Include All Subdomains checked, the rule matches the host and its subdomains but not unrelated hostnames.
5. Confirm the History Explorer can analyze and filter local history; existing visits that were previously cleaned cannot be recovered.
6. In Export / Import, use Export Full Backup to save a local JSON file containing the three rule sets and daily aggregate counts. Use Restore Full Backup to verify restoration. A restore itself does not run Clean Now.
7. Change the Firefox UI language between English and `zh-HK`/`zh-TW` to inspect the localized Options and Popup text.

**Safety limitation:** `history.onVisited` runs after Firefox writes the history entry. This extension deletes matching records after that event rather than preventing a write to storage.

**Migration:** The manifest add-on ID `firefox-minimal-history@local-extension.example` is intentionally unchanged from previous temporary-debug builds to support continuity. A user should still export Full Backup first, because removing a temporary add-on may clear `storage.local`.

**Source:** The matching `history-control-source-v1.1.0.zip` includes all runtime files unchanged, plus source-level tests and documentation. Run `node --test tests/*.test.js` using Node.js to execute mock-based tests. No separate build command is needed: the runtime JS/CSS/HTML in the source archive is byte-for-byte the same as the files inside the AMO submission ZIP.

## Extension branding icon

The public extension icon is provided in `icons/app-48.png`, `icons/app-96.png`, and `icons/app-128.png`; `manifest.json` references those sizes through its `icons` property. The three toolbar state icons (`icons/unsaved.svg`, `icons/saved.svg`, and `icons/excluded.svg`) remain unchanged. The icon artwork was generated for this extension and is included as PNG assets without fetching external resources at runtime.
