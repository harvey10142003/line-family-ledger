import { Router } from 'express';
import { sendMonthlySummaries, sendWeeklyBudgetDigests, sendCreditCardDueReminders, sendRecordNudges } from '../jobs/reminders';
import { postDueRecurring } from '../services/recurring';
import { runMonthlySnapshots } from '../services/net-worth';
import { notifyExpiredTransfers } from '../jobs/transfer-confirm';
import { logger } from '../logger';
import { syncFxRates } from '../services/fx';

export const jobsRouter = Router();

// 手動 / 外部排程器觸發提醒。需設 CRON_SECRET 才啟用，並用 x-cron-secret header 驗證。
// 例：POST /jobs/monthly?month=2026-05   POST /jobs/weekly
jobsRouter.post('/:task', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(403).json({ error: 'jobs endpoint disabled (set CRON_SECRET to enable)' });
  if (req.header('x-cron-secret') !== secret) return res.status(401).json({ error: 'unauthorized' });

  const { task } = req.params;
  try {
    if (task === 'monthly') {
      const month = typeof req.query.month === 'string' ? req.query.month : undefined;
      return res.json({ task, ...(await sendMonthlySummaries(month)) });
    }
    if (task === 'weekly') {
      return res.json({ task, ...(await sendWeeklyBudgetDigests()) });
    }
    if (task === 'card-due') {
      const days = typeof req.query.days === 'string' ? Number(req.query.days) : 3;
      return res.json({ task, ...(await sendCreditCardDueReminders(Number.isFinite(days) ? days : 3)) });
    }
    if (task === 'recurring') {
      return res.json({ task, ...(await postDueRecurring()) });
    }
    if (task === 'net-worth') {
      const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : undefined;
      return res.json({ task, ...(await runMonthlySnapshots(new Date(), month)) });
    }
    if (task === 'transfer-expire') {
      return res.json({ task, ...(await notifyExpiredTransfers()) });
    }
    if (task === 'fx-sync') {
      return res.json({ task, ...(await syncFxRates()) });
    }
    if (task === 'nudge') {
      return res.json({ task, ...(await sendRecordNudges()) });
    }
    return res.status(404).json({ error: `unknown task: ${task}` });
  } catch (err) {
    logger.error({ err, task }, 'jobs trigger failed');
    return res.status(500).json({ error: String(err) });
  }
});
