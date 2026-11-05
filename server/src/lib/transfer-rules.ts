// 轉帳引擎的規則（財務中樞 P1-4，規格 2.5、3.10.1、4.3）。純函式，不碰資料庫。
// 會寫資料庫的單一出口在 services/transfer.ts，它只透過這裡判斷「這個組合合不合法」「要連帶記哪些收支」。
//
// 核心原則：轉帳本身永遠不算收入也不算支出，只移動餘額（帳戶 ↔ 帳戶／卡／負債）。
// 會另外產生收支的只有：利息（還貸款＝支出；收回借款、定存解約或到期＝收入）與手續費（支出）。
import type { AccountType, CardStatementStatus, LiabilityDirection, TransferConfirmStatus, TransferKind, TransferSide } from '@prisma/client';

export const TRANSFER_KINDS: readonly TransferKind[] = [
  'ACCOUNT',
  'CARD_PAYMENT',
  'CASH_WITHDRAW',
  'CASH_DEPOSIT',
  'TIME_DEPOSIT',
  'LOAN_REPAY',
  'LEND',
  'BORROW',
  'COLLECT',
  'SPOUSE',
] as const;

export function isTransferKind(v: unknown): v is TransferKind {
  return typeof v === 'string' && (TRANSFER_KINDS as readonly string[]).includes(v);
}

export type Endpoint =
  | { type: 'ACCOUNT'; id: string; accountType: AccountType; ownerMemberId: string | null }
  | { type: 'CARD'; id: string }
  | { type: 'LIABILITY'; id: string; direction: LiabilityDirection };

export class TransferRuleError extends Error {
  constructor(
    public readonly code:
      | 'invalid_kind'
      | 'invalid_shape'
      | 'same_endpoint'
      | 'invalid_amount'
      | 'interest_not_allowed'
      | 'split_mismatch'
      | 'exceeds_principal'
      | 'overpay_needs_confirm'
      | 'already_undone'
      | 'not_creator'
      | 'not_counterpart'
      | 'not_pending'
      | 'undo_window_passed'
      | 'two_counterparts',
    message: string,
    public readonly status: 400 | 403 | 409 = 400,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TransferRuleError';
  }
}

const isAcc = (e: Endpoint | null): e is Extract<Endpoint, { type: 'ACCOUNT' }> => e?.type === 'ACCOUNT';
const isLia = (e: Endpoint | null, dir: LiabilityDirection): boolean => e?.type === 'LIABILITY' && e.direction === dir;

/**
 * 每種轉帳允許的「來源 → 目的」組合（規格 3.10.1）：
 * - ACCOUNT        帳戶 → 帳戶（一般轉帳，類型不限，與舊版相同）
 * - CARD_PAYMENT   帳戶 → 信用卡
 * - CASH_WITHDRAW  非現金帳戶 → 現金帳戶
 * - CASH_DEPOSIT   現金帳戶 → 非現金帳戶
 * - TIME_DEPOSIT   帳戶 ↔ 帳戶，恰好一端是定存帳戶（轉定存＝活存→定存；解約／到期＝定存→活存）
 * - LOAN_REPAY     帳戶 → 負債（我們欠別人，BORROWED），只放本金
 * - LEND           帳戶 → 借出（別人欠我們，LENT）
 * - BORROW         負債（BORROWED）→ 帳戶（借入）
 * - COLLECT        借出（LENT）→ 帳戶（收回）
 * - SPOUSE         某位成員的個人帳戶 → 另一位成員的個人帳戶
 */
