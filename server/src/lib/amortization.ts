// 貸款攤還計算（財務中樞 P1-3，規格 2.4）。純函式，不碰資料庫，單元測試在 test/amortization.test.ts。
//
// 金額單位：新台幣「元」。
//
// 捨入規則（寫死在這裡，測試逐條驗）：
// 1. 每期利息＝期初剩餘本金 × 月利率（年利率 ÷ 12），四捨五入到元。
// 2. 本息平均攤還的月付金＝P × r(1+r)^n ÷ ((1+r)^n − 1)，四捨五入到元；每期本金＝月付金 − 當期利息。
// 3. 本金平均攤還的每期本金＝攤還起點的本金 ÷ 攤還期數，四捨五入到元。
// 4. 最後一期把剩餘本金全部還清（吸收前面各期的捨入差），所以本金合計一定等於原始本金。
// 5. 利率變動：從「繳款日 ≥ 生效日」的那一期起用新利率，並以當時剩餘本金、剩餘期數重算月付金
//    （本金平均攤還不重算本金，只有利息跟著變）。
// 6. 寬限期：前 g 期只繳息，期滿後在剩下的 n − g 期內攤還（台灣房貸常見做法）。
//
// 與銀行的差異（查不到統一規定的部分，以實際帳單為準）：
// - 有些銀行按「日」計息（年利率 ÷ 365 × 實際天數），這裡按「月」計（年利率 ÷ 12），每期會差幾元。
// - 利息捨入有銀行採「捨去到元」而非四捨五入；這裡一律四捨五入。
// - 利率在一期中間變動時，銀行可能按天數拆兩段算；這裡整期用繳款日當天有效的利率。
// - 月付金也有銀行無條件進位到元或到十元；這裡四捨五入到元。

export type RepaymentMethod = 'EQUAL_PAYMENT' | 'EQUAL_PRINCIPAL' | 'INTEREST_ONLY' | 'FREE';

export interface RateChangeInput {
  effectiveDate: string; // YYYY-MM-DD（台北日期）
  annualRatePct: number; // 年利率（%），例如 2.185
}

export interface LoanTerms {
  principal: number; // 攤還起點本金（元）
  annualRatePct: number; // 起始年利率（%）
  termMonths: number; // 總期數（含寬限期）
  method: RepaymentMethod;
  gracePeriodMonths?: number; // 寬限期（只繳息）期數
  firstPaymentDate: string; // 第一期繳款日 YYYY-MM-DD
  paymentDay?: number | null; // 每月幾號繳（1–31，月底不足自動取月底）；不給＝第一期的日
  rateChanges?: RateChangeInput[];
}

export interface ScheduleRow {
  period: number; // 第幾期（從 1 起）
  date: string; // 繳款日 YYYY-MM-DD
  annualRatePct: number; // 這一期用的年利率
  payment: number; // 本期應繳＝本金＋利息
  principal: number; // 本期本金（不是支出）
  interest: number; // 本期利息（支出）
  balance: number; // 本期繳完後剩餘本金
  isGrace: boolean; // 寬限期（只繳息）
}

const EPS = 1e-9;

/** 四捨五入到元（只處理 ≥ 0；浮點誤差先加一點 epsilon，避免 0.4999999 這種情況被捨掉）。 */
export function roundYuan(x: number): number {
  if (x < 0) return -roundYuan(-x);
  return Math.floor(x + 0.5 + EPS);
}

/** 四捨五入到分（剩餘本金帶小數時用）。 */
export function round2(x: number): number {
  if (x < 0) return -round2(-x);
  return Math.floor(x * 100 + 0.5 + EPS) / 100;
}

