// D18：文字轉帳待對方確認超過 24 小時 → ONE_SIDED（只算建立者那一端），推播通知建立者。
import { lineClient } from '../line/client';
import { logger } from '../logger';
import { expirePendingTransfers } from '../services/transfer';

export async function notifyExpiredTransfers(now: Date = new Date()): Promise<{ expired: number }> {
  const rows = await expirePendingTransfers(now);
  for (const t of rows) {
    const amount = `$${Number(t.amount).toLocaleString('en-US')}`;
    try {
      await lineClient.pushMessage({
        to: t.member.lineUserId,
        messages: [{ type: 'text', text: `你記的一筆轉帳 ${amount} 對方 24 小時內沒有確認，先只記在你這邊（標「待確認」）。對方之後仍可在記帳簿或 LINE 確認。` }],
      });
    } catch (err) {
      logger.error({ err, transferId: t.id }, 'expired transfer notify failed');
    }
  }
  return { expired: rows.length };
}
