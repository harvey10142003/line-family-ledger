import type { MessageEvent, TextEventMessage } from '@line/bot-sdk';
import { lineClient } from '../client';
import { findMemberByLineId } from '../../services/family';
import { handlePendingInput } from './postback';
import { sendOnboardingMenu } from './follow';

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

  // TODO: 階段 1 — 把文字丟 Gemini 解析成「金額 + 分類 + 備註」並寫入 Transaction
  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: `[骨架佔位] 收到「${text}」\n家庭：${member.family.name}\n之後會接 Gemini 解析並自動分類記帳`,
      },
    ],
  });
}
