// LINE 文字記帳＋一句話建轉帳（財務中樞 P1-5、P1-6）：對話流程。
//
// 1. 原句先遮罩（卡號、帳號、身分證、手機）才送 Gemini；Gemini 只回意圖＋欄位原文。
// 2. lib/ledger-plan.ts 用程式複核金額、換算日期、判斷公司／外幣／歸屬人；不一致就問、不寫入。
// 3. lib/ledger-resolve.ts 對帳戶：多個候選 → Quick Reply（最多 4 個＋「都不是」）；比不到 → 新增帳戶／新增信用卡／取消。
//    點過的選擇記成別名。所有位置都確定了才一次寫入（不會寫一半）。
// 4. 收支 → recordTransaction；轉帳 → services/transfer.ts（唯一出口）。動到對方個人帳戶 → 待對方確認（D18），
//    LINE 推確認卡給對方。建立者收到確認卡：撤銷（24 小時內、只有建立者）、改帳戶、改金額。
//
// 對話中的暫存狀態放記憶體（同既有 pending-account／pending bill 的做法；重啟會清掉，使用者重說一次即可）。
import { lineClient } from '../client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { parseLedgerText } from '../../ai/gemini';
import { maskSensitive } from '../../lib/mask';
import { buildLedgerPlan, type LedgerParseRaw, type LedgerPlan, type PlanIssue } from '../../lib/ledger-plan';
import { optionLabel, pickKey, resolvePlan, type Question, type ResolvedTransfer, type ResolvedTx } from '../../lib/ledger-resolve';
import { extractAmounts } from '../../lib/amount-text';
import type { MatchCandidate, MemberRef } from '../../lib/account-match';
import { AccessError } from '../../lib/access';
import { TransferRuleError, TEXT_UNDO_WINDOW_MS } from '../../lib/transfer-rules';
import { ymdTaipei } from '../../lib/time-tw';
import { loadAccessScope } from '../../services/access';
import { getBudgetAlert } from '../../services/budget';
import { createCreditCard } from '../../services/creditcard';
import { confirmTransfer, rejectTransfer, replaceTransfer, undoTransfer } from '../../services/transfer';
import {
  createAccountFromText,
  executeTransfer,
  executeTx,
  frequentWithdrawFrom,
  learnAlias,
  loadMatchCandidates,
  loadMembers,
  type ExecutedTransfer,
} from '../../services/text-ledger';
import { confirmRequestMessage, ntd, transferCarousel, txSummaryText, type TransferCardData, type TxLine } from '../ledger-cards';
import { buildQuickFixReply } from './quick-fix';
import { buildAddAccountQuickReply, setPendingAccount } from './pending-account';

type Member = { id: string; familyId: string; displayName: string; lineUserId: string };

// ---- 測試可換掉 Gemini（不打外部 API）與現在時間 ----
type Parser = (masked: string, categories: { name: string; type: 'EXPENSE' | 'INCOME' }[], hints: { paymentNames?: string[]; memberNames?: string[] }) => Promise<LedgerParseRaw | null>;
let parser: Parser = parseLedgerText;
let clock: () => Date = () => new Date();
export function __setLedgerTestHooks(h: { parser?: Parser; clock?: () => Date }) {
  if (h.parser) parser = h.parser;
  if (h.clock) clock = h.clock;
}

// ---- 對話暫存 ----
type QState = { type: 'question'; familyId: string; memberId: string; masked: string; plan: LedgerPlan; picks: Record<string, string>; question: Question; done: number[]; at: number };
type OverpayState = { type: 'overpay'; familyId: string; memberId: string; masked: string; plan: LedgerPlan; picks: Record<string, string>; done: number[]; at: number };
type AmountState = { type: 'amount'; familyId: string; memberId: string; transferId: string; at: number };
type State = QState | OverpayState | AmountState;
const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map<string, State>();

function getState(userId: string): State | undefined {
  const s = states.get(userId);
  if (s && clock().getTime() - s.at > STATE_TTL_MS) {
    states.delete(userId);
    return undefined;
  }
  return s;
}

async function reply(replyToken: string, messages: any[]) {
  await lineClient.replyMessage({ replyToken, messages: messages.slice(0, 5) });
}
const text = (t: string, quickReply?: any) => ({ type: 'text', text: t, ...(quickReply ? { quickReply } : {}) });
const qrPostback = (label: string, data: string, displayText?: string) => ({
  type: 'action' as const,
  action: { type: 'postback' as const, label: label.slice(0, 20), data, displayText: (displayText ?? label).slice(0, 300) },
});

