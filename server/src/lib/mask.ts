// 送 Gemini 之前的遮罩（規格 6.6，P0-2 正式版）。
//
// 唯一出口：所有送 Gemini 的文字都在 ai/gemini-gateway.ts 經過 maskSensitive()（靜態棘輪 gemini-egress-ratchet.test.ts 守門）。
// 文字記帳另外在解析前先遮一次，因為程式複核金額時用的是遮罩後的句子（號碼、地址門牌不能被當成金額）。
//
// 金額不能被遮（「繳國泰卡 24261」「2 萬」「15.99 美金」都要留著），所以只遮「看起來是號碼／個資」的東西：
// - Email → [Email]
// - 地址（有「路／街／大道」＋門牌「號」）→ [地址]（門牌數字不會被當成金額）
// - 身分證字號、居留證號：英文字母＋1／2（或 A～D、8／9）＋8 碼 → [身分證]
// - 手機：09 開頭 10 碼（可帶 - 或空白）→ [手機]
// - 市話：要有區碼括號或連字號（07-1234567、(02)2345-6789）→ [電話]
// - 卡號：13～19 碼數字（可每 4 碼用空白或 - 隔開）→ [卡號末4:1234]
// - 帳號：10～12 碼連續數字（或用 - 隔開、合計 10～16 碼）→ [帳號末4:1234]
// - 姓名：呼叫端給的真實姓名清單（例如帳單戶名）→ [戶名A]、[戶名B]…；文字記帳不給（家人暱稱本來就要讓 AI 看）
// 末四碼保留下來，帳戶模糊比對（「1234 那張」）還用得到；絕不送全碼。
// 金額有千分位逗號（24,261）或小數點，不會被當成號碼；9 碼以下的數字一律不動。
// 冪等：已遮過的文字再遮一次結果不變（代號裡只有 4 碼數字）。

const FULLWIDTH_DIGIT = /[０-９]/g;
const FULLWIDTH_ASCII = /[Ａ-Ｚａ-ｚ＠．－（）]/g;

function halfWidth(s: string): string {
  return s
    .replace(FULLWIDTH_DIGIT, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(FULLWIDTH_ASCII, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

export interface MaskCounts {
  email: number;
  address: number;
  idNumber: number;
  mobile: number;
  phone: number;
  card: number;
  account: number;
  name: number;
}

export interface MaskResult {
  text: string;
  /** 每一種被遮的次數（測試與 log 用；不含原值） */
  counts: MaskCounts;
  /** 全部命中次數 */
  total: number;
  /** 姓名代號 → 呼叫端給的 names 陣列索引（拿來把 AI 回的代號對回成員；不可寫進 log） */
  nameTokens: Record<string, number>;
}

export interface MaskOptions {
  /** 要遮的真實姓名（帳單戶名）。少於 2 個字的忽略（單字會誤遮一般用字）。 */
  names?: readonly string[];
}

const CJK = '\\u4e00-\\u9fff';
// 地址：可選的縣市、鄉鎮區，接路／街／大道（可帶段、巷、弄），最後一定要有門牌「號」（可帶之 N、N 樓）。
// 沒有「號」的（「全聯中正路店」「中山路上」）不算地址，不遮。
const ADDRESS = new RegExp(
  [
    `(?:[${CJK}]{1,3}[市縣])?`,
    `(?:[${CJK}]{1,3}[區鄉鎮市])?`,
    `(?:[${CJK}0-9]{1,6}[村里]\\s?(?:\\d{1,3}鄰)?)?`,
    `[${CJK}0-9]{1,8}(?:路|街|大道)`,
    `\\s?(?:[一二三四五六七八九十0-9]{1,3}段)?`,
    `\\s?(?:\\d{1,5}\\s?巷)?`,
    `\\s?(?:\\d{1,5}\\s?弄)?`,
    `\\s?\\d{1,5}(?:之\\d{1,3})?\\s?號`,
    `(?:\\s?\\d{1,3}\\s?(?:樓|F)(?:之\\d{1,3})?)?`,
  ].join(''),
  'g',
);

function letterToken(i: number): string {
  // A..Z, AA..AZ, ...
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function maskSensitive(input: string, opts: MaskOptions = {}): MaskResult {
  const counts: MaskCounts = { email: 0, address: 0, idNumber: 0, mobile: 0, phone: 0, card: 0, account: 0, name: 0 };
  const nameTokens: Record<string, number> = {};
  let s = halfWidth(input);

  // 姓名：最長的先換，避免「施允瀚」被「允瀚」先吃掉一半
  const names = (opts.names ?? [])
    .map((n, i) => ({ n: halfWidth(n).trim(), i }))
    .filter((x) => x.n.length >= 2)
    .sort((a, b) => b.n.length - a.n.length);
  for (const { n, i } of names) {
    const token = `[戶名${letterToken(i)}]`;
    const parts = s.split(n);
    if (parts.length > 1) {
      counts.name += parts.length - 1;
      nameTokens[token] = i;
      s = parts.join(token);
    }
  }

  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, () => {
    counts.email++;
    return '[Email]';
  });

  s = s.replace(ADDRESS, () => {
    counts.address++;
    return '[地址]';
  });

  // 身分證（第二碼 1／2）、新式居留證（8／9）、舊式居留證（A～D）：前後不能接英數字（避免吃到更長的代碼）
  s = s.replace(/(?<![A-Za-z0-9])[A-Za-z][1289A-Da-d]\d{8}(?![A-Za-z0-9])/g, () => {
    counts.idNumber++;
    return '[身分證]';
  });

  // 手機：0912-345-678、0912 345 678、0912345678、+886 912 345 678
  s = s.replace(/(?:\+886[-\s]?|(?<![\d.,])0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}(?![\d.,])/g, () => {
    counts.mobile++;
    return '[手機]';
  });

  // 市話：一定要有括號區碼或連字號，避免把「03 120」這種數字串當成電話
  s = s.replace(/(?<![\d.,-])(?:\(0\d{1,2}\)\s?\d{3,4}-?\d{4}|0\d{1,2}-\d{3,4}-?\d{4})(?![\d.,-])/g, () => {
    counts.phone++;
    return '[電話]';
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

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { text: s, counts, total, nameTokens };
}

/** 文字裡已經是遮罩代號的個數（log 用：文字記帳先遮過一次，閘道再遮時命中 0，但代號數看得出有遮）。 */
export function countMaskTokens(s: string): number {
  return (s.match(/\[(?:Email|地址|身分證|手機|電話|卡號末4:\d{4}|帳號末4:\d{4}|戶名[A-Z]+)\]/g) ?? []).length;
}

/** 從遮罩代號取回末四碼（帳戶比對用）。 */
export function maskedLast4(s: string): string | null {
  const m = /末4:(\d{4})/.exec(s);
  return m ? m[1] : null;
}
