import type { PostbackEvent } from '@line/bot-sdk';
import { lineClient } from '../client';
import { createFamily, joinFamily, findMemberByLineId } from '../../services/family';
import { buildInviteUrl } from './follow';
import { confirmPendingBill, cancelPendingBill } from './message-file';
import { confirmPendingAccount, cancelPendingAccount } from './pending-account';
import { logger } from '../../logger';

// 暫存使用者狀態：等待輸入家庭名稱 / 家庭碼
// MVP 用 in-memory，正式部署需換 Redis
type PendingState = { type: 'awaiting_family_name' | 'awaiting_family_code' };
const pending = new Map<string, PendingState>();

export function getPending(userId: string): PendingState | undefined {
  return pending.get(userId);
}

export function clearPending(userId: string): void {
  pending.delete(userId);
}

export async function handlePostback(event: PostbackEvent): Promise<void> {
  const userId = event.source.userId;
  if (!userId) return;

  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');

  switch (action) {
    case 'create_family':
      pending.set(userId, { type: 'awaiting_family_name' });
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '請輸入家庭名稱（例如：施家、我們的家）' }],
      });
      return;

    case 'join_family':
      pending.set(userId, { type: 'awaiting_family_code' });
      await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: '請輸入 6 碼家庭碼' }],
      });
      return;

    case 'confirm_bill':
      await confirmPendingBill(userId, event.replyToken);
      return;

    case 'cancel_bill':
      await cancelPendingBill(userId, event.replyToken);
      return;

    case 'confirm_add_account':
      await confirmPendingAccount(userId, event.replyToken);
      return;

    case 'cancel_add_account':
      await cancelPendingAccount(userId, event.replyToken);
      return;

    default:
      logger.debug({ action }, 'unknown postback action');
  }
}

// 由 message-text 呼叫：處理「等待家庭名稱 / 家庭碼」狀態
export async function handlePendingInput(params: {
  userId: string;
  replyToken: string;
  text: string;
}): Promise<boolean> {
  const state = pending.get(params.userId);
  if (!state) return false;

  if (state.type === 'awaiting_family_name') {
    const familyName = params.text.trim().slice(0, 20);
    if (!familyName) {
      await lineClient.replyMessage({
        replyToken: params.replyToken,
        messages: [{ type: 'text', text: '家庭名稱不能空白，請再輸入一次' }],
      });
      return true;
    }

    const profile = await lineClient.getProfile(params.userId);
    const { family } = await createFamily({
      ownerLineId: params.userId,
      ownerDisplayName: profile.displayName,
      ownerAvatarUrl: profile.pictureUrl,
      familyName,
    });
    pending.delete(params.userId);

    const inviteUrl = buildInviteUrl(family.familyCode);
    await lineClient.replyMessage({
      replyToken: params.replyToken,
      messages: [
        {
          type: 'text',
          text: `家庭「${family.name}」建立成功！🎉\n\n家庭碼：${family.familyCode}\n邀請連結：${inviteUrl}\n\n把上面連結傳給家人，他們點開就能加入。\n\n之後直接打字記帳即可，例如：午餐 120`,
        },
      ],
    });
    return true;
  }

  if (state.type === 'awaiting_family_code') {
    const code = params.text.trim().toUpperCase();
    const profile = await lineClient.getProfile(params.userId);
    const result = await joinFamily({
      familyCode: code,
      lineUserId: params.userId,
      displayName: profile.displayName,
      avatarUrl: profile.pictureUrl,
    });

    if ('error' in result) {
      const msg =
        result.error === 'not_found'
          ? `找不到家庭碼「${code}」，請確認後再輸入一次`
          : '你已經是這個家庭的成員了';
      await lineClient.replyMessage({
        replyToken: params.replyToken,
        messages: [{ type: 'text', text: msg }],
      });
      return true;
    }

    pending.delete(params.userId);
    await lineClient.replyMessage({
      replyToken: params.replyToken,
      messages: [
        {
          type: 'text',
          text: `成功加入「${result.family.name}」！🎉\n\n之後直接打字記帳即可，例如：午餐 120`,
        },
      ],
    });
    return true;
  }

  return false;
}