const NOT_LEDGER_TEXT = '我看不出這是一筆記帳 🤔\n試試這樣輸入：\n  午餐 120\n  昨天 晚餐 300\n  台新轉 5000 到國泰\n\n打「選單」可看更多說明。';

function issueText(issues: PlanIssue[]): string {
  const i = issues[0];
  switch (i.code) {
    case 'amount_mismatch':
      return `「${i.segment}」的金額我抓不準（讀到 ${i.geminiAmount}，句子裡的數字是 ${i.found.join('、') || '無'}），這句先不記。\n請再說一次，例如「午餐 120」。`;
    case 'split_mismatch':
      return `本金 ${ntd(i.principal)}＋利息 ${ntd(i.interest)}${i.fee ? `＋手續費 ${ntd(i.fee)}` : ''} 不等於總額 ${ntd(i.total)}，這句先不記。\n請確認後再說一次，例如「還房貸 18000（本金 12000 利息 6000）」。`;
    case 'unknown_currency':
      return `「${i.currencyText}」這個幣別我還不會換算，這句先不記。可以改用台幣金額記。`;
    case 'foreign_transfer':
      return '外幣轉帳目前還不支援，請用台幣金額記。';
  }
}

/** 由 message-text 呼叫：處理「改金額」等待輸入。回 true＝這句被吃掉了。 */
export async function handleLedgerPendingText(userId: string, replyToken: string, t: string): Promise<boolean> {
  const s = getState(userId);
  if (!s || s.type !== 'amount') return false;
  const nums = extractAmounts(t);
  if (nums.length !== 1) {
    states.delete(userId);
    return false; // 不是單純一個金額 → 當一般記帳處理
  }
  states.delete(userId);
  const scope = await loadAccessScope(s.familyId, s.memberId);
  try {
    const created = await replaceTransfer(s.familyId, s.memberId, s.transferId, { amount: nums[0] }, scope, clock());
    const card = await cardFor(s.familyId, created.transfer.id, s.memberId);
    await reply(replyToken, [text(`已改成 ${ntd(nums[0])}（舊的那筆已撤銷）`), ...(card ? [transferCarousel([card])] : [])]);
    await notifyCounterpartIfPending(s.familyId, created.transfer.id);
  } catch (err) {
    await reply(replyToken, [text(transferErrorText(err))]);
  }
  return true;
}

/** 文字記帳主流程 */
export async function handleLedgerText(member: Member, replyToken: string, sentence: string): Promise<void> {
  const masked = maskSensitive(sentence).text;
  const [categories, members, candidates] = await Promise.all([
    prisma.category.findMany({ where: { familyId: member.familyId }, select: { name: true, type: true }, orderBy: { sortOrder: 'asc' } }),
    loadMembers(member.familyId),
    loadAccessScope(member.familyId, member.id).then((scope) => loadMatchCandidates(member.familyId, scope)),
  ]);
  const paymentNames = candidates.filter((c) => c.kind !== 'LIABILITY' && c.writable).map((c) => c.name);
  let raw: LedgerParseRaw | null = null;
  try {
    raw = await parser(masked, categories, { paymentNames, memberNames: members.map((m) => m.displayName) });
  } catch (err) {
    logger.error({ err }, 'ledger parser threw');
  }
  if (!raw || !raw.isLedger || raw.items.length === 0) {
    await reply(replyToken, [text(NOT_LEDGER_TEXT)]);
    return;
  }
  const plan = buildLedgerPlan(raw, masked, { now: clock(), speakerId: member.id, members, categoryNames: categories.map((c) => c.name) });
  if (plan.issues.length) {
    await reply(replyToken, [text(issueText(plan.issues))]);
    return;
  }
  if (plan.items.length === 0) {
    await reply(replyToken, [text(NOT_LEDGER_TEXT)]);
    return;
  }
  await continueFlow(member, replyToken, { masked, plan, picks: {}, done: [] });
}

