// 文字記帳補強（P1-6）與一句話建轉帳（P1-5）的解析對照表：規格 3.10.2 全部 8 個例句＋變化句、3.10.5 例句。
//
// Gemini 不在測試裡跑：每一句給「Gemini 應該回的意圖＋欄位原文」，驗證程式這一側（金額複核、日期換算、
// 公司／外幣／歸屬人、帳戶模糊比對、要不要問）跑出預期結果。Gemini 回錯的金額、亂掰的日期也要被擋下來。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedgerPlan, type LedgerItemRaw, type LedgerParseRaw, type PlanContext } from '../src/lib/ledger-plan';
import { resolvePlan, type ResolveContext, type ResolvedTransfer, type ResolvedTx } from '../src/lib/ledger-resolve';
import { maskSensitive } from '../src/lib/mask';
import type { MatchCandidate } from '../src/lib/account-match';
import { matchInstrument, nextAliases } from '../src/lib/account-match';

const SHARK = 'm_shark';
const APPLE = 'm_apple';
const members = [
  { id: SHARK, displayName: 'Shark' },
  { id: APPLE, displayName: 'Apple' },
];
const NOW = new Date('2026-11-05T10:00:00+08:00'); // 週四
const CATS = ['餐飲', '交通', '娛樂', '美容', '軟體訂閱', '其他支出', '薪水', '其他收入'];

const acc = (id: string, name: string, accountType: any, owner: string | null, extra: Partial<MatchCandidate> = {}): MatchCandidate => ({
  kind: 'ACCOUNT',
  id,
  name,
  accountType,
  ownerMemberId: owner,
  writable: owner == null || owner === SHARK,
  aliases: [],
  ...extra,
});
const card = (id: string, name: string, owner: string | null, extra: Partial<MatchCandidate> = {}): MatchCandidate => ({
  kind: 'CARD',
  id,
  name,
  ownerMemberId: owner,
  writable: owner == null || owner === SHARK,
  aliases: [],
  ...extra,
});
const lia = (id: string, name: string, direction: any, extra: Partial<MatchCandidate> = {}): MatchCandidate => ({
  kind: 'LIABILITY',
  id,
  name,
  direction,
  ownerMemberId: null,
  writable: true,
  aliases: [],
  ...extra,
});

// Shark 的視角：Apple 的個人帳戶看得到（只看總額）但不能動
const BASE: MatchCandidate[] = [
  acc('cash', '現金', 'CASH', null, { isDefault: true, sortOrder: 1 }),
  acc('bot', 'Shark 臺銀', 'BANK', SHARK, { institution: '004 臺灣銀行', sortOrder: 2 }),
  acc('taishin', 'Shark 台新', 'BANK', SHARK, { sortOrder: 3 }),
  acc('cathay', '國泰活存', 'BANK', null, { institution: '013 國泰世華', sortOrder: 4 }),
  acc('next', '將來活存', 'BANK', null, { institution: '將來銀行', sortOrder: 5 }),
  acc('appleEsun', 'Apple 玉山', 'BANK', APPLE, { isDefault: false, sortOrder: 6 }),
  card('cathayCard', '國泰卡', null, { last4: '1234', sortOrder: 1 }),
  card('taishinCard', '台新卡', SHARK, { last4: '5678', sortOrder: 2 }),
  lia('mortgage', '房貸', 'BORROWED', { liabilityKind: 'MORTGAGE', lender: '玉山', payFromAccountId: 'cathay' }),
  lia('xiaoming', '借小明', 'LENT', { liabilityKind: 'FAMILY', lender: '小明' }),
];
// 變化：Apple 也有臺銀（兩人都有臺銀 → 一定問）
const DUAL: MatchCandidate[] = [...BASE, acc('appleBot', 'Apple 臺銀', 'BANK', APPLE, { institution: '004 臺灣銀行', sortOrder: 7 })];

const planCtx = (now = NOW): PlanContext => ({ now, speakerId: SHARK, members, categoryNames: CATS, rates: { USD: 32.5, JPY: 0.21 } });
const resCtx = (candidates = BASE, picks?: Record<string, string>): ResolveContext => ({ speakerId: SHARK, members, candidates, picks });

