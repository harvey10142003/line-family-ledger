'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiGet, apiPost, apiPut } from '@/lib/api';

type Card = {
  id: string;
  name: string;
  icon: string | null;
  creditLimit: number;
  statementDay: number;
  dueDay: number;
  cycleUsed: number;
  available: number;
  nextDueDate: string;
  isArchived: boolean;
  sortOrder: number;
};

function ntd(n: number): string {
  const s = `$${Math.abs(n).toLocaleString('en-US')}`;
  return n < 0 ? `-${s}` : s;
}

export default function CreditCardsSection({ userId }: { userId: string }) {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);

  const [name, setName] = useState('');
  const [limit, setLimit] = useState('');
  const [statementDay, setStatementDay] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ cards: Card[] }>('/api/liff/credit-cards', userId);
      setCards(r.cards);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const openAdd = () => {
    setEditing(null);
    setName('');
    setLimit('');
    setStatementDay('');
    setDueDay('');
    setOpen(true);
  };

  const openEdit = (c: Card) => {
    setEditing(c);
    setName(c.name);
    setLimit(String(c.creditLimit));
    setStatementDay(String(c.statementDay));
    setDueDay(String(c.dueDay));
    setOpen(true);
  };

  const save = async () => {
    if (!name.trim()) return;
    const body = {
      name: name.trim(),
      creditLimit: Number(limit) || 0,
      statementDay: Number(statementDay) || 1,
      dueDay: Number(dueDay) || 15,
    };
    setBusy(true);
    try {
      if (editing) await apiPut(`/api/liff/credit-cards/${editing.id}`, userId, body);
      else await apiPost('/api/liff/credit-cards', userId, body);
      setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await apiPut(`/api/liff/credit-cards/${editing.id}`, userId, { isArchived: true });
      setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">信用卡</h2>
        <button onClick={openAdd} className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white">+ 信用卡</button>
      </div>

      {loading ? (
        <p className="py-3 text-center text-sm text-gray-400">載入中…</p>
      ) : cards.length === 0 ? (
        <p className="py-3 text-center text-sm text-gray-400">還沒有信用卡，點「+ 信用卡」新增（填額度/結算日/繳費日）</p>
      ) : (
        <ul className="space-y-2">
          {cards.map((c) => {
            const usedPct = c.creditLimit > 0 ? Math.min(Math.round((c.cycleUsed / c.creditLimit) * 100), 100) : 0;
            return (
              <li key={c.id}>
                <button onClick={() => openEdit(c)} className="w-full rounded-md border border-gray-100 p-3 text-left hover:bg-gray-50">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{c.icon ?? '💳'} {c.name}</span>
                    <span className="text-xs text-gray-500">額度 {ntd(c.creditLimit)}</span>
                  </div>
                  <div className="mt-1.5 h-2 rounded-full bg-gray-100">
                    <div className={`h-2 rounded-full ${usedPct >= 90 ? 'bg-red-500' : usedPct >= 70 ? 'bg-amber-400' : 'bg-indigo-400'}`} style={{ width: `${usedPct}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between text-xs text-gray-500">
                    <span>本期已用 <span className="font-medium text-gray-700">{ntd(c.cycleUsed)}</span></span>
                    <span>可用 <span className="font-medium text-gray-700">{ntd(c.available)}</span></span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-gray-400">
                    結算 每月{c.statementDay}日　·　繳費 每月{c.dueDay}日（下次 {c.nextDueDate.slice(5)}）
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {open && (
        <div className="mt-3 space-y-2 rounded-md border border-gray-100 bg-gray-50 p-3">
          <p className="text-xs font-medium text-gray-600">{editing ? '編輯信用卡' : '新增信用卡'}</p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="卡片名稱（如 台新太陽卡）" className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />
          <input value={limit} onChange={(e) => setLimit(e.target.value)} type="number" inputMode="numeric" placeholder="額度（如 100000）" className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-gray-500">
              結算日（每月幾號）
              <input value={statementDay} onChange={(e) => setStatementDay(e.target.value)} type="number" inputMode="numeric" min={1} max={31} placeholder="如 5" className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />
            </label>
            <label className="flex-1 text-xs text-gray-500">
              繳費日（每月幾號）
              <input value={dueDay} onChange={(e) => setDueDay(e.target.value)} type="number" inputMode="numeric" min={1} max={31} placeholder="如 22" className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex gap-2">
              <button onClick={save} disabled={busy} className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '儲存中' : '儲存'}</button>
              <button onClick={() => setOpen(false)} className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-600">取消</button>
            </div>
            {editing && <button onClick={archive} disabled={busy} className="text-xs text-red-400">封存</button>}
          </div>
        </div>
      )}
    </section>
  );
}
