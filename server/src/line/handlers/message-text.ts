import type { MessageEvent, TextEventMessage } from '@line/bot-sdk';
import { lineClient } from '../client';
import { findMemberByLineId } from '../../services/family';
import { handlePendingInput } from './postback';
import { sendOnboardingMenu } from './follow';
import { prisma } from '../../prisma';
import { parseTransactionText } from '../../ai/gemini';
import { recordTransaction } from '../../services/transaction';
import { getBudgetAlert } from '../../services/budget';
import { ensureDefaultAccounts, resolveAccountId } from '../../services/account';
import { logger } from '../../logger';

// 用戶可能用這些字眼叫出選單
const MENU_TRIGGERS = new Set([
  '開始', '選單', '功能', '主選單', '幫助', '說明',
  'menu', 'start', 'help', 'hi', 'hello',
]);

export async function handleTextMessage(
  event: MessageEvent & { message: TextEventMessage },
): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return;
  const text = event.message.text;

  // 先處理「建立家庭/加入家庭」流程中的等待輸入狀態
  const consumed = await handlePendingInput({
    userId,
    replyToken: event.replyToken,
    text,
  });
  if (consumed) return;

  const member = await findMemberByLineId(userId);
  if (!member) {
    // 沒家庭：任何訊息都先帶出選單，最低摩擦上手
    await sendOnboardingMenu(event.replyToken);
    return;
  }

  // 有家庭：menu 觸發詞顯示選單（之後給家庭成員看「家庭管理 / 報表」之類，先回提示）
  if (MENU_TRIGGERS.has(text.toLowerCase().trim())) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: `你目前在「${member.family.name}」家庭，家庭碼：${member.family.familyCode}\n\n直接打字記帳，例如：\n  午餐 120\n  早餐豆漿 45 早餐\n\n之後會支援拍照 / PDF 帳單匯入。`,
        },
      ],
    });
    return;
  }

  // 階段 1 — 把文字丟 Gemini 解析成「金額 + 分類 + 備註 + 帳戶」並寫入 Transaction
  await ensureDefaultAccounts(member.familyId);
  const [categories, accounts] = await Promise.all([
    prisma.category.findMany({
      where: { familyId: member.familyId },
      select: { name: true, type: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.account.findMany({
      where: { familyId: member.familyId, isArchived: false },
      select: { name: true },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);

  let parsed;
  try {
    parsed = await parseTransactionText(text, categories, accounts.map((a) => a.name));
  } catch (err) {
    logger.error({ err, userId }, 'parseTransactionText threw');
    parsed = null;
  }

  if (!parsed) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: '我看不出這是一筆記帳 🤔\n試試這樣輸入：\n  午餐 120\n  星巴克 150\n  薪水 50000\n\n打「選單」可看更多說明。',
        },
      ],
    });
    return;
  }

  // 整句共用付款方式（各細項 accountName 相同）
  const accountId = await resolveAccountId(member.familyId, parsed[0]?.accountName ?? null);

  // 逐筆寫入每個細項
  const txs = [];
  for (const item of parsed) {
    txs.push(
      await recordTransaction({
        familyId: member.familyId,
        memberId: member.id,
        parsed: item,
        accountId,
      }),
    );
  }

  const acctName = txs[0]?.account ? `${txs[0].account.icon ?? ''}${txs[0].account.name}` : null;
  const hasExpense = parsed.some((p) => p.type === 'EXPENSE');
  const alert = hasExpense ? await getBudgetAlert(member.familyId) : null;
  const alertLine = alert ? `\n\n${alert}` : '';

  let body: string;
  if (txs.length === 1) {
    const tx = txs[0];
    const icon = tx.category.icon ?? (tx.category.type === 'INCOME' ? '💰' : '💸');
    const sign = tx.category.type === 'INCOME' ? '+' : '';
    const noteLine = tx.note ? `\n📝 ${tx.note}` : '';
    const acctLine = acctName ? `\n💳 ${acctName}` : '';
    body = `已記帳 ✅\n${icon} ${tx.category.name}　${sign}$${Number(tx.amount).toLocaleString('en-US')}${noteLine}${acctLine}\n記錄者：${member.displayName}`;
  } else {
    // 多細項：逐筆列出 + 合計
    const lines = txs
      .map((tx) => {
        const icon = tx.category.icon ?? (tx.category.type === 'INCOME' ? '💰' : '💸');
        const sign = tx.category.type === 'INCOME' ? '+' : '';
        return `${icon} ${tx.note || tx.category.name}　${sign}$${Number(tx.amount).toLocaleString('en-US')}`;
      })
      .join('\n');
    const total = txs.reduce((s, tx) => s + (tx.category.type === 'INCOME' ? 1 : -1) * Number(tx.amount), 0);
    const totalAbs = Math.abs(total);
    const acctLine = acctName ? `　💳 ${acctName}` : '';
    body = `已記帳 ${txs.length} 筆 ✅\n${lines}\n合計 ${total < 0 ? '-' : ''}$${totalAbs.toLocaleString('en-US')}${acctLine}\n記錄者：${member.displayName}`;
  }

  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: `${body}${alertLine}` }],
  });
}
