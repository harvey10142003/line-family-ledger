'use client';

// 轉帳（財務中樞 P1-4）：一般轉帳、繳卡費、提領／存入現金、定存、還款、借出、借入、收回、夫妻互轉。
// 轉帳本身不算收支；只有利息、手續費會另外記一筆。本月轉帳列表可撤銷（只有建立的人）。
// 樣式沿用帳戶表單；不放 emoji。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiSendResult } from '@/lib/api';

export type TransferKind =
  | 'ACCOUNT'
  | 'CARD_PAYMENT'
  | 'CASH_WITHDRAW'
  | 'CASH_DEPOSIT'
  | 'TIME_DEPOSIT'
  | 'LOAN_REPAY'
  | 'LEND'
  | 'BORROW'
  | 'COLLECT'
  | 'SPOUSE';

export type TransferPreset = { kind: TransferKind; liabilityId?: string; nonce: number };

type Account = { id: string; name: string; type: string; ownerMemberId?: string | null; canEdit?: boolean };
type Card = { id: string; name: string; access?: string };
type Liability = { id: string; name: string; direction: 'BORROWED' | 'LENT'; canEdit: boolean; access: string; isArchived: boolean };
type Statement = { id: string; statementDate: string; dueDate: string; newBalance: number; paidAmount: number; remaining: number; status: string };
type TransferItem = {
  id: string;
  kind: TransferKind;
  kindLabel: string;
  amount: number;
  fee: number | null;
  interest: number | null;
  fromName: string;
  toName: string;
  note: string | null;
  memberName: string;
  transferredAt: string;
  undone: boolean;
  canUndo: boolean;
  // D18：文字轉帳動到對方個人帳戶 → 待對方確認
  confirmStatus?: 'CONFIRMED' | 'PENDING' | 'ONE_SIDED' | 'REJECTED';
  counterpartName?: string | null;
  canConfirm?: boolean;
  source?: string;
};

const KINDS: { k: TransferKind; label: string }[] = [
  { k: 'ACCOUNT', label: '一般轉帳' },
  { k: 'CARD_PAYMENT', label: '繳卡費' },
  { k: 'CASH_WITHDRAW', label: '提領現金' },
  { k: 'CASH_DEPOSIT', label: '存入現金' },
  { k: 'TIME_DEPOSIT', label: '定存' },
  { k: 'LOAN_REPAY', label: '還款' },
  { k: 'LEND', label: '借出' },
  { k: 'BORROW', label: '借入' },
  { k: 'COLLECT', label: '收回借款' },
  { k: 'SPOUSE', label: '夫妻互轉' },
];

const NEW = '__new__';

const ERR_TEXT: Record<string, string> = {
  invalid_shape: '來源和目的的組合不對，請換一個帳戶',
  same_endpoint: '來源和目的不能是同一個',
  invalid_amount: '金額要大於 0',
  interest_not_allowed: '這種轉帳不會有利息',
  split_mismatch: '本金＋利息＋手續費跟總額對不上',
  exceeds_principal: '本金超過剩餘本金',
  not_owner: '這是家人的個人帳戶，只有本人能動',
  not_found: '找不到這個帳戶',
  not_creator: '只有建立這筆轉帳的人可以撤銷',
  already_undone: '這筆已經撤銷過了',
  not_counterpart: '只有被動到帳戶的那位可以確認',
  not_pending: '這筆已經處理過了',
};

const CONFIRM_LABEL: Record<string, string> = {
  PENDING: '待確認',
  ONE_SIDED: '待確認（先記一邊）',
  REJECTED: '對方已拒絕',
};