const blank: LedgerItemRaw = {
  intent: 'EXPENSE',
  segment: '',
  amount: 0,
  categoryName: '',
  note: '',
  dateText: '',
  accountText: '',
  ownerText: '',
  currencyText: '',
  transferKind: '',
  fromText: '',
  toText: '',
  counterpartyText: '',
  principal: 0,
  interest: 0,
  fee: 0,
};
const tx = (o: Partial<LedgerItemRaw>): LedgerItemRaw => ({ ...blank, ...o });
const tr = (o: Partial<LedgerItemRaw>): LedgerItemRaw => ({ ...blank, intent: 'TRANSFER', ...o });
const g = (items: LedgerItemRaw[], shared: Partial<LedgerParseRaw> = {}): LedgerParseRaw => ({ isLedger: true, sharedAccountText: '', sharedDateText: '', items, ...shared });

function run(sentence: string, raw: LedgerParseRaw, candidates = BASE, picks?: Record<string, string>, now = NOW) {
  const masked = maskSensitive(sentence).text;
  const plan = buildLedgerPlan(raw, masked, planCtx(now));
  const res = resolvePlan(plan, resCtx(candidates, picks));
  return { plan, res };
}

function ready(r: ReturnType<typeof run>) {
  assert.equal(r.plan.issues.length, 0, `issues: ${JSON.stringify(r.plan.issues)}`);
  assert.equal(r.res.status, 'ready', `res: ${JSON.stringify(r.res)}`);
  return (r.res as any).steps as (ResolvedTx | ResolvedTransfer)[];
}
const T = (s: ResolvedTx | ResolvedTransfer) => s as ResolvedTransfer;
const X = (s: ResolvedTx | ResolvedTransfer) => s as ResolvedTx;

// ================= 規格 3.10.2 的 8 個例句 =================

test('例句1「台新轉 5000 到國泰」：國泰同時有活存和卡 → 問一句（列兩個候選）；選卡 → 改成繳卡費', () => {
  const raw = g([tr({ segment: '台新轉 5000 到國泰', amount: 5000, transferKind: 'ACCOUNT', fromText: '台新', toText: '國泰' })]);
  const r = run('台新轉 5000 到國泰', raw);
  assert.equal(r.plan.issues.length, 0);
  assert.equal(r.res.status, 'question');
  const q = (r.res as any).question;
  assert.equal(q.type, 'pick');
  assert.equal(q.role, 'to');
  assert.deepEqual(q.options.map((o: any) => o.id).sort(), ['cathay', 'cathayCard']);
  const s1 = ready(run('台新轉 5000 到國泰', raw, BASE, { '0:to': 'ACCOUNT:cathay' }));
  assert.equal(T(s1[0]).kind, 'ACCOUNT');
  assert.deepEqual([T(s1[0]).from, T(s1[0]).to], [{ type: 'ACCOUNT', id: 'taishin' }, { type: 'ACCOUNT', id: 'cathay' }]);
  const s2 = ready(run('台新轉 5000 到國泰', raw, BASE, { '0:to': 'CARD:cathayCard' }));
  assert.equal(T(s2[0]).kind, 'CARD_PAYMENT');
});

test('例句2「從臺銀繳國泰卡 24261」：臺銀 → 國泰卡，繳卡費 24261', () => {
  const s = ready(run('從臺銀繳國泰卡 24261', g([tr({ segment: '從臺銀繳國泰卡 24261', amount: 24261, transferKind: 'CARD_PAYMENT', fromText: '臺銀', toText: '國泰卡' })])));
  assert.equal(T(s[0]).kind, 'CARD_PAYMENT');
  assert.deepEqual(T(s[0]).from, { type: 'ACCOUNT', id: 'bot' });
  assert.deepEqual(T(s[0]).to, { type: 'CARD', id: 'cathayCard' });
  assert.equal(T(s[0]).item.amount, 24261);
});

test('例句3「領現金 3000」：預設非現金帳戶（或最常提款的）→ 現金', () => {
  const raw = g([tr({ segment: '領現金 3000', amount: 3000, transferKind: 'CASH_WITHDRAW', toText: '現金' })]);
  const s = ready(run('領現金 3000', raw));
  assert.equal(T(s[0]).kind, 'CASH_WITHDRAW');
  assert.deepEqual(T(s[0]).to, { type: 'ACCOUNT', id: 'cash' });
  assert.equal(T(s[0]).from.type, 'ACCOUNT');
  assert.notEqual((T(s[0]).from as any).id, 'cash');
  // 最常提款的那個優先
  const masked = maskSensitive('領現金 3000').text;
  const plan = buildLedgerPlan(raw, masked, planCtx());
  const r2 = resolvePlan(plan, { ...resCtx(), frequentWithdrawFromId: 'taishin' });
  assert.deepEqual((r2 as any).steps[0].from, { type: 'ACCOUNT', id: 'taishin' });
});