async function continueFlow(
  member: Member,
  replyToken: string,
  st: { masked: string; plan: LedgerPlan; picks: Record<string, string>; done: number[] },
  opts: { confirmOverpay?: boolean } = {},
) {
  const now = clock();
  const scope = await loadAccessScope(member.familyId, member.id);
  const [candidates, members, freq] = await Promise.all([loadMatchCandidates(member.familyId, scope), loadMembers(member.familyId), frequentWithdrawFrom(member.familyId, member.id, now)]);
  const res = resolvePlan(st.plan, { speakerId: member.id, members, candidates, picks: st.picks, frequentWithdrawFromId: freq });
  if (res.status === 'question') {
    states.set(member.lineUserId, { type: 'question', familyId: member.familyId, memberId: member.id, ...st, question: res.question, at: now.getTime() });
    await reply(replyToken, [questionMessage(res.question, members, member.id)]);
    return;
  }

  // ---- 全部確定：轉帳先建（可能要問溢繳），再記收支 ----
  const done = new Set(st.done);
  const transfers: ExecutedTransfer[] = [];
  for (const step of res.steps) {
    if (step.type !== 'TRANSFER' || done.has(step.index)) continue;
    const r = await executeTransfer(member.familyId, member.id, step, scope, now, { confirmOverpay: opts.confirmOverpay });
    if (!r.ok && r.error instanceof TransferRuleError && r.error.code === 'overpay_needs_confirm') {
      states.set(member.lineUserId, { type: 'overpay', familyId: member.familyId, memberId: member.id, ...st, done: [...done], at: now.getTime() });
      const d = r.error.detail as { newBalance: number; overpaid: number };
      await reply(replyToken, [
        ...(transfers.length ? [transferCarousel(await cardsOf(member, transfers, candidates, members))] : []),
        text(`這張卡本期應繳 ${ntd(d.newBalance)}，這次會溢繳 ${ntd(d.overpaid)}，確定照這個金額記嗎？`, {
          items: [qrPostback('確定溢繳', 'action=lp_overpay'), qrPostback('取消', 'action=lp_cancel', '取消這筆')],
        }),
      ]);
      return;
    }
    transfers.push(r);
    done.add(step.index);
  }
  const txSteps = res.steps.filter((s): s is ResolvedTx => s.type === 'TX' && !done.has(s.index));
  const txs = [];
  for (const step of txSteps) txs.push(await executeTx(member.familyId, member.id, step));
  states.delete(member.lineUserId);

  const messages: any[] = [];
  let quickReply: any;
  if (txs.length) {
    const nameOf = (id: string | null, kind: 'ACCOUNT' | 'CARD') => (id ? candidates.find((c) => c.kind === kind && c.id === id)?.name ?? null : null);
    const lines: TxLine[] = txs.map((t) => ({
      amount: Number(t.amount),
      type: t.category.type,
      label: t.note || t.category.name,
      category: `${t.category.icon ?? ''}${t.category.name}`,
      payName: nameOf(t.creditCardId, 'CARD') ?? nameOf(t.accountId, 'ACCOUNT'),
      date: t.step.item.date,
      ownerName: t.step.item.ownerMemberId ? members.find((m) => m.id === t.step.item.ownerMemberId)?.displayName ?? null : null,
      business: t.step.item.bookTo === 'BUSINESS',
      originalCurrency: t.step.item.originalCurrency,
      originalAmount: t.step.item.originalAmount,
      estimated: t.step.item.amountEstimated,
    }));
    let body = txSummaryText(lines, member.displayName);
    if (txs.some((t) => t.category.type === 'EXPENSE' && t.step.item.bookTo === 'FAMILY')) {
      const alert = await getBudgetAlert(member.familyId, scope);
      if (alert) body += `\n\n${alert}`;
    }
    const others = txs.find((t) => t.step.othersPay)?.step.othersPay;
    if (others) body += `\n\n「${others}」是其他成員的個人帳戶，只有本人能記帳，已先記到預設帳戶。`;
    const unknown = txs.find((t) => t.step.unknownPay)?.step.unknownPay;
    if (unknown) {
      setPendingAccount(member.lineUserId, {
        familyId: member.familyId,
        memberId: member.id,
        name: unknown,
        txnIds: txs.filter((t) => t.step.unknownPay === unknown).map((t) => t.id),
      });
      body += `\n\n💡 你提到的「${unknown}」還不是帳戶，要新增嗎？\n選「信用卡」會先用預設值建立，記得再到記帳簿補額度/結算日/繳費日。`;
      quickReply = buildAddAccountQuickReply(unknown);
    } else if (txs.length === 1 && transfers.length === 0) {
      quickReply = buildQuickFixReply(txs[0].id, txs[0].isShared);
    }
    messages.push(text(body));
  }
  const okTransfers = transfers.filter((t): t is Extract<ExecutedTransfer, { ok: true }> => t.ok);
  if (okTransfers.length) messages.push(transferCarousel(await cardsOf(member, okTransfers, candidates, members)));
  for (const f of transfers.filter((t) => !t.ok)) messages.push(text(`「${f.step.item.segment}」沒有記成：${transferErrorText((f as any).error)}`));
  if (quickReply && messages.length) {
    const last = messages[messages.length - 1];
    if (last.type === 'text') last.quickReply = quickReply;
    else messages[0].quickReply = quickReply;
  }
  await reply(replyToken, messages.length ? messages : [text('這句沒有可以記的內容。')]);
  for (const t of okTransfers) if (t.result.pending) await notifyCounterpartIfPending(member.familyId, t.result.transfer.id);
}

