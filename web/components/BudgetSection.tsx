'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiGet, apiPut } from '@/lib/api';

type CatBudget = { categoryId: string; name: string; icon: string | null; budget: number; spent: number; pct: number };
type BudgetStatus = {
  overall: { budget: number; spent: number; pct: number } | null;
  byCategory: CatBudget[];
  settings: { overall: number | null; byCategory: { categoryId: string; amount: number }[] };
};
type Category = { id: string; name: string; icon: string | null; type: 'EXPENSE' | 'INCOME' };

const ntd = (n: number) => `$${n.toLocaleString('en-US')}`;
const barColor = (pct: number) => (pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-400' : 'bg-emerald-400');

export default function BudgetSection({ userId, month, onChanged }: { userId: string; month: string; onChanged?: () => void }) {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [cats, setCats] = useState<Category[]>([]);
  const [overallInput, setOverallInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      apiGet<BudgetStatus>(`/api/liff/budget-status?month=${month}`, userId),
      apiGet<{ categories: Category[] }>('/api/liff/categories', userId),
    ]);
    setStatus(s);
    setCats(c.categories.filter((x) => x.type === 'EXPENSE'));
    setOverallInput(s.overall ? String(s.overall.budget) : '');
  }, [userId, month]);

  useEffect(() => {
    load();
  }, [load]);

  const saveOverall = async () => {
    setBusy(true);
    try {
      await apiPut('/api/liff/budgets', userId, { categoryId: null, amount: Number(overallInput) || 0 });
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const openManage = () => {
    const d: Record<string, string> = {};
    status?.settings.byCategory.forEach((b) => (d[b.categoryId] = String(b.amount)));
    setDraft(d);
    setManage(true);
  };

  const saveManage = async () => {
    setBusy(true);
    try {
      // 只送有變動的分類
      const prev = new Map(status?.settings.byCategory.map((b) => [b.categoryId, b.amount]) ?? []);
      for (const c of cats) {
        const newVal = Number(draft[c.id] ?? '') || 0;
        const oldVal = prev.get(c.id) ?? 0;
        if (newVal !== oldVal) await apiPut('/api/liff/budgets', userId, { categoryId: c.id, amount: newVal });
      }
      setManage(false);
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const ov = status?.overall;

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">每月預算</h2>
        <button onClick={openManage} className="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600">管理分類預算</button>
      </div>

      {ov && (
        <div className="mb-3">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">整體 已用 {ntd(ov.spent)} / {ntd(ov.budget)}</span>
            <span className={ov.pct >= 100 ? 'font-semibold text-red-500' : 'text-gray-500'}>{ov.pct}%</span>
          </div>
          <div className="mt-1 h-2.5 rounded-full bg-gray-100"><div className={`h-2.5 rounded-full ${barColor(ov.pct)}`} style={{ width: `${Math.min(ov.pct, 100)}%` }} /></div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <input type="number" inputMode="numeric" value={overallInput} onChange={(e) => setOverallInput(e.target.value)} placeholder="整體每月預算" className="min-w-0 flex-1 rounded-md border border-gray-200 px-3 py-2 text-sm" />
        <button onClick={saveOverall} disabled={busy} className="shrink-0 rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">儲存</button>
      </div>

      {/* 分類預算進度 */}
      {status && status.byCategory.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-gray-100 pt-3">
          {status.byCategory.map((c) => (
            <li key={c.categoryId} className="text-sm">
              <div className="flex justify-between">
                <span>{c.icon ?? ''} {c.name}</span>
                <span className={c.pct >= 100 ? 'font-medium text-red-500' : 'text-gray-500'}>{ntd(c.spent)} / {ntd(c.budget)}</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-gray-100"><div className={`h-2 rounded-full ${barColor(c.pct)}`} style={{ width: `${Math.min(c.pct, 100)}%` }} /></div>
            </li>
          ))}
        </ul>
      )}

      {/* 管理分類預算 Modal */}
      {manage && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) setManage(false); }}>
          <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl">
            <h3 className="mb-3 text-base font-semibold">分類預算</h3>
            <ul className="space-y-2">
              {cats.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <span className="text-sm">{c.icon ?? ''} {c.name}</span>
                  <input type="number" inputMode="numeric" value={draft[c.id] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))} placeholder="0" className="w-28 rounded-md border border-gray-200 px-3 py-1.5 text-sm" />
                </li>
              ))}
            </ul>
            <div className="mt-4 flex gap-2">
              <button onClick={saveManage} disabled={busy} className="rounded-lg bg-indigo-500 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '儲存中' : '儲存'}</button>
              <button onClick={() => setManage(false)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600">取消</button>
            </div>
            <p className="mt-2 text-xs text-gray-400">設 0 即取消該分類預算。</p>
          </div>
        </div>
      )}
    </section>
  );
}
