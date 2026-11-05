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

## 回退之後

- 容器是用 override 起來的：之後有人跑 `deploy-sub.sh ledger-server …`／`install.sh` 重建時沒有 override，
  舊映像又會跑 db push 而起不來。回退只是止血，要盡快修好往前部署，或改正式 compose。
- 資料本身不用還原（新版只加不改）。真的要還原到換版前，用 `ledger-deploy.sh` 換版前留的 pg_dump（見主機
  `/var/lib/ugomk/backup/predeploy/`），會丟掉換版後寫入的資料。
