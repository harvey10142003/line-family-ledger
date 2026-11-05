// 轉帳規則（lib/transfer-rules.ts）：3.10.1 每一種的合法／不合法組合、連帶收支、帳單狀態。不需要資料庫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TransferKind } from '@prisma/client';
import {
  checkShape,
  checkSplit,
  liabilityEffect,
  linkedEntries,
  money,
  statementStatus,
  TRANSFER_KINDS,
  TransferRuleError,
  type Endpoint,
} from '../src/lib/transfer-rules';

const acc = (id: string, accountType: any = 'BANK', ownerMemberId: string | null = null): Endpoint => ({ type: 'ACCOUNT', id, accountType, ownerMemberId });
const BANK = acc('bank');
const BANK2 = acc('bank2');
const CASH = acc('cash', 'CASH');
const TD = acc('td', 'TIME_DEPOSIT');
const SHARK = acc('shark', 'BANK', 'm_shark');
const SHARK2 = acc('shark2', 'BANK', 'm_shark');
const APPLE = acc('apple', 'BANK', 'm_apple');
const CARD: Endpoint = { type: 'CARD', id: 'card' };
const LOAN: Endpoint = { type: 'LIABILITY', id: 'loan', direction: 'BORROWED' };
const LENT: Endpoint = { type: 'LIABILITY', id: 'lent', direction: 'LENT' };

const ok = (k: TransferKind, f: Endpoint | null, t: Endpoint | null) => assert.doesNotThrow(() => checkShape(k, f, t), `${k} should pass`);
const no = (k: TransferKind, f: Endpoint | null, t: Endpoint | null) =>
  assert.throws(() => checkShape(k, f, t), (e: unknown) => e instanceof TransferRuleError, `${k} should fail`);

test('規格 3.10.1 的 10 種全部有規則', () => {
  assert.equal(TRANSFER_KINDS.length, 10);
});

test('每一種的合法組合', () => {
  ok('ACCOUNT', BANK, BANK2);
  ok('ACCOUNT', CASH, TD); // 一般轉帳不限帳戶類型（與舊版相同）
  ok('CARD_PAYMENT', BANK, CARD);
  ok('CASH_WITHDRAW', BANK, CASH);
  ok('CASH_DEPOSIT', CASH, BANK);
  ok('TIME_DEPOSIT', BANK, TD); // 轉定存
  ok('TIME_DEPOSIT', TD, BANK); // 解約／到期
  ok('LOAN_REPAY', BANK, LOAN);
  ok('LEND', BANK, LENT);
  ok('BORROW', LOAN, BANK);
  ok('COLLECT', LENT, BANK);
  ok('SPOUSE', APPLE, SHARK);
});

test('每一種的不合法組合', () => {
  no('ACCOUNT', BANK, BANK); // 同一個帳戶
  no('ACCOUNT', BANK, CARD);
  no('ACCOUNT', null, BANK);
  no('CARD_PAYMENT', BANK, BANK2);
  no('CARD_PAYMENT', LOAN, CARD);
  no('CASH_WITHDRAW', CASH, CASH);
  no('CASH_WITHDRAW', BANK, BANK2);
  no('CASH_DEPOSIT', BANK, CASH);
  no('CASH_DEPOSIT', CASH, acc('cash2', 'CASH'));
  no('TIME_DEPOSIT', BANK, BANK2); // 兩端都不是定存
  no('TIME_DEPOSIT', TD, acc('td2', 'TIME_DEPOSIT')); // 兩端都是定存
  no('LOAN_REPAY', BANK, LENT); // 還款只能還「借入的」
  no('LOAN_REPAY', LOAN, BANK);
  no('LEND', BANK, LOAN);
  no('BORROW', LENT, BANK);
  no('BORROW', BANK, LOAN);
  no('COLLECT', LOAN, BANK);
  no('SPOUSE', BANK, SHARK); // 共同帳戶 → 個人：用一般轉帳
  no('SPOUSE', SHARK, SHARK2); // 同一個人的兩個帳戶
  no('SPOUSE', APPLE, CARD);
});

test('連帶收支：還貸款利息＝支出（來源帳戶）、手續費＝支出', () => {
  assert.deepEqual(linkedEntries('LOAN_REPAY', BANK, LOAN, { interest: 6000, fee: 100 }), [
    { role: 'INTEREST_EXPENSE', accountId: 'bank', amount: 6000 },
    { role: 'FEE', accountId: 'bank', amount: 100 },
  ]);
});

