// 可見範圍與編輯權限（lib/access.ts）純邏輯測試，不需要資料庫。
// 期望值是逐格手寫的表（規格 6.2／D2／D10），不是拿被測函式反推，避免自己驗自己。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessScope, AccessError, levelFor, writableBy, DEFAULT_PERSONAL_VISIBILITY } from '../src/lib/access';

const SHARK = 'm_shark';
const APPLE = 'm_apple';

// 7 種付款工具：共同、Shark 個人 ×3 種可見、Apple 個人 ×3 種可見
const ITEMS = [
  { id: 'joint', ownerMemberId: null, visibility: 'FAMILY_FULL' },
  { id: 'shark_full', ownerMemberId: SHARK, visibility: 'FAMILY_FULL' },
  { id: 'shark_total', ownerMemberId: SHARK, visibility: 'FAMILY_TOTAL_ONLY' },
  { id: 'shark_owner', ownerMemberId: SHARK, visibility: 'OWNER_ONLY' },
  { id: 'apple_full', ownerMemberId: APPLE, visibility: 'FAMILY_FULL' },
  { id: 'apple_total', ownerMemberId: APPLE, visibility: 'FAMILY_TOTAL_ONLY' },
  { id: 'apple_owner', ownerMemberId: APPLE, visibility: 'OWNER_ONLY' },
] as const;

// [讀明細, 算進總額, 改, 刪]；Y＝可以，N＝不行
type Row = [string, string, 'Y' | 'N', 'Y' | 'N', 'Y' | 'N', 'Y' | 'N'];
const EXPECTED: Row[] = [
  // viewer  item           detail total edit delete
  ['shark', 'joint',        'Y', 'Y', 'Y', 'Y'],
  ['shark', 'shark_full',   'Y', 'Y', 'Y', 'Y'],
  ['shark', 'shark_total',  'Y', 'Y', 'Y', 'Y'],
  ['shark', 'shark_owner',  'Y', 'Y', 'Y', 'Y'],
  ['shark', 'apple_full',   'Y', 'Y', 'N', 'N'],
  ['shark', 'apple_total',  'N', 'Y', 'N', 'N'],
  ['shark', 'apple_owner',  'N', 'N', 'N', 'N'],
  ['apple', 'joint',        'Y', 'Y', 'Y', 'Y'],
  ['apple', 'shark_full',   'Y', 'Y', 'N', 'N'],
  ['apple', 'shark_total',  'N', 'Y', 'N', 'N'],
  ['apple', 'shark_owner',  'N', 'N', 'N', 'N'],
  ['apple', 'apple_full',   'Y', 'Y', 'Y', 'Y'],
  ['apple', 'apple_total',  'Y', 'Y', 'Y', 'Y'],
  ['apple', 'apple_owner',  'Y', 'Y', 'Y', 'Y'],
];

const scopeOf = (who: string) =>
  new AccessScope('fam', who === 'shark' ? SHARK : APPLE, ITEMS.map((i) => ({ ...i })), ITEMS.map((i) => ({ ...i })));

const yn = (b: boolean) => (b ? 'Y' : 'N');

test('權限矩陣：2 成員 × 7 種帳戶（共同／本人／對方 × 3 種可見）× 讀明細／讀總額／改／刪 — 帳戶與信用卡都一樣', () => {
  const lines: string[] = [];
  for (const [who, item, detail, total, edit, del] of EXPECTED) {
    const s = scopeOf(who);
    for (const kind of ['account', 'card'] as const) {
      const tx = kind === 'account' ? { accountId: item, creditCardId: null } : { accountId: null, creditCardId: item };
      const lv = s.txLevel(tx);
      const got: Row = [who, item, yn(lv === 'DETAIL'), yn(AccessScope.inTotals(lv)), yn(s.canWriteTx(tx)), yn(s.canWriteTx(tx))];
      assert.deepEqual(got, [who, item, detail, total, edit, del], `${kind} ${who}×${item}`);
      // 寫入守門：可寫 → 不丟；看不到明細 → 404；看得到但不是本人 → 403
      if (edit === 'Y') assert.doesNotThrow(() => s.assertTxWritable(tx));
      else
        assert.throws(
          () => s.assertTxWritable(tx),
          (e: unknown) => e instanceof AccessError && e.status === (detail === 'Y' ? 403 : 404),
        );
    }
    lines.push(`${who.padEnd(6)}${item.padEnd(13)}${detail} ${total} ${edit} ${del}`);
  }
  console.log('viewer item         明細 總額 改 刪\n' + lines.join('\n'));
});