export function checkShape(kind: TransferKind, from: Endpoint | null, to: Endpoint | null): void {
  const bad = (why: string): never => {
    throw new TransferRuleError('invalid_shape', `${kind}: ${why}`);
  };
  if (!from || !to) bad('需要來源與目的各一個');
  if (from!.type === to!.type && from!.id === to!.id) {
    throw new TransferRuleError('same_endpoint', 'from/to must differ');
  }
  switch (kind) {
    case 'ACCOUNT':
      if (!isAcc(from) || !isAcc(to)) bad('來源與目的都要是帳戶');
      return;
    case 'CARD_PAYMENT':
      if (!isAcc(from) || to!.type !== 'CARD') bad('帳戶 → 信用卡');
      return;
    case 'CASH_WITHDRAW':
      if (!isAcc(from) || !isAcc(to) || from.accountType === 'CASH' || to.accountType !== 'CASH') bad('非現金帳戶 → 現金帳戶');
      return;
    case 'CASH_DEPOSIT':
      if (!isAcc(from) || !isAcc(to) || from.accountType !== 'CASH' || to.accountType === 'CASH') bad('現金帳戶 → 非現金帳戶');
      return;
    case 'TIME_DEPOSIT': {
      if (!isAcc(from) || !isAcc(to)) bad('來源與目的都要是帳戶');
      const f = (from as Extract<Endpoint, { type: 'ACCOUNT' }>).accountType === 'TIME_DEPOSIT';
      const t = (to as Extract<Endpoint, { type: 'ACCOUNT' }>).accountType === 'TIME_DEPOSIT';
      if (f === t) bad('恰好一端要是定存帳戶');
      return;
    }
    case 'LOAN_REPAY':
      if (!isAcc(from) || !isLia(to, 'BORROWED')) bad('帳戶 → 負債（借入的）');
      return;
    case 'LEND':
      if (!isAcc(from) || !isLia(to, 'LENT')) bad('帳戶 → 借出');
      return;
    case 'BORROW':
      if (!isLia(from, 'BORROWED') || !isAcc(to)) bad('負債（借入的）→ 帳戶');
      return;
    case 'COLLECT':
      if (!isLia(from, 'LENT') || !isAcc(to)) bad('借出 → 帳戶');
      return;
    case 'SPOUSE': {
      if (!isAcc(from) || !isAcc(to)) return bad('來源與目的都要是帳戶');
      const fo = from.ownerMemberId;
      const tOwner = to.ownerMemberId;
      if (!fo || !tOwner || fo === tOwner) bad('兩端要是不同成員的個人帳戶（共同帳戶請用一般轉帳）');
      return;
    }
    default:
      throw new TransferRuleError('invalid_kind', `unknown kind ${String(kind)}`);
  }
}

export type LinkedRole = 'INTEREST_EXPENSE' | 'INTEREST_INCOME' | 'FEE';

/** 連帶記的收支要用的分類（沒有就建立）。 */
export const LINKED_CATEGORY: Record<LinkedRole, { name: string; type: 'EXPENSE' | 'INCOME' }> = {
  INTEREST_EXPENSE: { name: '貸款利息', type: 'EXPENSE' },
  INTEREST_INCOME: { name: '利息收入', type: 'INCOME' },
  FEE: { name: '手續費', type: 'EXPENSE' },
};

export interface LinkedEntry {
  role: LinkedRole;
  accountId: string; // 這筆收支記在哪個帳戶
  amount: number;
}

/**
 * 依種類算出這次轉帳要「另外」記的收支。轉帳本身不在這裡（它不算收支）。
 * - 利息：LOAN_REPAY → 支出（從來源帳戶付）；COLLECT、定存→活存的 TIME_DEPOSIT → 收入（進目的帳戶）。
 *   其他種類帶利息 → 丟錯（規格 3.10.1 表格以外的情形一律不算收支）。
 * - 手續費：任何種類都可以有，記在「付錢的那個帳戶」：來源是帳戶就記來源，來源是負債（借入、收回）就記目的帳戶。
 */
export function linkedEntries(
  kind: TransferKind,
  from: Endpoint,
  to: Endpoint,
  extra: { interest?: number | null; fee?: number | null },
): LinkedEntry[] {
  const out: LinkedEntry[] = [];
  const interest = extra.interest ?? 0;
  const fee = extra.fee ?? 0;
  if (interest < 0 || fee < 0) throw new TransferRuleError('invalid_amount', 'interest/fee must be >= 0');
  if (interest > 0) {
    if (kind === 'LOAN_REPAY' && from.type === 'ACCOUNT') {
      out.push({ role: 'INTEREST_EXPENSE', accountId: from.id, amount: interest });
    } else if (kind === 'COLLECT' && to.type === 'ACCOUNT') {
      out.push({ role: 'INTEREST_INCOME', accountId: to.id, amount: interest });
    } else if (kind === 'TIME_DEPOSIT' && from.type === 'ACCOUNT' && from.accountType === 'TIME_DEPOSIT' && to.type === 'ACCOUNT') {
      out.push({ role: 'INTEREST_INCOME', accountId: to.id, amount: interest });
    } else {
      throw new TransferRuleError('interest_not_allowed', `${kind} 不會產生利息（只有還貸款、收回借款、定存解約／到期可以帶利息）`);
    }
  }
  if (fee > 0) {
    const payer = from.type === 'ACCOUNT' ? from.id : to.type === 'ACCOUNT' ? to.id : null;
    if (!payer) throw new TransferRuleError('invalid_shape', 'fee needs an account endpoint');
    out.push({ role: 'FEE', accountId: payer, amount: fee });
  }
  return out;
}

