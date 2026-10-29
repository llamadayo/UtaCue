# UtaCue for Safari：iPhone 第一版

此版本把同一份歌單解析器與資料格式用於 Chrome 側邊欄和 Safari 彈出面板。Safari 版的播放控制執行於 **Safari 裡的 YouTube 網頁**。目前交付的是 Web Extension 程式碼、ZIP 打包與 Xcode 專案產生工具；尚未簽署、上架或完成 iPhone 真機驗收。

## 功能範圍

- 掃描 `www.youtube.com`／`m.youtube.com` 目前已載入的說明欄與留言。
- 手動貼上時間軸、切換來源與主要／附加區塊。
- 點選歌曲跳播、在前景循環指定起訖時間。
- 編輯曲名、起點、終點、類型，重新掃描保留人工修改。
- 沿用桌面版 `schemaVersion: 1` JSON，本機儲存與匯入／匯出。
- 手機用彈出面板、44px 觸控按鈕、16px 文字輸入、安全邊界及鍵盤高度適配。

第一版沒有額外的頁內歌單 UI。選歌後收起 Safari 面板，即可回到影片；循環設定已經存於該頁的 content script，不需要面板持續開啟。重新開啟面板會讀取頁面目前的選歌與循環狀態，不會重新播放或重設循環。

## 產生 Safari 檔案

使用 Node.js 18 或更新版本。沒有 npm 執行期相依套件，也不需要 `npm install`。

```sh
npm test
npm run build:safari
npm run package:safari
```

輸出：

- `dist/safari/`：只包含執行所需的 extension 檔案。
- `dist/UtaCue-safari-0.2.0.zip`：根目錄即有 `manifest.json`，可交給 Apple 的打包工具。

Safari manifest 由根目錄的 Chrome manifest 產生：移除 `sidePanel`、`side_panel`、Chrome 最低版本及不需要的 background worker，改用 `action.default_popup`。設定的 Safari 最低版本為 16.4；這是開發相容性基線，並非所有裝置已經實測的宣告。

Chrome 仍可直接載入專案根目錄，或使用 `npm run build:chrome` 產生單獨目錄。兩者使用同一份 core／UI／storage 程式。

## 方法 A：在 Mac 用 Xcode 安裝測試

先安裝完整 Xcode，確認命令列工具指向該版本。在這份分支的專案目錄執行：

```sh
npm run xcode:ios -- --bundle-id dev.llamadayo.utacue
```

這個指令會：

1. 重新產生 `dist/safari`。
2. 找到 Xcode 的 `safari-web-extension-packager`；舊版 Xcode 則使用 `safari-web-extension-converter`。
3. 產生含 App 與 Safari extension 的 iOS Swift 專案，並複製執行檔案至 `build/ios/`。

`dev.llamadayo.utacue` 是預設識別碼，可改為你的開發者帳號可使用的 Bundle ID。指令不會選擇簽署帳號、上傳 App Store Connect 或發布 App。

接著：

1. 在 Xcode 開啟 `build/ios/` 下產生的 `.xcodeproj`。
2. 在 App 和 Extension targets 的 Signing & Capabilities 選擇自己的 Team，處理 Xcode 顯示的簽署需求。
3. 確認兩個 targets 的 iOS Deployment Target 為 16.4 或更新。
4. 選擇連接的 iPhone，執行 containing app。
5. 在 Safari 的延伸功能設定啟用 UtaCue，允許讀取 YouTube 網站；在手機版與桌面版網域都使用時，要分別確認網站權限。
6. 用 Safari 開啟 YouTube 影片並重新整理，從 Safari 延伸功能選單開啟 UtaCue。

輸出目錄已存在時，腳本會停止，避免蓋掉已設定簽署的專案。需重新產生時，可選另一個目錄：

```sh
npm run xcode:ios -- --output build/ios-next --bundle-id dev.llamadayo.utacue
```

由於採 `--copy-resources`，之後修改原始碼不會自動更新先前 Xcode 專案內的複本。開發期間須同步新的 `dist/safari/` 資源，或產生新的專案，並重新建置到裝置。

## 方法 B：Apple 線上打包與 TestFlight

已有 Apple Developer Program 帳號時，可在 App Store Connect 使用 Safari Web Extension Packager，上傳 `dist/UtaCue-safari-0.2.0.zip`，依 Apple 流程建立 app record、打包與分發 TestFlight。這個流程不需要本機 Xcode，但仍需要你的 Apple 開發者帳號及平台提供的簽署／分發流程。

ZIP 是 extension 原始資源包，**不是可直接點開安裝到 iPhone 的 IPA**。

## 實際使用

