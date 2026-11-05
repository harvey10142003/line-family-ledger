// 文字記帳／一句話建轉帳：把 Gemini 回的「意圖＋欄位原文」變成程式確認過的計畫（規格 3.10.2、3.10.5）。純函式。
//
// 分工鐵則：Gemini 只回意圖與欄位原文（日期原文、帳戶原文、歸屬人原文、幣別原文、金額）；
// 這裡用程式做：
// - 金額複核：從（遮罩後的）原句用規則再抓一次數字，Gemini 的每個金額都要在原句裡找得到，不然就問。
// - 本金＋利息＋手續費＝總額：程式算，不等就問（只說總額的還房貸，交給攤還表拆）。
// - 日期：台北時區換算（lib/date-text.ts）；Gemini 回的日期原文不在原句裡就不採信，改用規則從片段抓。
// - 公司：片段有「公司」字樣 → bookTo=BUSINESS、報帳狀態 PENDING（代墊公司費用）。
// - 外幣：存原幣＋原幣金額，台幣用參考匯率估（amountEstimated）。
// - 歸屬人：只有「幫 Apple 記」「替 Apple」「Apple 的…」這種寫法才算；「跟 Apple 吃飯」不算（那是共同支出）。
import type { TransferKind } from '@prisma/client';
import type { FxBasis } from './fx-rates';
import { amountInSentence, currencyCode, currencyInText, estimateTwd, extractAmounts, referenceRates } from './amount-text';
import { findDateText, resolveDateText, type ResolvedDate } from './date-text';
import { baseNormalize, type MemberRef } from './account-match';
import { isTransferKind } from './transfer-rules';

// ---- Gemini 回的形狀（ai/gemini.ts 的 responseSchema 與這裡一致）----
export type LedgerIntent = 'EXPENSE' | 'INCOME' | 'TRANSFER';

export interface LedgerItemRaw {
  intent: LedgerIntent;
  segment: string; // 原句中屬於這一筆的片段
  amount: number; // 這一筆的金額（轉帳＝使用者說的總額）
  categoryName: string; // 收支才有
  note: string;
  dateText: string;
  accountText: string; // 收支的付款方式原文
  ownerText: string; // 歸屬人原文（幫 Apple 記 → Apple）
  currencyText: string; // 幣別原文（美金、日圓）
  transferKind: string; // TransferKind 或空字串
  fromText: string;
  toText: string;
  counterpartyText: string; // 借出、借入、收回的對象（小明）
  principal: number;
  interest: number;
  fee: number;
}

export interface LedgerParseRaw {
  isLedger: boolean;
  sharedAccountText: string;
  sharedDateText: string;
  items: LedgerItemRaw[];
}

// ---- 程式確認後的計畫 ----
export interface PlannedTx {
  type: 'TX';
  txType: 'EXPENSE' | 'INCOME';
  amount: number; // 台幣（外幣時是估的）
  originalCurrency: string | null;
  originalAmount: number | null;
  amountEstimated: boolean;
  fx?: { rate: number; basis: FxBasis; rateDate: string | null }; // 外幣：用了哪個匯率（services/fx.ts applyFxToPlan 依消費日填）
  categoryName: string;
  note: string;
  date: ResolvedDate;
  accountText: string | null;
  ownerMemberId: string | null; // 歸屬人（不是說話者時才有值）
  bookTo: 'FAMILY' | 'BUSINESS';
  segment: string;
}

export interface PlannedTransfer {
  type: 'TRANSFER';
  kind: TransferKind;
  amount: number; // 本金／轉帳金額（不含利息、手續費）
  interest: number;
  fee: number;
  total: number | null; // 使用者說的總額（有拆本金利息時）
  needsSplit: boolean; // 還貸款只說總額 → 依攤還表拆
  date: ResolvedDate;
  fromText: string | null;
  toText: string | null;
  counterparty: string | null;
  note: string;
  segment: string;
}

export type PlannedItem = PlannedTx | PlannedTransfer;

export type PlanIssue =
  | { code: 'amount_mismatch'; segment: string; geminiAmount: number; found: number[] }
  | { code: 'split_mismatch'; segment: string; total: number; principal: number; interest: number; fee: number }
  | { code: 'unknown_currency'; segment: string; currencyText: string }
  | { code: 'foreign_transfer'; segment: string };

export interface LedgerPlan {
  items: PlannedItem[];
  issues: PlanIssue[];
}

export interface PlanContext {
  now: Date;
  speakerId: string;
  members: MemberRef[];
  categoryNames: string[];
  rates?: Record<string, number>;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? r2(v) : 0);

/** 片段是不是原句的一部分（正規化後比對）；不是就不拿來判斷公司、日期 */
function segmentOf(sentence: string, seg: string, single: boolean): string {
  const S = baseNormalize(sentence);
  const g = baseNormalize(seg);
  if (g && S.includes(g)) return seg;
  return single ? sentence : seg;
}

/** 歸屬人：只認「幫／替／給 X 記」「X 的」，而且 X 要是家庭成員（不分大小寫）。說話者本人回 null。 */
export function resolveOwner(ownerText: string, segment: string, ctx: PlanContext): string | null {
  const t = baseNormalize(ownerText);
  const segN = baseNormalize(segment);
  const candidates = [...ctx.members].sort((a, b) => b.displayName.length - a.displayName.length);
  for (const m of candidates) {
    const dn = baseNormalize(m.displayName);
    if (!dn) continue;
    const named = t ? t.includes(dn) || dn.includes(t) : false;
    const pattern = new RegExp(`(幫|替|給|代)${escapeRe(dn)}|${escapeRe(dn)}的`);
    if ((named || !t) && pattern.test(segN)) return m.id === ctx.speakerId ? null : m.id;
  }
  return null;
}

