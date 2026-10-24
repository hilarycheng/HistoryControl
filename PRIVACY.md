# History Control — Privacy Notice / 隱私說明

## English

History Control processes Firefox browsing-history entries locally in the browser to apply rules defined by the user. It stores protected URL rules, hostname rules, and daily aggregate deletion counts in Firefox `storage.local`.

The extension does not transmit browsing history, saved URLs, usage statistics, or other personal data to an external service. It does not use remote analytics or tracking code. It does not require an account.

The History Explorer reads existing local browser history without uploading it. Automatic cleanup and Clean Now remove local browsing-history entries according to user-configured rules. Removed Firefox history cannot be recovered by the extension.

The optional Export and Full Backup features download JSON files to the user's device. Such files can contain private URLs and are managed by the user. Import reads only a JSON file the user selects.

Uninstalling the add-on may remove data stored in `storage.local`. Users should export a Full Backup before uninstalling or moving between development and signed installations.

## 繁體中文（正式書面語）

History Control 只在 Firefox 瀏覽器本機處理瀏覽紀錄，並按照使用者自行建立的規則執行清理。受保護網址、主機名稱規則及每日刪除次數統計會儲存在 Firefox `storage.local`。

擴充功能不會將瀏覽紀錄、已儲存網址或統計資料傳送至外部服務，亦不包含遠端分析或追蹤程式，不需要使用者帳戶。

History Explorer 只讀取本機 History。自動清理及「立即清理」會依據規則刪除本機瀏覽紀錄；擴充功能無法復原已刪除的紀錄。

匯出與完整備份功能只會在使用者要求時，將 JSON 檔案下載至本機。備份可能包含私人網址，使用者應自行妥善保管。匯入功能只讀取使用者主動選取的 JSON 檔案。

解除安裝擴充功能時，Firefox 可能清除其 `storage.local`。解除安裝或由開發版轉移至已簽署的正式版之前，請先匯出完整備份。
