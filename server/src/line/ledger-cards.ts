// 文字記帳／轉帳回覆用的 LINE 訊息（P1-5、P1-6）。純函式：只組訊息，不碰資料庫。
// 給消費者看的 LINE 訊息沿用既有風格（記帳成功的文字可帶少量符號）；確認卡把程式最後判斷的每個欄位都寫出來。
import type { TransferKind } from '@prisma/client';
import type { ResolvedDate } from '../lib/date-text';

export const ntd = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US')}`;
};

const KIND_TITLE: Record<TransferKind, string> = {
  ACCOUNT: '轉帳',
  CARD_PAYMENT: '繳卡費',
  CASH_WITHDRAW: '提領現金',
  CASH_DEPOSIT: '存入現金',
  TIME_DEPOSIT: '定存',
  LOAN_REPAY: '還款',
  LEND: '借出',
  BORROW: '借入',
  COLLECT: '收回借款',
  SPOUSE: '家人互轉',
};

export interface TransferCardData {
  id: string;
  kind: TransferKind;
  fromName: string;
  toName: string;
  amount: number;
  interest?: number | null;
  fee?: number | null;
  date: string; // YYYY-MM-DD
  dateIsToday: boolean; // 沒寫日期或換不出來
  dateUnparsed?: boolean; // 有寫日期但換不出來 → 標「日期是今天，要改嗎」
  statementLine?: string | null; // 「已沖 10 月帳單（應繳 24,261，已結清）」
  splitLine?: string | null; // 「依攤還表拆：本金 X、利息 Y」
  pendingFor?: string | null; // D18：等誰確認
  canEdit: boolean; // 已生效的才有改帳戶、改金額
}

const row = (label: string, value: string, color = '#111111') => ({
  type: 'box',
  layout: 'horizontal',
  margin: 'sm',
  contents: [
    { type: 'text', text: label, size: 'sm', color: '#888888', flex: 2 },
    { type: 'text', text: value, size: 'sm', color, flex: 5, wrap: true, align: 'end' },
  ],
});

const btn = (label: string, data: string, style: 'primary' | 'secondary' | 'link' = 'link') => ({
  type: 'button',
  style,
  height: 'sm',
  action: { type: 'postback', label, data, displayText: label },
});

/** 建立者收到的確認卡：撤銷／改帳戶／改金額（待對方確認的只有撤銷） */
export function transferBubble(d: TransferCardData) {
  const lines: any[] = [
    { type: 'text', text: `${d.fromName} → ${d.toName}`, size: 'md', weight: 'bold', wrap: true, color: '#111111' },
    { type: 'text', text: ntd(d.amount), size: 'xxl', weight: 'bold', color: '#4F46E5', margin: 'sm' },
    row('日期', `${d.date}${d.dateIsToday ? '（今天）' : ''}`, d.dateUnparsed ? '#D97706' : '#111111'),
  ];
  if (d.interest) lines.push(row('利息', `${ntd(d.interest)}（記成支出）`));
  if (d.fee) lines.push(row('手續費', `${ntd(d.fee)}（記成支出）`));
  if (d.splitLine) lines.push(row('拆帳', d.splitLine));
  if (d.statementLine) lines.push(row('帳單', d.statementLine));
  if (d.dateUnparsed) lines.push({ type: 'text', text: '看不懂寫的日期，先記今天，要改請撤銷後重記', size: 'xs', color: '#D97706', wrap: true, margin: 'md' });
  if (d.pendingFor) {
    lines.push({ type: 'text', text: `動到 ${d.pendingFor} 的個人帳戶，等 ${d.pendingFor} 按確認才生效（24 小時沒回就只記你這邊）`, size: 'xs', color: '#D97706', wrap: true, margin: 'md' });
  } else {
    lines.push({ type: 'text', text: '轉帳不算收入也不算支出，只移動餘額', size: 'xs', color: '#999999', wrap: true, margin: 'md' });
  }
  const buttons = [btn('撤銷', `action=tr_undo&id=${d.id}`)];
  if (d.canEdit) buttons.push(btn('改帳戶', `action=tr_acct&id=${d.id}`), btn('改金額', `action=tr_amt&id=${d.id}`));
  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      backgroundColor: d.pendingFor ? '#F59E0B' : '#6366F1',
      contents: [{ type: 'text', text: d.pendingFor ? `${KIND_TITLE[d.kind]}・待 ${d.pendingFor} 確認` : `已記${KIND_TITLE[d.kind]}`, color: '#FFFFFF', weight: 'bold', size: 'md' }],
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '14px', contents: lines },
    footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '8px', contents: buttons },
  };
}

