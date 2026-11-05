// 從資料庫載入某位成員的 AccessScope（判斷規則本身在 lib/access.ts）。
// 一個家庭的帳戶、卡、負債很少，整包載入記憶體判斷，不在每個查詢各自 join 條件。
import { prisma } from '../prisma';
import { AccessError, AccessScope } from '../lib/access';

export async function loadAccessScope(familyId: string, memberId: string): Promise<AccessScope> {
  const sel = { id: true, ownerMemberId: true, visibility: true } as const;
  const [accounts, cards, liabilities] = await Promise.all([
    prisma.account.findMany({ where: { familyId }, select: sel }),
    prisma.creditCard.findMany({ where: { familyId }, select: sel }),
    prisma.liability.findMany({ where: { familyId }, select: sel }),
  ]);
  return new AccessScope(familyId, memberId, accounts, cards, liabilities);
}

/**
 * 家庭裡有這個名字的帳戶或卡，但說話者不能記進去（別人的個人帳戶／卡）。
 * 給 LINE 文字記帳：不要問「要不要新增」（新增會撞名、或把交易綁進別人的帳戶），改成說明。
 */
export async function isOthersPersonalInstrumentName(scope: AccessScope, name: string): Promise<boolean> {
  const [acc, card] = await Promise.all([
    prisma.account.findFirst({ where: { familyId: scope.familyId, name }, select: { id: true } }),
    prisma.creditCard.findFirst({ where: { familyId: scope.familyId, name }, select: { id: true } }),
  ]);
  return (!!acc && !scope.canWriteAccount(acc.id)) || (!!card && !scope.canWriteCard(card.id));
}

/** 依 AccessScope 取出一筆「可以改」的交易；看不到回 404、不是本人回 403（AccessError）。 */
export async function getWritableTransaction(scope: AccessScope, txId: string) {
  const tx = await prisma.transaction.findFirst({
    where: { id: txId, familyId: scope.familyId },
    include: { category: true },
  });
  if (!tx) throw new AccessError(404, 'not_found', 'transaction not found');
  scope.assertTxWritable(tx);
  return tx;
}
