'use client';

// 全貌（財務中樞 P1-7）：淨資產、走勢、資產負債組成、每人各自、本月現金流、負債還清時間表、代墊公司費用。
// 數字全部由後端程式算（依我的可見範圍）；這裡只負責顯示。手機 375px 寬不需要橫向捲動。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { apiGet, apiSendResult } from '@/lib/api';

type Comp = { key: string; label: string; amount: number };
type Owner = { ownerId: string; name: string; assets: number; liabilities: number; netWorth: number };
type NetWorth = {
  assets: number;
  liabilities: number;
  netWorth: number;
  composition: { assets: Comp[]; liabilities: Comp[] };
  byOwner: Owner[];
  rows: { side: 'asset' | 'debt'; key: string; name: string; ownerName: string; amount: number }[];
};
type Overview = {
  asOf: string;
  netWorth: NetWorth;
  history: { month: string; netWorth: number; assets: number; liabilities: number; byOwner: Owner[]; live: boolean }[];
  cashflow: { month: string; income: number; expense: number; saved: number; savingsRate: number | null };
  payoff: {
    id: string;
    name: string;
    ownerName: string | null;
    access: string;
    currentPrincipal: number;
    payoffDate: string | null;
    monthsLeft: number | null;
    nextPayment: { date: string; payment: number; principal: number; interest: number } | null;
    annualRate: number | null;
  }[];
  receivable: number;
};

const LINE_COLORS = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6'];

