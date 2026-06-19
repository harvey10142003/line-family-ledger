'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiGet, apiPost, apiPut } from '@/lib/api';

type AccountType = 'CASH' | 'BANK' | 'CREDIT_CARD' | 'EPAYMENT' | 'OTHER';

type Account = {
  id: string;
  name: string;
  type: AccountType;
  icon: string | null;
  openingBalance: number;
  balance: number;
  isDefault: boolean;
  isArchived: boolean;
  sortOrder: number;
};

const TYPE_META: Record<AccountType, { label: string; icon: string }> = {
  CASH: { label: '現金', icon: '💵' },
  BANK: { label: '銀行', icon: '🏦' },
  CREDIT_CARD: { label: '信用卡', icon: '💳' }, // 舊資料顯示用；信用卡已獨立區塊
  EPAYMENT: { label: '電子支付', icon: '📱' },
  OTHER: { label: '其他', icon: '📦' },
};

// 新增/編輯帳戶可選的類型（信用卡已獨立，不在此）
const SELECTABLE_TYPES: AccountType[] = ['CASH', 'BANK', 'EPAYMENT', 'OTHER'];

function ntd(n: number): string {
  const s = `$${Math.abs(n).toLocaleString('en-US')}`;
  return n < 0 ? `-${s}` : s;
}

export default function AccountsSection({ userId }: { userId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'none' | 'add' | 'transfer'>('none');
  const [editing, setEditing] = useState<Account | null>(null);

  // 新增/編輯表單
  const [fName, setFName] = useState('');
  const [fType, setFType] = useState<AccountType>('CASH');
  const [fOpening, setFOpening] = useState('');
  const [fDefault, setFDefault] = useState(false);
  const [busy, setBusy] = useState(false);

  // 轉帳表單
  const [tFrom, setTFrom] = useState('');
  const [tTo, setTTo] = useState('');
  const [tAmount, setTAmount] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ accounts: Account[] }>('/api/liff/accounts', userId);
      setAccounts(r.accounts);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const total = accounts.reduce((s, a) => s + a.balance, 0);

  const openAdd = () => {
    setEditing(null);
    setFName('');
    setFType('CASH');
    setFOpening('');
    setFDefault(false);
    setMode('add');
  };

  const openEdit = (a: Account) => {
    setEditing(a);
    setFName(a.name);
    setFType(a.type);
    setFOpening(String(a.openingBalance));
    setFDefault(a.isDefault);
    setMode('add');
  };

  const saveAccount = async () => {
    if (!fName.trim()) return;
    setBusy(true);
    try {
      const opening = Number(fOpening) || 0;
      if (editing) {
        await apiPut(`/api/liff/accounts/${editing.id}`, userId, {
          name: fName.trim(),
          type: fType,
          openingBalance: opening,
          isDefault: fDefault,
        });
      } else {
        await apiPost('/api/liff/accounts', userId, {
          name: fName.trim(),
          type: fType,
          icon: TYPE_META[fType].icon,
          openingBalance: opening,
        });
      }
      setMode('none');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const archiveAccount = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await apiPut(`/api/liff/accounts/${editing.id}`, userId, { isArchived: true });
      setMode('none');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const doTransfer = async () => {
    const amt = Number(tAmount) || 0;
    if (!tFrom || !tTo || tFrom === tTo || amt <= 0) return;
    setBusy(true);
    try {
      await apiPost('/api/liff/transfers', userId, { fromAccountId: tFrom, toAccountId: tTo, amount: amt });
      setMode('none');
      setTAmount('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">帳戶 / 付款方式</h2>
        <div className="flex gap-2">
          <button onClick={() => setMode(mode === 'transfer' ? 'none' : 'transfer')} className="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600">⇄ 轉帳</button>
          <button onClick={openAdd} className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white">+ 帳戶</button>
        </div>
      </div>

      <div className="mb-3 rounded-md bg-gray-50 px-3 py-2">
        <span className="text-xs text-gray-500">總資產（含負債）</span>
        <p className={`text-xl font-semibold ${total < 0 ? 'text-red-500' : 'text-gray-800'}`}>{ntd(total)}</p>
      </div>

      {loading ? (
        <p className="py-4 text-center text-sm text-gray-400">載入中…</p>
      ) : (
        <ul className="space-y-1.5">
          {accounts.map((a) => (
            <li key={a.id}>
              <button onClick={() => openEdit(a)} className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left hover:bg-gray-50">
                <span className="flex items-center gap-2 text-sm">
                  <span>{a.icon ?? TYPE_META[a.type].icon}</span>
                  {a.name}
                  {a.isDefault && <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-500">預設</span>}
                </span>
                <span className={`text-sm font-medium ${a.balance < 0 ? 'text-red-500' : 'text-gray-800'}`}>{ntd(a.balance)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 新增 / 編輯帳戶 */}
      {mode === 'add' && (
        <div className="mt-3 space-y-2 rounded-md border border-gray-100 bg-gray-50 p-3">
          <p className="text-xs font-medium text-gray-600">{editing ? '編輯帳戶' : '新增帳戶'}</p>
          <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="帳戶名稱（如 台新銀行）" className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />
          <div className="flex flex-wrap gap-1.5">
            {SELECTABLE_TYPES.map((t) => (
              <button key={t} onClick={() => setFType(t)} className={`rounded-full px-3 py-1 text-xs ${fType === t ? 'bg-indigo-500 text-white' : 'bg-white text-gray-600 border border-gray-200'}`}>
                {TYPE_META[t].icon} {TYPE_META[t].label}
              </button>
            ))}
          </div>
          <input value={fOpening} onChange={(e) => setFOpening(e.target.value)} type="number" inputMode="numeric" placeholder="期初餘額（信用卡可留 0）" className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />
          {editing && (
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input type="checkbox" checked={fDefault} onChange={(e) => setFDefault(e.target.checked)} />
              設為記帳預設帳戶
            </label>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex gap-2">
              <button onClick={saveAccount} disabled={busy} className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '儲存中' : '儲存'}</button>
              <button onClick={() => setMode('none')} className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-600">取消</button>
            </div>
            {editing && !editing.isDefault && (
              <button onClick={archiveAccount} disabled={busy} className="text-xs text-red-400">封存</button>
            )}
          </div>
        </div>
      )}

      {/* 轉帳 */}
      {mode === 'transfer' && (
        <div className="mt-3 space-y-2 rounded-md border border-gray-100 bg-gray-50 p-3">
          <p className="text-xs font-medium text-gray-600">帳戶轉帳</p>
          <div className="flex items-center gap-2">
            <select value={tFrom} onChange={(e) => setTFrom(e.target.value)} className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-2 text-sm">
              <option value="">從…</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <span className="text-gray-400">→</span>
            <select value={tTo} onChange={(e) => setTTo(e.target.value)} className="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-2 text-sm">
              <option value="">到…</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <input value={tAmount} onChange={(e) => setTAmount(e.target.value)} type="number" inputMode="numeric" placeholder="金額" className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <button onClick={doTransfer} disabled={busy} className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? '處理中' : '確認轉帳'}</button>
            <button onClick={() => setMode('none')} className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-600">取消</button>
          </div>
        </div>
      )}
    </section>
  );
}
