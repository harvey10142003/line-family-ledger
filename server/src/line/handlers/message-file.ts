import type { MessageEvent, FileEventMessage } from '@line/bot-sdk';
import { lineClient } from '../client';
import { findMemberByLineId } from '../../services/family';

export async function handleFileMessage(
  event: MessageEvent & { message: FileEventMessage },
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

  // TODO: 階段 2b — 用 lineBlobClient.getMessageContent 拉 PDF binary
  //                → Gemini parseBillFile（multimodal inlineData mimeType=application/pdf）
  //                → 回 Flex preview 預覽要新增的多筆交易 → 確認入帳
  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: `[骨架佔位] 收到檔案「${event.message.fileName}」（${Math.round(Number(event.message.fileSize) / 1024)} KB）\n之後會接 Gemini 解析帳單批次匯入交易`,
      },
    ],
  });
}