function questionMessage(q: Question, members: MemberRef[], speakerId: string) {
  const roleWord = q.role === 'from' ? '從哪個帳戶' : q.role === 'to' ? '轉到哪裡' : '用哪個付款';
  if (q.type === 'pick') {
    return text(`「${q.raw}」有好幾個對得上，${roleWord}？`, {
      items: [
        ...q.options.map((o) => qrPostback(optionLabel(o, members, speakerId), `action=lp_pick&c=${o.kind}:${o.id}`, `選 ${o.name}`)),
        qrPostback('都不是', 'action=lp_none'),
      ],
    });
  }
  if (q.type === 'create') {
    const typeWord = q.accountType === 'TIME_DEPOSIT' ? '定存帳戶' : q.accountType === 'CASH' ? '現金帳戶' : '帳戶';
    return text(`找不到「${q.raw}」，要建立「${q.raw}」嗎？`, {
      items: [
        qrPostback(`新增${typeWord}`, 'action=lp_new&t=ACCOUNT', `新增帳戶 ${q.raw}`),
        ...(q.allowCard ? [qrPostback('新增信用卡', 'action=lp_new&t=CARD', `新增信用卡 ${q.raw}`)] : []),
        qrPostback('取消', 'action=lp_cancel', '取消'),
      ],
    });
  }
  return text(`${q.message}\n這句先不記。`);
}

/** Quick Reply 的回應（lp_*）與確認卡按鈕（tr_*）。回 true＝處理了。 */
export async function handleLedgerPostback(userId: string, replyToken: string, action: string, params: URLSearchParams): Promise<boolean> {
  if (!action.startsWith('lp_') && !action.startsWith('tr_')) return false;
  const member = await prisma.familyMember.findFirst({ where: { lineUserId: userId }, orderBy: { joinedAt: 'desc' } });
  if (!member) {
    await reply(replyToken, [text('請先建立或加入家庭。')]);
    return true;
  }
  try {
    if (action.startsWith('lp_')) await onPlanPostback(member, replyToken, action, params);
    else await onTransferPostback(member, replyToken, action, params);
  } catch (err) {
    // 規則／權限錯誤是預期內的（回給使用者看）；其他錯誤 transferErrorText 會記 log
    await reply(replyToken, [text(transferErrorText(err))]).catch(() => undefined);
  }
  return true;
}

