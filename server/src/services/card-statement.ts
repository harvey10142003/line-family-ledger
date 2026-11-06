// 信用卡帳單（CardStatement，每卡每期一列）。P1-4 繳卡費轉帳沖這裡的 paidAmount；
// 這裡只提供手動建立／更新一期帳單與列表（P2 丟件解析會改用同一個 upsert）。
// 建立／更新時順便把這張卡的預繳（沒沖到任何一期的繳卡費，見 transfer.ts cardPrepaid）沖進來——
// 只沖「結帳日之後才付」的（規則 A，lib/transfer-rules.ts isPrepaidAfterClosing）；當天或以前付的已在銀行帳單的本期應繳裡。
import { prisma } from '../prisma';
import { AccessError, type AccessScope } from '../lib/access';
import { isPrepaidAfterClosing, statementStatus } from '../lib/transfer-rules';
import { taipeiNoon, ymdTaipei } from '../lib/time-tw';
import { cardPrepaid } from './transfer';

const n = (d: unknown) => Number(d ?? 0);

function viewOf(s: {
  id: string;
  statementDate: Date;
  dueDate: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  newBalance: unknown;
  minimumDue: unknown;
  paidAmount: unknown;
  status: string;
}, now: Date) {
  const st = statementStatus(n(s.newBalance), n(s.paidAmount), s.dueDate, now);
  return {
    id: s.id,
    statementDate: ymdTaipei(s.statementDate),
    dueDate: ymdTaipei(s.dueDate),
    periodStart: s.periodStart ? ymdTaipei(s.periodStart) : null,
    periodEnd: s.periodEnd ? ymdTaipei(s.periodEnd) : null,
    newBalance: n(s.newBalance),
    minimumDue: s.minimumDue == null ? null : n(s.minimumDue),
    paidAmount: n(s.paidAmount),
    remaining: st.remaining,
    overpaid: st.overpaid,
    status: s.status,
  };
}

async function cardOf(familyId: string, cardId: string) {
  const c = await prisma.creditCard.findFirst({ where: { id: cardId, familyId }, select: { id: true } });
  if (!c) throw new AccessError(404, 'not_found', 'credit card not found');
  return c;
}

/** 帳單列表（新到舊）：看得到這張卡明細的才能看。 */
export async function getCardStatements(familyId: string, cardId: string, scope: AccessScope, now: Date = new Date()) {
  await cardOf(familyId, cardId);
  if (scope.cardLevel(cardId) !== 'DETAIL') throw new AccessError(404, 'not_found', 'credit card not found');
  const rows = await prisma.cardStatement.findMany({ where: { familyId, cardId }, orderBy: { statementDate: 'desc' }, take: 24 });
  return rows.map((s) => viewOf(s, now));
}

/** 這張卡目前的預繳（還沒沖到任何一期、付款日晚於最近一期結帳日的繳卡費，規則 A）；權限同帳單列表。 */
export async function getCardPrepaid(familyId: string, cardId: string): Promise<number> {
  return cardPrepaid(prisma, familyId, cardId);
}

/**
 * 手動建立（或更新同一期）帳單：同一張卡同一個結帳日只會有一列（冪等）。
 * 只有能改這張卡的人可以（D10）。已繳金額不在這裡改（由繳卡費轉帳沖）。
 */
export async function createCardStatement(familyId: string, cardId: string, input: Record<string, unknown>, scope: AccessScope, now: Date = new Date()) {
  await cardOf(familyId, cardId);
  scope.assertCardWritable(cardId);
  const statementDate = taipeiNoon(input.statementDate);
  const dueDate = taipeiNoon(input.dueDate);
  if (!statementDate || !dueDate) throw new Error('statementDate and dueDate (YYYY-MM-DD) required');
  const newBalance = Number(input.newBalance);
  if (!Number.isFinite(newBalance)) throw new Error('newBalance must be a number');
  const minimumDue = input.minimumDue == null || input.minimumDue === '' ? null : Number(input.minimumDue);
  if (minimumDue != null && !Number.isFinite(minimumDue)) throw new Error('invalid minimumDue');
  const periodStart = input.periodStart ? taipeiNoon(input.periodStart) ?? null : null;
  const periodEnd = input.periodEnd ? taipeiNoon(input.periodEnd) ?? null : null;
  const data = { dueDate, newBalance: Math.round(newBalance * 100) / 100, minimumDue, periodStart, periodEnd };
  const saved = await prisma.$transaction(async (tx) => {
    const s = await tx.cardStatement.upsert({
      where: { cardId_statementDate: { cardId, statementDate } },
      update: data,
      create: { familyId, cardId, statementDate, ...data },
    });
    // 預繳抵扣（MED-1＋規則 A）：還沒沖到任何一期、而且付款日（台北日期）晚於本期結帳日的繳卡費，整筆沖到這一期。
    // 結帳日當天或以前付的：銀行開這期帳單時已經扣掉了（本期應繳是扣完的數字）→ 不沖、不加已繳，cardStatementId 留空；
    //   cardPrepaid／淨資產看到有更新（或同一期）的結帳日就不再把它算預繳，所以不會重複扣。撤銷它也沒有帳單要還原。
    // 只沖到這張卡最新的一期：補登舊的一期時，晚於舊結帳日的那些可能屬於更新那期（或還是預繳），不動。
    // 整筆沖：轉帳只記一個 cardStatementId，撤銷時才能原樣還原；預繳比本期多的部分留在這一期當溢繳（淨資產算資產）。
    // updateMany 帶 cardStatementId: null 條件＝同時建兩期帳單也不會重複沖同一筆。
    const latest = await tx.cardStatement.findFirst({ where: { familyId, cardId }, orderBy: { statementDate: 'desc' }, select: { id: true } });
    const candidates =
      latest?.id === s.id
        ? await tx.transfer.findMany({
            where: { familyId, kind: 'CARD_PAYMENT', toCreditCardId: cardId, cardStatementId: null, undoneAt: null, confirmStatus: 'CONFIRMED' },
            select: { id: true, amount: true, transferredAt: true },
          })
        : [];
    const prepaid = candidates.filter((t) => isPrepaidAfterClosing(t.transferredAt, s.statementDate));
    let applied = 0;
    for (const t of prepaid) {
      const r = await tx.transfer.updateMany({ where: { id: t.id, cardStatementId: null, undoneAt: null }, data: { cardStatementId: s.id } });
      if (r.count) applied += n(t.amount);
    }
    const cur = applied ? await tx.cardStatement.update({ where: { id: s.id }, data: { paidAmount: { increment: Math.round(applied * 100) / 100 } } }) : s;
    const st = statementStatus(n(cur.newBalance), n(cur.paidAmount), cur.dueDate, now);
    return st.status === cur.status ? cur : tx.cardStatement.update({ where: { id: s.id }, data: { status: st.status } });
  });
  return viewOf(saved, now);
}
