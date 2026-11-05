// 淨資產（財務中樞 P1-7，規格 2.7、5）：純函式，數字全部程式算。
//
// 淨資產＝帳戶餘額（現金、銀行、電子支付、定存、證券／投資估值）＋借出（別人欠我們）＋代墊公司費用（公司欠家裡，D16）
//        －借入（房貸、車貸、信貸、親友）－信用卡已出帳未繳。
// - 依看的人可見範圍算（D2）：看不到的（對方 OWNER_ONLY）不算；只看總額的算進數字，但組成裡併成一塊「其他成員個人（僅總額）」，不露類型與名稱。
// - 公司帳戶（purpose=BUSINESS）不算家庭淨資產（2.2）。
// - 每人各自的一條線（byOwner）：共同的歸「共同」，個人的歸本人。
import type { AccessLevel } from './access';
import type { AccountType, LiabilityDirection, LiabilityKind } from '@prisma/client';

export interface NWAccount {
  id: string;
  name: string;
  type: AccountType;
  ownerMemberId: string | null;
  level: AccessLevel;
  business: boolean;
  balance: number;
}
export interface NWLiability {
  id: string;
  name: string;
  direction: LiabilityDirection;
  kind: LiabilityKind;
  ownerMemberId: string | null;
  level: AccessLevel;
  principal: number; // 該時間點的剩餘本金
}
export interface NWCard {
  id: string;
  name: string;
  ownerMemberId: string | null;
  level: AccessLevel;
  unpaid: number; // 已出帳未繳（溢繳為負）
}
export interface NWReceivable {
  ownerMemberId: string | null;
  level: AccessLevel;
  amount: number;
}
export interface NWInput {
  viewerId: string;
  members: { id: string; displayName: string }[];
  accounts: NWAccount[];
  liabilities: NWLiability[];
  cards: NWCard[];
  receivables: NWReceivable[];
}

export type AssetKey = 'cash' | 'bank' | 'timeDeposit' | 'investment' | 'lent' | 'receivable' | 'othersTotal';
export type DebtKey = 'mortgage' | 'car' | 'personal' | 'family' | 'otherLoan' | 'card' | 'othersTotal';

export const ASSET_LABEL: Record<AssetKey, string> = {
  cash: '現金',
  bank: '銀行與電子支付',
  timeDeposit: '定存',
  investment: '證券、基金、虛擬資產',
  lent: '借出（別人欠我們）',
  receivable: '代墊公司費用（公司欠家裡）',
  othersTotal: '其他成員個人（僅總額）',
};
export const DEBT_LABEL: Record<DebtKey, string> = {
  mortgage: '房貸',
  car: '車貸',
  personal: '信貸',
  family: '親友借款',
  otherLoan: '其他借款',
  card: '信用卡已出帳未繳',
  othersTotal: '其他成員個人（僅總額）',
};

export interface NWRow {
  side: 'asset' | 'debt';
  key: AssetKey | DebtKey;
  name: string;
  ownerName: string;
  amount: number;
}