function escapeRe(x: string) {
  return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickDate(item: LedgerItemRaw, sentence: string, segment: string, sharedDateText: string, now: Date): ResolvedDate {
  const S = baseNormalize(sentence);
  const own = s(item.dateText);
  if (own && S.includes(baseNormalize(own))) return resolveDateText(own, now);
  const fromSeg = findDateText(segment);
  if (fromSeg) return resolveDateText(fromSeg, now);
  const shared = s(sharedDateText);
  if (shared && S.includes(baseNormalize(shared))) return resolveDateText(shared, now);
  return resolveDateText('', now);
}

/** 句子只有收支沒寫轉帳、Gemini 卻回轉帳時的保險：轉帳一定要有「轉、繳、領、存、還、借」之類的字。 */
const TRANSFER_WORDS = /轉|繳|領|提款|提領|存|還|借|匯/;

export function buildLedgerPlan(raw: LedgerParseRaw, maskedSentence: string, ctx: PlanContext): LedgerPlan {
  const items: PlannedItem[] = [];
  const issues: PlanIssue[] = [];
  if (!raw || !raw.isLedger || !Array.isArray(raw.items)) return { items, issues };
  const found = extractAmounts(maskedSentence);
  const rates = ctx.rates ?? referenceRates();
  const rawItems = raw.items.filter((it) => it && num(it.amount) > 0);
  const single = rawItems.length === 1;

  for (const it of rawItems) {
    const segment = segmentOf(maskedSentence, s(it.segment), single);
    const amount = num(it.amount);
    const date = pickDate(it, maskedSentence, segment, raw.sharedDateText, ctx.now);

    let intent: LedgerIntent = it.intent === 'TRANSFER' || it.intent === 'INCOME' ? it.intent : 'EXPENSE';
    if (intent === 'TRANSFER' && !TRANSFER_WORDS.test(segment) && !TRANSFER_WORDS.test(maskedSentence)) intent = 'EXPENSE';

    if (intent === 'TRANSFER') {
      const kind: TransferKind = isTransferKind(it.transferKind) ? it.transferKind : 'ACCOUNT';
      if (currencyInText(segment) || (currencyCode(it.currencyText) && currencyCode(it.currencyText) !== 'TWD')) {
        issues.push({ code: 'foreign_transfer', segment });
        continue;
      }
      let principal = num(it.principal);
      const interest = num(it.interest);
      const fee = num(it.fee);
      // 每個 Gemini 給的數字都要在原句找得到
      for (const v of [amount, principal, interest, fee]) {
        if (v > 0 && !amountInSentence(v, found)) {
          issues.push({ code: 'amount_mismatch', segment, geminiAmount: v, found });
        }
      }
      let total: number | null = null;
      let transferAmount = amount;
      let needsSplit = false;
      if (principal > 0 || interest > 0) {
        if (principal === 0) principal = r2(amount - interest - fee);
        const sum = r2(principal + interest + fee);
        if (Math.abs(sum - amount) < 0.005) {
          total = amount;
        } else if (Math.abs(principal - amount) < 0.005 && amountInSentence(sum, found)) {
          total = sum; // Gemini 把本金放進 amount、總額另外寫在句子裡
        } else {
          issues.push({ code: 'split_mismatch', segment, total: amount, principal, interest, fee });
          continue;
        }
        transferAmount = principal;
      } else if (kind === 'LOAN_REPAY') {
        needsSplit = true; // 只說「還房貸 18000」：依攤還表算本期本金和利息
      }
      items.push({
        type: 'TRANSFER',
        kind,
        amount: transferAmount,
        interest,
        fee,
        total,
        needsSplit,
        date,
        fromText: s(it.fromText) || null,
        toText: s(it.toText) || null,
        counterparty: s(it.counterpartyText) || null,
        note: s(it.note),
        segment,
      });
      continue;
    }

    if (!amountInSentence(amount, found)) {
      issues.push({ code: 'amount_mismatch', segment, geminiAmount: amount, found });
      continue;
    }
    const txType = intent === 'INCOME' ? 'INCOME' : 'EXPENSE';
    const curRaw = s(it.currencyText);
    let currency = currencyCode(curRaw) ?? currencyInText(segment);
    if (curRaw && !currency) {
      issues.push({ code: 'unknown_currency', segment, currencyText: curRaw });
      continue;
    }
    if (currency === 'TWD') currency = null;
    let twd = amount;
    if (currency) {
      const est = estimateTwd(amount, currency, rates);
      if (est == null) {
        issues.push({ code: 'unknown_currency', segment, currencyText: curRaw || currency });
        continue;
      }
      twd = est;
    }
    let categoryName = s(it.categoryName);
    if (!ctx.categoryNames.includes(categoryName)) categoryName = txType === 'INCOME' ? '其他收入' : '其他支出';
    items.push({
      type: 'TX',
      txType,
      amount: twd,
      originalCurrency: currency,
      originalAmount: currency ? amount : null,
      amountEstimated: !!currency,
      categoryName,
      note: s(it.note),
      date,
      accountText: s(it.accountText) || s(raw.sharedAccountText) || null,
      ownerMemberId: resolveOwner(s(it.ownerText), segment, ctx),
      bookTo: /公司/.test(segment) ? 'BUSINESS' : 'FAMILY',
      segment,
    });
  }
  return { items, issues };
}