async function onPlanPostback(member: Member, replyToken: string, action: string, params: URLSearchParams) {
  const s = getState(member.lineUserId);
  if (action === 'lp_cancel') {
    states.delete(member.lineUserId);
    await reply(replyToken, [text('好的，這句沒有記。')]);
    return;
  }
  if (action === 'lp_overpay') {
    if (!s || s.type !== 'overpay') return reply(replyToken, [text('這個問題已經過期了，請再說一次。')]);
    return continueFlow(member, replyToken, s, { confirmOverpay: true });
  }
  if (!s || s.type !== 'question') {
    await reply(replyToken, [text('這個問題已經過期了，請再說一次。')]);
    return;
  }
  const q = s.question;
  const key = pickKey(q.index, q.role);
  const scope = await loadAccessScope(member.familyId, member.id);
  if (action === 'lp_pick' && q.type === 'pick') {
    const c = params.get('c') ?? '';
    const opt = q.options.find((o) => `${o.kind}:${o.id}` === c);
    if (!opt) return reply(replyToken, [text('這個選項已經不在了，請再說一次。')]);
    await learnAlias(member.familyId, opt, q.raw, scope);
    return continueFlow(member, replyToken, { ...s, picks: { ...s.picks, [key]: c } });
  }
  if (action === 'lp_none' && q.type === 'pick') {
    // 都不是 → 改問要不要新增（同比不到的情形）
    const create: Question = { type: 'create', index: q.index, role: q.role, raw: q.raw, accountType: 'BANK', allowCard: q.role !== 'from' };
    states.set(member.lineUserId, { ...s, question: create, at: clock().getTime() });
    return reply(replyToken, [questionMessage(create, await loadMembers(member.familyId), member.id)]);
  }
  if (action === 'lp_new' && q.type === 'create') {
    const t = params.get('t');
    let picked: string;
    if (t === 'CARD' && q.allowCard) {
      const existing = await prisma.creditCard.findFirst({ where: { familyId: member.familyId, name: q.raw } });
      const card = existing ?? (await createCreditCard({ familyId: member.familyId, name: q.raw }));
      picked = `CARD:${card.id}`;
    } else {
      const acc = await createAccountFromText(member.familyId, q.raw, q.accountType);
      picked = `ACCOUNT:${acc.id}`;
    }
    return continueFlow(member, replyToken, { ...s, picks: { ...s.picks, [key]: picked } });
  }
  await reply(replyToken, [text('這個問題已經過期了，請再說一次。')]);
}

async function onTransferPostback(member: Member, replyToken: string, action: string, params: URLSearchParams) {
  const id = params.get('id') ?? '';
  const now = clock();
  const scope = await loadAccessScope(member.familyId, member.id);
  switch (action) {
    case 'tr_undo': {
      await undoTransfer(member.familyId, member.id, id, scope, now, { withinMs: TEXT_UNDO_WINDOW_MS });
      await reply(replyToken, [text('已撤銷這筆轉帳，餘額、帳單、負債都還原了。')]);
      await notifyCounterpartUndone(member.familyId, id);
      return;
    }
    case 'tr_amt': {
      await assertEditable(member, id);
      states.set(member.lineUserId, { type: 'amount', familyId: member.familyId, memberId: member.id, transferId: id, at: now.getTime() });
      await reply(replyToken, [text('請輸入新的金額（只打數字，例如 24261）')]);
      return;
    }
    case 'tr_acct': {
      const tr = await assertEditable(member, id);
      const items = [];
      if (tr.fromAccountId) items.push(qrPostback('改來源帳戶', `action=tr_acct_side&id=${id}&s=from`));
      if (tr.toAccountId || tr.toCreditCardId) items.push(qrPostback('改目的帳戶', `action=tr_acct_side&id=${id}&s=to`));
      if (!items.length) return reply(replyToken, [text('這筆的帳戶要到記帳簿改。')]);
      await reply(replyToken, [text('要改哪一端？', { items })]);
      return;
    }
    case 'tr_acct_side': {
      const tr = await assertEditable(member, id);
      const side = params.get('s') === 'to' ? 'to' : 'from';
      const cands = await loadMatchCandidates(member.familyId, scope);
      const current = side === 'from' ? tr.fromAccountId : tr.toAccountId ?? tr.toCreditCardId;
      const allowCard = side === 'to' && (tr.kind === 'ACCOUNT' || tr.kind === 'CARD_PAYMENT');
      const opts = cands
        .filter((c) => c.id !== current && (c.kind === 'ACCOUNT' || (allowCard && c.kind === 'CARD')))
        .filter((c) => (side === 'from' ? c.writable : true))
        .slice(0, 12);
      if (!opts.length) return reply(replyToken, [text('沒有其他可以選的帳戶。')]);
      const members = await loadMembers(member.familyId);
      await reply(replyToken, [
        text(side === 'from' ? '改成從哪個帳戶？' : '改成轉到哪裡？', {
          items: opts.map((o) => qrPostback(optionLabel(o, members, member.id), `action=tr_acct_set&id=${id}&s=${side}&c=${o.kind}:${o.id}`, `改成 ${o.name}`)),
        }),
      ]);
      return;
    }
    case 'tr_acct_set': {
      const side = params.get('s') === 'to' ? 'to' : 'from';
      const [kind, cid] = (params.get('c') ?? '').split(':');
      const changes = side === 'from' ? { fromAccountId: cid } : kind === 'CARD' ? { toCreditCardId: cid } : { toAccountId: cid };
      const created = await replaceTransfer(member.familyId, member.id, id, changes, scope, now);
      const card = await cardFor(member.familyId, created.transfer.id, member.id);
      await reply(replyToken, [text('已改好（舊的那筆已撤銷）'), ...(card ? [transferCarousel([card])] : [])]);
      await notifyCounterpartIfPending(member.familyId, created.transfer.id);
      return;
    }
    case 'tr_ok': {
      const r = await confirmTransfer(member.familyId, member.id, id, now);
      await reply(replyToken, [text(`已確認，${ntd(Number(r.transfer.amount))} 記進你的帳戶了。`)]);
      await notifyCreator(member.familyId, id, `${member.displayName} 確認了這筆轉帳，兩邊帳戶都已記好。`);
      return;
    }
    case 'tr_no': {
      await rejectTransfer(member.familyId, member.id, id, now);
      await reply(replyToken, [text('已拒絕，這筆不會動到你的帳戶。')]);
      await notifyCreator(member.familyId, id, `${member.displayName} 拒絕了這筆轉帳，沒有記進任何帳戶。`);
      return;
    }
    default:
      await reply(replyToken, [text('這個按鈕已經失效了。')]);
  }
}