test('例句4「存 2 萬到將來定存」：定存帳戶不存在 → 問要不要建立（類型＝定存）；存在 → 從將來活存轉', () => {
  const raw = g([tr({ segment: '存 2 萬到將來定存', amount: 20000, transferKind: 'TIME_DEPOSIT', toText: '將來定存' })]);
  const r = run('存 2 萬到將來定存', raw);
  assert.equal(r.plan.issues.length, 0, '「2 萬」要抓得到 20000');
  assert.equal(r.res.status, 'question');
  assert.equal((r.res as any).question.type, 'create');
  assert.equal((r.res as any).question.accountType, 'TIME_DEPOSIT');
  assert.equal((r.res as any).question.raw, '將來定存');
  const withTd = [...BASE, acc('nextTd', '將來定存', 'TIME_DEPOSIT', null, { institution: '將來銀行', sortOrder: 8 })];
  const s = ready(run('存 2 萬到將來定存', raw, withTd));
  assert.deepEqual(T(s[0]).from, { type: 'ACCOUNT', id: 'next' });
  assert.deepEqual(T(s[0]).to, { type: 'ACCOUNT', id: 'nextTd' });
});

test('例句5「還房貸 18000（本金 12000 利息 6000）」：本金 12000 轉帳＋利息 6000，程式檢查 12000＋6000＝18000', () => {
  const sentence = '還房貸 18000（本金 12000 利息 6000）';
  const s = ready(run(sentence, g([tr({ segment: sentence, amount: 18000, principal: 12000, interest: 6000, transferKind: 'LOAN_REPAY', toText: '房貸' })])));
  const t = T(s[0]);
  assert.equal(t.kind, 'LOAN_REPAY');
  assert.equal(t.item.amount, 12000);
  assert.equal(t.item.interest, 6000);
  assert.equal(t.item.total, 18000);
  assert.deepEqual(t.to, { type: 'LIABILITY', id: 'mortgage' });
  assert.deepEqual(t.from, { type: 'ACCOUNT', id: 'cathay' }, '沒講來源 → 用房貸設定的扣款帳戶');
});

test('例句5 變化：本金＋利息≠總額 → 問；只說總額 → 交給攤還表拆', () => {
  const bad = '還房貸 18000（本金 12000 利息 5000）';
  const r = run(bad, g([tr({ segment: bad, amount: 18000, principal: 12000, interest: 5000, transferKind: 'LOAN_REPAY', toText: '房貸' })]));
  assert.equal(r.plan.issues[0]?.code, 'split_mismatch');
  const only = ready(run('還房貸 18000', g([tr({ segment: '還房貸 18000', amount: 18000, transferKind: 'LOAN_REPAY', toText: '房貸' })])));
  assert.equal(T(only[0]).item.needsSplit, true);
  assert.equal(T(only[0]).item.total, null);
});

test('例句6「借小明 5000」：找到借出對象「借小明」；沒有的對象 → 新建', () => {
  const s = ready(run('借小明 5000', g([tr({ segment: '借小明 5000', amount: 5000, transferKind: 'LEND', counterpartyText: '小明' })])));
  assert.equal(T(s[0]).kind, 'LEND');
  assert.deepEqual(T(s[0]).to, { type: 'LIABILITY', id: 'xiaoming' });
  assert.deepEqual(T(s[0]).from, { type: 'ACCOUNT', id: 'cash' }, '預設帳戶');
  const s2 = ready(run('借小華 3000', g([tr({ segment: '借小華 3000', amount: 3000, transferKind: 'LEND', counterpartyText: '小華' })])));
  assert.deepEqual(T(s2[0]).to, { type: 'NEW_LIABILITY', name: '小華' });
});

test('例句7「小明還我 2000」：借小明 → 預設帳戶；沒借過的人 → 不新建、要說明', () => {
  const s = ready(run('小明還我 2000', g([tr({ segment: '小明還我 2000', amount: 2000, transferKind: 'COLLECT', counterpartyText: '小明' })])));
  assert.equal(T(s[0]).kind, 'COLLECT');
  assert.deepEqual(T(s[0]).from, { type: 'LIABILITY', id: 'xiaoming' });
  const r = run('小華還我 2000', g([tr({ segment: '小華還我 2000', amount: 2000, transferKind: 'COLLECT', counterpartyText: '小華' })]));
  assert.equal((r.res as any).question.type, 'missing');
});

