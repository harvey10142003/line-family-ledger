import cron from 'node-cron';
import { logger } from '../logger';
import { sendMonthlySummaries, sendWeeklyBudgetDigests, sendCreditCardDueReminders, sendRecordNudges } from './reminders';
import { postDueRecurring } from '../services/recurring';
import { runMonthlySnapshots } from '../services/net-worth';
import { notifyExpiredTransfers } from './transfer-confirm';

const TZ = 'Asia/Taipei';

// 啟動 in-process 排程。若改用外部排程器（Zeabur cron job 打 /jobs/*），
// 設環境變數 DISABLE_INPROCESS_CRON=true 關閉，避免重複推播。
export function startSchedulers(): void {
  if (process.env.DISABLE_INPROCESS_CRON === 'true') {
    logger.info('in-process cron disabled (DISABLE_INPROCESS_CRON=true)');
    return;
  }

  // 每月 1 號 09:00（台北）推上個月月結報告
  cron.schedule(
    '0 9 1 * *',
    () => {
      sendMonthlySummaries().catch((err) => logger.error({ err }, 'monthly summary job failed'));
    },
    { timezone: TZ },
  );

  // 每週一 09:00（台北）推本月預算週報
  cron.schedule(
    '0 9 * * 1',
    () => {
      sendWeeklyBudgetDigests().catch((err) => logger.error({ err }, 'weekly budget job failed'));
    },
    { timezone: TZ },
  );

  // 每天 10:00（台北）信用卡繳費前 3 天提醒
  cron.schedule(
    '0 10 * * *',
    () => {
      sendCreditCardDueReminders(3).catch((err) => logger.error({ err }, 'credit card due job failed'));
    },
    { timezone: TZ },
  );

  // 每天 08:00（台北）產生到期的固定收支
  cron.schedule(
    '0 8 * * *',
    () => {
      postDueRecurring().catch((err) => logger.error({ err }, 'recurring post job failed'));
    },
    { timezone: TZ },
  );

  // 每天 21:00（台北）今天還沒記帳的家庭輕推
  cron.schedule(
    '0 21 * * *',
    () => {
      sendRecordNudges().catch((err) => logger.error({ err }, 'record nudge job failed'));
    },
    { timezone: TZ },
  );

  // 每月 1 號 08:30（台北）存上個月的淨資產快照（P1-7；在 09:00 月報之前）
  cron.schedule(
    '30 8 1 * *',
    () => {
      runMonthlySnapshots().catch((err) => logger.error({ err }, 'net worth snapshot job failed'));
    },
    { timezone: TZ },
  );

  // 每小時第 5 分：文字轉帳待對方確認超過 24 小時 → 只算建立者那一端，並通知建立者（D18）
  cron.schedule(
    '5 * * * *',
    () => {
      notifyExpiredTransfers().catch((err) => logger.error({ err }, 'transfer expire job failed'));
    },
    { timezone: TZ },
  );

  logger.info('reminder schedulers started (Asia/Taipei): recurring 08:00, monthly 1st 09:00, weekly Mon 09:00, card due 10:00, nudge 21:00, net worth 1st 08:30, transfer confirm expiry hourly');
}
