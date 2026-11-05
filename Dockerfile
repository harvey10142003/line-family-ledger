# Server-only Dockerfile (Zeabur 部署 server)
# Base 用 node:20-slim + 顯式安裝 openssl（Prisma 需要）
FROM node:20-slim AS base
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
COPY prisma ./prisma
RUN npm install --workspaces --include-workspace-root --include=dev

FROM base AS build
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm --workspace server run build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./
COPY --from=build /app/scripts/start-server.sh ./scripts/start-server.sh
EXPOSE 3000
# 啟動腳本：預設先 prisma db push（不帶 --accept-data-loss：schema 與資料庫不一致且會刪欄位／表時，db push 直接失敗、
# 容器不起來，不會靜默刪資料；2026-11 搬 GCP 時改，原本 Zeabur 版帶這個旗標）。真的要刪欄位時，先手動備份再另外處理。
# 回退到 schema 較舊的版本時帶 SKIP_DB_PUSH=1（見 docs/deploy/rollback.md）。
CMD ["sh", "scripts/start-server.sh"]