test('例句8「Apple 轉 1 萬給我」：Apple 的預設個人帳戶 → 說話者的預設個人帳戶，夫妻互轉 10000', () => {
  const s = ready(run('Apple 轉 1 萬給我', g([tr({ segment: 'Apple 轉 1 萬給我', amount: 10000, transferKind: 'SPOUSE', fromText: 'Apple', toText: '我' })])));
  assert.equal(T(s[0]).kind, 'SPOUSE');
  assert.deepEqual(T(s[0]).from, { type: 'ACCOUNT', id: 'appleEsun' });
  assert.deepEqual(T(s[0]).to, { type: 'ACCOUNT', id: 'bot' });
});

// ================= 3.10.2 變化句（全半形、台／臺、多候選、別名、末四碼、金額複核） =================

test('變化：全形數字「台新轉５０００到國泰卡」→ 5000、明講卡就不問', () => {
  const s = ready(run('台新轉５０００到國泰卡', g([tr({ segment: '台新轉5000到國泰卡', amount: 5000, transferKind: 'ACCOUNT', fromText: '台新', toText: '國泰卡' })])));
  assert.equal(T(s[0]).kind, 'CARD_PAYMENT');
  assert.equal(T(s[0]).item.amount, 5000);
});

test('變化：台／臺「從台銀繳國泰卡 24,261」→ 臺銀、千分位', () => {
  const s = ready(run('從台銀繳國泰卡 24,261', g([tr({ segment: '從台銀繳國泰卡 24,261', amount: 24261, transferKind: 'CARD_PAYMENT', fromText: '台銀', toText: '國泰卡' })])));
  assert.deepEqual(T(s[0]).from, { type: 'ACCOUNT', id: 'bot' });
});

test('變化：Shark、Apple 都有臺銀 → 一定問（說話者排第一）；說「我的臺銀」→ 直接用 Shark 的', () => {
  const raw = g([tr({ segment: '從臺銀繳國泰卡 24261', amount: 24261, transferKind: 'CARD_PAYMENT', fromText: '臺銀', toText: '國泰卡' })]);
  const r = run('從臺銀繳國泰卡 24261', raw, DUAL);
  assert.equal(r.res.status, 'question');
  const opts = (r.res as any).question.options.map((o: any) => o.id);
  assert.deepEqual(opts, ['bot', 'appleBot']);
  const mine = ready(run('從我的臺銀繳國泰卡 24261', g([tr({ segment: '從我的臺銀繳國泰卡 24261', amount: 24261, transferKind: 'CARD_PAYMENT', fromText: '我的臺銀', toText: '國泰卡' })]), DUAL));
  assert.deepEqual(T(mine[0]).from, { type: 'ACCOUNT', id: 'bot' });
  const apples = ready(run('從 Apple 的臺銀繳國泰卡 24261', g([tr({ segment: '從 Apple 的臺銀繳國泰卡 24261', amount: 24261, transferKind: 'CARD_PAYMENT', fromText: 'Apple 的臺銀', toText: '國泰卡' })]), DUAL));
  assert.deepEqual(T(apples[0]).from, { type: 'ACCOUNT', id: 'appleBot' });
});

test('變化：點過的叫法記成別名，下次同一句不再問', () => {
  const learned = DUAL.map((c) => (c.id === 'bot' ? { ...c, aliases: nextAliases(c.aliases, '臺銀', c.name) ?? c.aliases } : c));
  assert.deepEqual(learned.find((c) => c.id === 'bot')!.aliases, ['臺銀']);
  const s = ready(run('從臺銀繳國泰卡 24261', g([tr({ segment: '從臺銀繳國泰卡 24261', amount: 24261, transferKind: 'CARD_PAYMENT', fromText: '臺銀', toText: '國泰卡' })]), learned));
  assert.deepEqual(T(s[0]).from, { type: 'ACCOUNT', id: 'bot' });
  // 別名命中的若是說話者不能動的帳戶，不採用（還是問）
  const appleLearned = DUAL.map((c) => (c.id === 'appleBot' ? { ...c, aliases: ['臺銀'] } : c));
  const r = run('從臺銀繳國泰卡 24261', g([tr({ segment: '從臺銀繳國泰卡 24261', amount: 24261, transferKind: 'CARD_PAYMENT', fromText: '臺銀', toText: '國泰卡' })]), appleLearned);
  assert.equal(r.res.status, 'question');
});