export interface NetWorthResult {
  assets: number;
  liabilities: number;
  netWorth: number;
  composition: { assets: { key: AssetKey; label: string; amount: number }[]; liabilities: { key: DebtKey; label: string; amount: number }[] };
  byOwner: { ownerId: string; name: string; assets: number; liabilities: number; netWorth: number }[];
  rows: NWRow[]; // 只列看得到明細的（只看總額的不列名稱）
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function assetKey(t: AccountType): AssetKey {
  if (t === 'CASH') return 'cash';
  if (t === 'TIME_DEPOSIT') return 'timeDeposit';
  if (t === 'SECURITIES' || t === 'INVESTMENT' || t === 'CRYPTO') return 'investment';
  return 'bank';
}

function debtKey(k: LiabilityKind): DebtKey {
  switch (k) {
    case 'MORTGAGE':
      return 'mortgage';
    case 'CAR':
      return 'car';
    case 'PERSONAL':
      return 'personal';
    case 'FAMILY':
      return 'family';
    default:
      return 'otherLoan';
  }
}

export function computeNetWorth(input: NWInput): NetWorthResult {
  const assets = new Map<AssetKey, number>();
  const debts = new Map<DebtKey, number>();
  const owners = new Map<string, { assets: number; liabilities: number }>();
  const rows: NWRow[] = [];
  const nameOf = (ownerId: string | null) => (ownerId == null ? '共同' : input.members.find((m) => m.id === ownerId)?.displayName ?? '成員');
  const addOwner = (ownerId: string | null, side: 'assets' | 'liabilities', amt: number) => {
    const k = ownerId ?? 'shared';
    const o = owners.get(k) ?? { assets: 0, liabilities: 0 };
    o[side] += amt;
    owners.set(k, o);
  };
  const add = <K extends string>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  for (const a of input.accounts) {
    if (a.level === 'NONE' || a.business) continue;
    const key: AssetKey = a.level === 'TOTAL' ? 'othersTotal' : assetKey(a.type);
    add(assets, key, a.balance);
    addOwner(a.ownerMemberId, 'assets', a.balance);
    if (a.level === 'DETAIL') rows.push({ side: 'asset', key, name: a.name, ownerName: nameOf(a.ownerMemberId), amount: r2(a.balance) });
  }
  for (const l of input.liabilities) {
    if (l.level === 'NONE' || l.principal === 0) continue;
    if (l.direction === 'LENT') {
      const key: AssetKey = l.level === 'TOTAL' ? 'othersTotal' : 'lent';
      add(assets, key, l.principal);
      addOwner(l.ownerMemberId, 'assets', l.principal);
      if (l.level === 'DETAIL') rows.push({ side: 'asset', key, name: l.name, ownerName: nameOf(l.ownerMemberId), amount: r2(l.principal) });
    } else {
      const key: DebtKey = l.level === 'TOTAL' ? 'othersTotal' : debtKey(l.kind);
      add(debts, key, l.principal);
      addOwner(l.ownerMemberId, 'liabilities', l.principal);
      if (l.level === 'DETAIL') rows.push({ side: 'debt', key, name: l.name, ownerName: nameOf(l.ownerMemberId), amount: r2(l.principal) });
    }
  }
  for (const c of input.cards) {
    if (c.level === 'NONE' || c.unpaid === 0) continue;
    const key: DebtKey = c.level === 'TOTAL' ? 'othersTotal' : 'card';
    add(debts, key, c.unpaid);
    addOwner(c.ownerMemberId, 'liabilities', c.unpaid);
    if (c.level === 'DETAIL') rows.push({ side: 'debt', key, name: c.name, ownerName: nameOf(c.ownerMemberId), amount: r2(c.unpaid) });
  }
  for (const rcv of input.receivables) {
    if (rcv.level === 'NONE' || rcv.amount === 0) continue;
    const key: AssetKey = rcv.level === 'TOTAL' ? 'othersTotal' : 'receivable';
    add(assets, key, rcv.amount);
    addOwner(rcv.ownerMemberId, 'assets', rcv.amount);
  }
  const recvDetail = input.receivables.filter((x) => x.level === 'DETAIL').reduce((s, x) => s + x.amount, 0);
  if (recvDetail) rows.push({ side: 'asset', key: 'receivable', name: ASSET_LABEL.receivable, ownerName: '', amount: r2(recvDetail) });

  const totalAssets = r2([...assets.values()].reduce((s, x) => s + x, 0));
  const totalDebts = r2([...debts.values()].reduce((s, x) => s + x, 0));
  const assetOrder: AssetKey[] = ['cash', 'bank', 'timeDeposit', 'investment', 'lent', 'receivable', 'othersTotal'];
  const debtOrder: DebtKey[] = ['mortgage', 'car', 'personal', 'family', 'otherLoan', 'card', 'othersTotal'];
  const ownerOrder = ['shared', input.viewerId, ...input.members.map((m) => m.id).filter((id) => id !== input.viewerId)];
  return {
    assets: totalAssets,
    liabilities: totalDebts,
    netWorth: r2(totalAssets - totalDebts),
    composition: {
      assets: assetOrder.filter((k) => assets.has(k) && r2(assets.get(k)!) !== 0).map((k) => ({ key: k, label: ASSET_LABEL[k], amount: r2(assets.get(k)!) })),
      liabilities: debtOrder.filter((k) => debts.has(k) && r2(debts.get(k)!) !== 0).map((k) => ({ key: k, label: DEBT_LABEL[k], amount: r2(debts.get(k)!) })),
    },
    byOwner: ownerOrder
      .filter((k, i, arr) => arr.indexOf(k) === i && owners.has(k))
      .map((k) => {
        const o = owners.get(k)!;
        return { ownerId: k, name: k === 'shared' ? '共同' : nameOf(k), assets: r2(o.assets), liabilities: r2(o.liabilities), netWorth: r2(o.assets - o.liabilities) };
      }),
    rows,
  };
}

/** "YYYY-MM" 這個月最後一刻（台北 23:59:59.999）。 */
export function monthEndTaipei(month: string): Date {
  const [y, m] = month.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return new Date(new Date(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+08:00`).getTime() - 1);
}

/** 台北「上個月」"YYYY-MM"。 */
export function previousMonthTaipei(now: Date = new Date()): string {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function isMonth(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

/** 負債還清時間表：剩幾期、預計還清日（攤還表最後一期）。沒攤還表（親友、FREE）→ null。 */
export function monthsBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm] = fromYmd.split('-').map(Number);
  const [ty, tm] = toYmd.split('-').map(Number);
  return Math.max(0, (ty - fy) * 12 + (tm - fm));
}
