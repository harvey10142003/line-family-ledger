// 把計畫（lib/ledger-plan.ts）裡每一筆的「帳戶原文」對到真的帳戶／卡／負債（規格 3.10.2、3.10.3）。純函式。
//
// 候選只放說話者看得到的（呼叫端依 AccessScope 篩）。一句裡有任何一個位置要問（多個候選、或比不到要不要新增），
// 就先停下來回一個問題；使用者點選後把答案放進 picks 再跑一次，全部確定了才會真的寫入（不會寫一半）。
//
// 各種轉帳沒講帳戶時的預設：
// - 一般轉帳、繳卡費、存定存、借出、還貸款的來源：說話者能動的預設帳戶（還貸款優先用該筆負債設定的扣款帳戶）
// - 領現金：來源＝最常提款的那個（沒有就預設的非現金帳戶），目的＝說話者自己的現金（沒有就共同現金）
// - 存現金：來源＝現金，目的＝預設的非現金帳戶
// - 存定存：來源＝同一家機構的活存（「將來定存」→「將來」開頭的非定存帳戶），沒有才用預設帳戶
// - 夫妻互轉：「Apple」→ Apple 的預設個人帳戶，「我」→ 說話者的預設個人帳戶
// - 借出、借入、收回的對象：比對負債名稱／債權人；借出、借入比不到就新建（「借小明 5000」），收回比不到要問
import type { AccountType, TransferKind } from '@prisma/client';
import { matchInstrument, normalizeName, ownerHint, baseNormalize, type InstrumentKind, type MatchCandidate, type MemberRef } from './account-match';
import type { LedgerPlan, PlannedTransfer, PlannedTx } from './ledger-plan';

export type Role = 'pay' | 'from' | 'to';

export type EndpointRef =
  | { type: 'ACCOUNT'; id: string }
  | { type: 'CARD'; id: string }
  | { type: 'LIABILITY'; id: string }
  | { type: 'NEW_LIABILITY'; name: string };

export interface ResolvedTx {
  type: 'TX';
  index: number;
  item: PlannedTx;
  accountId: string | null;
  creditCardId: string | null;
  unknownPay: string | null; // 比不到的付款方式（先記預設帳戶，回覆時問要不要新增）
  othersPay: string | null; // 說的是別人的個人帳戶／卡：不能記進去，先記預設帳戶
}

export interface ResolvedTransfer {
  type: 'TRANSFER';
  index: number;
  item: PlannedTransfer;
  kind: TransferKind;
  from: EndpointRef;
  to: EndpointRef;
}

export type Question =
  | { type: 'pick'; index: number; role: Role; raw: string; options: MatchCandidate[] }
  | { type: 'create'; index: number; role: Role; raw: string; accountType: AccountType; allowCard: boolean }
  | { type: 'missing'; index: number; role: Role; message: string };

export interface ResolveContext {
  speakerId: string;
  members: MemberRef[];
  candidates: MatchCandidate[];
  picks?: Record<string, string>; // `${index}:${role}` → `${kind}:${id}`（使用者點選過的）
  frequentWithdrawFromId?: string | null;
}

export type ResolveResult = { status: 'ready'; steps: (ResolvedTx | ResolvedTransfer)[] } | { status: 'question'; question: Question };

export const pickKey = (index: number, role: Role) => `${index}:${role}`;

const byOrder = (a: MatchCandidate, b: MatchCandidate) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0);

function accounts(ctx: ResolveContext, f: (c: MatchCandidate) => boolean = () => true) {
  return ctx.candidates.filter((c) => c.kind === 'ACCOUNT' && f(c)).sort(byOrder);
}

/** 說話者能動的預設帳戶（同舊版 resolveAccountId：預設優先，再依排序；別人的個人帳戶跳過） */
export function defaultWritable(ctx: ResolveContext, f: (c: MatchCandidate) => boolean = () => true): MatchCandidate | null {
  return accounts(ctx, (c) => c.writable && f(c))[0] ?? null;
}

