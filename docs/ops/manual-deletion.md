# 記帳：人工處理刪除請求的紀錄流程

> 對應 CRM repo `docs/ops/restore-sop.md` §7-1 #4（「記帳：人工處理刪除時寫進庫外紀錄；之後若做『刪除我的資料』功能，再建紀錄表」）。
> 格式對齊 CRM repo `infra/server/restore/lib/ledger.mjs` 的 `ugomk-deletion-ledger/v1`（分支 `feat/deletion-ledger-gaps`，commit 713feb017）。
> 本文只寫流程與建議，**不改程式、不改 schema**。

## 1. 為什麼要記

記帳目前**沒有**「刪除帳號／家庭」功能，也沒有刪除紀錄表（2026-11-07 盤點）。使用者來要求刪除時是人工處理。

問題在備份：正式庫每天備份（R2 `subprojects/ledger/daily/…`，台北 02:40）。人工刪掉某個家庭之後，如果哪天要從**刪除之前**的備份還原，那個家庭的資料會整包復活，而且沒有人知道——重放工具 `replay-deletions.mjs --system ledger` 在記帳這邊沒有任何紀錄來源，只會回 0 筆＋缺口。

所以：**每處理完一件，當天把它寫進一份庫外紀錄檔**（不在記帳庫裡，庫整個壞掉也還在），還原時拿這份檔對照、人工重做。

## 2. 什麼時候要記

| 情況 | 要不要記 |
|---|---|
| 家庭擁有者要求刪除整個家庭（含所有成員、交易、帳戶、卡、負債、預算、目標…） | 要 |
| 某位成員要求刪除「自己的資料」（離開家庭、刪本人個人帳戶／卡／交易） | 要 |
| 使用者在 LIFF 自己刪交易／預算／目標／固定收支 | 不用（使用者自己的操作，不是個資刪除請求；還原後會復活是已知缺口，見 restore-sop §7） |
| 收到請求但最後沒有刪（身分無法確認、使用者撤回） | 不寫進紀錄檔（沒有東西要重刪）；留在客服紀錄 |

## 3. 紀錄檔格式（`ugomk-deletion-ledger/v1`）

一份紀錄檔是一個 JSON 物件，欄位與重放工具 export 出來的檔案完全相同，重放時可以直接當 `--ledger` 給：

```json
{
  "format": "ugomk-deletion-ledger/v1",
  "system": "ledger",
  "exported_at": "2026-11-20T03:12:00.000Z",
  "source": "manual",
  "since": "1970-01-01T00:00:00.000Z",
  "entries": [
    {
      "key": "ledger:manual:20261120-01",
      "system": "ledger",
      "kind": "ledger.family_erasure_manual",
      "requested_at": "2026-11-20T03:05:41.000Z",
      "status": "completed",
      "subject": { "familyId": "cmf0example00family01", "memberId": null, "method": "deleted" },
      "ref": { "ticket": "CS-20261118-03", "channel": "line_oa", "received_at": "2026-11-18T09:30:00.000Z", "handled_by": "shark" }
    }
  ],
  "gaps": []
}
```

### 3-1 檔案層欄位

| 欄位 | 填法 | 為什麼 |
|---|---|---|
| `format` | 固定 `ugomk-deletion-ledger/v1` | `validateLedger` 第一個檢查 |
| `system` | 固定 `ledger` | 重放 `--system ledger` 會檢查一致 |
| `exported_at` | 這一版檔案產生的時間（ISO UTC） | 合併多份時判斷涵蓋範圍、同 key 衝突取新的 |
| `source` | 固定 `manual` | 與每日自動匯出的檔（`(none：…)`）區分 |
| `since` | 固定 `1970-01-01T00:00:00.000Z` | 這份檔是**累積檔**（見 3-4），涵蓋從頭到 `exported_at` 的所有人工刪除；與每日檔（`--all`，也是 1970 起）合併時區間接得起來，不會被 `selectWindow` 判成斷層 |
| `entries` | 每處理完一件加一筆，**只加不改** | — |
| `gaps` | 空陣列 | 缺口由每日檔（`staticGaps`）帶，這份不重複寫 |

### 3-2 每一筆（entry）

