import express from 'express';
import { config } from './config';
import { logger } from './logger';
import { webhookRouter } from './routes/webhook';
import { liffRouter } from './routes/liff';
import { jobsRouter } from './routes/jobs';
import { startSchedulers } from './jobs/scheduler';
import { fxHealth } from './services/fx';

const app = express();

// LINE webhook 必須拿 raw body 驗簽，因此單獨掛在 /webhook 之前
app.use('/webhook', express.raw({ type: '*/*' }), webhookRouter);

app.use(express.json());

app.get('/health', (_req, res) => {
  // fx：臺銀牌告抓取狀態（失敗不影響 ok，只給人看）
  res.json({ ok: true, ts: Date.now(), fx: fxHealth() });
});

app.use('/api/liff', liffRouter);
app.use('/jobs', jobsRouter);

app.listen(config.port, () => {
  logger.info(`server listening on :${config.port} (${config.nodeEnv})`);
  startSchedulers();
});