async function assertEditable(member: Member, id: string) {
  const tr = await prisma.transfer.findFirst({ where: { id, familyId: member.familyId } });
  if (!tr) throw new AccessError(404, 'not_found', 'transfer not found');
  if (tr.memberId !== member.id) throw new TransferRuleError('not_creator', 'only creator', 403);
  if (tr.undoneAt) throw new TransferRuleError('already_undone', 'undone', 409);
  if (clock().getTime() - tr.createdAt.getTime() > TEXT_UNDO_WINDOW_MS) throw new TransferRuleError('undo_window_passed', '超過 24 小時', 403);
  return tr;
}

export function transferErrorText(err: unknown): string {
  if (err instanceof TransferRuleError) {
    switch (err.code) {
      case 'not_creator':
        return '只有記這筆的人可以撤銷或修改。';
      case 'undo_window_passed':
        return '已經超過 24 小時，請到記帳簿撤銷或修改。';
      case 'already_undone':
        return '這筆已經撤銷了。';
      case 'not_counterpart':
        return '這筆要由被動到帳戶的那位確認。';
      case 'not_pending':
        return err.message;
      case 'two_counterparts':
        return '兩端都是別人的個人帳戶，請由本人記這筆。';
      case 'exceeds_principal':
        return `還款金額超過剩餘本金（${err.message}）。`;
      default:
        return err.message;
    }
  }
  if (err instanceof AccessError) return err.status === 404 ? '找不到這筆（可能看不到這個帳戶）。' : '這個帳戶只有本人能動。';
  logger.error({ err }, 'ledger action failed');
  return '處理失敗了，請稍後再試或到記帳簿操作。';
}

// ---- 確認卡資料 ----

async function namesFor(familyId: string) {
  const [accs, cards, lias, members] = await Promise.all([
    prisma.account.findMany({ where: { familyId }, select: { id: true, name: true } }),
    prisma.creditCard.findMany({ where: { familyId }, select: { id: true, name: true } }),
    prisma.liability.findMany({ where: { familyId }, select: { id: true, name: true } }),
    prisma.familyMember.findMany({ where: { familyId }, select: { id: true, displayName: true, lineUserId: true } }),
  ]);
  return {
    acc: new Map(accs.map((a) => [a.id, a.name])),
    card: new Map(cards.map((c) => [c.id, c.name])),
    lia: new Map(lias.map((l) => [l.id, l.name])),
    members,
  };
}