test('連帶收支：收回借款、定存解約的利息＝收入（進目的帳戶）', () => {
  assert.deepEqual(linkedEntries('COLLECT', LENT, BANK, { interest: 50 }), [{ role: 'INTEREST_INCOME', accountId: 'bank', amount: 50 }]);
  assert.deepEqual(linkedEntries('TIME_DEPOSIT', TD, BANK, { interest: 320 }), [{ role: 'INTEREST_INCOME', accountId: 'bank', amount: 320 }]);
});

test('連帶收支：其他種類不能帶利息（轉定存、一般轉帳、繳卡費、夫妻互轉…）', () => {
  for (const [k, f, t] of [
    ['TIME_DEPOSIT', BANK, TD],
    ['ACCOUNT', BANK, BANK2],
    ['CARD_PAYMENT', BANK, CARD],
    ['SPOUSE', APPLE, SHARK],
    ['LEND', BANK, LENT],
    ['BORROW', LOAN, BANK],
  ] as [TransferKind, Endpoint, Endpoint][]) {
    assert.throws(() => linkedEntries(k, f, t, { interest: 1 }), /不會產生利息/, k);
  }
});

test('連帶收支：手續費記在付錢的帳戶（來源是負債時記目的帳戶）；沒有利息手續費就什麼都不記', () => {
  assert.deepEqual(linkedEntries('CASH_WITHDRAW', BANK, CASH, { fee: 15 }), [{ role: 'FEE', accountId: 'bank', amount: 15 }]);
  assert.deepEqual(linkedEntries('BORROW', LOAN, BANK, { fee: 30 }), [{ role: 'FEE', accountId: 'bank', amount: 30 }]);
  for (const k of ['ACCOUNT', 'SPOUSE'] as TransferKind[]) {
    assert.deepEqual(linkedEntries(k, APPLE, SHARK, {}), []);
  }
  assert.throws(() => linkedEntries('ACCOUNT', BANK, BANK2, { fee: -1 }));
});

test('負債剩餘本金：還款、收回減少；借出、借入增加（連原始本金一起）；其他種類不動', () => {
  assert.deepEqual(liabilityEffect('LOAN_REPAY', 12000), { side: 'to', current: -12000, principalToo: false });
  assert.deepEqual(liabilityEffect('COLLECT', 2000), { side: 'from', current: -2000, principalToo: false });
  assert.deepEqual(liabilityEffect('LEND', 5000), { side: 'to', current: 5000, principalToo: true });
  assert.deepEqual(liabilityEffect('BORROW', 5000), { side: 'from', current: 5000, principalToo: true });
  for (const k of ['ACCOUNT', 'CARD_PAYMENT', 'CASH_WITHDRAW', 'CASH_DEPOSIT', 'TIME_DEPOSIT', 'SPOUSE'] as TransferKind[]) {
    assert.equal(liabilityEffect(k, 1), null, k);
  }
});

test('本金＋利息＋手續費要等於總額（還房貸 18000＝本金 12000＋利息 6000）', () => {
  assert.doesNotThrow(() => checkSplit(18000, 12000, 6000));
  assert.doesNotThrow(() => checkSplit(null, 12000, 6000));
  assert.throws(() => checkSplit(18000, 12000, 5000), (e: any) => e.code === 'split_mismatch');
  assert.doesNotThrow(() => checkSplit(100.3, 100.1, 0.2)); // 浮點
});

test('信用卡帳單狀態：全額 PAID、部分 PARTIAL、溢繳 PAID＋overpaid、撤銷回 OPEN／OVERDUE', () => {
  const due = new Date('2026-11-20T00:00:00+08:00');
  const before = new Date('2026-11-10T00:00:00+08:00');
  const after = new Date('2026-11-25T00:00:00+08:00');
  assert.deepEqual(statementStatus(24261, 24261, due, before), { status: 'PAID', remaining: 0, overpaid: 0 });
  assert.deepEqual(statementStatus(24261, 10000, due, before), { status: 'PARTIAL', remaining: 14261, overpaid: 0 });
  assert.deepEqual(statementStatus(24261, 25000, due, before), { status: 'PAID', remaining: 0, overpaid: 739 });
  assert.deepEqual(statementStatus(24261, 0, due, before), { status: 'OPEN', remaining: 24261, overpaid: 0 });
  assert.deepEqual(statementStatus(24261, 0, due, after), { status: 'OVERDUE', remaining: 24261, overpaid: 0 });
  assert.equal(statementStatus(0, 0, due, after).status, 'PAID'); // 本期不用繳
});

test('金額：正數、四捨五入到分；0、負數、非數字丟錯', () => {
  assert.equal(money(120, 'amount'), 120);
  assert.equal(money('99.999', 'amount'), 100);
  assert.equal(money(0, 'fee', { allowZero: true }), 0);
  for (const bad of [0, -1, 'abc', null, undefined, NaN, Infinity]) assert.throws(() => money(bad, 'amount'));
});
