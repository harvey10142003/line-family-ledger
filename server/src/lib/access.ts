// 家庭成員之間的可見範圍與編輯權限（財務中樞 P1-2，規格 6.2／D2／D10）。
//
// 這是全專案「誰能看、誰能改」唯一的判斷處。/api/liff/* 每支 API、LINE 的快速修正、
// 月報、預算週報、繳費提醒都只透過 AccessScope 問，不在各處自己寫條件。
//
// 規則：
// - 帳戶／信用卡／負債是「歸屬」的單位：ownerMemberId=null 是共同，有值是某位成員個人的。
// - 本人看自己的、任何人看共同的 → DETAIL（明細）。
// - 看別人的個人項目：FAMILY_FULL → DETAIL；FAMILY_TOTAL_ONLY → TOTAL（只算進總額，看不到每一筆）；
//   OWNER_ONLY → NONE（完全看不到，也不算進他看到的任何數字）。
// - 交易的可見範圍跟著付款帳戶／卡走；沒掛帳戶也沒掛卡的交易＝共同。
// - 寫入（新增、改、刪、記到這個帳戶、從這個帳戶轉出）：只有共同的、或本人的才可以（D10）。
//   別人的個人帳戶就算設成 FAMILY_FULL 看得到明細，也不能改。
// - 找不到的帳戶／卡 id 一律當 NONE（fail-closed），不當共同。
import type { Visibility } from '@prisma/client';

export type AccessLevel = 'DETAIL' | 'TOTAL' | 'NONE';

export interface Ownable {
  ownerMemberId: string | null;
  visibility: Visibility;
}

export interface Instrumented {
  accountId?: string | null;
  creditCardId?: string | null;
}

export const VISIBILITIES: readonly Visibility[] = ['FAMILY_FULL', 'FAMILY_TOTAL_ONLY', 'OWNER_ONLY'] as const;

/** D2：個人帳戶建立時（或從共同改成個人時）沒指定可見範圍 → 對方只看總額。 */
export const DEFAULT_PERSONAL_VISIBILITY: Visibility = 'FAMILY_TOTAL_ONLY';

export function isVisibility(v: unknown): v is Visibility {
  return typeof v === 'string' && (VISIBILITIES as readonly string[]).includes(v);
}

/** 某位成員對某個帳戶／卡的可見程度。 */
export function levelFor(viewerMemberId: string, item: Ownable): AccessLevel {
  if (item.ownerMemberId == null) return 'DETAIL';
  if (item.ownerMemberId === viewerMemberId) return 'DETAIL';
  switch (item.visibility) {
    case 'FAMILY_FULL':
      return 'DETAIL';
    case 'FAMILY_TOTAL_ONLY':
      return 'TOTAL';
    default:
      return 'NONE';
  }
}

/** D10：共同的大家能改；個人的只有本人能改。 */
export function writableBy(viewerMemberId: string, item: Ownable): boolean {
  return item.ownerMemberId == null || item.ownerMemberId === viewerMemberId;
}

/** 權限不符時丟出，路由層轉成 403／404（看不到的東西回 404，不透露存在）。 */
export class AccessError extends Error {
  constructor(
    public readonly status: 403 | 404,
    public readonly code: 'not_found' | 'not_owner',
    message?: string,
  ) {
    super(message ?? (status === 404 ? 'not found' : 'only the owner can change this'));
    this.name = 'AccessError';
  }
}

export interface TransferEnds {
  fromAccountId: string | null;
  toAccountId: string | null;
  fromLiabilityId?: string | null;
  toCreditCardId?: string | null;
  toLiabilityId?: string | null;
}

export interface ScopeItem extends Ownable {
  id: string;
}

export class AccessScope {
  private readonly accounts: Map<string, ScopeItem>;
  private readonly cards: Map<string, ScopeItem>;
  private readonly liabilities: Map<string, ScopeItem>;

