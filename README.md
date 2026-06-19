# LINE 家庭共同記帳

LINE@ 機器人 + LIFF Web，讓家人共用同一本記帳簿。  
一對多架構：一個 LINE@ 帳號透過「家庭碼」服務無數個家庭。

## 功能（規劃）

| 階段 | 功能 |
|------|------|
| 1 | LINE 加好友建立/加入家庭、文字快速記帳、AI 自動分類、LIFF 月度明細 |
| 2 | 收據拍照辨識、**PDF 帳單匯入（信用卡月帳單一次帶入幾十筆）**、共同記帳顯示記錄者、月報表（圓餅圖 / 成員占比） |
| 3 | 預算 / 提醒 / 分帳結算 / Excel 匯出 |

> 階段 2 的拍照辨識（image message）跟 PDF 帳單匯入（file message）共用 Gemini multimodal pipeline，預計同時做。LINE 桌面版可直接拖 PDF 進對話框。

## 技術棧

- **Backend**：Node.js 20 + Express + Prisma + PostgreSQL
- **Frontend**：Next.js 15 (App Router) + Tailwind + LIFF SDK + Recharts
- **AI**：`gemini-2.5-flash` 同時負責文字記帳 parse + 收據圖片 OCR
- **部署**：Zeabur（PostgreSQL + 容器服務）
- **Monorepo**：npm workspaces（`server` + `web`）

## 資料模型

```
Family ──┬─ FamilyMember (LINE userId 綁定)
         ├─ Category (預設 13 種，可自訂)
         ├─ Transaction ─ Receipt (拍照來源才有)
         └─ InviteLink
```

家庭碼為 6 碼大寫英數（避開 0/O/1/I），每家庭唯一。

## 本地開發

```bash
# 1. 安裝依賴
npm install

# 2. 複製環境變數
cp .env.example .env
# 編輯 .env，填入 LINE / DeepSeek / Gemini / Postgres

# 3. 建表
npx prisma migrate dev --name init

# 4. 同時跑 server (3000) + web (3001)
npm run dev
```

## 環境變數

見 `.env.example`，重點：

- `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`：LINE 官方帳號
- `LINE_LIFF_ID` / `NEXT_PUBLIC_LIFF_ID`：LIFF App ID
- `GEMINI_API_KEY`：Google Gemini 2.5 Flash（文字 parse + 拍照辨識）
- `DATABASE_URL`：PostgreSQL 連線字串

## 目錄結構

```
line-family-ledger/
├── server/                Express + LINE webhook + AI
│   ├── src/
│   │   ├── line/
│   │   │   ├── client.ts
│   │   │   └── handlers/  follow / postback / message-text / message-image
│   │   ├── ai/            gemini (文字 parse + vision OCR)
│   │   ├── services/      family / transaction / category
│   │   └── routes/        webhook / liff
├── web/                   Next.js LIFF (儀表板 / 報表)
├── prisma/                schema + seed (預設分類)
└── Dockerfile             Zeabur 部署用
```

## LINE 對話流程

```
[加好友]
  → Bot: 建立新家庭 / 加入現有家庭 (Quick Reply)
[建立]
  → Bot: 請輸入家庭名稱
  → User: 施家
  → Bot: 建立成功！家庭碼 AB12CD，邀請連結 https://liff.line.me/...
[加入]
  → Bot: 請輸入 6 碼家庭碼
  → User: AB12CD
  → Bot: 成功加入「施家」
[記帳]
  → User: 午餐 120
  → Bot: 已記錄：餐飲 $120 (AI 自動分類)  ← 階段 1 待實作
  → User: [收據照片]
  → Bot: 看到金額 $358，分類「餐飲」，確認嗎？  ← 階段 2 待實作
  → User: [信用卡月帳單.pdf]
  → Bot: 看到 4 月信用卡帳單，14 筆交易 $48,562，預覽如下…  ← 階段 2 待實作
```

## Roadmap

- [x] 專案骨架 + Prisma schema
- [x] LINE webhook + 家庭碼建立 / 加入流程
- [x] LIFF 首頁骨架（顯示家庭資訊）
- [x] LINE Messaging API 對接（webhook 簽章驗證、follow / postback / message dispatch）
- [x] **階段 1**：Gemini 文字 parse → Transaction 寫入 + 自動分類
- [x] **階段 2a**：Gemini 收據 OCR（image message）
- [x] **階段 2b**：Gemini PDF 帳單批次匯入（file message，信用卡 / 水電瓦斯）
- [x] **階段 2c**：LIFF 明細列表 + 月報表圓餅圖 + 成員占比
- [x] **階段 3a**：每月預算（整體 + 超支提醒）/ 分帳結算（均分）/ CSV 匯出
- [x] **階段 3b**：定期提醒（node-cron：月結 1 號 09:00 / 預算週報 週一 09:00，台北時區；可用 /jobs/* 外部觸發）
