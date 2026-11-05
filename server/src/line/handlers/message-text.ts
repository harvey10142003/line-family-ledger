import type { MessageEvent, TextEventMessage } from '@line/bot-sdk';
import { lineClient } from '../client';
import { findMemberByLineId } from '../../services/family';
import { handlePendingInput } from './postback';
import { sendOnboardingMenu } from './follow';
import { handleLedgerText, handleLedgerPendingText } from './text-ledger';

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
          text: `你目前在「${member.family.name}」家庭，家庭碼：${member.family.familyCode}\n\n直接打字記帳，例如：\n  午餐 120\n  昨天 晚餐 300\n  公司 Zoom 15.99 美金\n  幫 Apple 記 美髮 1500\n\n也可以一句話轉帳：\n  台新轉 5000 到國泰\n  從臺銀繳國泰卡 24261\n  領現金 3000\n\n拍收據、傳 PDF 帳單也能記。`,
        },
      ],
    });
    return;
  }

  // 改金額等「等你輸入」的狀態（轉帳確認卡上的按鈕）
  if (await handleLedgerPendingText(userId, event.replyToken, text)) return;

  // 財務中樞 P1-5／P1-6：文字記帳＋一句話建轉帳（遮罩 → Gemini 只回意圖與原文 → 程式複核、換算、比對帳戶）
  await handleLedgerText(member, event.replyToken, text);
}