| 欄位 | 填法 |
|---|---|
| `key` | `ledger:manual:<YYYYMMDD>-<NN>`（台北日期＋當天流水號，例 `ledger:manual:20261120-01`）。全檔唯一，重複會被 `validateLedger` 拒絕 |
| `system` | 固定 `ledger` |
| `kind` | `ledger.family_erasure_manual`（整個家庭）或 `ledger.member_erasure_manual`（單一成員的資料） |
| `requested_at` | **實際在正式庫刪除完成的時間**（ISO UTC），不是使用者提出的時間——見 3-3 |
| `status` | 固定 `completed`（只記已經刪完的） |
| `subject.familyId` | `Family.id`（cuid） |
| `subject.memberId` | `FamilyMember.id`（cuid）；整個家庭刪除時填 `null` |
| `subject.method` | `deleted`（刪除）／`anonymized`（去識別，例如交易保留但把成員名稱、戶名清掉）／`other`（其他，細節寫客服紀錄） |
| `ref.ticket` | 客服紀錄或事故紀錄的編號，用來回查細節 |
| `ref.channel` | 使用者從哪裡提出：`line_oa`／`email`／`phone`／`other` |
| `ref.received_at` | 使用者提出的時間（ISO UTC） |
| `ref.handled_by` | 處理人代碼（例 `shark`） |

**不放**：姓名、LINE 顯示名稱、LINE userId、電話、email、家庭名稱、家庭碼、交易內容、金額、備註。紀錄檔只放內部 id——與 CRM／SM 的 ledger 同一個規則。要知道是誰，用 `ref.ticket` 回客服紀錄查。

### 3-3 為什麼 `requested_at` 填「刪除完成時間」

重放工具選要重做哪些紀錄的規則是：`requested_at ≥ 備份時間 − overlap`（`ledger.mjs` `selectWindow`）。意思是「備份做完之後才發生的刪除，備份裡還有那些資料，要重刪」。

人工處理從使用者提出到真的刪掉可能隔好幾天（隱私權政策給 30 天）。如果填「提出時間」，遇到「提出 → 備份 → 才刪」的順序，那筆會因為早於備份被排除，資料就復活了。填「刪除完成時間」才對得上「備份裡有沒有那些資料」。提出時間另外記在 `ref.received_at`。

### 3-4 一份累積檔、每次新存一版

- 紀錄檔是**累積的**：每次新增一筆，拿上一版的完整內容加一筆，`exported_at` 改成現在，存成**新的物件**（舊物件不覆蓋、不刪）。所以永遠「最新一版就夠」，舊版是防最新那份壞掉。
- 已經上傳過的 entry **不要改**。真的記錯（例如 familyId 打錯）→ 新增一筆正確的（新的 `key`），舊那筆留著，在客服紀錄註明作廢。重放時多一筆錯 id 只會「已不在／對不到」，不會刪錯東西；改舊 entry 則會讓不同版本內容不一致（合併時會被列為 conflict）。

## 4. 每處理完一件的步驟（Shark）

前提：實際刪除已經在正式庫完成（刪除本身怎麼下 SQL 不在本文範圍；見第 6 節的注意事項）。

全部在**程式主機 root** 做（`backup.env`、GPG 密語、R2 金鑰都只在那台）。指令中不會印出任何密鑰；密語走 `gpg_encrypt` 的檔案描述元，不出現在指令列。

```bash
# 0) 載入共用函式與 R2 身分（與 restore-sop 4-2 相同）
. /opt/ugomk/infra/lib/common.sh; . /opt/ugomk/infra/backup-runner/lib-backup.sh
load_env /etc/ugomk/backup.env
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
umask 077; W=$(mktemp -d /root/ledger-manual.XXXXXX); cd "$W"

# 1) 取最新一版（第一次做、R2 上還沒有 manual/ 時跳過，直接從第 3 節的範本開始，entries 留空）
r2_ls deletion-ledger/ledger/manual/          # 看最新的檔名（時間戳最大的那個）
r2_get deletion-ledger/ledger/manual/<最新>.json.gpg ./prev.json.gpg && gpg_decrypt prev.json.gpg prev.json

# 2) 加一筆、改 exported_at → new.json（用編輯器或 jq；只加不改舊 entry）
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
jq --arg now "$NOW" --argjson e '<這一筆 entry 的 JSON>' '.exported_at = $now | .entries += [$e]' prev.json > new.json

# 3) 驗格式（用重放工具自己的檢查，不用肉眼）
node --input-type=module -e "
  import fs from 'node:fs'; import { validateLedger } from '/opt/ugomk/infra/restore/lib/ledger.mjs';
  const l = validateLedger(JSON.parse(fs.readFileSync('new.json','utf8')), 'ledger');
  console.log('ok', l.entries.length, '筆');"
#   （主機沒有 node 時，在 crm-api 映像裡跑：restore-sop 的 restore_node_run，或把 new.json 拿回本機用 CRM repo 的 ledger.mjs 驗）

# 4) 加密 → 上傳 → 確認物件在
KEY="deletion-ledger/ledger/manual/$(date -u +%Y%m%dT%H%M%SZ).json.gpg"
gpg_encrypt new.json new.json.gpg && r2_put new.json.gpg "$KEY" && r2_ls "$KEY"

# 5) 清掉明文與暫存
cd / && rm -rf "$W"
```