/** D18：推給被動到帳戶的那位：確認／拒絕 */
export function confirmRequestMessage(d: { id: string; creatorName: string; kind: TransferKind; fromName: string; toName: string; amount: number; date: string }) {
  return {
    type: 'flex',
    altText: `${d.creatorName} 記了一筆${KIND_TITLE[d.kind]} ${ntd(d.amount)}，要你確認`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        backgroundColor: '#F59E0B',
        contents: [{ type: 'text', text: '請確認這筆轉帳', color: '#FFFFFF', weight: 'bold', size: 'md' }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: [
          { type: 'text', text: `${d.creatorName} 記了一筆${KIND_TITLE[d.kind]}，會動到你的個人帳戶：`, size: 'sm', color: '#555555', wrap: true },
          { type: 'text', text: `${d.fromName} → ${d.toName}`, size: 'md', weight: 'bold', wrap: true, margin: 'md' },
          { type: 'text', text: ntd(d.amount), size: 'xxl', weight: 'bold', color: '#4F46E5', margin: 'sm' },
          row('日期', d.date),
          { type: 'text', text: '按「確認」才會記進你的帳戶；24 小時內沒回，只會記在對方那邊（標待確認），之後仍可確認或拒絕。', size: 'xs', color: '#999999', wrap: true, margin: 'md' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: '8px',
        contents: [btn('確認', `action=tr_ok&id=${d.id}`, 'primary'), btn('拒絕', `action=tr_no&id=${d.id}`, 'secondary')],
      },
    },
  };
}

export function transferCarousel(cards: TransferCardData[]) {
  const bubbles = cards.slice(0, 10).map(transferBubble);
  const alt = cards.map((c) => `${KIND_TITLE[c.kind]} ${c.fromName}→${c.toName} ${ntd(c.amount)}${c.pendingFor ? `（待 ${c.pendingFor} 確認）` : ''}`).join('；');
  return {
    type: 'flex',
    altText: alt.slice(0, 390) || '轉帳',
    contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles },
  };
}

export interface TxLine {
  amount: number;
  type: 'EXPENSE' | 'INCOME';
  label: string; // 品項或分類
  category: string;
  payName: string | null;
  date: ResolvedDate;
  ownerName: string | null; // 歸屬人（幫 Apple 記）
  business: boolean;
  originalCurrency: string | null;
  originalAmount: number | null;
  estimated: boolean;
  fxLabel?: string | null; // 「臺銀 11/04 即期賣出 32.875」；env／固定值時是「參考匯率 32.5」
}

/** 收支回覆：每一筆把日期、帳戶、歸屬、公司或家庭、原幣與預估台幣都寫出來（3.10.5）。 */
export function txSummaryText(lines: TxLine[], recorder: string): string {
  const one = (t: TxLine) => {
    const sign = t.type === 'INCOME' ? '+' : '';
    const money = t.originalCurrency
      ? `${t.originalCurrency} ${t.originalAmount}（約 ${ntd(t.amount)}${t.estimated ? `，${t.fxLabel ? `依${t.fxLabel} ` : '參考匯率'}預估` : ''}）`
      : `${sign}${ntd(t.amount)}`;
    const parts = [
      `${t.label}　${money}`,
      `　${t.date.ok ? t.date.ymd : `${t.date.ymd}（今天）`}${t.payName ? `｜${t.payName}` : ''}`,
      `　${t.business ? '公司（代墊報帳）' : '家庭'}${t.ownerName ? `｜歸屬 ${t.ownerName}` : ''}｜${t.category}`,
    ];
    return parts.join('\n');
  };
  const head = lines.length === 1 ? '已記帳 ✅' : `已記帳 ${lines.length} 筆 ✅`;
  const body = lines.map(one).join('\n');
  const family = lines.filter((t) => !t.business);
  const total = family.reduce((s, t) => s + (t.type === 'INCOME' ? 1 : -1) * t.amount, 0);
  const totalLine = lines.length > 1 && family.length > 0 ? `\n家庭合計 ${ntd(total)}` : '';
  const dateWarn = lines.some((t) => t.date.explicit && !t.date.ok) ? '\n\n日期看不懂，先記成今天，要改嗎？可點「刪除」後重記或到記帳簿改。' : '';
  return `${head}\n${body}${totalLine}\n記錄者：${recorder}${dateWarn}`;
}