/** 某位成員的預設個人帳戶（夫妻互轉用；說話者看得到才有） */
export function memberDefault(ctx: ResolveContext, memberId: string): MatchCandidate | null {
  const own = accounts(ctx, (c) => c.ownerMemberId === memberId && c.accountType !== 'TIME_DEPOSIT' && c.accountType !== 'CASH');
  return own.find((c) => c.accountType === 'BANK' && c.isDefault) ?? own.find((c) => c.isDefault) ?? own.find((c) => c.accountType === 'BANK') ?? own[0] ?? null;
}

function cashAccount(ctx: ResolveContext): MatchCandidate | null {
  const cash = accounts(ctx, (c) => c.writable && c.accountType === 'CASH');
  return cash.find((c) => c.ownerMemberId === ctx.speakerId) ?? cash[0] ?? null;
}

function nonCashDefault(ctx: ResolveContext): MatchCandidate | null {
  if (ctx.frequentWithdrawFromId) {
    const f = ctx.candidates.find((c) => c.kind === 'ACCOUNT' && c.id === ctx.frequentWithdrawFromId && c.writable && c.accountType !== 'CASH');
    if (f) return f;
  }
  return (
    defaultWritable(ctx, (c) => c.accountType !== 'CASH' && c.accountType !== 'TIME_DEPOSIT' && !!c.isDefault) ??
    defaultWritable(ctx, (c) => c.accountType === 'BANK') ??
    defaultWritable(ctx, (c) => c.accountType !== 'CASH' && c.accountType !== 'TIME_DEPOSIT')
  );
}

const ref = (c: MatchCandidate): EndpointRef => ({ type: c.kind, id: c.id }) as EndpointRef;

/** 只說了某位成員的名字（「Apple」「我」）→ 那位成員 id；不是就 null */
function memberOnly(raw: string, ctx: ResolveContext): string | null {
  const h = ownerHint(raw, ctx.speakerId, ctx.members);
  return h.ownerId && h.onlyOwner ? h.ownerId : null;
}

type Outcome = { ok: EndpointRef; cand?: MatchCandidate } | { q: Question };

function fromPick(index: number, role: Role, ctx: ResolveContext): Outcome | null {
  const p = ctx.picks?.[pickKey(index, role)];
  if (!p) return null;
  const [kind, id] = p.split(':');
  const c = ctx.candidates.find((x) => x.kind === kind && x.id === id);
  if (!c) return { q: { type: 'missing', index, role, message: '剛剛選的帳戶找不到了，請再說一次。' } };
  return { ok: ref(c), cand: c };
}

function lookup(
  index: number,
  role: Role,
  raw: string | null,
  kinds: InstrumentKind[],
  ctx: ResolveContext,
  opts: { fallback?: () => MatchCandidate | null; create?: { accountType: AccountType; allowCard: boolean }; filter?: (c: MatchCandidate) => boolean },
): Outcome {
  const picked = fromPick(index, role, ctx);
  if (picked) return picked;
  const text = (raw ?? '').trim();
  if (text) {
    const who = memberOnly(text, ctx);
    if (who) {
      const d = who === ctx.speakerId ? memberDefault(ctx, who) ?? defaultWritable(ctx) : memberDefault(ctx, who);
      if (d) return { ok: ref(d), cand: d };
      return { q: { type: 'missing', index, role, message: '找不到這位成員可以用的個人帳戶（可能對你不公開），請直接說帳戶名稱。' } };
    }
    const pool = opts.filter ? ctx.candidates.filter(opts.filter) : ctx.candidates;
    const m = matchInstrument(text, pool, { speakerId: ctx.speakerId, members: ctx.members, kinds });
    if (m.status === 'unique') return { ok: ref(m.pick), cand: m.pick };
    if (m.status === 'ambiguous') return { q: { type: 'pick', index, role, raw: text, options: m.options } };
    if (opts.create) return { q: { type: 'create', index, role, raw: text, ...opts.create } };
    return { q: { type: 'missing', index, role, message: `找不到「${text}」。` } };
  }
  const d = opts.fallback?.() ?? null;
  if (d) return { ok: ref(d), cand: d };
  return { q: { type: 'missing', index, role, message: '找不到可以用的帳戶，請先到記帳簿新增帳戶。' } };
}

