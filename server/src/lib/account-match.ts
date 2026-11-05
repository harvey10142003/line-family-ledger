// 帳戶／信用卡／負債名稱模糊比對（規格 3.10.3）。純函式，候選清單由呼叫端依 AccessScope 篩好（只放說話者看得到的）。
//
// 1. 正規化：全半形、台→臺、大小寫、去空白，去掉「卡」「信用卡」「帳戶」「帳號」「戶頭」「銀行」「的」；
//    「我的」→ 說話者本人，「Apple 的」→ Apple（歸屬提示）。
// 2. 打分順序：完全相同 ＞ 別名命中 ＞ 機構名命中 ＞ 末四碼 ＞ 字串相似度。
// 3. 歸屬：說「我的」只看說話者的、說「Apple 的」只看 Apple 的；沒說是誰的，排序上說話者 → 共同 → 別人。
// 4. 結果：只有一個夠高分的 → 直接用；兩個以上 → 列出候選（最多 4 個）讓人選；比不到 → none。
//    曾經點選過的叫法（別名）優先：別名只命中一個「說話者能動」的候選 → 直接用（下次同一句不再問）。
//    沒寫「卡」也沒寫「帳戶」，而帳戶和信用卡都對得上 → 一定問（「台新轉 5000 到國泰」）。
import type { AccountType, LiabilityDirection, LiabilityKind } from '@prisma/client';

export type InstrumentKind = 'ACCOUNT' | 'CARD' | 'LIABILITY';

export interface MatchCandidate {
  kind: InstrumentKind;
  id: string;
  name: string;
  institution?: string | null;
  aliases: string[];
  last4?: string | null;
  ownerMemberId: string | null;
  writable: boolean; // 說話者能不能動（共同或本人的）
  isDefault?: boolean;
  accountType?: AccountType;
  direction?: LiabilityDirection;
  liabilityKind?: LiabilityKind;
  lender?: string | null;
  payFromAccountId?: string | null; // 負債的自動扣款帳戶（還貸款沒講來源時用）
  sortOrder?: number;
}

export interface MemberRef {
  id: string;
  displayName: string;
}

export type MatchResult =
  | { status: 'unique'; pick: MatchCandidate; via: 'exact' | 'alias' | 'institution' | 'last4' | 'contains' | 'fuzzy' }
  | { status: 'ambiguous'; options: MatchCandidate[] }
  | { status: 'none' };

export const MAX_OPTIONS = 4;

const STRIP_WORDS = /信用卡|帳戶|帳號|戶頭|銀行|卡片|卡|的/g;

