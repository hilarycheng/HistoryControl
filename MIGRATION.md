# History Control：開發版轉移至 AMO Listed 正式版

**版本：1.1.0**

本文件用於將 Firefox `about:debugging` 載入的 Temporary Add-on，轉移至 Mozilla Add-ons（AMO）公開上架、已簽署的正式版本。

## 最重要的資料安全原則

- **在完成完整備份前，請勿按 Remove、解除安裝開發版，或清除 Firefox Profile。**
- 開發版與正式版的 Extension ID 均維持 `firefox-minimal-history@local-extension.example`。這有助 Firefox 識別相同擴充功能，但**不能保證**開發版卸載後仍保留 `storage.local`。
- Firefox 官方文件指出：解除安裝擴充功能時會清除對應的 `storage.local`。因此必須先將資料匯出成檔案。
- **Rules-only「匯出設定」不包括 Statistics；請使用「匯出完整備份」。**

## 階段 A：在目前的 Debug Profile 建立完整備份

1. 解壓縮 **History Control v1.1.0** 的 ZIP，將執行檔覆蓋到原來用於 `about:debugging` 的擴充功能資料夾。請勿刪除或重設 Firefox Profile。
2. 在 `about:debugging#/runtime/this-firefox` 找到目前載入的 History Control，按 **Reload**。核實顯示版本為 `1.1.0`。
3. 開啟 **Options → Export / Import → Full Backup**。
4. 按 **Export Full Backup／匯出完整備份**。
5. 確認下載資料夾存在一份 `history-control-full-backup-YYYY-MM-DD.json`。建議另外複製至安全位置。
6. 可用純文字編輯器確認檔案包含四個根欄位：`protectedSites`、`excludedHosts`、`hostEntryRules`、`dailyDeletionStatsV1`，以及 `format: history-control-full-backup`。不需要分享檔案內容。
7. 確認檔案已建立及可開啟後，才繼續下一階段。備份內包含私人網址，請妥善保管。

**注意：** 1.1.0 的 Export Rules 仍然只處理規則。只有 Full Backup 才包括每日清理統計。

## 階段 B：AMO Listed 發佈

1. 使用 Mozilla Account 登入 [Firefox Add-ons Developer Hub](https://addons.mozilla.org/developers/)。
2. 選擇 **Submit a New Add-on**，發佈方式選擇 **On this site（Listed）**，不是 On your own。
3. 上傳 `history-control-amo-listed-v1.1.0.zip`。ZIP 根目錄直接包含 `manifest.json`，沒有頂層資料夾。
4. 填寫公開資訊，可參考本套件的 `AMO_LISTING.md`。授權條款和支援聯絡方式須由發佈者自行決定，不能自動代選。
5. 本版本沒有壓縮或混淆 JavaScript。若審核流程要求額外提供原始碼，可上傳 `history-control-source-v1.1.0.zip`。
6. 提交並處理 AMO 的自動驗證、簽署和可能的人工審核。**未取得簽署前的 ZIP 不是可永久安裝的正式 XPI。**

## 階段 C：從已簽署的 AMO 安裝

1. **再次確認階段 A 的完整 JSON 備份存在。**
2. 從正式的 AMO 上架頁面安裝已簽署的 History Control。若 Firefox 表示原開發版與新安裝版本有衝突，必須先確認備份後，才移除 Temporary Add-on。
3. 在新安裝的 History Control 中開啟 **Options → Export / Import → Full Backup**。
4. 按 **選擇完整備份 JSON 檔案**，選取階段 A 下載的檔案。
5. 按 **Restore Full Backup／還原完整備份**，閱讀警告後確認。此操作會取代目前的三類規則及每日統計，但**不會執行 Clean Now**。
6. 逐項檢查 Protected URLs、Host Entry、No History 及 Statistics。確認規則數量及每日數據與備份一致。
7. 檢查無規則的網站不受影響。完成核對前，先不要執行不可復原的 **Clean Now**。

## 備份範圍

| 資料 | Full Backup | Rules-only Export |
|---|---|---|
| Protected URLs | 包括 | 包括 |
| No History Rules | 包括 | 包括 |
| Host Entry Rules | 包括 | 包括 |
| 每日 Auto Delete / Clean Now 統計 | **包括** | 不包括 |
| 真正的 Firefox Browsing History | 不包括 | 不包括 |
| Cookies、登入資料、Bookmarks | 不包括 | 不包括 |

只備份擴充功能自行儲存的設定與計數，不會匯出 Firefox 原生 History 資料庫。已刪除的 History 無法由備份還原。

## 如果資料沒有自動沿用

此情況可能由 Temporary Add-on 解除安裝時清除本機儲存造成。使用新的 **Restore Full Backup** 即可還原擴充功能設定和統計。請勿嘗試透過一般瀏覽器 History 清除來修復此問題。

## 與簽署有關的限制

本套件提供準備提交 AMO 的原始 ZIP 及原始碼 ZIP，但**未經 Mozilla 簽署，亦未在你的帳戶公開上架**。開發者必須在 AMO 帳戶完成正式提交及審核。
