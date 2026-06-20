'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';

type TxType = 'EXPENSE' | 'INCOME';

type TxItem = {
  id: string;
  amount: number;
  type: TxType;
  categoryName: string;
  categoryIcon: string | null;
  note: string | null;
  memberName: string;
  isShared: boolean;
  accountId: string | null;
  creditCardId: string | null;
  accountName: string | null;
  accountIcon: string | null;
  paidAt: string;
};

type Category = { id: string; name: string; icon: string | null; type: TxType };
type Account = { id: string; name: string; icon: string | null };
type Card = { id: string; name: string; icon: string | null };

function ntd(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function TransactionsSection({
  userId,
  month,
  onChanged,
}: {
  userId: string;
  month: string;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<TxItem[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [filType, setFilType] = useState<'ALL' | TxType>('ALL');
  const [filCat, setFilCat] = useState('');
  const [filMember, setFilMember] = useState('');

  const [editing, setEditing] = useState<TxItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  // 表單欄位
  const [fType, setFType] = useState<TxType>('EXPENSE');
  const [fCat, setFCat] = useState('');
  const [fAmount, setFAmount] = useState('');
  const [fDate, setFDate] = useState(todayStr());
  const [fNote, setFNote] = useState('');
  const [fPay, setFPay] = useState(''); // '' | acc:<id> | card:<id>
  const [fShared, setFShared] = useState(true);

  const loadTx = useCallback(async () => {
    setLoading(true);
    try {
      const t = await apiGet<{ items: TxItem[] }>(`/api/liff/transactions?month=${month}`, userId);
      setItems(t.items);
    } finally {
      setLoading(false);
    }
  }, [userId, month]);

  const loadMeta = useCallback(async () => {
    const [c, a, cc] = await Promise.all([
      apiGet<{ categories: Category[] }>('/api/liff/categories', userId),
      apiGet<{ accounts: Account[] }>('/api/liff/accounts', userId),
      apiGet<{ cards: Card[] }>('/api/liff/credit-cards', userId),
    ]);
    setCats(c.categories);
    setAccounts(a.accounts);
    setCards(cc.cards);
  }, [userId]);

  useEffect(() => {
    loadTx();
  }, [loadTx]);
  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  const openAdd = () => {
    setEditing(null);
    setFType('EXPENSE');
    setFCat('');
    setFAmount('');
    setFDate(todayStr());
    setFNote('');
    setFPay(accounts[0] ? `acc:${accounts[0].id}` : '');
    setFShared(true);
    setShowForm(true);
  };

  const openEdit = (t: TxItem) => {
    setEditing(t);
    setFType(t.type);
    const c = cats.find((x) => x.name === t.categoryName && x.type === t.type);
    setFCat(c?.id ?? '');
    setFAmount(String(t.amount));
    setFDate(t.paidAt.slice(0, 10));
    setFNote(t.note ?? '');
    setFPay(t.creditCardId ? `card:${t.creditCardId}` : t.accountId ? `acc:${t.accountId}` : '');
    setFShared(t.isShared);
    setShowForm(true);
  };

  const save = async () => {
    if (!fCat || !(Number(fAmount) > 0)) return;
    const accountId = fPay.startsWith('acc:') ? fPay.slice(4) : null;
    const creditCardId = fPay.startsWith('card:') ? fPay.slice(5) : null;
    const body = { categoryId: fCat, amount: Number(fAmount), note: fNote, paidAt: fDate, accountId, creditCardId, isShared: fShared };
    setBusy(true);
    try {
      if (editing) await apiPatch(`/api/liff/transactions/${editing.id}`, userId, body);
      else await apiPost('/api/liff/transactions', userId, body);
      setShowForm(false);
      await loadTx();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!editing) return;
    if (!confirm('確定刪除這筆紀錄？')) return;
    setBusy(true);
    try {
      await apiDelete(`/api/liff/transactions/${editing.id}`, userId);
      setShowForm(false);
      await loadTx();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const kw = q.trim().toLowerCase();
  const catOptions = [...new Set(items.map((t) => t.categoryName))];
  const memberOptions = [...new Set(items.map((t) => t.memberName))];
  const filtered = items.filter((t) => {
    if (filType !== 'ALL' && t.type !== filType) return false;
    if (filCat && t.categoryName !== filCat) return false;
    if (filMember && t.memberName !== filMember) return false;
    if (kw) {
      const hay = `${t.note ?? ''} ${t.categoryName} ${t.accountName ?? ''} ${t.memberName}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  const filterActive = filType !== 'ALL' || !!filCat || !!filMember;

  const formCats = cats.filter((c) => c.type === fType);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜尋備註 / 分類 / 帳戶 / 成員"
          className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
        />
        <button onClick={() => setShowFilter((s) => !s)} className={`shrink-0 rounded-lg border px-3 py-2 text-sm ${filterActive ? 'border-indigo-400 bg-indigo-50 text-indigo-600' : 'border-gray-200 bg-white text-gray-600'}`}>篩選</button>
        <button onClick={openAdd} className="shrink-0 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white">+ 記一筆</button>
      </div>

      {showFilter && (
        <div className="space-y-2 rounded-lg bg-white p-3 shadow-sm">
          <div className="flex rounded-lg bg-gray-100 p-1 text-sm">
            {([['ALL', '全部'], ['EXPENSE', '支出'], ['INCOME', '收入']] as const).map(([v, l]) => (
              <button key={v} onClick={() => setFilType(v)} className={`flex-1 rounded-md py-1.5 ${filType === v ? 'bg-white font-medium shadow-sm' : 'text-gray-500'}`}>{l}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <select value={filCat} onChange={(e) => setFilCat(e.target.value)} className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-2 text-sm">
              <option value="">所有分類</option>
              {catOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filMember} onChange={(e) => setFilMember(e.target.value)} className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-2 text-sm">
              <option value="">所有成員</option>
              {memberOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          {filterActive && <button onClick={() => { setFilType('ALL'); setFilCat(''); setFilMember(''); }} className="text-xs text-gray-400">清除篩選</button>}
        </div>
      )}

      <section className="rounded-lg bg-white p-2 shadow-sm sm:p-4">
        {loading ? (
          <p className="py-6 text-center text-sm text-gray-400">載入中…</p>
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">{q ? '找不到符合的紀錄' : '本月尚無紀錄'}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filtered.map((t) => (
              <li key={t.id}>
                <button onClick={() => openEdit(t)} className="flex w-full items-center justify-between py-2.5 px-1 text-left hover:bg-gray-50">
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {t.categoryIcon ?? ''} {t.note || t.categoryName}
                      {t.type === 'EXPENSE' && !t.isShared && <span className="ml-1 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500">個人</span>}
                    </p>
                    <p className="text-xs text-gray-400">
                      {t.paidAt.slice(5, 10)}　{t.memberName}
                      {t.accountName ? `　${t.accountIcon ?? ''}${t.accountName}` : ''}
                    </p>
                  </div>
                  <span className={`shrink-0 pl-2 font-medium ${t.type === 'INCOME' ? 'text-emerald-500' : 'text-gray-800'}`}>
                    {t.type === 'INCOME' ? '+' : '-'}{ntd(t.amount)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 新增 / 編輯 Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <div className="w-full max-w-md rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl">
            <h3 className="mb-3 text-base font-semibold">{editing ? '編輯紀錄' : '新增紀錄'}</h3>

            <div className="mb-3 flex rounded-lg bg-gray-100 p-1">
              {(['EXPENSE', 'INCOME'] as TxType[]).map((tp) => (
                <button key={tp} onClick={() => { setFType(tp); setFCat(''); }} className={`flex-1 rounded-md py-1.5 text-sm font-medium ${fType === tp ? 'bg-white shadow-sm' : 'text-gray-500'}`}>
                  {tp === 'EXPENSE' ? '支出' : '收入'}
                </button>
              ))}
            </div>

            <label className="text-xs text-gray-500">金額</label>
            <input value={fAmount} onChange={(e) => setFAmount(e.target.value)} type="number" inputMode="decimal" placeholder="0" className="mb-2 mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-lg font-semibold" />

            <label className="text-xs text-gray-500">分類</label>
            <div className="mb-2 mt-1 flex flex-wrap gap-1.5">
              {formCats.map((c) => (
                <button key={c.id} onClick={() => setFCat(c.id)} className={`rounded-full px-3 py-1 text-xs ${fCat === c.id ? 'bg-indigo-500 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}>
                  {c.icon ?? ''} {c.name}
                </button>
              ))}
            </div>

            <div className="mb-2 flex gap-2">
              <label className="flex-1 text-xs text-gray-500">
                日期
                <input value={fDate} onChange={(e) => setFDate(e.target.value)} type="date" className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
              </label>
              <label className="flex-1 text-xs text-gray-500">
                付款方式
                <select value={fPay} onChange={(e) => setFPay(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-2 py-2 text-sm">
                  <option value="">未指定</option>
                  <optgroup label="帳戶">
                    {accounts.map((a) => <option key={a.id} value={`acc:${a.id}`}>{a.icon ?? ''} {a.name}</option>)}
                  </optgroup>
                  {cards.length > 0 && (
                    <optgroup label="信用卡">
                      {cards.map((c) => <option key={c.id} value={`card:${c.id}`}>{c.icon ?? '💳'} {c.name}</option>)}
                    </optgroup>
                  )}
                </select>
              </label>
            </div>

            {fType === 'EXPENSE' && (
              <div className="mb-2">
                <span className="text-xs text-gray-500">分帳</span>
                <div className="mt-1 flex rounded-lg bg-gray-100 p-1">
                  <button onClick={() => setFShared(true)} className={`flex-1 rounded-md py-1.5 text-sm ${fShared ? 'bg-white font-medium shadow-sm' : 'text-gray-500'}`}>👨‍👩‍👧 共同（分帳）</button>
                  <button onClick={() => setFShared(false)} className={`flex-1 rounded-md py-1.5 text-sm ${!fShared ? 'bg-white font-medium shadow-sm' : 'text-gray-500'}`}>🧍 個人（不分帳）</button>
                </div>
              </div>
            )}

            <label className="text-xs text-gray-500">備註</label>
            <input value={fNote} onChange={(e) => setFNote(e.target.value)} placeholder="例如：午餐" className="mb-3 mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />

            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <button onClick={save} disabled={busy || !fCat || !(Number(fAmount) > 0)} className="rounded-lg bg-indigo-500 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '儲存中' : '儲存'}</button>
                <button onClick={() => setShowForm(false)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600">取消</button>
              </div>
              {editing && <button onClick={del} disabled={busy} className="text-sm text-red-400">刪除</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