test('沒掛帳戶也沒掛卡的交易＝共同：兩人都能看、能改', () => {
  for (const who of ['shark', 'apple']) {
    const s = scopeOf(who);
    assert.equal(s.txLevel({ accountId: null, creditCardId: null }), 'DETAIL');
    assert.equal(s.canWriteTx({}), true);
  }
});

test('找不到的帳戶／卡 id 一律看不到、不能寫（fail-closed，不當共同）', () => {
  const s = scopeOf('shark');
  assert.equal(s.txLevel({ accountId: 'ghost' }), 'NONE');
  assert.equal(s.txLevel({ creditCardId: 'ghost' }), 'NONE');
  assert.equal(s.canWriteTx({ accountId: 'ghost' }), false);
  assert.throws(() => s.assertAccountWritable('ghost'), (e: unknown) => e instanceof AccessError && e.status === 404);
});

test('卡優先：同時帶 accountId 與 creditCardId 時看卡（與寫入邏輯二擇一一致）', () => {
  const s = scopeOf('shark');
  assert.equal(s.txLevel({ accountId: 'joint', creditCardId: 'apple_owner' }), 'NONE');
  assert.equal(s.canWriteTx({ accountId: 'joint', creditCardId: 'apple_owner' }), false);
});

test('轉帳：從別人的個人帳戶轉出一律擋（即使看得到明細）；轉進看不到的帳戶擋', () => {
  const s = scopeOf('shark');
  assert.throws(() => s.assertAccountWritable('apple_full'), (e: unknown) => e instanceof AccessError && e.status === 403);
  assert.throws(() => s.assertAccountWritable('apple_total'), (e: unknown) => e instanceof AccessError && e.status === 403);
  assert.throws(() => s.assertAccountWritable('apple_owner'), (e: unknown) => e instanceof AccessError && e.status === 404);
  assert.doesNotThrow(() => s.assertAccountTargetable('apple_total'));
  assert.throws(() => s.assertAccountTargetable('apple_owner'), (e: unknown) => e instanceof AccessError && e.status === 404);
});

test('轉帳列表：至少一端看得到明細才列；看不到的一端遮名稱', () => {
  const s = scopeOf('shark');
  assert.deepEqual(s.transferView({ fromAccountId: 'joint', toAccountId: 'apple_owner' }), { visible: true, maskFrom: false, maskTo: true });
  assert.deepEqual(s.transferView({ fromAccountId: 'apple_total', toAccountId: 'apple_owner' }), { visible: false, maskFrom: false, maskTo: true });
  assert.deepEqual(s.transferView({ fromAccountId: 'joint', toAccountId: 'shark_owner' }), { visible: true, maskFrom: false, maskTo: false });
});

test('歸屬設定：只能設成共同或自己；個人預設「只看總額」（D2）；共同一律 FAMILY_FULL', () => {
  const s = scopeOf('shark');
  assert.deepEqual(s.resolveOwnership(null, {}), { ownerMemberId: null, visibility: 'FAMILY_FULL' });
  assert.deepEqual(s.resolveOwnership(null, { ownerMemberId: SHARK }), { ownerMemberId: SHARK, visibility: DEFAULT_PERSONAL_VISIBILITY });
  assert.equal(DEFAULT_PERSONAL_VISIBILITY, 'FAMILY_TOTAL_ONLY');
  assert.deepEqual(s.resolveOwnership(null, { ownerMemberId: SHARK, visibility: 'OWNER_ONLY' }), { ownerMemberId: SHARK, visibility: 'OWNER_ONLY' });
  // 共同帳戶給了 visibility 也維持 FAMILY_FULL
  assert.deepEqual(s.resolveOwnership(null, { ownerMemberId: null, visibility: 'OWNER_ONLY' }), { ownerMemberId: null, visibility: 'FAMILY_FULL' });
  // 指定給別人 → 403
  assert.throws(() => s.resolveOwnership(null, { ownerMemberId: APPLE }), (e: unknown) => e instanceof AccessError && e.status === 403);
  // 不合法的 visibility → 擋
  assert.throws(() => s.resolveOwnership(null, { ownerMemberId: SHARK, visibility: 'PUBLIC' }), AccessError);
  // 自己的個人帳戶只改可見範圍
  assert.deepEqual(
    s.resolveOwnership({ ownerMemberId: SHARK, visibility: 'FAMILY_TOTAL_ONLY' }, { visibility: 'FAMILY_FULL' }),
    { ownerMemberId: SHARK, visibility: 'FAMILY_FULL' },
  );
  // 自己的個人帳戶改回共同
  assert.deepEqual(s.resolveOwnership({ ownerMemberId: SHARK, visibility: 'OWNER_ONLY' }, { ownerMemberId: null }), {
    ownerMemberId: null,
    visibility: 'FAMILY_FULL',
  });
  // 共同認領成自己的、沒給可見範圍 → D2 預設
  assert.deepEqual(s.resolveOwnership({ ownerMemberId: null, visibility: 'FAMILY_FULL' }, { ownerMemberId: SHARK }), {
    ownerMemberId: SHARK,
    visibility: 'FAMILY_TOTAL_ONLY',
  });
});

