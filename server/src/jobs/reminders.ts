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
  await pushMessages(memberLineIds, [{ type: 'text', text }]);
}

async function pushMessages(memberLineIds: string[], messages: any[]): Promise<void> {
  if (memberLineIds.length === 0) return;
  try {
    await lineClient.multicast({ to: memberLineIds, messages });
  } catch (err) {
    logger.error({ err, count: memberLineIds.length }, 'multicast failed');
  }
}

// 月報 Flex 圖卡
function buildMonthlyFlex(familyName: string, month: string, s: { totalExpense: number; totalIncome: number; byCategory: { name: string; icon: string | null; type: string; amount: number }[] }) {
  const net = Math.round((s.totalIncome - s.totalExpense) * 100) / 100;
  const top = s.byCategory.filter((c) => c.type === 'EXPENSE').slice(0, 5);
  const maxAmt = Math.max(1, ...top.map((c) => c.amount));
  const catRows = top.map((c) => ({
    type: 'box',
    layout: 'vertical',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          { type: 'text', text: `${c.icon ?? ''} ${c.name}`, size: 'sm', color: '#555555', flex: 0 },
          { type: 'text', text: ntd(c.amount), size: 'sm', color: '#111111', align: 'end' },
        ],
      },
      {
        type: 'box',
        layout: 'vertical',
        margin: 'sm',
        height: '6px',
        backgroundColor: '#EEEEEE',
        cornerRadius: '3px',
        contents: [{ type: 'box', layout: 'vertical', contents: [{ type: 'filler' }], width: `${Math.round((c.amount / maxAmt) * 100)}%`, backgroundColor: '#6366F1', cornerRadius: '3px', height: '6px' }],
      },
    ],
  }));

  return {
    type: 'flex',
    altText: `${familyName} ${month} 月結：支出 ${ntd(s.totalExpense)}、收入 ${ntd(s.totalIncome)}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#6366F1',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: `📊 ${month} 月結報告`, color: '#FFFFFF', weight: 'bold', size: 'lg' },
          { type: 'text', text: familyName, color: '#E0E7FF', size: 'sm', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '支出', size: 'xs', color: '#999999' }, { type: 'text', text: ntd(s.totalExpense), size: 'lg', weight: 'bold', color: '#EF4444' }] },
              { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '收入', size: 'xs', color: '#999999' }, { type: 'text', text: ntd(s.totalIncome), size: 'lg', weight: 'bold', color: '#10B981' }] },
              { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '結餘', size: 'xs', color: '#999999' }, { type: 'text', text: ntd(net), size: 'lg', weight: 'bold', color: net < 0 ? '#EF4444' : '#111111' }] },
            ],
          },
          ...(top.length > 0 ? [{ type: 'separator', margin: 'lg' }, { type: 'text', text: '支出 Top', size: 'sm', weight: 'bold', color: '#555555', margin: 'lg' }, ...catRows] : []),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'button', style: 'primary', color: '#6366F1', height: 'sm', action: { type: 'uri', label: '打開記帳簿', uri: liffUrl() } }],
      },
    },
  };
}

// 月結報告：預設推「上個月」。回傳實際推播的家庭數。
export async function sendMonthlySummaries(month?: string): Promise<{ families: number; pushed: number }> {
  const target = month ?? prevMonth(currentTaipeiMonth());
  const families = await prisma.family.findMany({ include: { members: true } });

  let pushed = 0;
  for (const fam of families) {
    const summary = await getMonthlySummary(fam.id, target);
    if (summary.totalExpense === 0 && summary.totalIncome === 0) continue; // 沒紀錄不打擾

    const flex = buildMonthlyFlex(fam.name, target, summary);
    await pushMessages(fam.members.map((m) => m.lineUserId), [flex]);
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

// 記帳 nudge：傍晚跑，今天還沒記任何帳的家庭輕推一下
export async function sendRecordNudges(): Promise<{ families: number; pushed: number }> {
  const t = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const ymd = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  const todayStart = new Date(`${ymd}T00:00:00+08:00`);

  const families = await prisma.family.findMany({ include: { members: true } });
  let pushed = 0;
  for (const fam of families) {
    const cnt = await prisma.transaction.count({ where: { familyId: fam.id, paidAt: { gte: todayStart } } });
    if (cnt > 0) continue; // 今天有記就不打擾
    await pushToFamily(fam.members.map((m) => m.lineUserId), '🐷 今天還沒記帳喔～\n花了什麼直接打給我，例如：午餐 120');
    pushed++;
  }
  logger.info({ families: families.length, pushed }, 'record nudges sent');
  return { families: families.length, pushed };
}