async function cardFor(familyId: string, transferId: string, viewerId: string, extra: Partial<TransferCardData> = {}): Promise<TransferCardData | null> {
  const tr = await prisma.transfer.findFirst({ where: { id: transferId, familyId }, include: { cardStatement: true } });
  if (!tr) return null;
  const nm = await namesFor(familyId);
  const fromName = (tr.fromAccountId && nm.acc.get(tr.fromAccountId)) || (tr.fromLiabilityId && nm.lia.get(tr.fromLiabilityId)) || '';
  const toName = (tr.toAccountId && nm.acc.get(tr.toAccountId)) || (tr.toCreditCardId && nm.card.get(tr.toCreditCardId)) || (tr.toLiabilityId && nm.lia.get(tr.toLiabilityId)) || '';
  const pendingFor = tr.confirmStatus === 'PENDING' || tr.confirmStatus === 'ONE_SIDED' ? nm.members.find((m) => m.id === tr.counterpartMemberId)?.displayName ?? '對方' : null;
  const st = tr.cardStatement;
  let statementLine: string | null = null;
  if (tr.kind === 'CARD_PAYMENT' && !pendingFor) {
    if (st) {
      const due = Number(st.newBalance);
      const paid = Number(st.paidAmount);
      const m = Number(ymdTaipei(st.statementDate).slice(5, 7));
      statementLine = `已沖 ${m} 月帳單（應繳 ${ntd(due)}，${paid >= due ? (paid > due ? `已結清，溢繳 ${ntd(paid - due)}` : '已結清') : `還差 ${ntd(due - paid)}`}）`;
    } else {
      statementLine = '這張卡還沒有建帳單，只記繳款';
    }
  }
  const date = ymdTaipei(tr.transferredAt);
  return {
    id: tr.id,
    kind: tr.kind,
    fromName,
    toName,
    amount: Number(tr.amount),
    interest: tr.interest == null ? null : Number(tr.interest),
    fee: tr.fee == null ? null : Number(tr.fee),
    date,
    dateIsToday: date === ymdTaipei(clock()),
    statementLine,
    pendingFor,
    canEdit: !pendingFor && tr.memberId === viewerId,
    ...extra,
  };
}

async function cardsOf(member: Member, results: ExecutedTransfer[], _c: MatchCandidate[], _m: MemberRef[]): Promise<TransferCardData[]> {
  const out: TransferCardData[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    const step: ResolvedTransfer = r.step;
    const card = await cardFor(member.familyId, r.result.transfer.id, member.id, {
      dateIsToday: !step.item.date.ok,
      dateUnparsed: step.item.date.explicit && !step.item.date.ok,
      splitLine: r.split ? `依攤還表拆：本金 ${ntd(r.split.principal)}、利息 ${ntd(r.split.interest)}，不對請撤銷重記` : null,
    });
    if (card) out.push(card);
  }
  return out;
}

async function push(to: string, messages: any[]) {
  try {
    await lineClient.pushMessage({ to, messages });
  } catch (err) {
    logger.error({ err }, 'ledger push failed');
  }
}

/** D18：推確認卡給被動到帳戶的那位 */
export async function notifyCounterpartIfPending(familyId: string, transferId: string) {
  const tr = await prisma.transfer.findFirst({ where: { id: transferId, familyId } });
  if (!tr || tr.confirmStatus !== 'PENDING' || !tr.counterpartMemberId) return;
  const nm = await namesFor(familyId);
  const cp = nm.members.find((m) => m.id === tr.counterpartMemberId);
  const creator = nm.members.find((m) => m.id === tr.memberId);
  if (!cp) return;
  const card = await cardFor(familyId, transferId, cp.id);
  if (!card) return;
  await push(cp.lineUserId, [confirmRequestMessage({ id: tr.id, creatorName: creator?.displayName ?? '家人', kind: tr.kind, fromName: card.fromName, toName: card.toName, amount: card.amount, date: card.date })]);
}

async function notifyCreator(familyId: string, transferId: string, msg: string) {
  const tr = await prisma.transfer.findFirst({ where: { id: transferId, familyId }, select: { memberId: true } });
  const m = tr && (await prisma.familyMember.findUnique({ where: { id: tr.memberId }, select: { lineUserId: true } }));
  if (m) await push(m.lineUserId, [text(msg)]);
}

async function notifyCounterpartUndone(familyId: string, transferId: string) {
  const tr = await prisma.transfer.findFirst({ where: { id: transferId, familyId }, select: { counterpartMemberId: true, confirmStatus: true, amount: true } });
  if (!tr?.counterpartMemberId) return;
  const m = await prisma.familyMember.findUnique({ where: { id: tr.counterpartMemberId }, select: { lineUserId: true } });
  if (m) await push(m.lineUserId, [text(`對方撤銷了一筆 ${ntd(Number(tr.amount))} 的轉帳，不用再確認了。`)]);
}
