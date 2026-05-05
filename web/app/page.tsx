'use client';

import { useEffect, useState } from 'react';
import { initLiff, getProfile } from '@/lib/liff';
import { apiGet } from '@/lib/api';

type MeResp =
  | { joined: false }
  | {
      joined: true;
      family: { id: string; name: string; code: string };
      member: { id: string; role: 'OWNER' | 'MEMBER'; displayName: string };
    };

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<MeResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await initLiff();
        const profile = await getProfile();
        if (!profile) return;
        const data = await apiGet<MeResp>('/api/liff/me', profile.userId);
        setMe(data);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <main className="p-6">載入中…</main>;
  if (error) return <main className="p-6 text-red-600">錯誤：{error}</main>;
  if (!me) return <main className="p-6">未登入</main>;

  if (!me.joined) {
    return (
      <main className="p-6 space-y-3">
        <h1 className="text-xl font-bold">尚未加入任何家庭</h1>
        <p className="text-gray-600">請回 LINE 對話框，建立或加入一個家庭。</p>
      </main>
    );
  }

  return (
    <main className="p-6 space-y-4">
      <header>
        <h1 className="text-2xl font-bold">{me.family.name}</h1>
        <p className="text-sm text-gray-500">家庭碼：{me.family.code}</p>
      </header>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <p className="text-sm text-gray-500">本月支出</p>
        <p className="text-3xl font-semibold mt-1">— 元</p>
        <p className="text-xs text-gray-400 mt-2">[骨架佔位] 之後串交易資料 + 圓餅圖</p>
      </section>
    </main>
  );
}