/** 全半形、台／臺、大小寫、空白 */
export function baseNormalize(s: string): string {
  return (s ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/台/g, '臺')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

/** 比對用的正規化：再去掉「卡」「帳戶」「銀行」「的」等字。 */
export function normalizeName(s: string): string {
  return baseNormalize(s).replace(STRIP_WORDS, '');
}

/** 從叫法裡拆出歸屬提示：「我的臺銀」→ speaker；「Apple 的國泰」→ Apple。回傳剩下要比對的字。 */
export function ownerHint(raw: string, speakerId: string, members: MemberRef[]): { ownerId: string | null; rest: string; onlyOwner: boolean } {
  let s = baseNormalize(raw);
  let ownerId: string | null = null;
  // 長名字先比，避免「Apple」被「App」吃掉
  const sorted = [...members].sort((a, b) => b.displayName.length - a.displayName.length);
  for (const m of sorted) {
    const dn = baseNormalize(m.displayName);
    if (dn && s.startsWith(dn)) {
      ownerId = m.id;
      s = s.slice(dn.length);
      break;
    }
  }
  if (!ownerId) {
    const me = /^(我自己|自己|我)(的)?/.exec(s);
    if (me) {
      ownerId = speakerId;
      s = s.slice(me[0].length);
    }
  }
  s = s.replace(/^的/, '');
  const rest = s;
  return { ownerId, rest, onlyOwner: normalizeName(rest) === '' };
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out.length ? out : s ? [s] : [];
}

/** Dice 係數（0～1） */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  const pool = [...B];
  let hit = 0;
  for (const x of A) {
    const i = pool.indexOf(x);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

const LIABILITY_KIND_WORDS: Record<string, LiabilityKind> = { 房貸: 'MORTGAGE', 車貸: 'CAR', 信貸: 'PERSONAL' };

type Tier = 'exact' | 'alias' | 'institution' | 'last4' | 'contains' | 'fuzzy';
const TIER_SCORE: Record<Tier, number> = { exact: 100, alias: 90, institution: 70, last4: 60, contains: 50, fuzzy: 30 };

/** 一個候選對一個叫法的分數（0＝沒對上）。memberNames：比對前從候選名稱拿掉成員名字（「Apple 臺銀」↔「臺銀」）。 */
export function scoreCandidate(query: string, c: MatchCandidate, memberNames: string[] = []): { score: number; tier: Tier | null } {
  const q = normalizeName(query);
  const digits = /(\d{4})/.exec(baseNormalize(query))?.[1] ?? null;
  const strip = (s: string) => {
    let t = baseNormalize(s);
    for (const n of memberNames) {
      const dn = baseNormalize(n);
      if (dn) t = t.split(dn).join('');
    }
    return normalizeName(t);
  };
  const name = strip(c.name);
  const names = [name, ...(c.kind === 'LIABILITY' && c.lender ? [strip(c.lender)] : [])].filter(Boolean);
  if (!q && !digits) return { score: 0, tier: null };
  if (q && names.includes(q)) return { score: TIER_SCORE.exact, tier: 'exact' };
  if (q && c.aliases.some((a) => normalizeName(a) === q)) return { score: TIER_SCORE.alias, tier: 'alias' };
  if (q && c.kind === 'LIABILITY' && LIABILITY_KIND_WORDS[q] && c.liabilityKind === LIABILITY_KIND_WORDS[q]) {
    return { score: TIER_SCORE.institution, tier: 'institution' };
  }
  const inst = c.institution ? normalizeName(c.institution.replace(/^\d{3}\s*/, '')) : '';
  if (q && inst && q.length >= 2 && (inst.includes(q) || q.includes(inst))) return { score: TIER_SCORE.institution, tier: 'institution' };
  if (digits && c.last4 && c.last4 === digits) return { score: TIER_SCORE.last4, tier: 'last4' };
  if (q && q.length >= 2 && names.some((n) => n.length >= 2 && (n.includes(q) || q.includes(n)))) return { score: TIER_SCORE.contains, tier: 'contains' };
  const sim = q ? Math.max(...names.map((n) => similarity(q, n))) : 0;
  // 名字都很短（2～4 字），門檻要高：「借小華」跟「借小明」（0.5）不能算對上
  if (sim > 0.66) return { score: Math.round(TIER_SCORE.fuzzy * sim), tier: 'fuzzy' };
  return { score: 0, tier: null };
}

function ownerRank(c: MatchCandidate, speakerId: string): number {
  if (c.ownerMemberId === speakerId) return 0;
  if (c.ownerMemberId == null) return 1;
  return 2;
}

/**
 * 在候選中找叫法 raw 指的是哪一個。
 * opts.kinds：這個位置允許哪些種類（例如繳卡費的目的只能是 CARD）。
 */
export function matchInstrument(
  raw: string,
  candidates: MatchCandidate[],
  ctx: { speakerId: string; members: MemberRef[]; kinds?: InstrumentKind[] },
): MatchResult {
  const kinds = ctx.kinds ?? ['ACCOUNT', 'CARD', 'LIABILITY'];
  const hint = ownerHint(raw, ctx.speakerId, ctx.members);
  let pool = candidates.filter((c) => kinds.includes(c.kind));
  if (hint.ownerId) pool = pool.filter((c) => c.ownerMemberId === hint.ownerId);
  if (hint.onlyOwner) return { status: 'none' }; // 只說了「Apple 的」：呼叫端改用那位的預設帳戶
  const memberNames = ctx.members.map((m) => m.displayName);
  const b = baseNormalize(hint.rest);
  const saysCard = /卡/.test(b);
  const saysAccount = /帳戶|戶頭|活存|存款|帳號/.test(b);

  const scored = pool
    .map((c) => ({ c, ...scoreCandidate(hint.rest, c, memberNames) }))
    .filter((x) => x.score > 0);
  if (scored.length === 0) return { status: 'none' };

  // 說了「卡」→ 有卡就只留卡；說了「帳戶／活存」→ 有帳戶就只留帳戶
  let hits = scored;
  if (saysCard && hits.some((x) => x.c.kind === 'CARD')) hits = hits.filter((x) => x.c.kind === 'CARD');
  if (saysAccount && hits.some((x) => x.c.kind === 'ACCOUNT')) hits = hits.filter((x) => x.c.kind === 'ACCOUNT');

  hits.sort((x, y) => y.score - x.score || ownerRank(x.c, ctx.speakerId) - ownerRank(y.c, ctx.speakerId) || (x.c.sortOrder ?? 0) - (y.c.sortOrder ?? 0));

  // 學過的叫法優先（只認說話者能動的那個，避免 Shark 教的別名讓 Apple 誤動 Shark 的帳戶）
  const aliasHits = hits.filter((x) => x.c.writable && x.c.aliases.some((a) => normalizeName(a) === normalizeName(hint.rest)));
  if (aliasHits.length === 1) return { status: 'unique', pick: aliasHits[0].c, via: 'alias' };

  if (hits.length === 1) return { status: 'unique', pick: hits[0].c, via: hits[0].tier! };

  // 沒說卡或帳戶、帳戶與卡都對得上 → 問
  const mixed = !saysCard && !saysAccount && hits.some((x) => x.c.kind === 'CARD') && hits.some((x) => x.c.kind !== 'CARD');
  const top = hits[0];
  const sameTop = hits.filter((x) => x.score === top.score);
  if (!mixed && sameTop.length === 1 && top.score >= TIER_SCORE.alias) {
    // 完全相同（或別名）只有一個，其他都只是部分相似 → 直接用
    return { status: 'unique', pick: top.c, via: top.tier! };
  }
  return { status: 'ambiguous', options: hits.slice(0, MAX_OPTIONS).map((x) => x.c) };
}

/** 新學到的叫法要不要記成別名：正規化後非空、不是名稱本身、沒記過、最多 20 個。 */
export function nextAliases(current: string[], raw: string, name: string): string[] | null {
  const q = normalizeName(ownerHintFree(raw));
  if (!q || q === normalizeName(name)) return null;
  if (current.some((a) => normalizeName(a) === q)) return null;
  return [...current, q].slice(-20);
}

// 別名不帶歸屬字（「我的臺銀」記成「臺銀」）
function ownerHintFree(raw: string): string {
  return baseNormalize(raw).replace(/^(我自己|自己|我)(的)?/, '');
}
