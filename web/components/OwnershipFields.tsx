'use client';

// 帳戶／信用卡的「歸屬＋對方可見範圍」表單欄位與列表標示（財務中樞 P1-2，D2／D10）。
// 樣式沿用帳戶表單的膠囊按鈕；不放 emoji。

export type Visibility = 'FAMILY_FULL' | 'FAMILY_TOTAL_ONLY' | 'OWNER_ONLY';
export type Owned = {
  ownerMemberId?: string | null;
  ownerName?: string | null;
  visibility?: Visibility;
  access?: 'DETAIL' | 'TOTAL';
  canEdit?: boolean;
};

const VIS_OPTIONS: { v: Visibility; label: string }[] = [
  { v: 'FAMILY_TOTAL_ONLY', label: '只看總額' },
  { v: 'FAMILY_FULL', label: '看得到明細' },
  { v: 'OWNER_ONLY', label: '完全看不到' },
];

export function OwnershipFields({
  mine,
  visibility,
  onChange,
}: {
  mine: boolean;
  visibility: Visibility;
  onChange: (next: { mine: boolean; visibility: Visibility }) => void;
}) {
  const pill = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs ${active ? 'bg-indigo-500 text-white' : 'border border-gray-200 bg-white text-gray-600'}`;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-16 shrink-0 text-xs text-gray-500">歸屬</span>
        <button type="button" onClick={() => onChange({ mine: false, visibility })} className={pill(!mine)}>
          共同
        </button>
        <button type="button" onClick={() => onChange({ mine: true, visibility })} className={pill(mine)}>
          我的個人
        </button>
      </div>
      {mine && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-16 shrink-0 text-xs text-gray-500">家人可見</span>
            {VIS_OPTIONS.map((o) => (
              <button key={o.v} type="button" onClick={() => onChange({ mine, visibility: o.v })} className={pill(visibility === o.v)}>
                {o.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-gray-400">個人帳戶只有你能記帳與修改。「完全看不到」的不會算進家人看到的家庭數字。</p>
        </>
      )}
    </div>
  );
}

/** 列表上的歸屬小標：共同不標；我的／某人的；家人只看得到總額時加註。 */
export function OwnerBadges({ item, memberId }: { item: Owned; memberId: string }) {
  if (!item.ownerMemberId) return null;
  const mine = item.ownerMemberId === memberId;
  return (
    <>
      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{mine ? '我的' : `${item.ownerName ?? '家人'}的`}</span>
      {!mine && item.access === 'TOTAL' && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600">只看總額</span>}
      {mine && item.visibility === 'OWNER_ONLY' && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">不公開</span>}
    </>
  );
}

/** 送給後端的歸屬欄位：我的＝自己的 memberId；共同＝null。 */
export function ownershipBody(mine: boolean, visibility: Visibility, memberId: string) {
  return mine ? { ownerMemberId: memberId, visibility } : { ownerMemberId: null };
}