function counterpartyLiability(item: PlannedTransfer, direction: 'LENT' | 'BORROWED', ctx: ResolveContext, index: number, role: Role): Outcome | null {
  const picked = fromPick(index, role, ctx);
  if (picked) return picked;
  const who = (item.counterparty ?? (role === 'to' ? item.toText : item.fromText) ?? '').trim();
  if (!who) return null;
  const pool = ctx.candidates.filter((c) => c.kind === 'LIABILITY' && c.direction === direction);
  const m = matchInstrument(who, pool, { speakerId: ctx.speakerId, members: ctx.members, kinds: ['LIABILITY'] });
  if (m.status === 'unique') return { ok: ref(m.pick), cand: m.pick };
  if (m.status === 'ambiguous') return { q: { type: 'pick', index, role, raw: who, options: m.options } };
  // 「借小明」也可能存成名稱「借小明」：再用「借＋名字」比一次
  const m2 = matchInstrument(`借${who}`, pool, { speakerId: ctx.speakerId, members: ctx.members, kinds: ['LIABILITY'] });
  if (m2.status === 'unique') return { ok: ref(m2.pick), cand: m2.pick };
  return { ok: { type: 'NEW_LIABILITY', name: who } };
}

function resolveTransfer(index: number, item: PlannedTransfer, ctx: ResolveContext): ResolvedTransfer | Question {
  let kind = item.kind;
  let from: Outcome;
  let to: Outcome;
  switch (kind) {
    case 'CARD_PAYMENT':
      from = lookup(index, 'from', item.fromText, ['ACCOUNT'], ctx, { fallback: () => defaultWritable(ctx, (c) => c.accountType !== 'TIME_DEPOSIT') });
      to = lookup(index, 'to', item.toText, ['CARD'], ctx, { create: { accountType: 'BANK', allowCard: true } });
      break;
    case 'CASH_WITHDRAW':
      from = lookup(index, 'from', item.fromText, ['ACCOUNT'], ctx, { fallback: () => nonCashDefault(ctx), filter: (c) => c.accountType !== 'CASH' });
      to = lookup(index, 'to', item.toText && !/現金/.test(item.toText) ? item.toText : null, ['ACCOUNT'], ctx, { fallback: () => cashAccount(ctx), filter: (c) => c.accountType === 'CASH' });
      break;
    case 'CASH_DEPOSIT':
      from = lookup(index, 'from', item.fromText && !/現金/.test(item.fromText) ? item.fromText : null, ['ACCOUNT'], ctx, { fallback: () => cashAccount(ctx), filter: (c) => c.accountType === 'CASH' });
      to = lookup(index, 'to', item.toText, ['ACCOUNT'], ctx, { fallback: () => nonCashDefault(ctx), filter: (c) => c.accountType !== 'CASH', create: { accountType: 'BANK', allowCard: false } });
      break;
    case 'TIME_DEPOSIT': {
      // 定存解約：來源是定存帳戶
      const fromIsTd = !!item.fromText && /定存/.test(item.fromText);
      if (fromIsTd) {
        from = lookup(index, 'from', item.fromText, ['ACCOUNT'], ctx, { filter: (c) => c.accountType === 'TIME_DEPOSIT', create: { accountType: 'TIME_DEPOSIT', allowCard: false } });
        to = lookup(index, 'to', item.toText, ['ACCOUNT'], ctx, { fallback: () => sameInstitution(from, ctx) ?? defaultWritable(ctx, (c) => c.accountType !== 'TIME_DEPOSIT') });
      } else {
        to = lookup(index, 'to', item.toText, ['ACCOUNT'], ctx, { filter: (c) => c.accountType === 'TIME_DEPOSIT', create: { accountType: 'TIME_DEPOSIT', allowCard: false } });
        from = lookup(index, 'from', item.fromText, ['ACCOUNT'], ctx, {
          fallback: () => sameInstitution(to, ctx, item.toText) ?? defaultWritable(ctx, (c) => c.accountType !== 'TIME_DEPOSIT' && c.accountType !== 'CASH'),
          filter: (c) => c.accountType !== 'TIME_DEPOSIT',
        });
      }
      break;
    }
    case 'LOAN_REPAY': {
      to = lookup(index, 'to', item.toText ?? item.counterparty, ['LIABILITY'], ctx, { filter: (c) => c.kind === 'LIABILITY' && c.direction === 'BORROWED' });
      const loan = 'ok' in to ? to.cand : undefined;
      const payFrom = loan?.payFromAccountId ?? null;
      from = lookup(index, 'from', item.fromText, ['ACCOUNT'], ctx, {
        fallback: () => (payFrom ? ctx.candidates.find((c) => c.kind === 'ACCOUNT' && c.id === payFrom && c.writable) ?? null : null) ?? defaultWritable(ctx, (c) => c.accountType !== 'TIME_DEPOSIT'),
      });
      break;
    }
    case 'LEND':
      from = lookup(index, 'from', item.fromText, ['ACCOUNT'], ctx, { fallback: () => defaultWritable(ctx, (c) => c.accountType !== 'TIME_DEPOSIT') });
      to = counterpartyLiability(item, 'LENT', ctx, index, 'to') ?? { q: { type: 'missing', index, role: 'to', message: '借給誰？請說「借小明 5000」。' } };
      break;
    case 'BORROW':
      from = counterpartyLiability(item, 'BORROWED', ctx, index, 'from') ?? { q: { type: 'missing', index, role: 'from', message: '跟誰借？請說「跟小明借 5000」。' } };
      to = lookup(index, 'to', item.toText, ['ACCOUNT'], ctx, { fallback: () => defaultWritable(ctx, (c) => c.accountType !== 'TIME_DEPOSIT') });
      break;
    case 'COLLECT': {
      const c = counterpartyLiability(item, 'LENT', ctx, index, 'from');
      from = c && 'ok' in c && c.ok.type === 'NEW_LIABILITY' ? { q: { type: 'missing', index, role: 'from', message: `找不到借給「${c.ok.name}」的紀錄，請先到記帳簿「負債」確認。` } } : c ?? { q: { type: 'missing', index, role: 'from', message: '是誰還你錢？請說「小明還我 2000」。' } };
      to = lookup(index, 'to', item.toText, ['ACCOUNT'], ctx, { fallback: () => defaultWritable(ctx, (c2) => c2.accountType !== 'TIME_DEPOSIT') });
      break;
    }
    case 'SPOUSE':
    case 'ACCOUNT':
    default: {
      from = lookup(index, 'from', item.fromText, ['ACCOUNT'], ctx, { fallback: () => defaultWritable(ctx, (c) => c.accountType !== 'TIME_DEPOSIT'), create: { accountType: 'BANK', allowCard: false } });
      // 一般轉帳的目的可能是卡（「轉到國泰」而國泰也是卡）：都對得上會問；選了卡 → 改成繳卡費
      to = lookup(index, 'to', item.toText, kind === 'SPOUSE' ? ['ACCOUNT'] : ['ACCOUNT', 'CARD'], ctx, {
        fallback: () => defaultWritable(ctx, (c) => c.accountType !== 'TIME_DEPOSIT'),
        create: { accountType: 'BANK', allowCard: kind !== 'SPOUSE' },
      });
      break;
    }
  }
  if ('q' in from) return from.q;
  if ('q' in to) return to.q;
  if ((kind === 'ACCOUNT' || kind === 'SPOUSE') && to.ok.type === 'CARD') kind = 'CARD_PAYMENT';
  // 兩端都是不同成員的個人帳戶 → 夫妻互轉；說成夫妻互轉但其實有一端是共同的 → 一般轉帳
  if ((kind === 'ACCOUNT' || kind === 'SPOUSE') && from.ok.type === 'ACCOUNT' && to.ok.type === 'ACCOUNT') {
    const fo = from.cand?.ownerMemberId ?? null;
    const tOwner = to.cand?.ownerMemberId ?? null;
    kind = fo && tOwner && fo !== tOwner ? 'SPOUSE' : 'ACCOUNT';
  }
  return { type: 'TRANSFER', index, item, kind, from: from.ok, to: to.ok };
}

