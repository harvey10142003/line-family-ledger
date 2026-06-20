// 記帳後 LINE Quick Reply 快速修正：改分類 / 標個人共同 / 刪除
import { prisma } from '../../prisma';
import { lineClient } from '../client';
import { findMemberByLineId } from '../../services/family';
import { logger } from '../../logger';

function ntd(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

// 記帳成功後附在回覆上的快速修正按鈕（針對單筆 tx）
export function buildQuickFixReply(txId: string, isShared: boolean) {
  return {
    items: [
      { type: 'action' as const, action: { type: 'postback' as const, label: '改分類', data: `action=fix_cat&tx=${txId}`, displayText: '改分類' } },
      {
        type: 'action' as const,
        action: { type: 'postback' as const, label: isShared ? '改個人' : '改共同', data: `action=toggle_shared&tx=${txId}`, displayText: isShared ? '改個人' : '改共同' },
      },
      { type: 'action' as const, action: { type: 'postback' as const, label: '🗑 刪除', data: `action=del_tx&tx=${txId}`, displayText: '刪除這筆' } },
    ],
  };
}

async function findTx(userId: string, txId: string) {
  const member = await findMemberByLineId(userId);
  if (!member) return null;
  const tx = await prisma.transaction.findFirst({
    where: { id: txId, familyId: member.familyId },
    include: { category: true },
  });
  return tx ? { member, tx } : null;
}

export async function handleQuickFix(userId: string, replyToken: string, action: string, params: URLSearchParams): Promise<boolean> {
  const txId = params.get('tx');
  if (!txId) return false;

  try {
    if (action === 'del_tx') {
      const found = await findTx(userId, txId);
      if (!found) {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '找不到這筆紀錄（可能已刪除）。' }] });
        return true;
      }
      await prisma.transaction.delete({ where: { id: txId } });
      await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '已刪除這筆 🗑' }] });
      return true;
    }

    if (action === 'toggle_shared') {
      const found = await findTx(userId, txId);
      if (!found) {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '找不到這筆紀錄。' }] });
        return true;
      }
      const next = !found.tx.isShared;
      await prisma.transaction.update({ where: { id: txId }, data: { isShared: next } });
      await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `已改為「${next ? '共同（分帳）' : '個人（不分帳）'}」✅` }] });
      return true;
    }

    if (action === 'fix_cat') {
      const found = await findTx(userId, txId);
      if (!found) {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '找不到這筆紀錄。' }] });
        return true;
      }
      const cats = await prisma.category.findMany({
        where: { familyId: found.member.familyId, type: found.tx.category.type },
        orderBy: { sortOrder: 'asc' },
        take: 13,
      });
      await lineClient.replyMessage({
        replyToken,
        messages: [
          {
            type: 'text',
            text: '要改成哪個分類？',
            quickReply: {
              items: cats.map((c) => ({
                type: 'action' as const,
                action: { type: 'postback' as const, label: `${c.icon ?? ''} ${c.name}`.slice(0, 20), data: `action=set_cat&tx=${txId}&c=${c.id}`, displayText: `改分類：${c.name}` },
              })),
            },
          },
        ],
      });
      return true;
    }

    if (action === 'set_cat') {
      const catId = params.get('c');
      const found = await findTx(userId, txId);
      if (!found || !catId) {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '找不到這筆紀錄。' }] });
        return true;
      }
      const cat = await prisma.category.findFirst({ where: { id: catId, familyId: found.member.familyId } });
      if (!cat) {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '分類無效。' }] });
        return true;
      }
      await prisma.transaction.update({ where: { id: txId }, data: { categoryId: catId } });
      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: `已改分類為 ${cat.icon ?? ''} ${cat.name}　${ntd(Number(found.tx.amount))} ✅` }],
      });
      return true;
    }
  } catch (err) {
    logger.error({ err, action, txId }, 'quick fix failed');
  }
  return false;
}
