# Server-only Dockerfile (Zeabur 部署 server)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
COPY prisma ./prisma
RUN npm install --workspaces --include-workspace-root

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm --workspace server run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node server/dist/index.js"]