test('變化：末四碼「1234 那張」→ 國泰卡；卡號全碼送 Gemini 前被遮成末四碼', () => {
  const sentence = '從台新繳 4111 1111 1111 1234 那張 3000';
  const masked = maskSensitive(sentence).text;
  assert.ok(!masked.includes('4111 1111'), masked);
  assert.ok(masked.includes('[卡號末4:1234]'), masked);
  const s = ready(run(sentence, g([tr({ segment: masked, amount: 3000, transferKind: 'CARD_PAYMENT', fromText: '台新', toText: '[卡號末4:1234]' })])));
  assert.deepEqual(T(s[0]).to, { type: 'CARD', id: 'cathayCard' });
  const s2 = ready(run('繳 1234 那張卡 3000', g([tr({ segment: '繳 1234 那張卡 3000', amount: 3000, transferKind: 'CARD_PAYMENT', toText: '1234 那張卡' })])));
  assert.deepEqual(T(s2[0]).to, { type: 'CARD', id: 'cathayCard' });
  assert.equal(T(s2[0]).item.amount, 3000, '末四碼 1234 不算金額');
});

test('變化：Gemini 回的金額不在原句裡 → 問（不寫入）', () => {
  const r = run('台新轉 5000 到國泰活存', g([tr({ segment: '台新轉 5000 到國泰活存', amount: 50000, transferKind: 'ACCOUNT', fromText: '台新', toText: '國泰活存' })]));
  assert.equal(r.plan.issues[0]?.code, 'amount_mismatch');
  assert.equal(r.plan.items.length, 1, '計畫還在，但有 issue 時 handler 不寫入');
  const r2 = run('午餐 120', g([tx({ segment: '午餐 120', amount: 1200, categoryName: '餐飲', note: '午餐' })]));
  assert.equal(r2.plan.issues[0]?.code, 'amount_mismatch');
  assert.equal(r2.plan.items.length, 0);
});

test('變化：中文數字「Apple 轉一萬給我」「存三千到將來活存」', () => {
  const s = ready(run('Apple 轉一萬給我', g([tr({ segment: 'Apple 轉一萬給我', amount: 10000, transferKind: 'SPOUSE', fromText: 'Apple', toText: '我' })])));
  assert.equal(T(s[0]).item.amount, 10000);
  const s2 = ready(run('現金存三千到將來活存', g([tr({ segment: '現金存三千到將來活存', amount: 3000, transferKind: 'CASH_DEPOSIT', fromText: '現金', toText: '將來活存' })])));
  assert.equal(T(s2[0]).kind, 'CASH_DEPOSIT');
  assert.deepEqual([T(s2[0]).from, T(s2[0]).to], [{ type: 'ACCOUNT', id: 'cash' }, { type: 'ACCOUNT', id: 'next' }]);
});

test('變化：「從 Apple 的玉山轉 3000 到我的台新」→ 夫妻互轉（D18 由轉帳引擎處理）', () => {
  const raw = g([tr({ segment: '從 Apple 的玉山轉 3000 到我的台新', amount: 3000, transferKind: 'ACCOUNT', fromText: 'Apple 的玉山', toText: '我的台新' })]);
  // 「我的台新」帳戶和台新卡都是 Shark 的 → 目的要問；選帳戶後兩端是不同成員的個人帳戶 → 夫妻互轉
  assert.equal((run('從 Apple 的玉山轉 3000 到我的台新', raw).res as any).question.role, 'to');
  const s = ready(run('從 Apple 的玉山轉 3000 到我的台新', raw, BASE, { '0:to': 'ACCOUNT:taishin' }));
  assert.equal(T(s[0]).kind, 'SPOUSE');
  assert.deepEqual(T(s[0]).from, { type: 'ACCOUNT', id: 'appleEsun' });
  assert.deepEqual(T(s[0]).to, { type: 'ACCOUNT', id: 'taishin' });
});

test('變化：「國泰」說成「國泰世華」→ 機構名命中；繳卡費目的只看卡', () => {
  const raw = g([tr({ segment: '國泰世華轉 2000 到台新', amount: 2000, transferKind: 'ACCOUNT', fromText: '國泰世華', toText: '台新' })]);
  // 「台新」帳戶與台新卡都對得上 → 目的要問
  const r = run('國泰世華轉 2000 到台新', raw);
  assert.equal((r.res as any).question.role, 'to');
  const s = ready(run('國泰世華轉 2000 到台新', raw, BASE, { '0:to': 'ACCOUNT:taishin' }));
  assert.deepEqual(T(s[0]).from, { type: 'ACCOUNT', id: 'cathay' });
  // 繳卡費的目的只看卡：說「台新」→ 台新卡，不問
  const s2 = ready(run('繳台新 3000', g([tr({ segment: '繳台新 3000', amount: 3000, transferKind: 'CARD_PAYMENT', toText: '台新' })])));
  assert.deepEqual(T(s2[0]).to, { type: 'CARD', id: 'taishinCard' });
});