/** 存定存沒講來源：同一家機構（名稱或 institution 開頭相同）的非定存帳戶 */
function sameInstitution(o: Outcome, ctx: ResolveContext, rawTd?: string | null): MatchCandidate | null {
  const td = 'ok' in o ? o.cand : undefined;
  const key = td?.institution ? normalizeName(td.institution) : normalizeName((td?.name ?? rawTd ?? '').replace(/定存/g, ''));
  const k = key.replace(/定存/g, '');
  if (!k) return null;
  return (
    accounts(ctx, (c) => c.writable && c.accountType !== 'TIME_DEPOSIT' && c.accountType !== 'CASH').find((c) => {
      const inst = c.institution ? normalizeName(c.institution) : '';
      const nm = normalizeName(c.name);
      return (inst && (inst.includes(k) || k.includes(inst))) || nm.startsWith(k);
    }) ?? null
  );
}

function resolveTx(index: number, item: PlannedTx, ctx: ResolveContext): ResolvedTx | Question {
  const base: ResolvedTx = { type: 'TX', index, item, accountId: null, creditCardId: null, unknownPay: null, othersPay: null };
  const fallback = defaultWritable(ctx);
  const picked = fromPick(index, 'pay', ctx);
  if (picked && 'q' in picked) return picked.q;
  let cand: MatchCandidate | undefined = picked && 'ok' in picked ? picked.cand : undefined;
  if (!cand && item.accountText) {
    const m = matchInstrument(item.accountText, ctx.candidates, { speakerId: ctx.speakerId, members: ctx.members, kinds: ['ACCOUNT', 'CARD'] });
    if (m.status === 'ambiguous') {
      // 只留說話者能記進去的；剩一個就直接用
      const w = m.options.filter((c) => c.writable);
      if (w.length === 1) cand = w[0];
      else if (w.length > 1) return { type: 'pick', index, role: 'pay', raw: item.accountText, options: w };
      else return { ...base, accountId: fallback?.id ?? null, othersPay: item.accountText };
    } else if (m.status === 'unique') {
      cand = m.pick;
    } else {
      return { ...base, accountId: fallback?.id ?? null, unknownPay: item.accountText };
    }
  }
  if (!cand) return { ...base, accountId: fallback?.id ?? null };
  if (!cand.writable) return { ...base, accountId: fallback?.id ?? null, othersPay: item.accountText ?? cand.name };
  return cand.kind === 'CARD' ? { ...base, creditCardId: cand.id } : { ...base, accountId: cand.id };
}

