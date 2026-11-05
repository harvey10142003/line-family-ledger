// 信用卡帳單（CardStatement，每卡每期一列）。P1-4 繳卡費轉帳沖這裡的 paidAmount；
// 這裡只提供手動建立／更新一期帳單與列表（P2 丟件解析會改用同一個 upsert）。
import { prisma } from '../prisma';
import { AccessError, type AccessScope } from '../lib/access';
import { statementStatus } from '../lib/transfer-rules';
import { taipeiNoon, ymdTaipei } from '../lib/time-tw';

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
  const s = await prisma.cardStatement.upsert({
    where: { cardId_statementDate: { cardId, statementDate } },
    update: data,
    create: { familyId, cardId, statementDate, ...data },
  });
  const st = statementStatus(n(s.newBalance), n(s.paidAmount), s.dueDate, now);
  const saved = st.status === s.status ? s : await prisma.cardStatement.update({ where: { id: s.id }, data: { status: st.status } });
  return viewOf(saved, now);
}