test('變化：比不到的帳戶 → 問要不要新增（帳戶／信用卡／取消）', () => {
  const r = run('從郵局轉 2000 到台新', g([tr({ segment: '從郵局轉 2000 到台新', amount: 2000, transferKind: 'ACCOUNT', fromText: '郵局', toText: '台新' })]));
  assert.equal((r.res as any).question.type, 'create');
  assert.equal((r.res as any).question.raw, '郵局');
});

test('變化：定存解約「將來定存解約 5 萬轉回活存」→ 定存 → 同機構活存', () => {
  const withTd = [...BASE, acc('nextTd', '將來定存', 'TIME_DEPOSIT', null, { institution: '將來銀行', sortOrder: 8 })];
  const s = ready(run('將來定存解約 5 萬轉回活存', g([tr({ segment: '將來定存解約 5 萬轉回活存', amount: 50000, transferKind: 'TIME_DEPOSIT', fromText: '將來定存', toText: '' })]), withTd));
  assert.deepEqual([T(s[0]).from, T(s[0]).to], [{ type: 'ACCOUNT', id: 'nextTd' }, { type: 'ACCOUNT', id: 'next' }]);
});

test('變化：「跟小明借 5000」→ 借入（新建負債對象）', () => {
  const s = ready(run('跟小明借 5000', g([tr({ segment: '跟小明借 5000', amount: 5000, transferKind: 'BORROW', counterpartyText: '小明' })])));
  assert.equal(T(s[0]).kind, 'BORROW');
  assert.deepEqual(T(s[0]).from, { type: 'NEW_LIABILITY', name: '小明' }, '借小明是借出（LENT），借入要另建');
});

test('變化：Gemini 誤判成轉帳但句子沒有任何轉帳字眼 → 當一般支出', () => {
  const r = run('午餐 120', g([tr({ segment: '午餐 120', amount: 120, transferKind: 'ACCOUNT', categoryName: '餐飲', note: '午餐' })]));
  assert.equal(r.plan.items[0].type, 'TX');
});

// ================= 3.10.5 文字記帳補強 =================

test('舊例句不變：「午餐 120」→ 一筆、今天、預設帳戶、家庭', () => {
  const s = ready(run('午餐 120', g([tx({ segment: '午餐 120', amount: 120, categoryName: '餐飲', note: '午餐' })])));
  assert.equal(s.length, 1);
  const t = X(s[0]);
  assert.equal(t.item.amount, 120);
  assert.equal(t.item.date.ok, false, '沒寫日期＝今天（記成現在時間，跟舊版一樣）');
  assert.equal(t.item.date.ymd, '2026-11-05');
  assert.equal(t.item.bookTo, 'FAMILY');
  assert.equal(t.item.ownerMemberId, null);
  assert.equal(t.accountId, 'cash');
});

test('舊例句不變：「早餐 豆漿25 蛋餅35」→ 兩筆、整句共用付款', () => {
  const s = ready(run('早餐 豆漿25 蛋餅35', g([tx({ segment: '豆漿25', amount: 25, categoryName: '餐飲', note: '早餐 豆漿' }), tx({ segment: '蛋餅35', amount: 35, categoryName: '餐飲', note: '早餐 蛋餅' })])));
  assert.deepEqual(s.map((x) => X(x).item.amount), [25, 35]);
  assert.ok(s.every((x) => X(x).accountId === 'cash'));
});

test('「吃午餐花了 120 元」寬鬆說法 → 120', () => {
  const s = ready(run('吃午餐花了 120 元', g([tx({ segment: '吃午餐花了 120 元', amount: 120, categoryName: '餐飲', note: '午餐' })])));
  assert.equal(X(s[0]).item.amount, 120);
});

