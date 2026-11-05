# 記帳 server 回退（schema 有變的版本）

## 為什麼不能直接換回舊標籤

server 開機會跑 `prisma db push`（不帶 `--accept-data-loss`）。新版加了欄位／表之後，舊映像的 db push
會想把它們刪掉 → 有資料就拒絕 → 容器起不來（restart 迴圈）。所以「換回舊標籤」必須同時**不跑 db push**。

## 怎麼做

| 回退目標映像 | 跳過 db push 的方式 |
|---|---|
| 含 `scripts/start-server.sh` 的映像（chore/ledger-safe-rollback 之後） | env `SKIP_DB_PUSH=1`，或下面的 command 覆寫 |
| 更舊的映像（6b98a025、55842f59、e5fa2f25…，CMD 是 `sh -c "npx prisma db push … && node …"`） | compose `command: ["node", "server/dist/index.js"]` 覆寫 |

command 覆寫對新舊映像都有效（基底 node 映像的 entrypoint `docker-entrypoint.sh` 會照樣 exec），
主機 `ledger-deploy.sh` 回退時一律用 compose override 檔帶這個 command，不改正式 compose 檔。

## 回退前檢查（舊程式讀新資料會不會壞）

舊 Prisma client 只選它認得的欄位，多出來的欄位／表不影響。會壞的只有：

1. **新 enum 值**：新版寫進 `Account.type` 的 `TIME_DEPOSIT／SECURITIES／INVESTMENT／CRYPTO`，舊 client 讀到會丟錯（整個帳戶清單 500）。
   回退前：`SELECT type, count(*) FROM "Account" WHERE type::text IN ('TIME_DEPOSIT','SECURITIES','INVESTMENT','CRYPTO') GROUP BY 1;` 要 0 列。
2. **DROP NOT NULL（P1-4 起）**：新版若把某欄改成可空並寫了 NULL，舊 client 讀到 NULL 會丟錯。回退前查那些欄位 `IS NULL` 的筆數要 0。
3. **新外鍵**（`Account/CreditCard.ownerMemberId` → FamilyMember，ON DELETE RESTRICT）：舊程式刪除被指為擁有者的成員會失敗（少見）。

### 第 3 批（P1-5／6／7：文字轉帳 D18、文字記帳補強、淨資產快照）多出來的檢查

schema 只加不改（`Transaction.recordedByMemberId`、`Transfer.confirmStatus` 等 6 欄、`NetWorthSnapshot` 表、2 個新 enum，
新 enum 只出現在新欄位上，舊 client 不讀）。舊程式不會壞，但**數字會不一樣**：

4. **待對方確認的轉帳（D18）**：第 2 批以前的程式不認得 `confirmStatus`，會把「待確認／對方拒絕／只算一邊」的轉帳兩端都算進餘額。
   回退前查：`SELECT "confirmStatus", count(*) FROM "Transfer" WHERE "confirmStatus" <> 'CONFIRMED' AND "undoneAt" IS NULL GROUP BY 1;`
   有的話先處理：`PENDING`／`REJECTED` → 標撤銷（`UPDATE "Transfer" SET "undoneAt"=now() WHERE "confirmStatus" IN ('PENDING','REJECTED') AND "undoneAt" IS NULL;`）；
   `ONE_SIDED` 要請建立者決定（舊版只能兩端都算或整筆撤銷）。往前再部署回第 3 批時，這些標撤銷的不會自動恢復。
5. **代墊公司費用**：第 3 批起家庭支出、分類、預算、分帳不算 `bookTo=BUSINESS`；回退後舊程式會把它們算回家庭支出（資料沒變，只是報表不同）。
6. 淨資產快照表舊程式不讀，留著無害；回退期間每月 1 號不會存快照，往前部署後可在「全貌」按「重算上個月」補。

**第 2 批＋第 3 批同一窗上線、出事要退回第 1 批（e5fa2f2）映像時**：第 1 批的程式不認得 Transfer 兩端可為 null、`undoneAt`、`confirmStatus`，
所以先查三件事，全部 0 才能直接退（SKIP_DB_PUSH 或 command 覆寫）：

```sql
SELECT count(*) FROM "Transfer" WHERE "fromAccountId" IS NULL OR "toAccountId" IS NULL;  -- 繳卡費、還貸款、借出入：第 1 批讀 t.fromAccount.name 會 500
SELECT count(*) FROM "Transfer" WHERE "undoneAt" IS NOT NULL;                             -- 第 1 批會把已撤銷的算進餘額
SELECT count(*) FROM "Transfer" WHERE "confirmStatus" <> 'CONFIRMED';                     -- 第 1 批會把待確認／拒絕的兩端都算進餘額
```

不是 0（上線後已經有人用新種類轉帳）→ 不要硬退：先修往前；真的要退，只能用 `ledger-deploy.sh` 換版前留的 pg_dump 還原（會丟掉換版後寫入的資料），
或只退 web、server 留在第 3 批。

### 臺銀牌告匯率（11-05，接在第 3 批 b66fcf2 之後）多出來的檢查

schema 只加不改（`Transaction.fxRate／fxRateDate／fxRateSource` 3 個可空欄位、`FxRateDaily` 新表，預期 SQL 見
`finance-hub-fx-bot-expected-db-push.sql`）。舊程式不讀這些欄位與表，**回退到 b66fcf2 不會壞、數字也不變**：
已記的外幣交易 `amount` 是當時用臺銀匯率算好的台幣，回退後照舊顯示；只是之後新記的外幣改回 env／固定值估算。
回退仍要 SKIP_DB_PUSH（舊 schema 的 db push 會想刪新表與 3 欄而失敗）。

### 財務中樞 P0 資安（11-06，feat/finance-hub-p0-security，接在 c834706 之後）多出來的檢查

schema 只加不改（新表 `AuditLog`，預期 SQL 見 `finance-hub-p0-security-expected-db-push.sql`）。舊程式不讀 `AuditLog` 與
`FamilyMember.legalNameEnc`，**回退不會壞、數字也不變**；回退仍要 SKIP_DB_PUSH（舊 schema 的 db push 會想刪 `AuditLog`）。
開機建的 trigger／函式（擋 AuditLog 的 UPDATE／DELETE／TRUNCATE）回退後留著無害。回退期間沒有稽核紀錄、不能登記帳單戶名。
詳見 `finance-hub-p0-security.md`。

## 回退之後

- 容器是用 override 起來的：之後有人跑 `deploy-sub.sh ledger-server …`／`install.sh` 重建時沒有 override，
  舊映像又會跑 db push 而起不來。回退只是止血，要盡快修好往前部署，或改正式 compose。
- 資料本身不用還原（新版只加不改）。真的要還原到換版前，用 `ledger-deploy.sh` 換版前留的 pg_dump（見主機
  `/var/lib/ugomk/backup/predeploy/`），會丟掉換版後寫入的資料。