/** 本息平均攤還的月付金（四捨五入到元）。月利率為 0 時＝本金 ÷ 期數。 */
export function equalPayment(principal: number, monthlyRate: number, n: number): number {
  if (n <= 0) return 0;
  if (monthlyRate === 0) return roundYuan(principal / n);
  const f = Math.pow(1 + monthlyRate, n);
  return roundYuan((principal * monthlyRate * f) / (f - 1));
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function parseYmd(s: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid date ${s}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 第一期日加 k 個月，日＝paymentDay（月底不足取月底）。 */
export function periodDate(firstPaymentDate: string, k: number, paymentDay?: number | null): string {
  const f = parseYmd(firstPaymentDate);
  const total = f.y * 12 + (f.m - 1) + k;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const day = Math.min(paymentDay ?? f.d, daysInMonth(y, m));
  return ymd(y, m, day);
}

/** 某一天有效的年利率：生效日 ≤ 該日的最後一筆變動；都沒有＝起始利率。 */
export function rateAt(date: string, baseRatePct: number, changes: RateChangeInput[] = []): number {
  let rate = baseRatePct;
  let best = '';
  for (const c of changes) {
    if (c.effectiveDate <= date && c.effectiveDate >= best) {
      best = c.effectiveDate;
      rate = c.annualRatePct;
    }
  }
  return rate;
}

/**
 * 產生完整攤還表。FREE（親友借款，無固定期數）回空陣列。
 * 參數不合理（期數 ≤ 0、本金 < 0、寬限期 ≥ 期數）丟錯。
 */
export function buildSchedule(t: LoanTerms): ScheduleRow[] {
  if (t.method === 'FREE') return [];
  const n = Math.floor(t.termMonths);
  const grace = Math.max(0, Math.floor(t.gracePeriodMonths ?? 0));
  if (!(n > 0)) throw new Error('termMonths must be positive');
  if (!(t.principal >= 0)) throw new Error('principal must be >= 0');
  if (t.method !== 'INTEREST_ONLY' && grace >= n) throw new Error('gracePeriodMonths must be less than termMonths');

  const rows: ScheduleRow[] = [];
  let balance = t.principal;
  let payment = 0; // 本息平均的月付金（遇到利率變動、寬限期結束時重算）
  let principalEach = 0; // 本金平均的每期本金
  let lastRate: number | null = null;
  let amortStarted = false;

  for (let i = 0; i < n; i++) {
    const period = i + 1;
    const date = periodDate(t.firstPaymentDate, i, t.paymentDay);
    const ratePct = rateAt(date, t.annualRatePct, t.rateChanges);
    const r = ratePct / 100 / 12;
    const interest = roundYuan(balance * r);
    const isLast = period === n;
    const inGrace = t.method === 'INTEREST_ONLY' ? !isLast : i < grace;

    let principal: number;
    if (inGrace) {
      principal = 0;
    } else if (isLast) {
      principal = balance;
    } else if (t.method === 'EQUAL_PRINCIPAL') {
      if (!amortStarted) principalEach = roundYuan(balance / (n - i));
      principal = Math.min(principalEach, balance);
    } else if (t.method === 'EQUAL_PAYMENT') {
      if (!amortStarted || ratePct !== lastRate) payment = equalPayment(balance, r, n - i);
      principal = Math.min(Math.max(payment - interest, 0), balance);
    } else {
      // INTEREST_ONLY 最後一期在上面 isLast 處理
      principal = 0;
    }
    if (!inGrace) amortStarted = true;
    lastRate = ratePct;

    balance = round2(balance - principal);
    rows.push({
      period,
      date,
      annualRatePct: ratePct,
      payment: round2(principal + interest),
      principal: round2(principal),
      interest,
      balance,
      isGrace: inGrace,
    });
  }
  return rows;
}

/** 依攤還表，到某天（含）為止「應該」剩多少本金（沒有攤還表＝null）。 */
export function expectedBalanceAt(schedule: ScheduleRow[], principal: number, date: string): number | null {
  if (schedule.length === 0) return null;
  let bal = principal;
  for (const row of schedule) {
    if (row.date > date) break;
    bal = row.balance;
  }
  return bal;
}

/** 某天之後（含當天）的下一期。都繳完了回 null。 */
export function nextPeriod(schedule: ScheduleRow[], date: string): ScheduleRow | null {
  return schedule.find((r) => r.date >= date) ?? null;
}

/**
 * 只知道「這次總共繳了多少」時，建議怎麼拆本金／利息（給使用者確認，不自動入帳）。
 * 利息＝目前剩餘本金 × 月利率（四捨五入到元），剩下的算本金，本金最多到剩餘本金為止，
 * 再多出來的回報為 excess（可能是繳了違約金、帳管費，或金額打錯）。
 */
export function suggestSplit(
  currentPrincipal: number,
  annualRatePct: number,
  total: number,
): { principal: number; interest: number; excess: number } {
  const interest = Math.min(roundYuan(currentPrincipal * (annualRatePct / 100 / 12)), roundYuan(total));
  const rest = round2(total - interest);
  const principal = Math.min(rest, currentPrincipal);
  return { principal: round2(principal), interest, excess: round2(rest - principal) };
}

/** 借出＝資產（正）、借入＝負債（負）。給「借出記成資產」與日後淨資產用。 */
export function signedLiabilityAmount(direction: 'BORROWED' | 'LENT', amount: number): number {
  return direction === 'LENT' ? amount : -amount;
}
