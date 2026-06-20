// 文字記帳時偵測到未知付款方式 → 詢問是否新增為帳戶（一般帳戶；信用卡請至記帳簿新增）
import { prisma } from '../../prisma';
import { lineClient } from '../client';
import { createAccount } from '../../services/account';
import { createCreditCard } from '../../services/creditcard';
import { logger } from '../../logger';

type PendingAccount = {
  familyId: string;
  name: string;
  txnIds: string[]; // 剛記到預設帳戶的交易，確認後改綁新帳戶
};
const pending = new Map<string, PendingAccount>();

export function setPendingAccount(userId: string, data: PendingAccount): void {
  pending.set(userId, data);
}

// 由 message-text 在回覆時附 Quick Reply 詢問（帳戶 / 信用卡 / 不用）
export function buildAddAccountQuickReply(name: string) {
  return {
    items: [
      {
        type: 'action' as const,
        action: { type: 'postback' as const, label: `👛 帳戶`, data: 'action=confirm_add_account', displayText: `新增帳戶 ${name}` },
      },
      {
        type: 'action' as const,
        action: { type: 'postback' as const, label: `💳 信用卡`, data: 'action=add_credit_card', displayText: `新增信用卡 ${name}` },
      },
      {
        type: 'action' as const,
        action: { type: 'postback' as const, label: '不用', data: 'action=cancel_add_account', displayText: '不新增' },
      },
    ],
  };
}

// 確認新增為「信用卡」：用預設額度/結算日/繳費日建立，並把剛記的交易改綁到卡
export async function confirmPendingCreditCard(userId: string, replyToken: string): Promise<void> {
  const p = pending.get(userId);
  if (!p) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '沒有待新增的項目了。' }] });
    return;
  }
  pending.delete(userId);
  try {
    let card = await prisma.creditCard.findFirst({ where: { familyId: p.familyId, name: p.name } });
    if (!card) card = await createCreditCard({ familyId: p.familyId, name: p.name }); // 預設額度0/結算1/繳費15
    if (p.txnIds.length > 0) {
      await prisma.transaction.updateMany({ where: { id: { in: p.txnIds } }, data: { creditCardId: card.id, accountId: null } });
    }
    await lineClient.replyMessage({
      replyToken,
      messages: [
        {
          type: 'text',
          text: `已新增信用卡「${card.name}」💳 並把剛剛 ${p.txnIds.length} 筆改記到它。\n\n請到記帳簿 →「信用卡」設定額度 / 結算日 / 繳費日，繳費提醒才會準。`,
        },
      ],
    });
  } catch (err) {
    logger.error({ err, userId }, 'confirmPendingCreditCard failed');
    await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '新增信用卡失敗了，請到記帳簿手動新增。' }] });
  }
}

export async function confirmPendingAccount(userId: string, replyToken: string): Promise<void> {
  const p = pending.get(userId);
  if (!p) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '沒有待新增的帳戶了。' }] });
    return;
  }
  pending.delete(userId);

  try {
    // 已存在同名就直接用，否則建立（type 預設 OTHER）
    let acc = await prisma.account.findFirst({ where: { familyId: p.familyId, name: p.name } });
    if (!acc) acc = await createAccount({ familyId: p.familyId, name: p.name, type: 'OTHER', icon: '👛' });

    // 把剛記的交易改綁到新帳戶
    if (p.txnIds.length > 0) {
      await prisma.transaction.updateMany({ where: { id: { in: p.txnIds } }, data: { accountId: acc.id } });
    }

    await lineClient.replyMessage({
      replyToken,
      messages: [
        {
          type: 'text',
          text: `已新增帳戶「${acc.name}」✅ 並把剛剛 ${p.txnIds.length} 筆改記到這個帳戶。\n可到記帳簿設定它的期初餘額。`,
        },
      ],
    });
  } catch (err) {
    logger.error({ err, userId }, 'confirmPendingAccount failed');
    await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '新增帳戶失敗了，請到記帳簿手動新增。' }] });
  }
}

export async function cancelPendingAccount(userId: string, replyToken: string): Promise<void> {
  pending.delete(userId);
  await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '好的，沒有新增帳戶（剛剛的記帳已記到預設帳戶）。' }] });
}
