'use client';

// 負債與借出（財務中樞 P1-3）：房貸、車貸、信貸、親友借款、借出去的錢。
// 手機優先：清單一行一筆，點開才看攤還表、改利率、更新對帳值。還款走轉帳（記一筆還款）。不放 emoji。
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiSendResult } from '@/lib/api';
import { OwnershipFields, OwnerBadges, ownershipBody, type Owned, type Visibility } from './OwnershipFields';
import type { TransferKind } from './TransfersSection';

type Method = 'EQUAL_PAYMENT' | 'EQUAL_PRINCIPAL' | 'INTEREST_ONLY' | 'FREE';
type Kind = 'MORTGAGE' | 'CAR' | 'PERSONAL' | 'FAMILY' | 'OTHER';
type Row = { period: number; date: string; annualRatePct: number; payment: number; principal: number; interest: number; balance: number; isGrace: boolean };

type Liability = {
  id: string;
  name: string;
  direction: 'BORROWED' | 'LENT';
  currentPrincipal: number;
  isArchived: boolean;
  kind?: Kind;
  lender?: string | null;
  principal?: number;
  annualRate?: number | null;
  termMonths?: number | null;
  method?: Method;
  expectedPrincipal?: number | null;
  nextPayment?: Row | null;
  payoffDate?: string | null;
} & Owned;

const KIND_LABEL: Record<Kind, string> = { MORTGAGE: '房貸', CAR: '車貸', PERSONAL: '信貸', FAMILY: '親友', OTHER: '其他' };
const METHOD_LABEL: Record<Method, string> = { EQUAL_PAYMENT: '本息平均', EQUAL_PRINCIPAL: '本金平均', INTEREST_ONLY: '只繳息', FREE: '不固定' };

function ntd(n: number): string {
  const s = `$${Math.abs(n).toLocaleString('en-US')}`;
  return n < 0 ? `-${s}` : s;
}

const pill = (active: boolean) =>
  `rounded-full px-3 py-1 text-xs ${active ? 'bg-indigo-500 text-white' : 'border border-gray-200 bg-white text-gray-600'}`;
const field = 'w-full rounded-md border border-gray-200 px-3 py-2 text-sm';

