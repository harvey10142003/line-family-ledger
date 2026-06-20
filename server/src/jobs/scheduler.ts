import cron from 'node-cron';
import { logger } from '../logger';
import { sendMonthlySummaries, sendWeeklyBudgetDigests, sendCreditCardDueReminders } from './reminders';

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

  logger.info('reminder schedulers started (Asia/Taipei): monthly 1st 09:00, weekly Mon 09:00, card due daily 10:00');
}