export function resolvePlan(plan: LedgerPlan, ctx: ResolveContext): ResolveResult {
  const steps: (ResolvedTx | ResolvedTransfer)[] = [];
  for (let i = 0; i < plan.items.length; i++) {
    const it = plan.items[i];
    const r = it.type === 'TX' ? resolveTx(i, it, ctx) : resolveTransfer(i, it, ctx);
    if (r.type !== 'TX' && r.type !== 'TRANSFER') return { status: 'question', question: r };
    steps.push(r);
  }
  return { status: 'ready', steps };
}

/** Quick Reply 按鈕上的候選名稱（帶歸屬，讓人分得出 Shark 的臺銀和 Apple 的臺銀） */
export function optionLabel(c: MatchCandidate, members: MemberRef[], speakerId: string): string {
  const owner = c.ownerMemberId == null ? '' : c.ownerMemberId === speakerId ? '我的' : `${members.find((m) => m.id === c.ownerMemberId)?.displayName ?? '成員'}的`;
  const kind = c.kind === 'CARD' ? '（卡）' : c.kind === 'LIABILITY' ? '（負債）' : '';
  const name = owner && baseNormalize(c.name).includes(baseNormalize(owner.replace(/的$/, ''))) ? c.name : `${owner}${c.name}`;
  return `${name}${kind}`;
}
