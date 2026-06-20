// 定期提醒（階段 3b）
// - 月結報告：每月 1 號推上個月摘要
// - 預算週報：每週一推本月預算使用進度（僅設了預算的家庭）
//
// 邏輯與排程分離：本檔只負責「做事」，可被 node-cron 或 HTTP 端點觸發。

import { prisma } from '../prisma';
import { lineClient } from '../line/client';
import { config } from '../config';
import { logger } from '../logger';
import { getMonthlySummary } from '../services/transaction';
import { getBudgets } from '../services/budget';
import { getCreditCards } from '../services/creditcard';

function ntd(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

function liffUrl(): string {
  return `https://liff.line.me/${config.line.liffId}`;
}

// 台北當月 "YYYY-MM"
export function currentTaipeiMonth(): string {
  const t = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 上一個月 "YYYY-MM"
export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}`;
}

// 推播給一個家庭的所有成員（multicast，最多 500 人）
async function pushToFamily(memberLineIds: string[], text: string): Promise<void> {
  if (memberLineIds.length === 0) return;
  try {
    await lineClient.multicast({ to: memberLineIds, messages: [{ type: 'text', text }] });
  } catch (err) {
    logger.error({ err, count: memberLineIds.length }, 'multicast failed');
  }
}

// 月結報告：預設推「上個月」。回傳實際推播的家庭數。
export async function sendMonthlySummaries(month?: string): Promise<{ families: number; pushed: number }> {
  const target = month ?? prevMonth(currentTaipeiMonth());
  const families = await prisma.family.findMany({ include: { members: true } });

  let pushed = 0;
  for (const fam of families) {
    const summary = await getMonthlySummary(fam.id, target);
    if (summary.totalExpense === 0 && summary.totalIncome === 0) continue; // 沒紀錄不打擾

    const top = summary.byCategory
      .filter((c) => c.type === 'EXPENSE')
      .slice(0, 3)
      .map((c) => `${c.icon ?? ''} ${c.name} ${ntd(c.amount)}`)
      .join('\n');

    const text = [
      `📊 ${fam.name}　${target} 月結報告`,
      ``,
      `本月支出 ${ntd(summary.totalExpense)}`,
      `本月收入 ${ntd(summary.totalIncome)}`,
      ...(top ? [``, `支出 Top：`, top] : []),
      ``,
      `打開記帳簿看完整報表 👉`,
      liffUrl(),
    ].join('\n');

    await pushToFamily(fam.members.map((m) => m.lineUserId), text);
    pushed++;
  }

  logger.info({ target, families: families.length, pushed }, 'monthly summaries sent');
  return { families: families.length, pushed };
}

// 信用卡繳費提醒：每天跑，繳費日前 daysBefore 天（預設 3）推播。
export async function sendCreditCardDueReminders(daysBefore = 3): Promise<{ families: number; pushed: number }> {
  const families = await prisma.family.findMany({ include: { members: true } });
  // 今天台北 00:00
  const t = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const todayStr = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  const today = new Date(`${todayStr}T00:00:00+08:00`);

  let pushed = 0;
  for (const fam of families) {
    const cards = await getCreditCards(fam.id);
    const due = cards.filter((c) => {
      const d = new Date(`${c.nextDueDate}T00:00:00+08:00`);
      const days = Math.round((d.getTime() - today.getTime()) / 86400000);
      return days === daysBefore;
    });
    if (due.length === 0) continue;

    const lines = due
      .map((c) => `${c.icon ?? '💳'} ${c.name}　本期應繳約 ${ntd(c.cycleUsed)}（${c.nextDueDate.slice(5)} 繳款）`)
      .join('\n');
    const text = `🔔 信用卡繳費提醒（${daysBefore} 天後到期）\n\n${lines}\n\n記得繳款別忘了～`;
    await pushToFamily(fam.members.map((m) => m.lineUserId), text);
    pushed++;
  }

  logger.info({ daysBefore, families: families.length, pushed }, 'credit card due reminders sent');
  return { families: families.length, pushed };
}

// 預算週報：本月，只推有設整體預算的家庭。
export async function sendWeeklyBudgetDigests(): Promise<{ families: number; pushed: number }> {
  const month = currentTaipeiMonth();
  const families = await prisma.family.findMany({ include: { members: true } });

  let pushed = 0;
  for (const fam of families) {
    const { overall } = await getBudgets(fam.id);
    if (overall == null || overall <= 0) continue;

    const summary = await getMonthlySummary(fam.id, month);
    const pct = Math.round((summary.totalExpense / overall) * 100);
    const remain = Math.round((overall - summary.totalExpense) * 100) / 100;

    const head =
      pct >= 100
        ? `⚠️ 本月已超出預算（${pct}%）`
        : pct >= 80
          ? `🔔 本月預算已用 ${pct}%，要留意囉`
          : `本月預算使用 ${pct}%，狀況良好 👍`;

    const text = [
      `📅 ${fam.name}　預算週報`,
      ``,
      head,
      `已花 ${ntd(summary.totalExpense)} / 預算 ${ntd(overall)}`,
      remain >= 0 ? `本月還可花 ${ntd(remain)}` : `已超支 ${ntd(-remain)}`,
      ``,
      `查看明細 👉`,
      liffUrl(),
    ].join('\n');

    await pushToFamily(fam.members.map((m) => m.lineUserId), text);
    pushed++;
  }

  logger.info({ month, families: families.length, pushed }, 'weekly budget digests sent');
  return { families: families.length, pushed };
}
