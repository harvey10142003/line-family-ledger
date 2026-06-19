import type { MessageEvent, FileEventMessage } from '@line/bot-sdk';
import { lineClient, lineBlobClient } from '../client';
import { findMemberByLineId } from '../../services/family';
import { prisma } from '../../prisma';
import { parseBillFile, type ParsedBillItem } from '../../ai/gemini';
import { recordTransactionsBatch } from '../../services/transaction';
import { logger } from '../../logger';

// 暫存待確認的帳單匯入（MVP in-memory，正式部署換 Redis）
type PendingBill = {
  familyId: string;
  memberId: string;
  memberName: string;
  items: ParsedBillItem[];
  fileName: string;
};
const pendingBills = new Map<string, PendingBill>();

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function ntd(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

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

  const fileName = event.message.fileName ?? '';
  if (!/\.pdf$/i.test(fileName)) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: '目前只支援 PDF 帳單匯入 📄\n把信用卡 / 水電瓦斯月帳單的 PDF 傳進來，我幫你批次記帳。' }],
    });
    return;
  }

  const categories = await prisma.category.findMany({
    where: { familyId: member.familyId },
    select: { name: true, type: true },
    orderBy: { sortOrder: 'asc' },
  });

  let items: ParsedBillItem[] | null;
  try {
    const stream = await lineBlobClient.getMessageContent(event.message.id);
    const buffer = await streamToBuffer(stream as unknown as NodeJS.ReadableStream);
    items = await parseBillFile(buffer, 'application/pdf', categories);
  } catch (err) {
    logger.error({ err, userId }, 'bill parse failed');
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: '帳單解析失敗了 😢 請確認是清楚的 PDF 帳單再試一次。' }],
    });
    return;
  }

  if (!items || items.length === 0) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: '這份 PDF 我抓不到任何消費明細 🤔\n請確認是信用卡 / 水電瓦斯帳單。' }],
    });
    return;
  }

  pendingBills.set(userId, {
    familyId: member.familyId,
    memberId: member.id,
    memberName: member.displayName,
    items,
    fileName,
  });

  const total = items.reduce((s, t) => s + t.amount, 0);
  const preview = items
    .slice(0, 8)
    .map((t) => `・${t.paidAt ? t.paidAt.slice(5) + ' ' : ''}${t.note || t.categoryName} ${ntd(t.amount)}`)
    .join('\n');
  const more = items.length > 8 ? `\n…還有 ${items.length - 8} 筆` : '';

  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: `📄 ${fileName}\n抓到 ${items.length} 筆交易，合計 ${ntd(total)}\n\n${preview}${more}\n\n要全部匯入嗎？`,
        quickReply: {
          items: [
            {
              type: 'action',
              action: { type: 'postback', label: `✅ 匯入 ${items.length} 筆`, data: 'action=confirm_bill', displayText: '確認匯入' },
            },
            {
              type: 'action',
              action: { type: 'postback', label: '❌ 取消', data: 'action=cancel_bill', displayText: '取消匯入' },
            },
          ],
        },
      },
    ],
  });
}

// 由 postback 呼叫：確認匯入暫存的帳單
export async function confirmPendingBill(userId: string, replyToken: string): Promise<void> {
  const bill = pendingBills.get(userId);
  if (!bill) {
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: '沒有待匯入的帳單了（可能已逾時），請重新傳一次 PDF。' }],
    });
    return;
  }
  pendingBills.delete(userId);

  const { count, total } = await recordTransactionsBatch({
    familyId: bill.familyId,
    memberId: bill.memberId,
    items: bill.items,
    source: 'MANUAL',
  });

  await lineClient.replyMessage({
    replyToken,
    messages: [
      {
        type: 'text',
        text: `已匯入 ${count} 筆交易 ✅\n合計 ${ntd(total)}\n記錄者：${bill.memberName}\n\n打開記帳簿可看分類圓餅圖。`,
      },
    ],
  });
}

// 由 postback 呼叫：取消暫存的帳單
export async function cancelPendingBill(userId: string, replyToken: string): Promise<void> {
  pendingBills.delete(userId);
  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: '已取消匯入，沒有寫入任何資料。' }],
  });
}