test('付款方式：「刷國泰卡午餐 120」→ 國泰卡；「午餐 120 用現金」→ 現金；別人的個人帳戶 → 記預設並說明', () => {
  const s = ready(run('刷國泰卡午餐 120', g([tx({ segment: '刷國泰卡午餐 120', amount: 120, categoryName: '餐飲', note: '午餐', accountText: '國泰卡' })])));
  assert.equal(X(s[0]).creditCardId, 'cathayCard');
  const s2 = ready(run('午餐 120 用現金', g([tx({ segment: '午餐 120 用現金', amount: 120, categoryName: '餐飲', accountText: '現金' })])));
  assert.equal(X(s2[0]).accountId, 'cash');
  const s3 = ready(run('Apple 玉山 午餐 120', g([tx({ segment: 'Apple 玉山 午餐 120', amount: 120, categoryName: '餐飲', accountText: 'Apple 玉山' })])));
  assert.equal(X(s3[0]).othersPay, 'Apple 玉山');
  assert.equal(X(s3[0]).accountId, 'cash');
  const s4 = ready(run('用街口 午餐 120', g([tx({ segment: '用街口 午餐 120', amount: 120, categoryName: '餐飲', accountText: '街口' })])));
  assert.equal(X(s4[0]).unknownPay, '街口');
});

test('付款方式有兩個候選（兩張都叫台新的）→ 問', () => {
  const r = run('刷台新 午餐 120', g([tx({ segment: '刷台新 午餐 120', amount: 120, categoryName: '餐飲', accountText: '台新' })]));
  assert.equal(r.res.status, 'question');
  assert.deepEqual((r.res as any).question.options.map((o: any) => o.id).sort(), ['taishin', 'taishinCard']);
});

test('日期：「昨天 晚餐 300」「10/3 加油 1200」「上週五 電影 600」', () => {
  const a = ready(run('昨天 晚餐 300', g([tx({ segment: '昨天 晚餐 300', amount: 300, categoryName: '餐飲', dateText: '昨天' })])));
  assert.equal(X(a[0]).item.date.ymd, '2026-11-04');
  const b = ready(run('10/3 加油 1200', g([tx({ segment: '10/3 加油 1200', amount: 1200, categoryName: '交通', dateText: '10/3' })])));
  assert.equal(X(b[0]).item.date.ymd, '2026-10-03');
  assert.equal(X(b[0]).item.amount, 1200, '10/3 不算金額');
  const c = ready(run('上週五 電影 600', g([tx({ segment: '上週五 電影 600', amount: 600, categoryName: '娛樂', dateText: '上週五' })])));
  assert.equal(X(c[0]).item.date.ymd, '2026-10-30');
});

test('日期跨年：1/2 說「12/30 聚餐 2000」→ 去年 12/30', () => {
  const now = new Date('2027-01-02T09:00:00+08:00');
  const s = ready(run('12/30 聚餐 2000', g([tx({ segment: '12/30 聚餐 2000', amount: 2000, categoryName: '餐飲', dateText: '12/30' })]), BASE, undefined, now));
  assert.equal(X(s[0]).item.date.ymd, '2026-12-30');
});

test('日期：Gemini 掰了原句沒有的日期 → 不採信；換不出來 → 今天並標 ok=false', () => {
  const s = ready(run('午餐 120', g([tx({ segment: '午餐 120', amount: 120, categoryName: '餐飲', dateText: '昨天' })])));
  assert.equal(X(s[0]).item.date.ymd, '2026-11-05');
  assert.equal(X(s[0]).item.date.ok, false);
  const s2 = ready(run('下禮拜 聚餐 800', g([tx({ segment: '下禮拜 聚餐 800', amount: 800, categoryName: '餐飲', dateText: '下禮拜' })])));
  assert.equal(X(s2[0]).item.date.ok, false);
  assert.equal(X(s2[0]).item.date.explicit, true, '有寫日期但換不出來 → 回覆要標「日期是今天，要改嗎」');
});

test('一句多筆不同日期：「昨天早餐 80，今天午餐 120」', () => {
  const s = ready(run('昨天早餐 80，今天午餐 120', g([tx({ segment: '昨天早餐 80', amount: 80, categoryName: '餐飲', dateText: '昨天' }), tx({ segment: '今天午餐 120', amount: 120, categoryName: '餐飲', dateText: '今天' })])));
  assert.deepEqual(s.map((x) => X(x).item.date.ymd), ['2026-11-04', '2026-11-05']);
});

test('歸屬人：「幫 Apple 記 美髮 1500」「Apple 的午餐 150」→ Apple；「跟 Apple 吃晚餐 800」→ 不算', () => {
  const a = ready(run('幫 Apple 記 美髮 1500', g([tx({ segment: '幫 Apple 記 美髮 1500', amount: 1500, categoryName: '美容', ownerText: 'Apple' })])));
  assert.equal(X(a[0]).item.ownerMemberId, APPLE);
  const b = ready(run('Apple 的午餐 150', g([tx({ segment: 'Apple 的午餐 150', amount: 150, categoryName: '餐飲', ownerText: 'Apple' })])));
  assert.equal(X(b[0]).item.ownerMemberId, APPLE);
  const c = ready(run('跟 Apple 吃晚餐 800', g([tx({ segment: '跟 Apple 吃晚餐 800', amount: 800, categoryName: '餐飲', ownerText: 'Apple' })])));
  assert.equal(X(c[0]).item.ownerMemberId, null, 'Gemini 誤填歸屬人也不採信');
});

