# Server-only Dockerfile (Zeabur 部署 server)
FROM node:20-slim AS deps
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
COPY prisma ./prisma
RUN npm install --workspaces --include-workspace-root --include=dev

FROM node:20-slim AS build
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm --workspace server run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./
EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node server/dist/index.js"]