1. 在 Safari 播放一部 YouTube 歌枠。首次播放先點一下 YouTube 的播放按鈕。
2. 展開說明欄或留言，讓包含時間戳的文字真正載入頁面。
3. 開啟 UtaCue，按「掃描目前頁面」。掃描只讀取已載入內容，不會自動下載全部留言。
4. 沒有可用時間戳時，使用「貼上時間軸」。
5. 點歌後收起面板。若 Safari 阻擋程式播放，面板會提示先點影片播放；選歌與循環設定仍保留在頁面。
6. 再開面板可切換循環、前後首、修改起訖時間，或使用「目前播放時間」填入終點。

資料保存在各瀏覽器的本機 extension storage。Chrome 與 iPhone 不會自動同步；使用 JSON 交換資料。

## JSON 備份

手機支援 Web Share 檔案分享時，匯出會開啟系統分享選單，可選「儲存到檔案」；不支援時改用一般下載。使用者取消分享會顯示取消，不會偷偷再下載。選單與檔案選取器在 Safari extension popup 裡的行為仍須在目標 iPhone 確認。

匯入前會檢查 schema、時間、來源與區塊關係、重複影片／項目識別碼等資料。相同影片的備份經確認後取代該影片的本機歌單，其他影片保留。格式錯誤不會開始寫入；儲存額度不足會顯示失敗。

單份備份上限為 5 MiB，匯入與匯出一致。全部歌單超過時請逐部影片匯出。即使單檔未超過上限，瀏覽器剩餘儲存額度不足仍可能拒絕匯入。

## 真機驗收步驟

先選一部可播放、超過 30 秒的普通影片，使用手動時間軸獨立驗證播放器：

```text
00:05 測試歌曲 A
00:12 測試歌曲 B
00:20 測試段落
```

| 操作 | 預期結果 |
| --- | --- |
| 先點影片播放，再貼上測試時間軸 | 出現三項且可選歌 |
| 選 A，循環開啟，收起面板 | 影片前景播放到約 12 秒後回到約 5 秒 |
| 影片緩衝期間選 B 並立即收起面板 | 播放恢復後仍循環 B；設定不依賴 popup 的第二次命令 |
| 再開 UtaCue | 選歌、循環與播放／暫停顯示符合頁面實際狀態 |
| 關循環、暫停後拖曳至區段終點 | 不強迫開始播放或跳回 |
| 編輯 A 的起點至 00:08、自訂終點至 00:11 | 新範圍生效，存檔後可重新讀取 |
| 重新貼上／掃描同一來源 | 不產生重複區塊，人工修改保留 |
| 將正在循環的歌曲改為註記 | 舊歌曲循環停止 |
| 由 YouTube 首頁進入影片，再切到另一部影片 | 能連線；上一部歌單與循環不會套到新片 |
| 同時開兩個 YouTube 分頁 | 另一分頁的訊息不改變目前面板內容 |
| 展開實際歌枠說明與留言，掃描 | 可選擇掃描到的來源；未載入的留言不會被宣稱已掃描 |
| 匯出→儲存到檔案→匯入 | 曲名、分類、起訖與手改內容保持一致 |
| 匯入其他影片的備份 | 不干擾當前影片循環 |
| 開啟鍵盤、橫向、較小螢幕 | 對話框可捲動，儲存／取消與時間輸入可操作 |
| 播放廣告或在影片切換期間操作 | 顯示等待／不可操作，不把廣告時長套入歌曲 |

測試時記錄 iPhone 型號、iOS 版本、YouTube 網域、影片網址及操作步驟。這些項目尚未在真實 iPhone 上完成驗收；Node 測試使用 DOM／播放器／extension API 替身，只驗證程式邏輯與協定。

## 邊界與實作備註

- Safari popup 控制 Safari 網頁，不能接管 YouTube 原生 App。
- 僅以前景播放為目標。鎖屏、切 App、切背景分頁會受 iOS 暫停與計時器限制影響，不保證背景循環。
- 循環透過播放器跳轉完成，不是音訊級無縫循環；串流、緩衝及播放器會影響邊界精度。
- 沒有有限片長的直播不能循環。`/live/`、`/shorts/` 可辨識影片 ID，但第一版主要驗收普通 `/watch` 影片，其他版型不保證能掃到相同內容。
- 刷新／關閉影片頁會結束該頁的循環 session；歌單仍在本機儲存，重新選歌即可開始。
- YouTube 的手機 DOM 或播放器換片事件若改變，需更新 `content.js` 的適配。廣告、SPA 換片及檔案分享流程必須納入真機驗收。
- 選歌及循環設定是單次 `PLAYER_COMMAND`；`GET_PLAYBACK_STATE` 提供 `loop` 和 `selectedEntryId`，popup 重開只讀取，不重設。
- 本版未加入下載影音、背景音訊、API key、後端服務或雲端同步。

## Apple 官方參考

- [Safari Web Extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions)
- [Packaging a web extension for Safari](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
- [Packaging and distributing with App Store Connect](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect)
- [Assessing browser compatibility](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility)
- [Running your Safari web extension](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)