function ntd(n: number): string {
  const s = `$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  return n < 0 ? `-${s}` : s;
}
function wan(n: number): string {
  // 圖表軸：萬為單位，省空間
  return Math.abs(n) >= 10000 ? `${Math.round(n / 1000) / 10}萬` : `${Math.round(n)}`;
}
function prevMonth(m: string): string {
  const [y, mm] = m.split('-').map(Number);
  return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
}

export default function NetWorthSection({ userId, month }: { userId: string; month: string }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Overview>(`/api/liff/overview?month=${month}`, userId));
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [userId, month]);

  useEffect(() => {
    load();
  }, [load]);

  // 走勢：家庭一條＋每人各一條（共同那條不畫，避免太亂）
  const { series, names } = useMemo(() => {
    const names = new Set<string>();
    const series = (data?.history ?? []).map((h) => {
      const p: Record<string, number | string> = { month: h.month.slice(2).replace('-', '/'), 家庭: h.netWorth };
      for (const o of h.byOwner) {
        if (o.ownerId === 'shared') continue;
        p[o.name] = o.netWorth;
        names.add(o.name);
      }
      return p;
    });
    return { series, names: [...names] };
  }, [data]);

  const recompute = async () => {
    if (!data) return;
    const target = prevMonth(data.asOf ? new Date(new Date(data.asOf).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 7) : month);
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiSendResult('POST', '/api/liff/net-worth/snapshots', { month: target });
      setMsg(r.ok ? `已重算 ${target} 的快照` : `重算沒有成功（${r.status}）`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="py-6 text-center text-sm text-red-500">載入失敗：{error}</p>;
  if (!data) return <p className="py-6 text-center text-sm text-gray-400">載入中…</p>;

  const nw = data.netWorth;
  const maxAsset = Math.max(1, ...nw.composition.assets.map((a) => Math.abs(a.amount)));
  const maxDebt = Math.max(1, ...nw.composition.liabilities.map((a) => Math.abs(a.amount)));
  const cf = data.cashflow;

  return (
    <div className="space-y-4">
      {/* 淨資產 */}
      <section className="rounded-lg bg-white p-4 shadow-sm">
        <p className="text-xs text-gray-500">家庭淨資產（你看得到的範圍）</p>
        <p className={`mt-1 text-3xl font-semibold ${nw.netWorth < 0 ? 'text-red-500' : 'text-gray-900'}`}>{ntd(nw.netWorth)}</p>
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md bg-gray-50 px-3 py-2">
            <p className="text-[11px] text-gray-500">資產</p>
            <p className="font-medium text-emerald-600">{ntd(nw.assets)}</p>
          </div>
          <div className="rounded-md bg-gray-50 px-3 py-2">
            <p className="text-[11px] text-gray-500">負債</p>
            <p className="font-medium text-red-500">{ntd(nw.liabilities)}</p>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-gray-400">帳戶＋借出＋代墊公司費用－貸款與借款－信用卡已出帳未繳。轉帳不算收支；家人設成不公開的不算。</p>
      </section>

      {/* 走勢 */}
      <section className="rounded-lg bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">淨資產走勢</h2>
          <button onClick={recompute} disabled={busy} className="rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500 disabled:opacity-50">
            {busy ? '重算中' : '重算上個月'}
          </button>
        </div>
        {msg && <p className="mb-1 text-[11px] text-gray-500">{msg}</p>}
        {series.length < 2 && <p className="mb-2 text-[11px] text-gray-400">每月 1 號早上會自動記下上個月底的淨資產，累積幾個月後就看得到走勢。</p>}
        <div className="h-52 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 10 }} width={44} tickFormatter={wan} />
              <Tooltip formatter={(v: number) => ntd(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="家庭" stroke={LINE_COLORS[0]} strokeWidth={2} dot={{ r: 3 }} />
              {names.map((n, i) => (
                <Line key={n} type="monotone" dataKey={n} stroke={LINE_COLORS[(i + 1) % LINE_COLORS.length]} strokeWidth={1.5} dot={{ r: 2 }} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="space-y-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
        {/* 資產組成 */}
        <section className="rounded-lg bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-gray-700">資產組成</h2>
          {nw.composition.assets.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-400">還沒有資產資料</p>
          ) : (
            <ul className="space-y-2">
              {nw.composition.assets.map((a) => (
                <li key={a.key} className="text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="min-w-0 truncate text-gray-600">{a.label}</span>
                    <span className="shrink-0">{ntd(a.amount)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-gray-100">
                    <div className="h-1.5 rounded-full bg-emerald-400" style={{ width: `${Math.max(2, Math.round((Math.abs(a.amount) / maxAsset) * 100))}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 負債組成 */}
        <section className="rounded-lg bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-gray-700">負債組成</h2>
          {nw.composition.liabilities.length === 0 ? (
            <p className="py-4 text-center text-sm text-gray-400">目前沒有負債</p>
          ) : (
            <ul className="space-y-2">
              {nw.composition.liabilities.map((a) => (
                <li key={a.key} className="text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="min-w-0 truncate text-gray-600">{a.label}</span>
                    <span className="shrink-0">{ntd(a.amount)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-gray-100">
                    <div className="h-1.5 rounded-full bg-red-400" style={{ width: `${Math.max(2, Math.round((Math.abs(a.amount) / maxDebt) * 100))}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 每人各自 */}
      {nw.byOwner.length > 0 && (
        <section className="rounded-lg bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-gray-700">各自的淨資產</h2>
          <ul className="divide-y divide-gray-50">
            {nw.byOwner.map((o) => (
              <li key={o.ownerId} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 truncate">{o.name}</span>
                <span className="shrink-0 text-right">
                  <span className={`font-medium ${o.netWorth < 0 ? 'text-red-500' : ''}`}>{ntd(o.netWorth)}</span>
                  <span className="block text-[11px] text-gray-400">
                    資產 {ntd(o.assets)}・負債 {ntd(o.liabilities)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 本月現金流 */}
      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">{cf.month} 現金流</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md bg-gray-50 px-3 py-2">
            <p className="text-[11px] text-gray-500">收入</p>
            <p className="font-medium text-emerald-600">{ntd(cf.income)}</p>
          </div>
          <div className="rounded-md bg-gray-50 px-3 py-2">
            <p className="text-[11px] text-gray-500">支出</p>
            <p className="font-medium text-red-500">{ntd(cf.expense)}</p>
          </div>
          <div className="rounded-md bg-gray-50 px-3 py-2">
            <p className="text-[11px] text-gray-500">存下</p>
            <p className={`font-medium ${cf.saved < 0 ? 'text-red-500' : 'text-gray-900'}`}>{ntd(cf.saved)}</p>
          </div>
          <div className="rounded-md bg-gray-50 px-3 py-2">
            <p className="text-[11px] text-gray-500">儲蓄率</p>
            <p className="font-medium">{cf.savingsRate == null ? '—' : `${cf.savingsRate}%`}</p>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-gray-400">不含轉帳、繳卡費、還本金；不含代墊公司費用。</p>
      </section>

      {/* 代墊公司費用 */}
      {data.receivable !== 0 && (
        <section className="flex items-center justify-between rounded-lg bg-white p-4 text-sm shadow-sm">
          <div>
            <p className="font-semibold text-gray-700">代墊公司費用</p>
            <p className="text-[11px] text-gray-400">公司欠家裡、還沒歸墊的（已算進資產）</p>
          </div>
          <span className="font-medium text-amber-700">{ntd(data.receivable)}</span>
        </section>
      )}

      {/* 負債還清時間表 */}
      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">負債還清時間表</h2>
        {data.payoff.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-400">目前沒有要還的貸款或借款</p>
        ) : (
          <ul className="divide-y divide-gray-50">
            {data.payoff.map((p) => (
              <li key={p.id} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {p.name}
                    {p.ownerName ? <span className="ml-1 text-[11px] text-gray-400">{p.ownerName}</span> : null}
                  </span>
                  <span className="shrink-0 font-medium">{ntd(p.currentPrincipal)}</span>
                </div>
                <p className="text-[11px] text-gray-400">
                  {p.payoffDate ? `預計 ${p.payoffDate} 還清（還有 ${p.monthsLeft} 個月）` : p.access === 'DETAIL' ? '沒有固定期數（親友借款等）' : '只看得到總額'}
                  {p.nextPayment ? `・下期 ${p.nextPayment.date.slice(5)} 繳 ${ntd(p.nextPayment.payment)}（本金 ${ntd(p.nextPayment.principal)}、利息 ${ntd(p.nextPayment.interest)}）` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