### 4-1 存放位置

| 項目 | 值 |
|---|---|
| R2 前綴 | `deletion-ledger/ledger/manual/` |
| 檔名 | `<上傳時間 UTC，YYYYMMDDTHHMMSSZ>.json.gpg`，每次新檔，不覆蓋 |
| 為什麼放 `manual/` 子目錄 | 同一個 `deletion-ledger/ledger/` 下，每日 03:10 的 `deletion-ledger.sh` 會寫 `YYYY-MM-DD.json.gpg`（記帳 0 筆＋缺口）。人工檔放子目錄才不會跟它撞名或被誤當成每日檔 |
| 誰上傳 | Shark（主機 root）。agent 不碰 R2 與正式主機 |

### 4-2 加密方式

與每日備份、每日刪除紀錄**同一把**：GPG 對稱 AES256，密語是 `/etc/ugomk/backup.env` 的 `BACKUP_GPG_PASSPHRASE`（`lib-backup.sh` 的 `gpg_encrypt`／`gpg_decrypt`，密語走 fd 3，不進指令列、不進 shell 歷史）。還原時不必多管一把鑰匙。

明文 `prev.json`／`new.json` 只存在 `umask 077` 的暫存目錄，上傳完立刻刪。**不要**把明文寄信、貼聊天、放 repo。

## 5. 還原時怎麼用

照 restore-sop 5-1-3／5-1-6，記帳的 replay 多給這份：

```bash
# 程式主機 root，同第 4 節第 0 步載入身分
r2_get deletion-ledger/ledger/manual/<最新>.json.gpg ./ledger-manual.json.gpg && gpg_decrypt ledger-manual.json.gpg ledger-manual.json && rm -f ledger-manual.json.gpg
# replay --system ledger 加 --ledger /replay/ledger-manual.json（可與每日檔 deletion-ledger/ledger/YYYY-MM-DD.json 一起給，工具會合併）
```

- 重放工具在記帳這邊**不會自動刪任何東西**（`systems.mjs` 的 `ledger.planEntry` 對所有種類都回 unresolved）。dry-run 會把每一筆列成「無法重放」、結束碼 3——這就是要的效果：清單出來了。
- 報告只印 `kind`，看不到 familyId／memberId。要逐筆照**解密後的紀錄檔**（`subject`）在隔離庫重做同樣的刪除，做完核對（`SELECT count(*) FROM "Family" WHERE id = '<familyId>'` 等於 0），再跑一次加 `--ack-gaps`。
- 紀錄檔最新一版的 `exported_at` 之後才處理的刪除不在檔裡：對照客服紀錄補。

## 6. 人工刪除時的注意（給做刪除的人）

這一節不是刪除 SQL，只列已知會卡住或會漏的地方。實際 SQL 先在演練庫跑過、Shark 核可才動正式庫。