  constructor(
    public readonly familyId: string,
    public readonly memberId: string,
    accounts: ScopeItem[],
    cards: ScopeItem[],
    liabilities: ScopeItem[] = [],
  ) {
    this.accounts = new Map(accounts.map((a) => [a.id, a]));
    this.cards = new Map(cards.map((c) => [c.id, c]));
    this.liabilities = new Map(liabilities.map((l) => [l.id, l]));
  }

  /** 負債／借出（P1-3）：規則與帳戶相同。 */
  liabilityLevel(id: string): AccessLevel {
    const l = this.liabilities.get(id);
    return l ? levelFor(this.memberId, l) : 'NONE';
  }

  canWriteLiability(id: string): boolean {
    const l = this.liabilities.get(id);
    return !!l && writableBy(this.memberId, l);
  }

  assertLiabilityWritable(id: string): void {
    if (this.liabilityLevel(id) === 'NONE') throw new AccessError(404, 'not_found', 'liability not found');
    if (!this.canWriteLiability(id)) throw new AccessError(403, 'not_owner', 'only the owner of this personal liability can change it');
  }

  /** 還別人的貸款、把錢借進對方名下的借出：看得到即可（同轉進對方帳戶）。 */
  assertLiabilityTargetable(id: string): void {
    if (this.liabilityLevel(id) === 'NONE') throw new AccessError(404, 'not_found', 'liability not found');
  }

  /** 繳對方的卡費：看得到即可（錢是從自己能動的帳戶出去）。 */
  assertCardTargetable(id: string): void {
    if (this.cardLevel(id) === 'NONE') throw new AccessError(404, 'not_found', 'credit card not found');
  }

  liability(id: string): ScopeItem | undefined {
    return this.liabilities.get(id);
  }

  accountLevel(id: string): AccessLevel {
    const a = this.accounts.get(id);
    return a ? levelFor(this.memberId, a) : 'NONE';
  }

  cardLevel(id: string): AccessLevel {
    const c = this.cards.get(id);
    return c ? levelFor(this.memberId, c) : 'NONE';
  }

  canWriteAccount(id: string): boolean {
    const a = this.accounts.get(id);
    return !!a && writableBy(this.memberId, a);
  }

  canWriteCard(id: string): boolean {
    const c = this.cards.get(id);
    return !!c && writableBy(this.memberId, c);
  }

  /** 交易跟著付款工具走：卡優先（與 accountId 二擇一），都沒有＝共同。 */
  txLevel(tx: Instrumented): AccessLevel {
    if (tx.creditCardId) return this.cardLevel(tx.creditCardId);
    if (tx.accountId) return this.accountLevel(tx.accountId);
    return 'DETAIL';
  }

  canWriteTx(tx: Instrumented): boolean {
    if (tx.creditCardId) return this.canWriteCard(tx.creditCardId);
    if (tx.accountId) return this.canWriteAccount(tx.accountId);
    return true;
  }

  /** 列表（明細）只出 DETAIL；總額、報表、分帳、趨勢算 DETAIL＋TOTAL。 */
  static inTotals(level: AccessLevel): boolean {
    return level !== 'NONE';
  }

  /** 轉帳一端的可見程度：帳戶、卡或負債（P1-4 起來源可以是負債、目的可以是卡或負債）。兩個都空＝NONE。 */
  transferEndLevel(end: { accountId?: string | null; creditCardId?: string | null; liabilityId?: string | null }): AccessLevel {
    if (end.accountId) return this.accountLevel(end.accountId);
    if (end.creditCardId) return this.cardLevel(end.creditCardId);
    if (end.liabilityId) return this.liabilityLevel(end.liabilityId);
    return 'NONE';
  }

  /**
   * 轉帳列表：至少一端是我看得到明細的才列出；完全看不到的那一端名稱遮掉。
   * 兩端都是別人的個人帳戶（總額或不公開）→ 不列。
   */
  transferView(tr: TransferEnds): { visible: boolean; maskFrom: boolean; maskTo: boolean } {
    const f = this.transferEndLevel({ accountId: tr.fromAccountId, liabilityId: tr.fromLiabilityId });
    const t = this.transferEndLevel({ accountId: tr.toAccountId, creditCardId: tr.toCreditCardId, liabilityId: tr.toLiabilityId });
    return { visible: f === 'DETAIL' || t === 'DETAIL', maskFrom: f === 'NONE', maskTo: t === 'NONE' };
  }

