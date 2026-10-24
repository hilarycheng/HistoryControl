# History Control 1.1.0 — Mozilla Add-ons Listed candidate

**Distribution:** Firefox Add-ons **Listed（公開上架）**，而不是 Unlisted。

**GitHub Repository:** https://github.com/hilarycheng/HistoryControl

本版在 v1.0.9 的功能上新增：
- **Full Backup：** 匯出完整的 Protected URLs、No History、Host Entry 及每日清理統計。
- **Restore Full Backup：** 從本機 JSON 還原上述資料；此操作不會執行 Clean Now。
- **正式 App Icon：** 已加入獨立的 48、96、128px PNG 品牌圖示，供 Firefox 擴充功能管理頁及 Mozilla Add-ons Listing 使用。Toolbar 原有的灰色／綠色／紅色狀態 SVG 不變。
- **發佈包分離：** AMO ZIP 只包含 Extension 執行檔；Source ZIP 包含相同原始碼、測試及審核文件。
- **資料相容：** Mozilla AMO 已封存第一次提交的 Extension ID，本次使用新 ID；`storage.local` Key 和清理邏輯不變。正式版支援還原舊 Debug ID 匯出的 Full Backup。

此套件可提交 Mozilla 的 Listed 上架流程，但**未經簽署，未獲審核，也尚未公開發佈**。必須由發佈者在 [AMO Developer Hub](https://addons.mozilla.org/developers/) 完成提交，才會取得正式安裝版本。

請先閱讀：
- `MIGRATION.md`：保留目前 Debug 版 Rules / Statistics 的步驟。
- `AMO_LISTING.md`：英文及繁體中文的公開上架說明。
- `REVIEWER_NOTES.md`：權限、測試方式及 Mozilla 審核備註。
- `PRIVACY.md`：資料處理及本機備份說明。

## 安全轉移三步驟

1. **在 Debug 版中先 Reload v1.1.0，使用 Export Full Backup，並確認 JSON 已下載。**
2. 使用 AMO Listed 方式提交發佈 ZIP，取得 Mozilla 已簽署的正式版本。
3. 在正式版安裝後使用 Restore Full Backup，核對 Rules 及 Statistics，再使用其他 History 清理功能。

**重要：** Debug 和正式版 ID 不同，設定不會自動共用。請先在舊 ID 的 Debug 版匯出完整備份，再安裝新 ID 正式版並還原；解除安裝 Temporary Add-on 可能清除其 `storage.local`。

## 既有功能

- Exact / Prefix Protected URL，Keep Entry Only / Keep All Matched URLs。
- Keep Host Entry Only，含可選子網域。
- No History Hostname 規則，含可選子網域。
- Auto Delete、Clean Now、History Explorer、Minimum URL Count、每日 Statistics。
- Toolbar Popup、Options 左側導覽、繁體中文正式書面語／English Locale。
- 所有未套用規則的網站，其 History 不受影響。

Firefox 仍會先建立 History 紀錄，再由 Extension 刪除，不能保證零寫入。已刪除的 History 無法復原。

## 測試

```bash
node --test tests/*.test.js
```

自動化測試採用模擬 Firefox API。未在真實 Firefox 或 AMO 審核環境完成整合測試，因此不能保證 Mozilla 最終接受上架。

## 本次更新：新 AMO Extension ID

- 新 ID：`{d573c284-f17e-4a66-9834-2cbf0477d960}`。原 Debug ID：`firefox-minimal-history@local-extension.example`。
- 因第一次 AMO 提交已被刪除，新上架需要使用新的 ID。
- Full Backup 還原支援以上兩個 ID，不會接納不相關 Extension 的備份。
- 請保留此新 ID 供未來 AMO 更新使用，勿再次變更。