function ntd(n: number): string {
  const s = `$${Math.abs(n).toLocaleString('en-US')}`;
  return n < 0 ? `-${s}` : s;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const pill = (active: boolean) =>
  `rounded-full px-3 py-1 text-xs ${active ? 'bg-indigo-500 text-white' : 'border border-gray-200 bg-white text-gray-600'}`;
const field = 'w-full rounded-md border border-gray-200 px-3 py-2 text-sm';

export default function TransfersSection({
  userId,
  memberId,
  rev,
  preset,
  onChanged,
}: {
  userId: string;
  memberId: string;
  rev: number;
  preset: TransferPreset | null;
  onChanged: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [liabilities, setLiabilities] = useState<Liability[]>([]);
  const [items, setItems] = useState<TransferItem[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // 繳卡費要再確認：溢繳（超過本期應繳）或預繳（找不到可沖的帳單，記成預繳、下期帳單自動抵扣）
  const [overpay, setOverpay] = useState<{ kind: 'overpay' | 'prepay'; amount: number; allPaid?: boolean } | null>(null);

  const [kind, setKind] = useState<TransferKind>('ACCOUNT');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [newName, setNewName] = useState('');
  const [amount, setAmount] = useState('');
  const [interest, setInterest] = useState('');
  const [fee, setFee] = useState('');
  const [total, setTotal] = useState('');
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState('');
  const [statement, setStatement] = useState<Statement | null>(null);

  const month = date.slice(0, 7);

  const load = useCallback(async () => {
    const [a, c, l, t] = await Promise.all([
      apiGet<{ accounts: Account[] }>('/api/liff/accounts', userId),
      apiGet<{ cards: Card[] }>('/api/liff/credit-cards', userId),
      apiGet<{ items: Liability[] }>('/api/liff/liabilities', userId),
      apiGet<{ items: TransferItem[] }>(`/api/liff/transfers?month=${todayStr().slice(0, 7)}`, userId),
    ]);
    setAccounts(a.accounts);
    setCards(c.cards);
    setLiabilities(l.items.filter((x) => !x.isArchived));
    setItems(t.items);
  }, [userId]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load, rev]);

  // 從負債頁按「記一筆還款」帶進來
  useEffect(() => {
    if (!preset) return;
    reset(preset.kind);
    if (preset.kind === 'LOAN_REPAY' || preset.kind === 'LEND') setTo(preset.liabilityId ?? '');
    if (preset.kind === 'COLLECT' || preset.kind === 'BORROW') setFrom(preset.liabilityId ?? '');
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.nonce]);

  const reset = (k: TransferKind) => {
    setKind(k);
    setFrom('');
    setTo('');
    setNewName('');
    setAmount('');
    setInterest('');
    setFee('');
    setTotal('');
    setNote('');
    setMsg(null);
    setOverpay(null);
    setStatement(null);
  };

  const writable = accounts.filter((a) => a.canEdit !== false);
  const fromLiability = kind === 'BORROW' || kind === 'COLLECT';
  const toCard = kind === 'CARD_PAYMENT';
  const toLiability = kind === 'LOAN_REPAY' || kind === 'LEND';
  const allowsInterest = kind === 'LOAN_REPAY' || kind === 'COLLECT' || kind === 'TIME_DEPOSIT';
  const liaDir = kind === 'LOAN_REPAY' || kind === 'BORROW' ? 'BORROWED' : 'LENT';
  const liaOptions = liabilities.filter((l) => l.direction === liaDir && (fromLiability ? l.canEdit : true));
  const canCreateLiability = kind === 'LEND' || kind === 'BORROW';

  // 依種類先篩出合理的帳戶（後端仍會再檢查一次）
  const fromAccounts = useMemo(() => {
    if (kind === 'CASH_WITHDRAW') return writable.filter((a) => a.type !== 'CASH');
    if (kind === 'CASH_DEPOSIT') return writable.filter((a) => a.type === 'CASH');
    if (kind === 'SPOUSE') return writable.filter((a) => a.ownerMemberId === memberId);
    return writable;
  }, [kind, writable, memberId]);
  const toAccounts = useMemo(() => {
    if (kind === 'CASH_WITHDRAW') return accounts.filter((a) => a.type === 'CASH');
    if (kind === 'CASH_DEPOSIT') return accounts.filter((a) => a.type !== 'CASH');
    if (kind === 'SPOUSE') return accounts.filter((a) => a.ownerMemberId && a.ownerMemberId !== memberId);
    return accounts;
  }, [kind, accounts, memberId]);

  // 繳卡費：帶出該卡最近一期還沒繳清的帳單
  useEffect(() => {
    if (!toCard || !to) {
      setStatement(null);
      return;
    }
    apiGet<{ items: Statement[] }>(`/api/liff/credit-cards/${to}/statements`, userId)
      .then((r) => {
        const s = r.items.find((x) => x.status !== 'PAID') ?? null;
        setStatement(s);
        if (s && !amount) setAmount(String(s.remaining));
      })
      .catch(() => setStatement(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toCard, to, userId]);

  const suggest = async () => {
    const t = Number(total);
    if (!to || !(t > 0)) return;
    try {
      const r = await apiGet<{ principal: number; interest: number; excess: number }>(`/api/liff/liabilities/${to}/suggest-split?total=${t}&date=${date}`, userId);
      setAmount(String(r.principal));
      setInterest(String(r.interest));
      setFee(r.excess > 0 ? String(r.excess) : '');
      setMsg(r.excess > 0 ? `多出 ${ntd(r.excess)} 先放手續費，請確認是不是帳管費或違約金` : '依剩餘本金和目前利率算的，請對照銀行扣款明細');
    } catch {
      setMsg('算不出來，請手動填本金和利息');
    }
  };

  const submit = async (confirmOverpay = false) => {
    setMsg(null);
    const body: Record<string, unknown> = {
      kind,
      amount: Number(amount),
      transferredAt: date,
      note: note.trim() || null,
    };
    if (interest) body.interest = Number(interest);
    if (fee) body.fee = Number(fee);
    if (kind === 'LOAN_REPAY' && total) body.total = Number(total);
    if (fromLiability) {
      if (from === NEW) body.newLiability = { name: newName.trim() };
      else body.fromLiabilityId = from;
      body.toAccountId = to;
    } else {
      body.fromAccountId = from;
      if (toCard) {
        body.toCreditCardId = to;
        if (statement) body.cardStatementId = statement.id;
      } else if (toLiability) {
        if (to === NEW) body.newLiability = { name: newName.trim() };
        else body.toLiabilityId = to;
      } else body.toAccountId = to;
    }
    if (confirmOverpay) body.confirmOverpay = true;
    setBusy(true);
    try {
      const r = await apiSendResult('POST', '/api/liff/transfers', body);
      if (r.ok) {
        reset(kind);
        setOpen(false);
        onChanged();
        await load();
        return;
      }
      if (r.data?.code === 'overpay_needs_confirm') {
        setOverpay({ kind: 'overpay', amount: Number(r.data.detail?.overpaid ?? 0) });
        return;
      }
      if (r.data?.code === 'no_statement_needs_confirm') {
        setOverpay({ kind: 'prepay', amount: Number(r.data.detail?.amount ?? amount), allPaid: r.data.detail?.reason === 'all_paid' });
        return;
      }
      setMsg(ERR_TEXT[r.data?.code] ?? `沒有成功（${r.status}）`);
    } finally {
      setBusy(false);
    }
  };

  const undo = async (id: string) => {
    setBusy(true);
    try {
      const r = await apiSendResult('POST', `/api/liff/transfers/${id}/undo`, {});
      if (!r.ok) setMsg(ERR_TEXT[r.data?.code] ?? `撤銷沒有成功（${r.status}）`);
      onChanged();
      await load();
    } finally {
      setBusy(false);
    }
  };

  // D18：對方記的轉帳動到我的個人帳戶 → 我在這裡確認或拒絕
  const decide = async (id: string, action: 'confirm' | 'reject') => {
    setBusy(true);
    try {
      const r = await apiSendResult('POST', `/api/liff/transfers/${id}/${action}`, {});
      if (!r.ok) setMsg(ERR_TEXT[r.data?.code] ?? `沒有成功（${r.status}）`);
      onChanged();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const needsName = (canCreateLiability && (from === NEW || to === NEW)) ? !newName.trim() : false;
  const ready = !!from && !!to && Number(amount) > 0 && !needsName;

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">轉帳</h2>
        <button onClick={() => { if (!open) reset(kind); setOpen(!open); }} className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white">
          {open ? '收起' : '+ 轉帳'}
        </button>
      </div>
      <p className="mb-2 text-[11px] text-gray-400">轉帳、繳卡費、還本金都不算收支；利息和手續費會另外記一筆。</p>

      {open && (
        <div className="mb-3 space-y-2 rounded-md border border-gray-100 bg-gray-50 p-3">
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map((o) => (
              <button key={o.k} type="button" onClick={() => reset(o.k)} className={pill(kind === o.k)}>
                {o.label}
              </button>
            ))}
          </div>

          {/* 來源 */}
          <label className="block text-xs text-gray-500">從</label>
          {fromLiability ? (
            <select value={from} onChange={(e) => setFrom(e.target.value)} className={field}>
              <option value="">{kind === 'BORROW' ? '跟誰借…' : '誰還錢…'}</option>
              {liaOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              {canCreateLiability && <option value={NEW}>新增對象…</option>}
            </select>
          ) : (
            <select value={from} onChange={(e) => setFrom(e.target.value)} className={field}>
              <option value="">選帳戶…</option>
              {fromAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}

          {/* 目的 */}
          <label className="block text-xs text-gray-500">到</label>
          {toCard ? (
            <select value={to} onChange={(e) => { setTo(e.target.value); setAmount(''); }} className={field}>
              <option value="">選信用卡…</option>
              {cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : toLiability ? (
            <select value={to} onChange={(e) => setTo(e.target.value)} className={field}>
              <option value="">{kind === 'LEND' ? '借給誰…' : '還哪一筆…'}</option>
              {liaOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              {canCreateLiability && <option value={NEW}>新增對象…</option>}
            </select>
          ) : (
            <select value={to} onChange={(e) => setTo(e.target.value)} className={field}>
              <option value="">選帳戶…</option>
              {toAccounts.filter((a) => a.id !== from).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          {canCreateLiability && (from === NEW || to === NEW) && (
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="對象名稱（例如 小明）" className={field} />
          )}

          {toCard && statement && (
            <p className="text-xs text-gray-500">
              {statement.statementDate} 帳單：應繳 {ntd(statement.newBalance)}，已繳 {ntd(statement.paidAmount)}，截止 {statement.dueDate}
            </p>
          )}
          {toCard && to && !statement && <p className="text-xs text-gray-400">這張卡沒有未繳清的帳單，這筆會記成預繳，下期帳單建立時自動抵扣。</p>}

          {kind === 'LOAN_REPAY' && (
            <div className="flex gap-2">
              <input value={total} onChange={(e) => setTotal(e.target.value)} type="number" inputMode="decimal" placeholder="這次總共扣了多少（選填）" className={`${field} min-w-0 flex-1`} />
              <button type="button" onClick={suggest} disabled={!to || to === NEW} className="shrink-0 rounded-md border border-gray-200 bg-white px-3 text-xs text-gray-600 disabled:opacity-40">
                幫我拆
              </button>
            </div>
          )}

          <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" inputMode="decimal" placeholder={kind === 'LOAN_REPAY' || kind === 'COLLECT' ? '本金' : '金額'} className={field} />
          <div className="flex gap-2">
            {allowsInterest && (
              <input value={interest} onChange={(e) => setInterest(e.target.value)} type="number" inputMode="decimal" placeholder={kind === 'LOAN_REPAY' ? '利息（記支出）' : '利息（記收入）'} className={`${field} min-w-0 flex-1`} />
            )}
            <input value={fee} onChange={(e) => setFee(e.target.value)} type="number" inputMode="decimal" placeholder="手續費（記支出）" className={`${field} min-w-0 flex-1`} />
          </div>
          <div className="flex gap-2">
            <input value={date} onChange={(e) => setDate(e.target.value)} type="date" className={`${field} min-w-0 flex-1`} />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="備註" className={`${field} min-w-0 flex-1`} />
          </div>

          {msg && <p className="text-xs text-amber-600">{msg}</p>}
          {overpay != null && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {overpay.kind === 'overpay'
                ? `這次會溢繳 ${ntd(overpay.amount)}，確定要繳這麼多嗎？`
                : `${overpay.allPaid ? '這張卡最近一期帳單已繳清' : '這張卡還沒有登錄帳單'}，這筆 ${ntd(overpay.amount)} 會先記成預繳，下期帳單建立時自動抵扣。確定嗎？`}
              <div className="mt-2 flex gap-2">
                <button onClick={() => submit(true)} disabled={busy} className="rounded-md bg-amber-500 px-3 py-1.5 text-white">{overpay.kind === 'overpay' ? '確定溢繳' : '確定預繳'}</button>
                <button onClick={() => setOverpay(null)} className="rounded-md border border-amber-200 px-3 py-1.5">改金額</button>
              </div>
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button onClick={() => submit(false)} disabled={busy || !ready} className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? '處理中' : '確認'}
            </button>
            <button onClick={() => setOpen(false)} className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-600">取消</button>
          </div>
          {month !== todayStr().slice(0, 7) && <p className="text-[11px] text-gray-400">日期不在本月，記好後在下方列表看不到，到該月份查。</p>}
        </div>
      )}

      {items.length === 0 ? (
        <p className="py-2 text-center text-sm text-gray-400">本月還沒有轉帳</p>
      ) : (
        <ul className="divide-y divide-gray-50">
          {items.map((t) => (
            <li key={t.id} className={`flex items-center justify-between gap-2 py-2 text-sm ${t.undone || t.confirmStatus === 'REJECTED' ? 'opacity-40' : ''}`}>
              <div className="min-w-0">
                <p className="truncate">
                  <span className="mr-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{t.kindLabel}</span>
                  {t.fromName} → {t.toName}
                </p>
                <p className="truncate text-[11px] text-gray-400">
                  {t.transferredAt.slice(5, 10)}　{t.memberName}
                  {t.interest ? `　利息 ${ntd(t.interest)}` : ''}
                  {t.fee ? `　手續費 ${ntd(t.fee)}` : ''}
                  {t.note ? `　${t.note}` : ''}
                  {t.undone ? '　已撤銷' : ''}
                </p>
                {!t.undone && t.confirmStatus && t.confirmStatus !== 'CONFIRMED' && (
                  <p className="text-[11px] text-amber-600">
                    {CONFIRM_LABEL[t.confirmStatus]}
                    {t.counterpartName && t.confirmStatus !== 'REJECTED' ? `：等 ${t.counterpartName} 確認` : ''}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`font-medium ${t.undone ? 'line-through' : ''}`}>{ntd(t.amount)}</span>
                {t.canConfirm && (
                  <>
                    <button onClick={() => decide(t.id, 'confirm')} disabled={busy} className="rounded bg-indigo-500 px-2 py-0.5 text-[11px] text-white">
                      確認
                    </button>
                    <button onClick={() => decide(t.id, 'reject')} disabled={busy} className="rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500">
                      拒絕
                    </button>
                  </>
                )}
                {t.canUndo && (
                  <button onClick={() => undo(t.id)} disabled={busy} className="rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500">
                    撤銷
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