- **`AuditLog` 刪不掉也不用刪**：資料庫有 trigger 擋 `UPDATE`／`DELETE`／`TRUNCATE`（`ensureAuditAppendOnly`），表也沒有外鍵到家庭。裡面只有 id、欄位名、列舉值、筆數（`services/audit.ts` 擋原文），刪家庭後留著的是「某個已不存在的 id 曾被操作過」。對使用者的回覆照實說「操作稽核紀錄只含內部編號，依稽核需要保留」。
- **外鍵有 Restrict**：`Account`／`CreditCard`／`Liability` 的 `ownerMemberId`、`Transfer` 的帳戶／卡／負債、`Transaction.memberId`、`Transfer.memberId` 都是 Restrict（或必填關聯預設 Restrict）。只刪一位成員會被擋；刪整個家庭靠 `Family` 的 cascade，但 cascade 與 Restrict 混在一起時順序可能卡住——先在演練庫試，必要時照「轉帳 → 交易 → 帳戶／卡／負債 → 成員 → 家庭」的順序在同一個交易裡刪。
- **加密欄位**：`FamilyMember.legalNameEnc` 是應用層加密的戶名，跟著成員列一起刪即可，不需要解密。
- **庫外的東西**：LINE OA 聊天紀錄在 LINE 平台、送 AI 解析的內容在 Gemini 端，都不在記帳庫，也不在這份紀錄的範圍；需要時照隱私權政策說明回覆。

## 7. 未來做「刪除我的資料」功能時的紀錄表（建議，不實作）

做了自助刪除功能之後，紀錄要在**刪除的同一個交易**裡寫進庫內表（才不會刪了沒記），每日 03:10 的 `deletion-ledger.sh` 再把它匯出到 R2——跟 SM 的 `deletion_requests` 同一套做法。屆時這份人工紀錄檔可以停用（舊的保留）。

### 7-1 建議 schema

```prisma
// 刪除請求紀錄（只加不改；與 AuditLog 一樣由 ensureAuditAppendOnly 類的 trigger 擋 UPDATE/DELETE）
// 不掛外鍵：被刪的家庭／成員消失後紀錄要留著。detail 只放 id 與筆數，不放姓名、內容、金額。
model DeletionRequest {
  id               String    @id @default(cuid())
  confirmationCode String    @unique // 回給使用者的確認碼（查狀態用，不洩漏其他資料）
  scope            String    // family | member
  familyId         String    // 被刪的家庭（scope=member 時是成員所屬家庭）
  memberId         String?   // scope=member 才有
  method           String    @default("deleted") // deleted | anonymized
  source           String    // liff_self | manual
  actorMemberId    String?   // 誰按的（本人）；manual＝null
  status           String    @default("completed") // received | completed
  detail           Json?     // { counts: { transactions: n, accounts: n, ... } }
  createdAt        DateTime  @default(now()) // 與刪除同一個交易＝刪除當下
  completedAt      DateTime?

  @@index([familyId])
  @@index([createdAt])
  @@map("deletion_requests")
}
```

- 表名用 `@@map("deletion_requests")` 跟 SM 一致，重放工具好認。
- `createdAt` 在同一個交易寫，等於刪除當下——第 3-3 節講的時間問題自動解掉。
- `familyId`／`memberId` 是獨立欄位（不是塞在 detail），匯出時不必解 JSON。
- 加表走「只加不改」（記帳開機 `prisma db push` 不帶 `--accept-data-loss`，加新表是安全的；見 `docs/deploy/rollback.md` 的回退注意）。

### 7-2 重放工具要跟著改的地方（CRM repo，不在本 repo）

`infra/server/restore/lib/systems.mjs` 的 `ledger`：

- 拿掉 `noSource`，`exportEntries` 讀 `public.deletion_requests`（`createdAt >= since`），對成 `ledger.family_erasure`／`ledger.member_erasure`，subject 帶 `familyId`／`memberId`。
- `planEntry`／`applyEntry`：`ledger.family_erasure` 可以自動重放（照第 6 節的順序刪該 familyId，限「建立時間 ≤ 受理時間」）；`ledger.member_erasure` 牽涉共同帳戶與交易歸屬，建議先維持「需人工」。
- 人工紀錄檔的 `ledger.*_manual` 種類維持「需人工」。
- `staticGaps` 改成只剩「功能上線前人工處理的，看 `deletion-ledger/ledger/manual/`」。

## 8. 相關

- CRM repo `docs/ops/restore-sop.md` §5-1-3、§5-1-6、§7、§7-1 #4
- CRM repo `infra/server/restore/lib/ledger.mjs`（格式、`validateLedger`、`mergeLedgers`、`selectWindow`）
- CRM repo `infra/server/restore/lib/systems.mjs`（`ledger` 目前不自動重放）
- CRM repo `infra/server/backup-runner/deletion-ledger.sh`（每日 03:10 的庫外紀錄）