test('levelFor／writableBy 基本規則', () => {
  assert.equal(levelFor(SHARK, { ownerMemberId: null, visibility: 'OWNER_ONLY' }), 'DETAIL'); // 共同不看 visibility
  assert.equal(writableBy(APPLE, { ownerMemberId: SHARK, visibility: 'FAMILY_FULL' }), false); // D10：看得到也不能改
});

// ---- P1-3／P1-4：負債與轉帳端點（卡、負債）同一套規則 ----
const scopeWithLiabilities = (who: string) =>
  new AccessScope(
    'fam',
    who === 'shark' ? SHARK : APPLE,
    ITEMS.map((i) => ({ ...i })),
    ITEMS.map((i) => ({ ...i })),
    ITEMS.map((i) => ({ ...i })),
  );

test('負債矩陣：2 成員 × 7 種歸屬 × 讀明細／算進總額／改（與帳戶同表）', () => {
  for (const [who, id, detail, total, edit] of EXPECTED) {
    const s = scopeWithLiabilities(who);
    const lv = s.liabilityLevel(id);
    assert.equal(yn(lv === 'DETAIL'), detail, `${who} ${id} detail`);
    assert.equal(yn(lv !== 'NONE'), total, `${who} ${id} total`);
    assert.equal(yn(s.canWriteLiability(id)), edit, `${who} ${id} edit`);
    if (edit === 'Y') assert.doesNotThrow(() => s.assertLiabilityWritable(id));
    else assert.throws(() => s.assertLiabilityWritable(id), (e: any) => e instanceof AccessError && e.status === (total === 'Y' ? 403 : 404));
    // 還別人的貸款、繳別人的卡：看得到即可；完全看不到 → 404
    if (total === 'Y') {
      assert.doesNotThrow(() => s.assertLiabilityTargetable(id));
      assert.doesNotThrow(() => s.assertCardTargetable(id));
    } else {
      assert.throws(() => s.assertLiabilityTargetable(id), (e: any) => e.status === 404);
      assert.throws(() => s.assertCardTargetable(id), (e: any) => e.status === 404);
    }
  }
});

test('負債：找不到的 id 一律看不到（fail-closed）；舊呼叫不給負債清單也能用', () => {
  const s = scopeOf('shark');
  assert.equal(s.liabilityLevel('joint'), 'NONE');
  assert.equal(s.canWriteLiability('joint'), false);
});

test('轉帳列表：來源是負債、目的是卡或負債時也照可見範圍遮名／不列', () => {
  const a = scopeWithLiabilities('apple');
  // 從共同帳戶繳 Shark 不公開的卡：Apple 看得到這筆，卡名遮掉
  assert.deepEqual(a.transferView({ fromAccountId: 'joint', toAccountId: null, toCreditCardId: 'shark_owner' }), { visible: true, maskFrom: false, maskTo: true });
  // Shark 只看總額的帳戶還 Shark 不公開的貸款：Apple 不列
  assert.deepEqual(a.transferView({ fromAccountId: 'shark_total', toAccountId: null, toLiabilityId: 'shark_owner' }), { visible: false, maskFrom: false, maskTo: true });
  // 收回 Apple 自己的借出到共同帳戶
  assert.deepEqual(a.transferView({ fromAccountId: null, fromLiabilityId: 'apple_owner', toAccountId: 'joint' }), { visible: true, maskFrom: false, maskTo: false });
  // 兩端都沒有（不該發生）→ 不列
  assert.equal(a.transferView({ fromAccountId: null, toAccountId: null }).visible, false);
});
