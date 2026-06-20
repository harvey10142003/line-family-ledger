'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api';

type TxType = 'EXPENSE' | 'INCOME';
type Freq = 'MONTHLY' | 'WEEKLY';

type Rule = {
  id: string;
  amount: number;
  note: string | null;
  isShared: boolean;
  frequency: Freq;
  dayOfMonth: number;
  dayOfWeek: number;
  isActive: boolean;
  categoryId: string;
  categoryName: string;
  categoryIcon: string | null;
  type: TxType;
  accountId: string | null;
  creditCardId: string | null;
  payName: string | null;
};
type Category = { id: string; name: string; icon: string | null; type: TxType };
type Account = { id: string; name: string; icon: string | null };
type Card = { id: string; name: string; icon: string | null };

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const ntd = (n: number) => `$${n.toLocaleString('en-US')}`;

export default function RecurringSection({ userId, onChanged }: { userId: string; onChanged?: () => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [busy, setBusy] = useState(false);

  const [fType, setFType] = useState<TxType>('EXPENSE');
  const [fCat, setFCat] = useState('');
  const [fAmount, setFAmount] = useState('');
  const [fFreq, setFFreq] = useState<Freq>('MONTHLY');
  const [fDom, setFDom] = useState('1');
  const [fDow, setFDow] = useState('1');
  const [fPay, setFPay] = useState('');
  const [fShared, setFShared] = useState(true);
  const [fNote, setFNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c, a, cc] = await Promise.all([
        apiGet<{ rules: Rule[] }>('/api/liff/recurring', userId),
        apiGet<{ categories: Category[] }>('/api/liff/categories', userId),
        apiGet<{ accounts: Account[] }>('/api/liff/accounts', userId),
        apiGet<{ cards: Card[] }>('/api/liff/credit-cards', userId),
      ]);
      setRules(r.rules);
      setCats(c.categories);
      setAccounts(a.accounts);
      setCards(cc.cards);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const openAdd = () => {
    setEditing(null);
    setFType('EXPENSE');
    setFCat('');
    setFAmount('');
    setFFreq('MONTHLY');
    setFDom('1');
    setFDow('1');
    setFPay(accounts[0] ? `acc:${accounts[0].id}` : '');
    setFShared(true);
    setFNote('');
    setOpen(true);
  };
  const openEdit = (r: Rule) => {
    setEditing(r);
    setFType(r.type);
    setFCat(r.categoryId);
    setFAmount(String(r.amount));
    setFFreq(r.frequency);
    setFDom(String(r.dayOfMonth));
    setFDow(String(r.dayOfWeek));
    setFPay(r.creditCardId ? `card:${r.creditCardId}` : r.accountId ? `acc:${r.accountId}` : '');
    setFShared(r.isShared);
    setFNote(r.note ?? '');
    setOpen(true);
  };

  const save = async () => {
    if (!fCat || !(Number(fAmount) > 0)) return;
    const body = {
      categoryId: fCat,
      amount: Number(fAmount),
      note: fNote,
      isShared: fShared,
      frequency: fFreq,
      dayOfMonth: Number(fDom) || 1,
      dayOfWeek: Number(fDow) || 0,
      accountId: fPay.startsWith('acc:') ? fPay.slice(4) : null,
      creditCardId: fPay.startsWith('card:') ? fPay.slice(5) : null,
    };
    setBusy(true);
    try {
      if (editing) await apiPut(`/api/liff/recurring/${editing.id}`, userId, body);
      else await apiPost('/api/liff/recurring', userId, body);
      setOpen(false);
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };
  const toggleActive = async (r: Rule) => {
    await apiPut(`/api/liff/recurring/${r.id}`, userId, { isActive: !r.isActive });
    await load();
  };
  const del = async () => {
    if (!editing) return;
    if (!confirm('刪除這個固定收支？')) return;
    setBusy(true);
    try {
      await apiDelete(`/api/liff/recurring/${editing.id}`, userId);
      setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const freqLabel = (r: Rule) => (r.frequency === 'MONTHLY' ? `每月 ${r.dayOfMonth} 日` : `每週${DOW[r.dayOfWeek]}`);
  const formCats = cats.filter((c) => c.type === fType);

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">固定收支（自動記帳）</h2>
        <button onClick={openAdd} className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white">+ 新增</button>
      </div>

      {loading ? (
        <p className="py-3 text-center text-sm text-gray-400">載入中…</p>
      ) : rules.length === 0 ? (
        <p className="py-3 text-center text-sm text-gray-400">還沒有固定收支。房租、訂閱、薪水… 設一次每月自動記。</p>
      ) : (
        <ul className="space-y-1.5">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center justify-between rounded-md border border-gray-100 px-3 py-2">
              <button onClick={() => openEdit(r)} className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm">
                  {r.categoryIcon ?? ''} {r.note || r.categoryName}
                  {r.type === 'EXPENSE' && !r.isShared && <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-500">個人</span>}
                </p>
                <p className="text-xs text-gray-400">{freqLabel(r)}　{ntd(r.amount)}{r.payName ? `　${r.payName}` : ''}</p>
              </button>
              <button onClick={() => toggleActive(r)} className={`ml-2 shrink-0 rounded-full px-2 py-1 text-[11px] ${r.isActive ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>
                {r.isActive ? '啟用中' : '已暫停'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 space-y-2 rounded-md border border-gray-100 bg-gray-50 p-3">
          <p className="text-xs font-medium text-gray-600">{editing ? '編輯固定收支' : '新增固定收支'}</p>

          <div className="flex rounded-lg bg-white p-1">
            {(['EXPENSE', 'INCOME'] as TxType[]).map((tp) => (
              <button key={tp} onClick={() => { setFType(tp); setFCat(''); }} className={`flex-1 rounded-md py-1.5 text-sm ${fType === tp ? 'bg-indigo-500 text-white' : 'text-gray-500'}`}>
                {tp === 'EXPENSE' ? '支出' : '收入'}
              </button>
            ))}
          </div>

          <input value={fAmount} onChange={(e) => setFAmount(e.target.value)} type="number" inputMode="numeric" placeholder="金額" className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />

          <div className="flex flex-wrap gap-1.5">
            {formCats.map((c) => (
              <button key={c.id} onClick={() => setFCat(c.id)} className={`rounded-full px-3 py-1 text-xs ${fCat === c.id ? 'bg-indigo-500 text-white' : 'border border-gray-200 bg-white text-gray-600'}`}>
                {c.icon ?? ''} {c.name}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <select value={fFreq} onChange={(e) => setFFreq(e.target.value as Freq)} className="rounded-md border border-gray-200 px-2 py-2 text-sm">
              <option value="MONTHLY">每月</option>
              <option value="WEEKLY">每週</option>
            </select>
            {fFreq === 'MONTHLY' ? (
              <div className="flex flex-1 items-center gap-1 text-sm text-gray-500">
                <input value={fDom} onChange={(e) => setFDom(e.target.value)} type="number" min={1} max={31} className="w-16 rounded-md border border-gray-200 px-2 py-2 text-sm" />
                <span>日</span>
              </div>
            ) : (
              <select value={fDow} onChange={(e) => setFDow(e.target.value)} className="flex-1 rounded-md border border-gray-200 px-2 py-2 text-sm">
                {DOW.map((d, i) => (
                  <option key={i} value={i}>
                    每週{d}
                  </option>
                ))}
              </select>
            )}
          </div>

          <select value={fPay} onChange={(e) => setFPay(e.target.value)} className="w-full rounded-md border border-gray-200 px-2 py-2 text-sm">
            <option value="">付款方式：未指定</option>
            <optgroup label="帳戶">
              {accounts.map((a) => (
                <option key={a.id} value={`acc:${a.id}`}>
                  {a.icon ?? ''} {a.name}
                </option>
              ))}
            </optgroup>
            {cards.length > 0 && (
              <optgroup label="信用卡">
                {cards.map((c) => (
                  <option key={c.id} value={`card:${c.id}`}>
                    {c.icon ?? '💳'} {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>

          {fType === 'EXPENSE' && (
            <div className="flex rounded-lg bg-white p-1">
              <button onClick={() => setFShared(true)} className={`flex-1 rounded-md py-1.5 text-xs ${fShared ? 'bg-indigo-500 text-white' : 'text-gray-500'}`}>共同（分帳）</button>
              <button onClick={() => setFShared(false)} className={`flex-1 rounded-md py-1.5 text-xs ${!fShared ? 'bg-indigo-500 text-white' : 'text-gray-500'}`}>個人</button>
            </div>
          )}

          <input value={fNote} onChange={(e) => setFNote(e.target.value)} placeholder="備註（如 房租、Netflix）" className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />

          <div className="flex items-center justify-between pt-1">
            <div className="flex gap-2">
              <button onClick={save} disabled={busy || !fCat || !(Number(fAmount) > 0)} className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '儲存中' : '儲存'}</button>
              <button onClick={() => setOpen(false)} className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-600">取消</button>
            </div>
            {editing && <button onClick={del} disabled={busy} className="text-xs text-red-400">刪除</button>}
          </div>
        </div>
      )}
    </section>
  );
}
