import type { MessageEvent, TextEventMessage } from '@line/bot-sdk';
import { lineClient } from '../client';
import { findMemberByLineId } from '../../services/family';
import { handlePendingInput } from './postback';

export async function handleTextMessage(
  event: MessageEvent & { message: TextEventMessage },
): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return;

  // 先處理「建立家庭/加入家庭」流程中的等待輸入狀態
  const consumed = await handlePendingInput({
    userId,
    replyToken: event.replyToken,
    text: event.message.text,
  });
  if (consumed) return;

  const member = await findMemberByLineId(userId);
  if (!member) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: '你還沒有家庭，請先建立或加入一個家庭。傳「開始」叫出選單。',
        },
      ],
    });
    return;
  }

  // TODO: 階段 1 — 把文字丟 DeepSeek-V4-Flash 解析成「金額 + 分類 + 備註」並寫入 Transaction
  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: `[骨架佔位] 收到「${event.message.text}」\n家庭：${member.family.name}\n之後會接 DeepSeek 解析並自動分類記帳`,
      },
    ],
  });
}
