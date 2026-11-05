'use client';

// 全貌頁最下面：隱私與存取紀錄（財務中樞 P0-3／P0-4）。
// - 帳單戶名：只用來比對帳單是誰的；後端加密保存，這裡只看得到遮罩（施＊瀚）。
// - 存取紀錄：「誰看過／動過我的資料」＝別人對我的個人帳戶做的事；「全家紀錄」＝共同的＋跟我有關的。
// 手機 375px 不需要橫向捲動。
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiSendResult } from '@/lib/api';

type LegalName = { registered: false } | { registered: true; masked: string | null; unavailable?: 'key' | 'cipher' };
type AuditItem = {
  id: string;
  at: string;
  channel: string;
  action: string;
  targetType: string;
  targetId: string | null;
  actorName: string | null;
  isMine: boolean;
  aboutMe: boolean;
  detail: Record<string, unknown> | null;
};

const ACTION: Record<string, string> = {
  VIEW_PERSONAL: '看了',
  EDIT: '修改了',
  DELETE: '刪除了',
  UNDO: '撤銷了',
  CONFIRM: '確認了',
  REJECT: '拒絕了',
  EXPORT_CSV: '匯出了',
  PERMISSION_CHANGE: '變更了權限：',
  MEMBER_JOIN: '加入了家庭',
  LEGAL_NAME_SET: '登記了帳單戶名',
  LEGAL_NAME_CLEAR: '清除了帳單戶名',
  FIELD_KEY_ROTATE: '更新了加密金鑰',
};
const TARGET: Record<string, string> = {
  TRANSACTION: '一筆交易',
  TRANSACTION_LIST: '交易明細',
  TRANSFER: '一筆轉帳',
  TRANSFER_LIST: '轉帳明細',
  ACCOUNT: '帳戶',
  CREDIT_CARD: '信用卡',
  CARD_STATEMENT: '信用卡帳單',
  LIABILITY: '負債',
  RECURRING: '固定收支',
  SAVINGS_GOAL: '儲蓄目標',
  EXPORT: 'CSV 匯出檔',
};
const VIS: Record<string, string> = { FAMILY_FULL: '全家看明細', FAMILY_TOTAL_ONLY: '全家只看總額', OWNER_ONLY: '只有自己' };
const NO_TARGET = new Set(['MEMBER_JOIN', 'LEGAL_NAME_SET', 'LEGAL_NAME_CLEAR', 'FIELD_KEY_ROTATE']);