test('公司費用＋外幣：「公司 Zoom 15.99 美金」→ BUSINESS、USD 15.99、預估台幣 520', () => {
  const s = ready(run('公司 Zoom 15.99 美金', g([tx({ segment: '公司 Zoom 15.99 美金', amount: 15.99, categoryName: '軟體訂閱', note: 'Zoom', currencyText: '美金' })])));
  const t = X(s[0]).item;
  assert.equal(t.bookTo, 'BUSINESS');
  assert.equal(t.originalCurrency, 'USD');
  assert.equal(t.originalAmount, 15.99);
  assert.equal(t.amount, 520);
  assert.equal(t.amountEstimated, true);
  const s2 = ready(run('公司 計程車 350', g([tx({ segment: '公司 計程車 350', amount: 350, categoryName: '交通', note: '計程車' })])));
  assert.equal(X(s2[0]).item.bookTo, 'BUSINESS');
  assert.equal(X(s2[0]).item.originalCurrency, null);
});

test('外幣：「日本 拉麵 1200 日圓」→ JPY；不認得的幣別 → 問', () => {
  const s = ready(run('日本 拉麵 1200 日圓', g([tx({ segment: '日本 拉麵 1200 日圓', amount: 1200, categoryName: '餐飲', currencyText: '日圓' })])));
  assert.equal(X(s[0]).item.originalCurrency, 'JPY');
  assert.equal(X(s[0]).item.amount, 252);
  const r = run('越南 河粉 50000 越盾', g([tx({ segment: '越南 河粉 50000 越盾', amount: 50000, categoryName: '餐飲', currencyText: '越盾' })]));
  assert.equal(r.plan.issues[0]?.code, 'unknown_currency');
});

test('混在一起：「昨天刷國泰卡 公司 Zoom 15.99 美金，跟 Apple 吃晚餐 800」→ 兩筆', () => {
  const sentence = '昨天刷國泰卡 公司 Zoom 15.99 美金，跟 Apple 吃晚餐 800';
  const s = ready(
    run(
      sentence,
      g([
        tx({ segment: '昨天刷國泰卡 公司 Zoom 15.99 美金', amount: 15.99, categoryName: '軟體訂閱', note: 'Zoom', dateText: '昨天', accountText: '國泰卡', currencyText: '美金' }),
        tx({ segment: '跟 Apple 吃晚餐 800', amount: 800, categoryName: '餐飲', note: '晚餐', dateText: '昨天' }),
      ]),
    ),
  );
  const [a, b] = s.map(X);
  assert.equal(a.item.bookTo, 'BUSINESS');
  assert.equal(a.item.originalCurrency, 'USD');
  assert.equal(a.creditCardId, 'cathayCard');
  assert.equal(a.item.date.ymd, '2026-11-04');
  assert.equal(b.item.bookTo, 'FAMILY');
  assert.equal(b.item.ownerMemberId, null);
  assert.equal(b.item.originalCurrency, null);
  assert.equal(b.accountId, 'cash');
});

test('同一句含轉帳和消費：「領現金 3000，然後午餐 120 用現金」→ 一筆轉帳＋一筆支出', () => {
  const sentence = '領現金 3000，然後午餐 120 用現金';
  const s = ready(
    run(
      sentence,
      g([
        tr({ segment: '領現金 3000', amount: 3000, transferKind: 'CASH_WITHDRAW', toText: '現金' }),
        tx({ segment: '午餐 120 用現金', amount: 120, categoryName: '餐飲', note: '午餐', accountText: '現金' }),
      ]),
    ),
  );
  assert.equal(s[0].type, 'TRANSFER');
  assert.equal(T(s[0]).kind, 'CASH_WITHDRAW');
  assert.equal(s[1].type, 'TX');
  assert.equal(X(s[1]).accountId, 'cash');
});

test('比對器：完全相同只有一個、其他部分相似 → 直接用', () => {
  const m = matchInstrument('國泰活存', BASE, { speakerId: SHARK, members, kinds: ['ACCOUNT', 'CARD'] });
  assert.equal(m.status, 'unique');
});
