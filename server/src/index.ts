import express from 'express';
import { config } from './config';
import { logger } from './logger';
import { webhookRouter } from './routes/webhook';
import { liffRouter } from './routes/liff';
import { jobsRouter } from './routes/jobs';
import { startSchedulers } from './jobs/scheduler';
import { fxHealth } from './services/fx';
import { ensureAuditAppendOnly } from './services/audit';
import { fieldKeyFingerprint, fieldKeyStatus } from './lib/field-crypto';
import { checkFieldKeyAgainstDb, fieldKeyMismatch } from './services/field-key-check';

const app = express();

// LINE webhook 必須拿 raw body 驗簽，因此單獨掛在 /webhook 之前
app.use('/webhook', express.raw({ type: '*/*' }), webhookRouter);

app.use(express.json());

app.get('/health', (_req, res) => {
  // fx：臺銀牌告抓取狀態（失敗不影響 ok，只給人看）
  // fieldKey：敏感欄位加密金鑰是否可用（只回 true/false，不回原因；沒設時登記真實姓名會回 503）
  // fieldKeyFingerprint：目前金鑰 sha256 的前 8 碼（跟離線備份核對；絕不回金鑰本身）
  // fieldKeyMismatch：開機試解資料庫裡既有的密文失敗＝true（金鑰貼錯／換機沒帶到）；null＝還沒檢查完或金鑰不可用
  res.json({
    ok: true,
    ts: Date.now(),
    fx: fxHealth(),
    fieldKey: fieldKeyStatus().ok,
    fieldKeyFingerprint: fieldKeyFingerprint(),
    fieldKeyMismatch: fieldKeyMismatch(),
  });
});

app.use('/api/liff', liffRouter);
app.use('/jobs', jobsRouter);

app.listen(config.port, () => {
  logger.info(`server listening on :${config.port} (${config.nodeEnv})`);
  startSchedulers();
  // 敏感欄位金鑰（P0-3）：沒設不擋開機，只影響登記真實姓名等敏感欄位（fail-closed）
  const fk = fieldKeyStatus();
  if (fk.ok) logger.info({ version: fk.version, versions: fk.versions, fingerprint: fieldKeyFingerprint() }, 'field encryption key loaded');
  else logger.warn({ reason: fk.reason }, 'field encryption key unavailable: sensitive-field writes will be refused');
  // 金鑰自我檢查：資料庫已有密文就試解一筆（每個版本一筆）；解不開寫 error log、/health 回 fieldKeyMismatch:true。不擋開機。
  checkFieldKeyAgainstDb().catch((err) => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'field key self-check could not run'));
  // 稽核紀錄只加不改（P0-4）：資料庫 trigger 擋 UPDATE／DELETE／TRUNCATE
  ensureAuditAppendOnly().then(
    () => logger.info('audit log append-only trigger ensured'),
    (err) => logger.error({ error: err instanceof Error ? err.message : String(err) }, 'audit append-only trigger setup failed'),
  );
});
