#!/bin/sh
# 記帳 server 容器啟動腳本（Dockerfile CMD 呼叫）
#
# SKIP_DB_PUSH=1：不跑 prisma db push，直接起 server。用途：
#   - 回退到「schema 比資料庫舊」的版本：舊 schema 的 db push 會想刪新欄位而失敗、容器起不來，
#     回退時一律帶這個開關（比這支腳本更舊的映像沒有它，要用 compose command 覆寫成
#     ["node","server/dist/index.js"]，見 docs/deploy/rollback.md）。
#   - schema 已由人工或別的工作先套好，開機不想再動資料庫。
# 未設或其他值：照舊先 db push（不帶 --accept-data-loss，會刪資料的變更直接失敗）。
#
# node 以子行程執行、這裡把 SIGTERM／SIGINT 轉給它：以前 sh 當 PID 1 不轉送訊號，
# docker stop 要等滿 grace period 才被 SIGKILL（每次換版多中斷十幾秒）。
set -eu

case "${SKIP_DB_PUSH:-0}" in
  1|true|yes)
    echo "[start] SKIP_DB_PUSH=${SKIP_DB_PUSH}：不跑 prisma db push（回退或 schema 已先套好）"
    ;;
  *)
    npx prisma db push --skip-generate
    ;;
esac

node server/dist/index.js &
PID=$!
trap 'kill -TERM "$PID" 2>/dev/null || true' TERM INT
# 第一個 wait 會被訊號打斷，再 wait 一次拿 node 真正的結束碼
set +e
wait "$PID"
RC=$?
if kill -0 "$PID" 2>/dev/null; then
  wait "$PID"
  RC=$?
fi
exit "$RC"
