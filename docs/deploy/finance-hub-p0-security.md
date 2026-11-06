# 財務中樞 P0 資安（P0-2 遮罩、P0-3 欄位加密、P0-4 稽核）上線說明

分支 `feat/finance-hub-p0-security`（基底 `feat/finance-hub-p1-batch3` c834706）。P2 無腦丟件開工前必須先上線。

## 1. 主機要新增的 env（server 服務；web 不用）

| env | 必填 | 內容 |
|---|---|---|
| `LEDGER_FIELD_KEY` | 要用「登記帳單戶名」等敏感欄位時必填 | 32 bytes 隨機金鑰，64 個 hex 字元（或 base64／base64url）。產生：`openssl rand -hex 32` |
| `LEDGER_FIELD_KEY_VERSION` | 選填，預設 `1` | 目前金鑰的版本號（正整數）。第一次上線用 1 |
| `LEDGER_FIELD_KEYS_OLD` | 平常不設 | 只在輪替期間設：`1:<舊金鑰>`（多把用逗號）。重加密完就拿掉 |

- 金鑰放部署平台的秘密管理（GCP app-tw1：主機 env 檔，root 600；不要進 repo、不要進資料庫、不要貼到聊天或 log）。
- **另外離線備份一份**（例如密碼管理器）。遺失＝所有已登記的帳單戶名永遠解不開（只能請家人重新登記）。
  - **記下指紋並核對**：上線後打 `/health`，把 `fieldKeyFingerprint`（金鑰 sha256 的前 8 碼，推不回金鑰）抄進備份那一筆的備註。
    再用備份的金鑰在本機跑 `node server/dist/scripts/field-key-fingerprint.js`，貼上金鑰按 Enter（從標準輸入讀，不進 shell 歷史），
    印出的 8 碼要跟 `/health` 一樣——不一樣＝備份的不是線上那把，當場重備份。每次換金鑰（輪替、搬主機）都要再核對一次。
- **搬主機必須帶同一把金鑰**（和 CRM 的 `PII_ENCRYPTION_KEY` 同一個道理）。
- 不設也能開機：記帳、報表全部照常；只有「登記帳單戶名」回 503（fail-closed，不會改存明文）。
  開機 log 會有一行 `field encryption key unavailable`；`/health` 的 `fieldKey` 是 `false`。
- **開機自我檢查**：資料庫裡已經有密文時，開機會用目前的金鑰試解（每個金鑰版本一筆）。解不開＝部署的金鑰不是當初寫入的那把
  （貼錯、搬主機沒帶到、輪替時漏設 `LEDGER_FIELD_KEYS_OLD`）→ log 一行 error `field key self-check failed`，`/health` 回
  `fieldKeyMismatch: true`。不擋開機，但這時登記、查看帳單戶名都會失敗，要立刻換回正確的金鑰。
  `fieldKeyMismatch` 是 `null`＝還沒檢查完或金鑰不可用（看 `fieldKey`）；`false`＝試解成功或資料庫還沒有密文。
- 不用新增 Gemini 相關 env；遮罩在程式裡。

## 2. 上線注意事項

1. **schema 只加不改**：新表 `AuditLog`（預期 SQL：`finance-hub-p0-security-expected-db-push.sql`）。開機 db push 不會觸發資料遺失警告。
2. **開機會建 trigger**：`ensureAuditAppendOnly()` 在資料庫建 `ledger_audit_log_append_only()` 函式與兩個 trigger，
   擋掉對 `AuditLog` 的 UPDATE／DELETE／TRUNCATE。上線後看 log 有 `audit log append-only trigger ensured`；
   若是 `setup failed`（資料庫帳號沒有 CREATE FUNCTION 權限），功能照常，只剩程式層防線，要請 deploy-ops 用擁有者帳號手動跑檔尾 SQL。
   之後真的要清稽核紀錄（例如法遵保存期限到了）要由擁有者帳號先 `ALTER TABLE "AuditLog" DISABLE TRIGGER ...`，不是程式能做的事。
3. **server 與 web 可分開換**：web 只多了全貌頁最下面的「帳單戶名」「存取紀錄」，打的是新 API；
   舊 server 會回 404 → 畫面顯示載入失敗，不影響其他頁。建議同一窗一起換。
4. **回退**：回 c834706 以前的映像要 `SKIP_DB_PUSH=1`（舊 schema 會想刪 `AuditLog` 表）。舊程式不讀 `AuditLog`、不讀 `legalNameEnc`，
   回退不會壞也不會改數字；trigger 與函式留著無害。回退期間的操作不會有稽核紀錄。
