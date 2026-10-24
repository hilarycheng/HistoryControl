# AMO Listed — 公開上架文案草稿

## English

**Name:** History Control

**Short summary:** Keep selected entry points in Firefox browsing history, automatically clean matching history URLs, and explore local history statistics.

**Description:**

History Control gives you precise control over which browsing-history entries Firefox keeps. You decide which URLs or hostnames are affected. Browsing history for unrelated sites is left untouched.

Features:
- Save protected URLs with Exact Match or Path Prefix Match rules.
- Keep only a chosen entry point, or keep all matching URLs.
- Clear matching history for hostnames and optionally their subdomains.
- Manually clean existing history for configured rules.
- Explore history by hostname, URL count, visit count, and most recent visit.
- Track daily automatic and manual history-deletion counts.
- Export and import rules, or make a Full Backup that also includes daily statistics.
- Use the interface in English or formal Traditional Chinese, following Firefox's UI language.

Privacy: All analysis and stored settings remain local to your browser. No browsing data is sent to a remote server. Optional JSON backups are saved locally at your request and may contain sensitive URLs.

**Important limitation:** Firefox writes browsing-history entries before the extension's automatic cleanup can remove them. This add-on does not guarantee that matching visits were never written to disk. Deleted history cannot be undone.

## 繁體中文（正式書面語）

**名稱：** History Control

**簡短說明：** 保留指定入口網址、自動清理符合規則的瀏覽紀錄，並在本機查看歷史紀錄統計。

**詳細說明：**

History Control 讓使用者精確管理 Firefox 的瀏覽紀錄。只有明確設定的網址或主機名稱會套用清理規則，其他網站的瀏覽紀錄保持不變。

功能包括：
- 使用完全比對或路徑前綴比對保護指定網址。
- 選擇僅保留入口網址，或保留所有符合規則的網址。
- 清理指定主機名稱及可選的所有子網域。
- 手動清理既有瀏覽紀錄。
- 按主機名稱、網址數量、造訪次數及最後造訪時間分析紀錄。
- 統計每日自動與手動清理次數。
- 匯出／匯入規則，以及包含每日統計的完整備份。
- 依 Firefox 介面語言使用英文或繁體中文正式書面語。

隱私：分析與設定均保留於使用者的瀏覽器本機，不會將瀏覽資料傳送至外部伺服器。使用者自行匯出的 JSON 備份可能包含私人網址，請妥善保管。

**重要限制：** Firefox 會先建立 History 紀錄，再由擴充功能自動刪除。此擴充功能無法保證特定瀏覽紀錄從未寫入磁碟。已刪除的紀錄無法復原。

## 提交時由發佈者決定

- **License／授權：** 應由程式擁有者自行選擇，這份套件不代為宣告開源授權。
- **Support email / URL：** 填入你願意公開提供的聯絡方式；不要填入私人資料。
- **AMO listing URL／Slug：** 由 AMO 確認是否可用。
- **Categories：** 依 AMO 當時可用的分類，選擇最合適的類別。
- **Privacy policy：** 若在 AMO 提交畫面需要，可參考 `PRIVACY.md`，並自行提供託管位置或貼上政策。
