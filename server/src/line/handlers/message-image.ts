import type { MessageEvent, ImageEventMessage } from '@line/bot-sdk';
import { lineClient, lineBlobClient } from '../client';
import { findMemberByLineId } from '../../services/family';
import { prisma } from '../../prisma';
import { parseReceiptImage } from '../../ai/gemini';
import { recordTransaction } from '../../services/transaction';
import { getBudgetAlert } from '../../services/budget';
import { logger } from '../../logger';

// LINE blob client 回傳 Readable stream，收集成 Buffer
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

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

  // 階段 2a — 拉圖片 → Gemini Flash OCR → 自動入帳
  const categories = await prisma.category.findMany({
    where: { familyId: member.familyId },
    select: { name: true, type: true },
    orderBy: { sortOrder: 'asc' },
  });

  let receipt;
  try {
    const stream = await lineBlobClient.getMessageContent(event.message.id);
    const buffer = await streamToBuffer(stream as unknown as NodeJS.ReadableStream);
    receipt = await parseReceiptImage(buffer, 'image/jpeg', categories);
  } catch (err) {
    logger.error({ err, userId }, 'receipt OCR failed');
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: '收據辨識失敗了 😢 請再拍清楚一點，或直接打字記帳（例如：午餐 120）。' }],
    });
    return;
  }

  if (!receipt) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: '我在這張圖看不出消費金額 🤔\n請拍清楚收據／發票，或直接打字記帳（例如：午餐 120）。',
        },
      ],
    });
    return;
  }

  const note = receipt.merchant || receipt.items[0]?.name || '收據';
  const paidAt = receipt.paidAt ? new Date(`${receipt.paidAt}T12:00:00+08:00`) : undefined;

  const tx = await recordTransaction({
    familyId: member.familyId,
    memberId: member.id,
    parsed: {
      amount: receipt.totalAmount,
      categoryName: receipt.suggestedCategory ?? '其他支出',
      note,
      type: 'EXPENSE',
    },
    source: 'PHOTO',
    paidAt,
  });

  const dateLine = receipt.paidAt ? `\n📅 ${receipt.paidAt}` : '';
  const alert = await getBudgetAlert(member.familyId);
  const alertLine = alert ? `\n\n${alert}` : '';
  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: `已從收據記帳 📸✅\n${tx.category.icon ?? '💸'} ${tx.category.name}　$${Number(tx.amount).toLocaleString('en-US')}\n📝 ${note}${dateLine}\n記錄者：${member.displayName}${alertLine}\n\n金額有誤的話可在記帳簿裡調整。`,
      },
    ],
  });
}
