'use client';

import { useEffect, useState, useCallback } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { initLiff, getProfile } from '@/lib/liff';
import { apiGet, apiPut, apiDownload } from '@/lib/api';
import AccountsSection from '@/components/AccountsSection';
import CreditCardsSection from '@/components/CreditCardsSection';
import TransactionsSection from '@/components/TransactionsSection';
import RecurringSection from '@/components/RecurringSection';

type MeResp =
  | { joined: false }
  | { joined: true; family: { id: string; name: string; code: string }; member: { id: string; role: string; displayName: string } };

type Summary = {
  month: string;
  totalExpense: number;
  totalIncome: number;
  byCategory: { name: string; icon: string | null; type: 'EXPENSE' | 'INCOME'; amount: number }[];
  byMember: { memberId: string; name: string; amount: number }[];
};
type BudgetStatus = { month: string; overall: { budget: number; spent: number; pct: number } | null };
type Settlement = {
  memberCount: number;
  totalExpense: number;
  perPersonShare: number;
  transfers: { fromName: string; toName: string; amount: number }[];
};

type Tab = 'overview' | 'tx' | 'accounts' | 'more';

const PIE_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#a855f7', '#64748b'];
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'overview', label: '總覽', icon: '📊' },
  { key: 'tx', label: '明細', icon: '📝' },
  { key: 'accounts', label: '帳戶', icon: '💳' },
  { key: 'more', label: '更多', icon: '⚙️' },
];

const currentMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const shiftMonth = (m: string, delta: number) => { const [y, mm] = m.split('-').map(Number); const d = new Date(y, mm - 1 + delta, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const ntd = (n: number) => `$${n.toLocaleString('en-US')}`;

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<MeResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>('overview');
  const [month, setMonth] = useState(currentMonth());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [budgetInput, setBudgetInput] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await initLiff();
        const profile = await getProfile();
        if (!profile) return;
        setUserId(profile.userId);
        setMe(await apiGet<MeResp>('/api/liff/me', profile.userId));
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadMonth = useCallback(async (uid: string, mon: string) => {
    setDataLoading(true);
    try {
      const [s, b, st] = await Promise.all([
        apiGet<Summary>(`/api/liff/summary?month=${mon}`, uid),
        apiGet<BudgetStatus>(`/api/liff/budget-status?month=${mon}`, uid),
        apiGet<Settlement>(`/api/liff/settlement?month=${mon}`, uid),
      ]);
      setSummary(s);
      setBudget(b);
      setSettlement(st);
      setBudgetInput(b.overall ? String(b.overall.budget) : '');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setDataLoading(false);
    }
  }, []);

  useEffect(() => {
    if (userId && me && (me as any).joined) loadMonth(userId, month);
  }, [userId, me, month, loadMonth]);

  const saveBudget = async () => {
    if (!userId) return;
    setSavingBudget(true);
    try {
      await apiPut('/api/liff/budgets', userId, { categoryId: null, amount: Number(budgetInput) || 0 });
      await loadMonth(userId, month);
    } finally {
      setSavingBudget(false);
    }
  };
  const doExport = async () => {
    if (!userId) return;
    try { await apiDownload(`/api/liff/export?month=${month}`, userId, `ledger-${month}.csv`); } catch (e: any) { setError(e?.message ?? String(e)); }
  };

  if (loading) return <main className="p-6 text-gray-500">載入中…</main>;
  if (error) return <main className="p-6 text-red-600">錯誤：{error}</main>;
  if (!me) return <main className="p-6">未登入</main>;
  if (!me.joined)
    return (
      <main className="p-6 space-y-3">
        <h1 className="text-xl font-bold">尚未加入任何家庭</h1>
        <p className="text-gray-600">請回 LINE 對話框，建立或加入一個家庭。</p>
      </main>
    );

  const expenseCats = summary?.byCategory.filter((c) => c.type === 'EXPENSE') ?? [];
  const totalExpense = summary?.totalExpense ?? 0;
  const ov = budget?.overall;
  const barColor = !ov ? '' : ov.pct >= 100 ? 'bg-red-500' : ov.pct >= 80 ? 'bg-amber-400' : 'bg-emerald-400';
  const showMonthBar = tab === 'overview' || tab === 'tx';

  return (
    <div className="min-h-screen bg-gray-50 pb-20 md:pb-6">
      {/* Header */}
      <header className="border-b border-gray-100 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <h1 className="text-lg font-bold">{me.family.name}</h1>
          <span className="text-xs text-gray-400">家庭碼 {me.family.code}</span>
        </div>
        {/* 桌面頂部分頁 */}
        <nav className="mx-auto hidden max-w-3xl gap-1 px-4 md:flex">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === t.key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {t.icon} {t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* 月份切換（總覽 / 明細）*/}
      {showMonthBar && (
        <div className="mx-auto max-w-3xl px-4 pt-3">
          <div className="flex items-center justify-between rounded-lg bg-white px-3 py-2 shadow-sm">
            <button onClick={() => setMonth((m) => shiftMonth(m, -1))} className="px-3 py-1 text-lg text-gray-500">‹</button>
            <span className="font-semibold">{month}</span>
            <button onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={month >= currentMonth()} className="px-3 py-1 text-lg text-gray-500 disabled:opacity-30">›</button>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        {/* ===== 總覽 ===== */}
        {tab === 'overview' && (
          <>
            <section className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-white p-4 shadow-sm">
                <p className="text-xs text-gray-500">本月支出</p>
                <p className="mt-1 text-2xl font-semibold text-red-500">{ntd(totalExpense)}</p>
              </div>
              <div className="rounded-lg bg-white p-4 shadow-sm">
                <p className="text-xs text-gray-500">本月收入</p>
                <p className="mt-1 text-2xl font-semibold text-emerald-500">{ntd(summary?.totalIncome ?? 0)}</p>
              </div>
            </section>

            {dataLoading && <p className="text-center text-sm text-gray-400">更新中…</p>}

            {/* 預算 */}
            <section className="rounded-lg bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-gray-700">每月預算</h2>
              {ov && (
                <div className="mb-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">已用 {ntd(ov.spent)} / {ntd(ov.budget)}</span>
                    <span className={ov.pct >= 100 ? 'font-semibold text-red-500' : 'text-gray-500'}>{ov.pct}%</span>
                  </div>
                  <div className="mt-1 h-2.5 rounded-full bg-gray-100">
                    <div className={`h-2.5 rounded-full ${barColor}`} style={{ width: `${Math.min(ov.pct, 100)}%` }} />
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <input type="number" inputMode="numeric" value={budgetInput} onChange={(e) => setBudgetInput(e.target.value)} placeholder="設定每月預算金額" className="min-w-0 flex-1 rounded-md border border-gray-200 px-3 py-2 text-sm" />
                <button onClick={saveBudget} disabled={savingBudget} className="shrink-0 rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{savingBudget ? '儲存中' : '儲存'}</button>
              </div>
              <p className="mt-1 text-xs text-gray-400">設 0 即取消。每月循環套用。</p>
            </section>

            <div className="md:grid md:grid-cols-2 md:gap-4 md:space-y-0 space-y-4">
              {/* 分類圓餅圖 */}
              <section className="rounded-lg bg-white p-4 shadow-sm">
                <h2 className="mb-2 text-sm font-semibold text-gray-700">支出分類占比</h2>
                {expenseCats.length === 0 ? (
                  <p className="py-8 text-center text-sm text-gray-400">這個月還沒有支出</p>
                ) : (
                  <>
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={expenseCats} dataKey="amount" nameKey="name" cx="50%" cy="50%" outerRadius={75} innerRadius={42}>
                            {expenseCats.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                          </Pie>
                          <Tooltip formatter={(v: number) => ntd(v)} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <ul className="mt-2 space-y-1">
                      {expenseCats.map((c, i) => {
                        const pct = totalExpense > 0 ? Math.round((c.amount / totalExpense) * 100) : 0;
                        return (
                          <li key={c.name} className="flex items-center justify-between text-sm">
                            <span className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />{c.icon ?? ''} {c.name}</span>
                            <span className="text-gray-600">{ntd(c.amount)}　<span className="text-gray-400">{pct}%</span></span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>

              {/* 成員占比 */}
              {summary && summary.byMember.length > 0 && (
                <section className="rounded-lg bg-white p-4 shadow-sm">
                  <h2 className="mb-2 text-sm font-semibold text-gray-700">成員支出占比</h2>
                  <ul className="space-y-2">
                    {summary.byMember.map((mem) => {
                      const pct = totalExpense > 0 ? Math.round((mem.amount / totalExpense) * 100) : 0;
                      return (
                        <li key={mem.memberId} className="text-sm">
                          <div className="flex justify-between"><span>{mem.name}</span><span className="text-gray-600">{ntd(mem.amount)}　<span className="text-gray-400">{pct}%</span></span></div>
                          <div className="mt-1 h-2 rounded-full bg-gray-100"><div className="h-2 rounded-full bg-indigo-400" style={{ width: `${pct}%` }} /></div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </div>

            {/* 分帳結算 */}
            {settlement && settlement.memberCount > 1 && settlement.totalExpense > 0 && (
              <section className="rounded-lg bg-white p-4 shadow-sm">
                <h2 className="mb-1 text-sm font-semibold text-gray-700">分帳結算（均分）</h2>
                <p className="mb-2 text-xs text-gray-400">每人應分攤 {ntd(settlement.perPersonShare)}（{settlement.memberCount} 人）</p>
                {settlement.transfers.length === 0 ? (
                  <p className="py-2 text-center text-sm text-gray-400">大家分攤平均，免結算 🎉</p>
                ) : (
                  <ul className="space-y-1.5">
                    {settlement.transfers.map((tr, i) => (
                      <li key={i} className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 text-sm">
                        <span><span className="font-medium">{tr.fromName}</span> → <span className="font-medium">{tr.toName}</span></span>
                        <span className="font-semibold text-indigo-600">{ntd(tr.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}

        {/* ===== 明細 ===== */}
        {tab === 'tx' && userId && <TransactionsSection userId={userId} month={month} onChanged={() => userId && loadMonth(userId, month)} />}

        {/* ===== 帳戶 ===== */}
        {tab === 'accounts' && userId && (
          <>
            <AccountsSection userId={userId} />
            <CreditCardsSection userId={userId} />
          </>
        )}

        {/* ===== 更多 ===== */}
        {tab === 'more' && userId && (
          <>
            <RecurringSection userId={userId} />
            <section className="rounded-lg bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-gray-700">匯出</h2>
              <button onClick={doExport} className="w-full rounded-lg border border-gray-200 px-4 py-3 text-left text-sm">
                ⬇ 匯出本月 CSV（{month}）
              </button>
              <p className="mt-3 text-xs text-gray-400">更多功能陸續加入：儲蓄目標、趨勢圖、月報…</p>
            </section>
          </>
        )}
      </main>

      {/* 手機底部導覽 */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-gray-200 bg-white md:hidden">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`flex flex-1 flex-col items-center py-2 text-[11px] ${tab === t.key ? 'text-indigo-600' : 'text-gray-400'}`}>
            <span className="text-lg leading-none">{t.icon}</span>
            <span className="mt-0.5">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
