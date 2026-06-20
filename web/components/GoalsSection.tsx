'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api';

type Goal = {
  id: string;
  name: string;
  icon: string | null;
  targetAmount: number;
  savedAmount: number;
  pct: number;
  remaining: number;
  targetDate: string | null;
};

const ntd = (n: number) => `$${n.toLocaleString('en-US')}`;

export default function GoalsSection({ userId }: { userId: string }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [busy, setBusy] = useState(false);

  const [fName, setFName] = useState('');
  const [fTarget, setFTarget] = useState('');
  const [fDate, setFDate] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiGet<{ goals: Goal[] }>('/api/liff/savings', userId);
      setGoals(r.goals);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const openAdd = () => { setEditing(null); setFName(''); setFTarget(''); setFDate(''); setOpen(true); };
  const openEdit = (g: Goal) => { setEditing(g); setFName(g.name); setFTarget(String(g.targetAmount)); setFDate(g.targetDate ?? ''); setOpen(true); };

  const save = async () => {
    if (!fName.trim() || !(Number(fTarget) > 0)) return;
    const body = { name: fName.trim(), targetAmount: Number(fTarget), targetDate: fDate || null };
    setBusy(true);
    try {
      if (editing) await apiPut(`/api/liff/savings/${editing.id}`, userId, body);
      else await apiPost('/api/liff/savings', userId, body);
      setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const adjust = async (g: Goal, sign: 1 | -1) => {
    const v = prompt(sign > 0 ? `存入「${g.name}」多少？` : `從「${g.name}」取出多少？`, '');
    const amt = Number(v);
    if (!Number.isFinite(amt) || amt <= 0) return;
    await apiPost(`/api/liff/savings/${g.id}/adjust`, userId, { delta: sign * amt });
    await load();
  };

  const del = async () => {
    if (!editing) return;
    if (!confirm('刪除這個目標？')) return;
    setBusy(true);
    try {
      await apiDelete(`/api/liff/savings/${editing.id}`, userId);
      setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">儲蓄目標</h2>
        <button onClick={openAdd} className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white">+ 新增</button>
      </div>

      {loading ? (
        <p className="py-3 text-center text-sm text-gray-400">載入中…</p>
      ) : goals.length === 0 ? (
        <p className="py-3 text-center text-sm text-gray-400">設個目標一起存！例如：旅遊基金 $50,000</p>
      ) : (
        <ul className="space-y-3">
          {goals.map((g) => (
            <li key={g.id} className="rounded-md border border-gray-100 p-3">
              <div className="flex items-center justify-between">
                <button onClick={() => openEdit(g)} className="text-sm font-medium">{g.icon ?? '🎯'} {g.name}</button>
                <span className="text-xs text-gray-500">{ntd(g.savedAmount)} / {ntd(g.targetAmount)}</span>
              </div>
              <div className="mt-1.5 h-2.5 rounded-full bg-gray-100"><div className="h-2.5 rounded-full bg-indigo-400" style={{ width: `${g.pct}%` }} /></div>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-xs text-gray-400">{g.pct}%{g.remaining > 0 ? `　還差 ${ntd(g.remaining)}` : '　達標 🎉'}{g.targetDate ? `　🗓 ${g.targetDate}` : ''}</span>
                <span className="flex gap-1">
                  <button onClick={() => adjust(g, 1)} className="rounded-md bg-emerald-50 px-2.5 py-1 text-xs text-emerald-600">存入</button>
                  <button onClick={() => adjust(g, -1)} className="rounded-md bg-gray-100 px-2.5 py-1 text-xs text-gray-500">取出</button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 space-y-2 rounded-md border border-gray-100 bg-gray-50 p-3">
          <p className="text-xs font-medium text-gray-600">{editing ? '編輯目標' : '新增目標'}</p>
          <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="目標名稱（如 旅遊基金）" className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />
          <input value={fTarget} onChange={(e) => setFTarget(e.target.value)} type="number" inputMode="numeric" placeholder="目標金額" className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />
          <label className="block text-xs text-gray-500">目標日期（可選）
            <input value={fDate} onChange={(e) => setFDate(e.target.value)} type="date" className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />
          </label>
          <div className="flex items-center justify-between pt-1">
            <div className="flex gap-2">
              <button onClick={save} disabled={busy || !fName.trim() || !(Number(fTarget) > 0)} className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '儲存中' : '儲存'}</button>
              <button onClick={() => setOpen(false)} className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-600">取消</button>
            </div>
            {editing && <button onClick={del} disabled={busy} className="text-xs text-red-400">刪除</button>}
          </div>
        </div>
      )}
    </section>
  );
}
