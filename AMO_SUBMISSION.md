# 提交 Mozilla AMO Listed 版本

1. 登入 [Mozilla Add-ons Developer Hub](https://addons.mozilla.org/developers/)，選擇 **Submit a New Add-on**。
2. 發佈方式選 **On this site（Listed）**，不是 Unlisted。
3. 上傳 `history-control-amo-listed-v1.1.0.zip`；此檔案沒有 Top-Level Folder，`manifest.json` 位於 ZIP 根目錄，並已包含 48／96／128px App Icon。
4. 如審核表單要求額外的 Source Code，提供 `history-control-source-v1.1.0.zip`。本版沒有 minification / bundling / obfuscation，不需要建置程序。
5. 參考 `AMO_LISTING.md` 填寫公開名稱、簡介、詳細說明與本地化內容。授權條款、公開支援聯絡方式及上架網址必須由發佈者自行決定。
6. 依實際資料行為填寫隱私與權限問卷。程式只在本機處理 History，`manifest.json` 已宣告無資料傳輸（`data_collection_permissions: none`）。
7. 在 AMO 檢查自動驗證結果並提交審核。獲批准及簽署後，才可將其視為正式可安裝版本。
8. **轉移現有 Debug 版時先完成 Full Backup。** 詳細流程見 `MIGRATION.md`。

本資料夾不包含由 Mozilla 簽署的 XPI，也未代使用者登入帳戶或提交上架。
