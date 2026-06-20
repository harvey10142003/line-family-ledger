'use client';

import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { apiGet } from '@/lib/api';

type Point = { month: string; expense: number; income: number };

export default function TrendChart({ userId }: { userId: string }) {
  const [data, setData] = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await apiGet<{ trend: Point[] }>('/api/liff/trend?months=6', userId);
        setData(r.trend.map((p) => ({ ...p, month: p.month.slice(5) }))); // 顯示 MM
      } finally {
        setLoading(false);
      }
    })();
  }, [userId]);

  const hasData = data.some((p) => p.expense > 0 || p.income > 0);

  return (
    <section className="rounded-lg bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-sm font-semibold text-gray-700">近 6 個月收支趨勢</h2>
      {loading ? (
        <p className="py-8 text-center text-sm text-gray-400">載入中…</p>
      ) : !hasData ? (
        <p className="py-8 text-center text-sm text-gray-400">尚無足夠資料</p>
      ) : (
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <Tooltip formatter={(v: number) => `$${v.toLocaleString('en-US')}`} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="expense" name="支出" fill="#ef4444" radius={[4, 4, 0, 0]} />
              <Bar dataKey="income" name="收入" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