5. **Gemini 送出內容變了**：所有文字段落（含 prompt 裡的家庭帳戶名稱清單）都會先遮罩；收據照片、PDF 帳單原檔仍照原樣送出
   （照片沒辦法先遮，PDF 要等 P2-5 先抽文字）。這點仍靠 Gemini 付費層條款（Shark 待辦 S1）。
   log 每次送出多兩行 `gemini request (masked)`／`gemini response`，只有長度、命中數、二進位大小，沒有原文。
6. **log 遮蔽**：`password`、`pdfPassword`、`legalName`、`idNumber`、`idToken`、`authorization`、金鑰等欄位名稱在任何一層都會被換成 `[已遮蔽]`。
7. **smoke test（部署後先跑，任一項不對就回退或修 env）**：
   - `curl https://<server>/health`：`fieldKey` 是 `true`、`fieldKeyMismatch` **不是** `true`（`false` 或還沒檢查完的 `null`；幾秒後再打一次應為 `false`）、
     `fieldKeyFingerprint` 跟離線備份的指紋一樣。
   - server log 有一行 `audit log append-only trigger ensured`（沒有的話看第 2 點）。
8. 上線後驗收（兩支手機）：
   - Apple 開「全貌」→ 最下面「帳單戶名」登記自己的名字 → 只顯示遮罩（王＊明）。
   - Shark 開「記帳簿」交易列表（要有 Apple 個人帳戶、可見範圍＝全家看明細的交易）→ Apple 的「存取紀錄 → 誰看過我的」出現一行。
   - LINE 對任一筆記帳按「刪除」→「全家紀錄」出現，來源顯示 LINE。

## 3. 金鑰輪替

1. 產新金鑰。env 改成：`LEDGER_FIELD_KEY=<新>`、`LEDGER_FIELD_KEY_VERSION=2`、`LEDGER_FIELD_KEYS_OLD=1:<舊>`，重啟 server。
   （此時新寫入用 v2，舊的 v1 密文仍可讀。）
2. 容器內：`node server/dist/scripts/rotate-field-key.js --dry-run`（只輸出數量）→ 確認 `needed` 數字。
3. `node server/dist/scripts/rotate-field-key.js` → `rotated` 應等於 `needed`、`failed`＝0；每一列都會寫一筆 `FIELD_KEY_ROTATE` 稽核。
4. 再跑一次 `--dry-run`，`needed`＝0 才可以把 `LEDGER_FIELD_KEYS_OLD` 拿掉、重啟。舊金鑰仍離線保存一段時間（還原舊備份時要用）。

## 4. 稽核記了什麼

| 動作 | 什麼時候記 | 失敗時 |
|---|---|---|
| `VIEW_PERSONAL` | 看到別人個人帳戶／卡／負債的明細：交易列表、轉帳列表、負債攤還表與繳款、卡帳單（同人同畫面 10 分鐘記一次）、匯出（每次） | 盡力寫，失敗只記錯誤 |
| `EXPORT_CSV` | 每次匯出 | **寫不進去就不給檔（503）** |
| `EDIT`／`DELETE` 交易 | LIFF 改／刪、改帳戶；LINE 快速修正（刪除、改共同／個人、改分類） | **跟資料同一個交易**，稽核失敗資料也不改 |
| `PERMISSION_CHANGE`／`EDIT` | 帳戶、卡、負債的修改（歸屬或可見範圍有變＝權限變更） | 盡力寫 |
| `UNDO`／`EDIT`／`CONFIRM`／`REJECT` 轉帳 | LIFF 與 LINE 確認卡的撤銷、改金額／改帳戶、對方確認／拒絕 | 盡力寫 |
| `DELETE` | 固定收支、儲蓄目標刪除 | 盡力寫 |
| `MEMBER_JOIN` | 有人用家庭碼加入 | 盡力寫 |
| `LEGAL_NAME_SET`／`CLEAR` | 登記、清除帳單戶名 | **跟資料同一個交易** |
| `FIELD_KEY_ROTATE` | 金鑰輪替重加密 | 跟資料同一個交易 |

`detail` 只放 id、欄位名稱、列舉值、筆數、月份（刪交易時留金額與日期）；備註、姓名、密碼不會進去（程式會擋）。

LIFF「全貌」最下面「存取紀錄」：
- **誰看過我的**：別人對我的個人帳戶做的事。
- **全家紀錄**：共同帳務的紀錄＋我做的＋關於我的；別人對他自己個人帳戶的操作不給其他人看（避免從紀錄反推 OWNER_ONLY 帳戶的活動）。