function when(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function describe(it: AuditItem): string {
  const who = it.isMine ? '你' : it.actorName ?? '系統';
  const verb = ACTION[it.action] ?? it.action;
  if (NO_TARGET.has(it.action)) return `${who}${verb}`;
  let target = TARGET[it.targetType] ?? it.targetType;
  if (it.aboutMe && !it.isMine && it.targetType !== 'EXPORT') target = `你的${target}`;
  const d = it.detail ?? {};
  const extra: string[] = [];
  if (typeof d.month === 'string') extra.push(d.month);
  if (typeof d.count === 'number') extra.push(`${d.count} 筆`);
  if (typeof d.rows === 'number') extra.push(`${d.rows} 筆`);
  if (it.action === 'PERMISSION_CHANGE' && typeof d.visibilityAfter === 'string') {
    extra.push(`${VIS[String(d.visibilityBefore)] ?? '共同'} → ${VIS[d.visibilityAfter] ?? d.visibilityAfter}`);
  }
  return `${who}${verb}${target}${extra.length ? `（${extra.join('，')}）` : ''}`;
}

export default function PrivacySection({ userId }: { userId: string }) {
  const [legal, setLegal] = useState<LegalName | null>(null);
  const [input, setInput] = useState('');
  const [legalMsg, setLegalMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scope, setScope] = useState<'mine' | 'family'>('mine');
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLegal = useCallback(async () => {
    try {
      setLegal(await apiGet<LegalName>('/api/liff/me/legal-name', userId));
    } catch {
      setLegal(null);
    }
  }, [userId]);

  const loadLog = useCallback(async () => {
    try {
      const r = await apiGet<{ items: AuditItem[] }>(`/api/liff/audit-log?scope=${scope}`, userId);
      setItems(r.items);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [userId, scope]);

  useEffect(() => {
    loadLegal();
  }, [loadLegal]);
  useEffect(() => {
    setItems(null);
    loadLog();
  }, [loadLog]);

  const save = async (value: string | null) => {
    setSaving(true);
    setLegalMsg(null);
    try {
      const r = await apiSendResult<LegalName & { code?: string }>('PUT', '/api/liff/me/legal-name', { legalName: value });
      if (r.ok) {
        setLegal(r.data);
        setInput('');
        setLegalMsg(value ? '已登記' : '已清除');
        await loadLog();
      } else if (r.status === 503) setLegalMsg('系統還沒設定好加密金鑰，暫時不能登記，請稍後再試。');
      else if (r.status === 400) setLegalMsg('請輸入 2～40 個字的姓名，不要含數字或 @。');
      else setLegalMsg(`沒有成功（${r.status}）`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-700">帳單戶名</h2>
        <p className="mt-1 text-[11px] text-gray-400">只用來辨認帳單是誰的。加密保存，只有你自己看得到（而且只顯示遮罩）。</p>
        <p className="mt-2 text-sm">
          {legal == null
            ? '讀取中…'
            : !legal.registered
              ? '還沒登記'
              : legal.masked
                ? `已登記：${legal.masked}`
                : '已登記（暫時無法顯示）'}
        </p>
        <div className="mt-2 flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={legal?.registered ? '輸入新的戶名' : '例如：王小明'}
            maxLength={40}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-md border border-gray-200 px-3 py-2 text-sm"
          />
          <button
            onClick={() => save(input)}
            disabled={saving || input.trim().length < 2}
            className="shrink-0 rounded-md bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-40"
          >
            儲存
          </button>
        </div>
        {legal?.registered && (
          <button onClick={() => save(null)} disabled={saving} className="mt-2 text-[12px] text-gray-500 underline disabled:opacity-40">
            清除我的戶名
          </button>
        )}
        {legalMsg && <p className="mt-2 text-[12px] text-gray-500">{legalMsg}</p>}
      </section>

      <section className="rounded-lg bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-700">存取紀錄</h2>
          <div className="flex shrink-0 rounded-md bg-gray-100 p-0.5 text-[12px]">
            {(['mine', 'family'] as const).map((k) => (
              <button key={k} onClick={() => setScope(k)} className={`rounded px-2 py-1 ${scope === k ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}>
                {k === 'mine' ? '誰看過我的' : '全家紀錄'}
              </button>
            ))}
          </div>
        </div>
        <p className="mb-2 text-[11px] text-gray-400">
          {scope === 'mine' ? '家人看過、改過你個人帳戶的紀錄（同一個畫面 10 分鐘內只記一次）。' : '共同帳務的修改、刪除、匯出，以及跟你有關的紀錄。'}
        </p>
        {error ? (
          <p className="py-4 text-center text-sm text-red-500">載入失敗：{error}</p>
        ) : items == null ? (
          <p className="py-4 text-center text-sm text-gray-400">載入中…</p>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-400">{scope === 'mine' ? '目前沒有人看過你的個人帳戶' : '還沒有紀錄'}</p>
        ) : (
          <ul className="divide-y divide-gray-50">
            {items.map((it) => (
              <li key={it.id} className="flex items-start justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 break-words text-gray-700">{describe(it)}</span>
                <span className="shrink-0 text-right text-[11px] text-gray-400">
                  {when(it.at)}
                  <span className="block">{it.channel === 'LINE' ? 'LINE' : it.channel === 'SYSTEM' ? '系統' : '記帳簿'}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
