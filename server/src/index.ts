import express from 'express';
import { config } from './config';
import { logger } from './logger';
import { webhookRouter } from './routes/webhook';
import { liffRouter } from './routes/liff';
import { jobsRouter } from './routes/jobs';
import { startSchedulers } from './jobs/scheduler';
import { fxHealth } from './services/fx';
import { ensureAuditAppendOnly } from './services/audit';
import { fieldKeyStatus } from './lib/field-crypto';

const app = express();

// LINE webhook 必須拿 raw body 驗簽，因此單獨掛在 /webhook 之前
app.use('/webhook', express.raw({ type: '*/*' }), webhookRouter);

app.use(express.json());

app.get('/health', (_req, res) => {
  // fx：臺銀牌告抓取狀態（失敗不影響 ok，只給人看）
  // fieldKey：敏感欄位加密金鑰是否可用（只回 true/false，不回原因；沒設時登記真實姓名會回 503）
  res.json({ ok: true, ts: Date.now(), fx: fxHealth(), fieldKey: fieldKeyStatus().ok });
});

app.use('/api/liff', liffRouter);
app.use('/jobs', jobsRouter);

app.listen(config.port, () => {
  logger.info(`server listening on :${config.port} (${config.nodeEnv})`);
  startSchedulers();
  // 敏感欄位金鑰（P0-3）：沒設不擋開機，只影響登記真實姓名等敏感欄位（fail-closed）
  const fk = fieldKeyStatus();
  if (fk.ok) logger.info({ version: fk.version, versions: fk.versions }, 'field encryption key loaded');
  else logger.warn({ reason: fk.reason }, 'field encryption key unavailable: sensitive-field writes will be refused');
  // 稽核紀錄只加不改（P0-4）：資料庫 trigger 擋 UPDATE／DELETE／TRUNCATE
  ensureAuditAppendOnly().then(
    () => logger.info('audit log append-only trigger ensured'),
    (err) => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'audit append-only trigger setup failed'),
  );
});