/**
 * 轉帳對負債剩餘本金的影響（正＝增加）。principalToo＝原始本金也一起加（借出、借入是「又多借了」）。
 * 還款與收回只減剩餘本金，原始本金不動。
 */
export function liabilityEffect(kind: TransferKind, amount: number): { side: 'from' | 'to'; current: number; principalToo: boolean } | null {
  switch (kind) {
    case 'LOAN_REPAY':
      return { side: 'to', current: -amount, principalToo: false };
    case 'LEND':
      return { side: 'to', current: amount, principalToo: true };
    case 'BORROW':
      return { side: 'from', current: amount, principalToo: true };
    case 'COLLECT':
      return { side: 'from', current: -amount, principalToo: false };
    default:
      return null;
  }
}

/** 本金＋利息＋手續費要等於使用者說的總額（有給總額才檢查；容許 0.005 元以內的浮點誤差）。 */
export function checkSplit(total: number | null | undefined, amount: number, interest = 0, fee = 0): void {
  if (total == null) return;
  if (Math.abs(total - (amount + interest + fee)) > 0.005) {
    throw new TransferRuleError('split_mismatch', `本金 ${amount}＋利息 ${interest}＋手續費 ${fee} ≠ 總額 ${total}`, 400, {
      total,
      amount,
      interest,
      fee,
    });
  }
}

/**
 * 信用卡帳單繳款後的狀態：
 * - 已繳 ≥ 本期應繳 → PAID（溢繳也是 PAID，多出來的回報在 overpaid）
 * - 0 < 已繳 < 應繳 → PARTIAL
 * - 已繳 0 → 過了繳款截止日是 OVERDUE，否則 OPEN（撤銷繳款後也照這條回到原狀）
 */
export function statementStatus(newBalance: number, paidAmount: number, dueDate: Date, now: Date = new Date()): {
  status: CardStatementStatus;
  remaining: number;
  overpaid: number;
} {
  const paid = Math.round(paidAmount * 100) / 100;
  const due = Math.round(newBalance * 100) / 100;
  const remaining = Math.max(Math.round((due - paid) * 100) / 100, 0);
  const overpaid = Math.max(Math.round((paid - due) * 100) / 100, 0);
  let status: CardStatementStatus;
  if (paid > 0 && paid >= due) status = 'PAID';
  else if (paid > 0) status = 'PARTIAL';
  else if (due <= 0) status = 'PAID';
  else status = dueDate.getTime() < now.getTime() ? 'OVERDUE' : 'OPEN';
  return { status, remaining, overpaid };
}

/** 金額正規化：正數、四捨五入到分。不合法丟錯。 */
export function money(v: unknown, field: string, opts: { allowZero?: boolean } = {}): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || (!opts.allowZero && n === 0)) {
    throw new TransferRuleError('invalid_amount', `${field} must be a positive number`);
  }
  return Math.round(n * 100) / 100;
}

/**
 * D18：這筆轉帳哪幾端算進帳戶餘額。
 * - CONFIRMED：兩端都算（舊資料、LIFF 手動、共同帳戶、自己的帳戶）
 * - PENDING（等對方確認）、REJECTED（對方拒絕）：都不算
 * - ONE_SIDED（對方 24 小時沒回）：只算建立者自己那一端（對方那端標待確認，不扣不加）
 */
export function activeLegs(t: { confirmStatus?: TransferConfirmStatus | null; counterpartSide?: TransferSide | null }): { from: boolean; to: boolean } {
  switch (t.confirmStatus ?? 'CONFIRMED') {
    case 'CONFIRMED':
      return { from: true, to: true };
    case 'ONE_SIDED':
      return { from: t.counterpartSide !== 'FROM', to: t.counterpartSide !== 'TO' };
    default:
      return { from: false, to: false };
  }
}

/** 文字轉帳待確認的期限：24 小時（規格 D18）；文字撤銷窗口也是 24 小時（3.10.3，超過要到 LIFF）。 */
export const CONFIRM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TEXT_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;
