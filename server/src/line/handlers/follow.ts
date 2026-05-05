import type { FollowEvent } from '@line/bot-sdk';
import { lineClient } from '../client';
import { findMemberByLineId } from '../../services/family';
import { config } from '../../config';

export async function handleFollow(event: FollowEvent): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return;

  const existing = await findMemberByLineId(userId);
  if (existing) {
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: `歡迎回來！你目前在「${existing.family.name}」家庭，家庭碼：${existing.family.familyCode}\n\n直接打字記帳即可，例如：午餐 120`,
        },
      ],
    });
    return;
  }

  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: '歡迎使用家庭共同記帳！🏠\n請選擇要建立新家庭，還是加入現有家庭？',
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '建立新家庭',
                data: 'action=create_family',
                displayText: '建立新家庭',
              },
            },
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '加入現有家庭',
                data: 'action=join_family',
                displayText: '加入現有家庭',
              },
            },
          ],
        },
      },
    ],
  });
}

// 產生 LINE 邀請連結（line.me URL scheme 開啟此 LINE@ 並帶入家庭碼）
export function buildInviteUrl(familyCode: string): string {
  // 用 LIFF 入口頁，後續可在前端讀取 query 自動加入
  return `https://liff.line.me/${config.line.liffId}?code=${familyCode}`;
}
