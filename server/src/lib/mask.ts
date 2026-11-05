// 送 Gemini 之前的最小遮罩（規格 6.6；P0-2 正式遮罩模組上線前先用這支，P0-2 會擴充姓名、地址）。
//
// 只遮「看起來是號碼」的東西，金額不能被遮（「繳國泰卡 24261」「2 萬」「15.99 美金」都要留著）：
// - 身分證字號：英文字母＋1／2＋8 碼（例如 A123456789）→ [身分證]
// - 手機：09 開頭 10 碼（可帶 - 或空白）→ [手機]
// - 卡號：13～19 碼數字（可每 4 碼用空白或 - 隔開）→ [卡號末4:1234]
// - 帳號：10～12 碼連續數字（或用 - 隔開、合計 10～16 碼）→ [帳號末4:1234]
// 末四碼保留下來，帳戶模糊比對（「1234 那張」）還用得到；絕不送全碼。
// 金額有千分位逗號（24,261）或小數點，不會被當成號碼；9 碼以下的數字一律不動。

const FULLWIDTH_DIGIT = /[０-９]/g;

function halfDigits(s: string): string {
  return s.replace(FULLWIDTH_DIGIT, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

export interface MaskResult {
  text: string;
  /** 每一種被遮的次數（測試與 log 用；不含原值） */
  counts: { idNumber: number; mobile: number; card: number; account: number };
}

export function maskSensitive(input: string): MaskResult {
  const counts = { idNumber: 0, mobile: 0, card: 0, account: 0 };
  let s = halfDigits(input);

  // 身分證：前後不能接英數字（避免吃到更長的代碼）
  s = s.replace(/(?<![A-Za-z0-9])[A-Za-z][12]\d{8}(?![A-Za-z0-9])/g, () => {
    counts.idNumber++;
    return '[身分證]';
  });

  // 手機：0912-345-678、0912 345 678、0912345678
  s = s.replace(/(?<![\d.,])09\d{2}[-\s]?\d{3}[-\s]?\d{3}(?![\d.,])/g, () => {
    counts.mobile++;
    return '[手機]';
  });

  // 卡號（每 4 碼用空白或 - 隔開）：4-4-4-1～7，合計 13～19 碼
  s = s.replace(/(?<![\d.,])\d{4}([-\s])\d{4}\1\d{4}(?:\1?\d{1,7})(?![\d.,])/g, (m) => {
    const digits = m.replace(/[-\s]/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    counts.card++;
    return `[卡號末4:${digits.slice(-4)}]`;
  });

  // 帳號（用 - 隔開，例如 808-12-345678-9）：合計 10～16 碼。日期 2026-10-03 只有 8 碼，不會中。
  s = s.replace(/(?<![\d.,-])\d{2,8}(?:-\d{1,8}){1,4}(?![\d.,-])/g, (m) => {
    const digits = m.replace(/-/g, '');
    if (digits.length < 10 || digits.length > 16) return m;
    counts.account++;
    return `[帳號末4:${digits.slice(-4)}]`;
  });

  // 連續數字：13～19 碼＝卡號；10～12 碼或超過 19 碼＝帳號。前後不能接數字、小數點、逗號（金額）。
  // 用空白隔開的幾個金額（「80 120 300」）各自都不到 10 碼，不會被合起來當號碼。
  s = s.replace(/(?<![\d.,])\d{10,}(?![\d.,])/g, (digits) => {
    if (digits.length >= 13 && digits.length <= 19) {
      counts.card++;
      return `[卡號末4:${digits.slice(-4)}]`;
    }
    counts.account++;
    return `[帳號末4:${digits.slice(-4)}]`;
  });

  return { text: s, counts };
}

/** 從遮罩代號取回末四碼（帳戶比對用）。 */
export function maskedLast4(s: string): string | null {
  const m = /末4:(\d{4})/.exec(s);
  return m ? m[1] : null;
}