  /**
   * 寫入前檢查交易：看不到明細 → 404（不透露存在）；看得到但不是本人的個人帳戶 → 403。
   */
  assertTxWritable(tx: Instrumented): void {
    if (this.txLevel(tx) !== 'DETAIL') throw new AccessError(404, 'not_found', 'transaction not found');
    if (!this.canWriteTx(tx)) throw new AccessError(403, 'not_owner', 'only the owner of this personal account can change it');
  }

  /** 要把錢記到／轉出這個帳戶：看不到 → 404；看得到但不是自己的個人帳戶 → 403。 */
  assertAccountWritable(id: string): void {
    if (this.accountLevel(id) === 'NONE') throw new AccessError(404, 'not_found', 'account not found');
    if (!this.canWriteAccount(id)) throw new AccessError(403, 'not_owner', 'only the owner of this personal account can change it');
  }

  assertCardWritable(id: string): void {
    if (this.cardLevel(id) === 'NONE') throw new AccessError(404, 'not_found', 'credit card not found');
    if (!this.canWriteCard(id)) throw new AccessError(403, 'not_owner', 'only the owner of this personal card can change it');
  }

  /** 轉帳目的帳戶只要看得到（明細或總額）即可：把錢轉進對方帳戶不會動到對方的支出。 */
  assertAccountTargetable(id: string): void {
    if (this.accountLevel(id) === 'NONE') throw new AccessError(404, 'not_found', 'account not found');
  }

  /**
   * 建立／修改帳戶或卡的歸屬：只能設成「共同」或「自己」，不能指定給別人。
   * 回傳正規化後的 { ownerMemberId, visibility }（共同一律 FAMILY_FULL）。
   *
   * - current＝null 代表新建。
   * - 共同 → 自己：允許（認領成個人帳戶），沒給可見範圍時用 D2 預設「只看總額」。
   * - 自己 → 共同：允許。
   * - 只改可見範圍：只有本人（個人項目）才有意義；共同項目忽略並維持 FAMILY_FULL。
   */
  resolveOwnership(
    current: Ownable | null,
    input: { ownerMemberId?: unknown; visibility?: unknown },
  ): { ownerMemberId: string | null; visibility: Visibility } {
    if (input.visibility !== undefined && !isVisibility(input.visibility)) {
      throw new AccessError(403, 'not_owner', 'invalid visibility');
    }
    let owner: string | null = current?.ownerMemberId ?? null;
    if (input.ownerMemberId !== undefined) {
      if (input.ownerMemberId === null || input.ownerMemberId === '') owner = null;
      else if (input.ownerMemberId === this.memberId) owner = this.memberId;
      else throw new AccessError(403, 'not_owner', 'ownerMemberId must be yourself or null (shared)');
    }
    if (owner == null) return { ownerMemberId: null, visibility: 'FAMILY_FULL' };
    const becamePersonal = (current?.ownerMemberId ?? null) == null;
    const visibility = (input.visibility as Visibility | undefined) ?? (becamePersonal ? DEFAULT_PERSONAL_VISIBILITY : current!.visibility);
    return { ownerMemberId: owner, visibility };
  }

  /** 給前端顯示用的每列欄位。 */
  describe(item: ScopeItem | undefined): { access: AccessLevel; canEdit: boolean } {
    if (!item) return { access: 'NONE', canEdit: false };
    return { access: levelFor(this.memberId, item), canEdit: writableBy(this.memberId, item) };
  }

  account(id: string): ScopeItem | undefined {
    return this.accounts.get(id);
  }

  card(id: string): ScopeItem | undefined {
    return this.cards.get(id);
  }
}
