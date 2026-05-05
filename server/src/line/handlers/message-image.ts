import type { MessageEvent, ImageEventMessage } from '@line/bot-sdk';
import { lineClient } from '../client';
import { findMemberByLineId } from '../../services/family';

export async function handleImageMessage(
  event: MessageEvent & { message: ImageEventMessage },
): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return;

  const member = await findMemberByLineId(userId);
  if (!member) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: '你還沒有家庭，請先建立或加入一個家庭。' }],
    });
    return;
  }

  // TODO: 階段 2 — 用 lineBlobClient.getMessageContent 拉圖片 → Gemini Flash OCR → 確認入帳
  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: `[骨架佔位] 收到收據照片，之後會接 Gemini Flash 辨識金額/品項`,
      },
    ],
  });
}