export default function LiabilitiesSection({
  userId,
  memberId,
  rev,
  onPay,
  onChanged,
}: {
  userId: string;
  memberId: string;
  rev: number;
  onPay: (kind: TransferKind, liabilityId: string) => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<Liability[]>([]);
  const [totals, setTotals] = useState({ borrowed: 0, lent: 0, net: 0 });
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // 新增表單
  const [dir, setDir] = useState<'BORROWED' | 'LENT'>('BORROWED');
  const [kind, setKind] = useState<Kind>('MORTGAGE');
  const [name, setName] = useState('');
  const [lender, setLender] = useState('');
  const [principal, setPrincipal] = useState('');
  const [current, setCurrent] = useState('');
  const [method, setMethod] = useState<Method>('EQUAL_PAYMENT');
  const [rate, setRate] = useState('');
  const [term, setTerm] = useState('');
  const [start, setStart] = useState('');
  const [grace, setGrace] = useState('');
  const [mine, setMine] = useState(false);
  const [vis, setVis] = useState<Visibility>('FAMILY_TOTAL_ONLY');

  // 點開後的操作
  const [newRate, setNewRate] = useState('');
  const [rateDate, setRateDate] = useState('');
  const [recon, setRecon] = useState('');

  const load = useCallback(async () => {
    const r = await apiGet<{ items: Liability[]; totals: { borrowed: number; lent: number; net: number } }>('/api/liff/liabilities', userId);
    setItems(r.items);
    setTotals(r.totals);
  }, [userId]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load, rev]);

  const openAdd = () => {
    setDir('BORROWED');
    setKind('MORTGAGE');
    setName('');
    setLender('');
    setPrincipal('');
    setCurrent('');
    setMethod('EQUAL_PAYMENT');
    setRate('');
    setTerm('');
    setStart('');
    setGrace('');
    setMine(false);
    setVis('FAMILY_TOTAL_ONLY');
    setMsg(null);
    setAdding(true);
  };

  const save = async () => {
    setMsg(null);
    const body: Record<string, unknown> = {
      name: name.trim(),
      direction: dir,
      kind,
      lender: lender.trim() || null,
      principal: Number(principal),
      method,
      ...ownershipBody(mine, vis, memberId),
    };
    if (current) body.currentPrincipal = Number(current);
    if (method !== 'FREE') {
      body.annualRate = Number(rate);
      body.termMonths = Number(term);
      body.startDate = start;
      if (grace) body.gracePeriodMonths = Number(grace);
    } else if (rate) body.annualRate = Number(rate);
    setBusy(true);
    try {
      const r = await apiSendResult('POST', '/api/liff/liabilities', body);
      if (!r.ok) {
        setMsg(method !== 'FREE' ? '請確認年利率、期數、首期還款日都有填，寬限期要小於期數' : '請確認名稱和本金');
        return;
      }
      setAdding(false);
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (l: Liability) => {
    if (l.access !== 'DETAIL') return;
    if (openId === l.id) {
      setOpenId(null);
      return;
    }
    setOpenId(l.id);
    setNewRate('');
    setRateDate('');
    setRecon(String(l.currentPrincipal));
    setMsg(null);
    setRows([]);
    if (l.method && l.method !== 'FREE') {
      const s = await apiGet<{ rows: Row[] }>(`/api/liff/liabilities/${l.id}/schedule`, userId);
      setRows(s.rows);
    }
  };

  const changeRate = async (id: string) => {
    if (!rateDate || newRate === '') return;
    setBusy(true);
    try {
      const r = await apiSendResult('POST', `/api/liff/liabilities/${id}/rate-changes`, { effectiveDate: rateDate, annualRate: Number(newRate) });
      setMsg(r.ok ? '利率已更新，攤還表從生效日那期起重算' : '沒有成功，請確認日期與利率');
      await load();
      const s = await apiGet<{ rows: Row[] }>(`/api/liff/liabilities/${id}/schedule`, userId);
      setRows(s.rows);
    } finally {
      setBusy(false);
    }
  };

  const update = async (id: string, body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      const r = await apiSendResult('PUT', `/api/liff/liabilities/${id}`, body);
      setMsg(r.ok ? ok : '沒有成功');
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const upcoming = rows.filter((r) => r.date >= today).slice(0, 12);

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">負債與借出</h2>
        <button onClick={openAdd} className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-medium text-white">+ 新增</button>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="rounded-md bg-gray-50 px-3 py-2">
          <span className="text-xs text-gray-500">還欠</span>
          <p className="text-lg font-semibold text-red-500">{ntd(totals.borrowed)}</p>
        </div>
        <div className="rounded-md bg-gray-50 px-3 py-2">
          <span className="text-xs text-gray-500">借出未收回（算資產）</span>
          <p className="text-lg font-semibold text-emerald-600">{ntd(totals.lent)}</p>
        </div>
      </div>

      {items.length === 0 && <p className="py-2 text-center text-sm text-gray-400">還沒有負債或借出</p>}
      <ul className="space-y-1.5">
        {items.map((l) => {
          const diff = l.expectedPrincipal != null ? Math.round((l.currentPrincipal - l.expectedPrincipal) * 100) / 100 : 0;
          return (
            <li key={l.id} className="rounded-md">
              <button onClick={() => toggle(l)} disabled={l.access !== 'DETAIL'} className="flex w-full items-start justify-between gap-2 rounded-md px-2 py-2 text-left hover:bg-gray-50 disabled:cursor-default disabled:hover:bg-transparent">
                <span className="min-w-0 text-sm">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {l.name}
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${l.direction === 'LENT' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}>
                      {l.direction === 'LENT' ? '借出' : l.kind ? KIND_LABEL[l.kind] : '負債'}
                    </span>
                    <OwnerBadges item={l} memberId={memberId} />
                  </span>
                  {l.nextPayment && (
                    <span className="block text-[11px] text-gray-400">
                      下期 {l.nextPayment.date} 應繳 {ntd(l.nextPayment.payment)}（本金 {ntd(l.nextPayment.principal)}／利息 {ntd(l.nextPayment.interest)}）
                    </span>
                  )}
                  {l.payoffDate && <span className="block text-[11px] text-gray-400">預計 {l.payoffDate.slice(0, 7)} 還清</span>}
                  {Math.abs(diff) > 1 && (
                    <span className="block text-[11px] text-amber-600">依攤還表應剩 {ntd(l.expectedPrincipal!)}，差 {ntd(diff)}，請以銀行對帳單為準</span>
                  )}
                </span>
                <span className={`shrink-0 text-sm font-medium ${l.direction === 'LENT' ? 'text-emerald-600' : 'text-gray-800'}`}>{ntd(l.currentPrincipal)}</span>
              </button>

              {openId === l.id && (
                <div className="mt-1 space-y-2 rounded-md border border-gray-100 bg-gray-50 p-3 text-xs">
                  <p className="text-gray-500">
                    {l.lender ? `${l.lender}　` : ''}
                    {l.method ? METHOD_LABEL[l.method] : ''}
                    {l.annualRate != null ? `　年利率 ${l.annualRate}%` : ''}
                    {l.termMonths ? `　${l.termMonths} 期` : ''}
                    {l.principal != null ? `　原始本金 ${ntd(l.principal)}` : ''}
                  </p>
                  {l.canEdit && (
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => onPay(l.direction === 'LENT' ? 'COLLECT' : 'LOAN_REPAY', l.id)} className="rounded-md bg-indigo-500 px-3 py-1.5 text-white">
                        {l.direction === 'LENT' ? '記一筆收回' : '記一筆還款'}
                      </button>
                      <button onClick={() => onPay(l.direction === 'LENT' ? 'LEND' : 'BORROW', l.id)} className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-gray-600">
                        {l.direction === 'LENT' ? '再借出' : '再借入'}
                      </button>
                    </div>
                  )}

                  {upcoming.length > 0 && (
                    <div className="overflow-hidden rounded-md border border-gray-100 bg-white">
                      <table className="w-full text-right text-[11px]">
                        <thead className="bg-gray-50 text-gray-500">
                          <tr>
                            <th className="px-2 py-1 text-left font-normal">日期</th>
                            <th className="px-2 py-1 font-normal">應繳</th>
                            <th className="px-2 py-1 font-normal">本金</th>
                            <th className="px-2 py-1 font-normal">利息</th>
                          </tr>
                        </thead>
                        <tbody>
                          {upcoming.map((r) => (
                            <tr key={r.period} className="border-t border-gray-50">
                              <td className="px-2 py-1 text-left text-gray-500">{r.date.slice(2)}</td>
                              <td className="px-2 py-1">{r.payment.toLocaleString('en-US')}</td>
                              <td className="px-2 py-1">{r.principal.toLocaleString('en-US')}</td>
                              <td className="px-2 py-1">{r.interest.toLocaleString('en-US')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="px-2 py-1 text-[10px] text-gray-400">按月計息、四捨五入到元，跟銀行可能差幾元</p>
                    </div>
                  )}

                  {l.canEdit && l.method && l.method !== 'FREE' && (
                    <div className="flex gap-2">
                      <input value={rateDate} onChange={(e) => setRateDate(e.target.value)} type="date" className={`${field} min-w-0 flex-1 text-xs`} />
                      <input value={newRate} onChange={(e) => setNewRate(e.target.value)} type="number" inputMode="decimal" placeholder="新年利率 %" className={`${field} w-24 text-xs`} />
                      <button onClick={() => changeRate(l.id)} disabled={busy} className="shrink-0 rounded-md border border-gray-200 bg-white px-3 text-gray-600">改利率</button>
                    </div>
                  )}
                  {l.canEdit && (
                    <div className="flex gap-2">
                      <input value={recon} onChange={(e) => setRecon(e.target.value)} type="number" inputMode="decimal" placeholder="對帳單上的剩餘本金" className={`${field} min-w-0 flex-1 text-xs`} />
                      <button onClick={() => update(l.id, { currentPrincipal: Number(recon) }, '剩餘本金已更新')} disabled={busy || recon === ''} className="shrink-0 rounded-md border border-gray-200 bg-white px-3 text-gray-600">
                        更新本金
                      </button>
                    </div>
                  )}
                  {msg && <p className="text-amber-600">{msg}</p>}
                  {l.canEdit && (
                    <button onClick={() => update(l.id, { isArchived: true }, '已封存')} disabled={busy} className="text-red-400">封存</button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {adding && (
        <div className="mt-3 space-y-2 rounded-md border border-gray-100 bg-gray-50 p-3">
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => { setDir('BORROWED'); setKind('MORTGAGE'); setMethod('EQUAL_PAYMENT'); }} className={pill(dir === 'BORROWED')}>我們欠別人</button>
            <button type="button" onClick={() => { setDir('LENT'); setKind('FAMILY'); setMethod('FREE'); }} className={pill(dir === 'LENT')}>別人欠我們</button>
          </div>
          {dir === 'BORROWED' && (
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                <button key={k} type="button" onClick={() => { setKind(k); if (k === 'FAMILY') setMethod('FREE'); }} className={pill(kind === k)}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={dir === 'LENT' ? '名稱（例如 借小明）' : '名稱（例如 房貸）'} className={field} />
          <input value={lender} onChange={(e) => setLender(e.target.value)} placeholder={dir === 'LENT' ? '借款人' : '銀行或債權人'} className={field} />
          <div className="flex gap-2">
            <input value={principal} onChange={(e) => setPrincipal(e.target.value)} type="number" inputMode="decimal" placeholder="原始本金" className={`${field} min-w-0 flex-1`} />
            <input value={current} onChange={(e) => setCurrent(e.target.value)} type="number" inputMode="decimal" placeholder="目前剩餘（選填）" className={`${field} min-w-0 flex-1`} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(METHOD_LABEL) as Method[]).map((m) => (
              <button key={m} type="button" onClick={() => setMethod(m)} className={pill(method === m)}>
                {METHOD_LABEL[m]}
              </button>
            ))}
          </div>
          {method !== 'FREE' ? (
            <>
              <div className="flex gap-2">
                <input value={rate} onChange={(e) => setRate(e.target.value)} type="number" inputMode="decimal" placeholder="年利率 %" className={`${field} min-w-0 flex-1`} />
                <input value={term} onChange={(e) => setTerm(e.target.value)} type="number" inputMode="numeric" placeholder="總期數（月）" className={`${field} min-w-0 flex-1`} />
              </div>
              <div className="flex gap-2">
                <label className="min-w-0 flex-1 text-xs text-gray-500">
                  首期還款日
                  <input value={start} onChange={(e) => setStart(e.target.value)} type="date" className={field} />
                </label>
                <label className="min-w-0 flex-1 text-xs text-gray-500">
                  寬限期（月，選填）
                  <input value={grace} onChange={(e) => setGrace(e.target.value)} type="number" inputMode="numeric" className={field} />
                </label>
              </div>
            </>
          ) : (
            <p className="text-[11px] text-gray-400">不固定：只記本金和每次還多少（親友借款常用）。</p>
          )}
          <OwnershipFields mine={mine} visibility={vis} onChange={(n) => { setMine(n.mine); setVis(n.visibility); }} />
          <p className="text-[11px] text-gray-400">這裡記的是「已經存在」的欠款，不會動到帳戶餘額；剛借出／借入的錢請用轉帳的「借出」「借入」。</p>
          {msg && <p className="text-xs text-amber-600">{msg}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={save} disabled={busy || !name.trim() || !(Number(principal) >= 0) || principal === ''} className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? '儲存中' : '儲存'}
            </button>
            <button onClick={() => setAdding(false)} className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-600">取消</button>
          </div>
        </div>
      )}
    </section>
  );
}
