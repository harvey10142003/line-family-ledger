// P0-2：送 Gemini 前遮罩（規格 6.6）。
//
// 1. 靜態棘輪：全專案只有 ai/gemini-gateway.ts 能 import Gemini SDK、呼叫 generateContent／getGenerativeModel、
//    或直接打 generativelanguage.googleapis.com。新的出口（存摺、PDF 文字…）一定要走閘道，否則這支會紅。
// 2. 行為：用假的傳輸層接住「真正送出去的內容」，確認卡號、帳號、身分證、手機、Email、地址、姓名都被遮，
//    金額與日期留著；log 只有長度與命中數，沒有原文。
// 3. 測試字串集：規格 P0-2 驗收「全部被遮；遮罩後仍能解析出金額與日期」。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { maskSensitive, countMaskTokens } from '../src/lib/mask';
import { extractAmounts } from '../src/lib/amount-text';

const SRC = join(__dirname, '..', 'src');
const GATEWAY = ['ai', 'gemini-gateway.ts'].join(sep);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

// 註解裡提到這些字不算（說明文字會寫「呼叫 generateContent」）
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const EGRESS = [
  /@google\/generative-ai['"]/,
  /\bGoogleGenerativeAI\b/,
  /\.generateContent(?:Stream)?\s*\(/,
  /\.getGenerativeModel\s*\(/,
  /\.startChat\s*\(/,
  /generativelanguage\.googleapis\.com/,
  /aiplatform\.googleapis\.com/,
];

test('棘輪：只有 ai/gemini-gateway.ts 能直接碰 Gemini', () => {
  const offenders: string[] = [];
  for (const f of walk(SRC)) {
    const rel = relative(SRC, f);
    if (rel === GATEWAY) continue;
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const re of EGRESS) {
      // ai/gemini.ts 只允許 import 型別（import type ... from '@google/generative-ai'）
      if (re.source.startsWith('@google') && rel === join('ai', 'gemini.ts')) {
        const lines = code.split(/\r?\n/).filter((l) => re.test(l));
        if (lines.every((l) => /^\s*import type\b/.test(l))) continue;
      }
      if (re.test(code)) offenders.push(`${rel} ← ${re.source}`);
    }
  }
  assert.deepEqual(offenders, [], '直接碰 Gemini 的地方要改走 generateWithGemini()');
});

test('棘輪：閘道本身每一段文字都過 maskSensitive，且只有一個 generateContent 呼叫點', () => {
  const code = stripComments(readFileSync(join(SRC, GATEWAY), 'utf8'));
  assert.equal((code.match(/\.generateContent\s*\(/g) ?? []).length, 1);
  assert.match(code, /maskSensitive\(p, \{ names: req\.maskNames \}\)/);
  assert.match(code, /binary part without binaryReason/);
});

// ---- 行為：假的傳輸層 ----
let gw: typeof import('../src/ai/gemini-gateway');
let gem: typeof import('../src/ai/gemini');
let logger: typeof import('../src/logger').logger;

before(async () => {
  process.env.LINE_CHANNEL_SECRET ??= 'test-secret';
  process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'test-token';
  process.env.LINE_LIFF_ID ??= '1234567890-test';
  process.env.GEMINI_API_KEY ??= 'test-gemini';
  gw = await import('../src/ai/gemini-gateway');
  gem = await import('../src/ai/gemini');
  ({ logger } = await import('../src/logger'));
});

const RAW = {
  card: '4311-9512-3456-7788',
  account: '808-12-345678-9',
  id: 'A123456789',
  mobile: '0912-345-678',
  email: 'shark.shih@example.com',
  address: '高雄市前鎮區中山二路 5 號 12 樓',
  name: '施允瀚',
};

function captureLogs() {
  const lines: string[] = [];
  const orig = { info: logger.info, error: logger.error, warn: logger.warn };
  const grab = (...args: unknown[]) => {
    lines.push(JSON.stringify(args));
  };
  (logger as any).info = grab;
  (logger as any).error = grab;
  (logger as any).warn = grab;
  return {
    lines,
    restore() {
      Object.assign(logger as any, orig);
    },
  };
}

test('閘道：文字記帳實際送出的內容沒有任何原值，log 只有長度與命中數', async () => {
  const sent: any[] = [];
  const restore = gw.setGeminiTransportForTest({
    async generate(_model, _cfg, parts) {
      sent.push(parts);
      return JSON.stringify({ isLedger: true, sharedAccountText: '', sharedDateText: '', items: [] });
    },
  });
  const logs = captureLogs();
  try {
    // 故意把「沒遮過」的句子直接丟進 parseLedgerText：閘道仍要遮
    const sentence = `10/3 午餐 120 刷 ${RAW.card} 轉 ${RAW.account} 身分證 ${RAW.id} 手機 ${RAW.mobile} ${RAW.email} 送到 ${RAW.address}`;
    await gem.parseLedgerText(sentence, [{ name: '餐飲', type: 'EXPENSE' }]);
  } finally {
    logs.restore();
    restore();
  }
  assert.equal(sent.length, 1);
  const body = JSON.stringify(sent[0]);
  for (const v of Object.values(RAW).filter((v) => v !== RAW.name)) assert.ok(!body.includes(v), `送出內容不能有 ${v}`);
  assert.ok(body.includes('[卡號末4:7788]') && body.includes('[帳號末4:6789]'));
  assert.ok(body.includes('午餐 120') && body.includes('10/3'), '金額與日期要留著');

  const all = logs.lines.join('\n');
  assert.match(all, /gemini request \(masked\)/);
  assert.match(all, /"purpose":"text-ledger"/);
  assert.match(all, /"hits":[1-9]/);
  for (const v of Object.values(RAW)) assert.ok(!all.includes(v), `log 不能有 ${v}`);
  assert.ok(!all.includes('午餐'), 'log 不能有原句');
});

test('閘道：給 maskNames 時真實姓名換成代號，代號對照只回給呼叫端', async () => {
  const sent: any[] = [];
  const restore = gw.setGeminiTransportForTest({
    async generate(_m, _c, parts) {
      sent.push(parts);
      return '{}';
    },
  });
  const logs = captureLogs();
  let out: Awaited<ReturnType<typeof gw.generateWithGemini>>;
  try {
    out = await gw.generateWithGemini({ purpose: 'document-text', generationConfig: {}, parts: [`戶名：${RAW.name}　應繳 24,261`], maskNames: ['Apple 本名', RAW.name] });
  } finally {
    logs.restore();
    restore();
  }
  const body = JSON.stringify(sent[0]);
  assert.ok(!body.includes(RAW.name));
  assert.ok(body.includes('[戶名B]') && body.includes('24,261'));
  assert.deepEqual(out.nameTokens, { '[戶名B]': 1 });
  assert.ok(!logs.lines.join('\n').includes(RAW.name));
  assert.ok(!logs.lines.join('\n').includes('戶名B'), '對照表不進 log');
});

test('閘道：二進位段落沒寫 binaryReason 直接拒絕，不會送出', async () => {
  let called = 0;
  const restore = gw.setGeminiTransportForTest({
    async generate() {
      called++;
      return '{}';
    },
  });
  try {
    await assert.rejects(
      gw.generateWithGemini({ purpose: 'receipt-ocr', generationConfig: {}, parts: ['x', { inlineData: { data: Buffer.from('img'), mimeType: 'image/jpeg' } }] }),
      gw.GeminiEgressError,
    );
  } finally {
    restore();
  }
  assert.equal(called, 0);
});

test('閘道：收據圖片照送（寫明原因），文字提示仍有遮；log 記二進位大小與型別', async () => {
  const sent: any[] = [];
  const restore = gw.setGeminiTransportForTest({
    async generate(_m, _c, parts) {
      sent.push(parts);
      return JSON.stringify({ isReceipt: false, totalAmount: 0, merchant: '', paidAt: '', suggestedCategory: '餐飲', items: [] });
    },
  });
  const logs = captureLogs();
  try {
    await gem.parseReceiptImage(Buffer.alloc(1234, 1), 'image/jpeg', [{ name: '餐飲', type: 'EXPENSE' }]);
  } finally {
    logs.restore();
    restore();
  }
  assert.equal(sent[0].length, 2);
  assert.equal(sent[0][1].inlineData.mimeType, 'image/jpeg');
  const all = logs.lines.join('\n');
  assert.match(all, /"bytes":1234/);
  assert.match(all, /image-ocr-needs-pixels/);
});

test('閘道：Gemini 回壞掉的 JSON，錯誤 log 不夾帶回應原文', async () => {
  const restore = gw.setGeminiTransportForTest({
    async generate() {
      return `not json ${RAW.id} ${RAW.mobile}`;
    },
  });
  const logs = captureLogs();
  try {
    assert.equal(await gem.parseLedgerText('午餐 120', [{ name: '餐飲', type: 'EXPENSE' }]), null);
  } finally {
    logs.restore();
    restore();
  }
  const all = logs.lines.join('\n');
  assert.match(all, /parseLedgerText failed/);
  assert.ok(!all.includes(RAW.id) && !all.includes(RAW.mobile));
});

// ---- 測試字串集（P0-2 驗收）----
const CASES: { s: string; gone: string[]; keep: string[]; amounts?: number[] }[] = [
  { s: '刷 4311 9512 3456 7788 午餐 120', gone: ['4311 9512 3456 7788'], keep: ['[卡號末4:7788]', '午餐'], amounts: [120] },
  { s: '卡號4311951234567788 加油 1,500', gone: ['4311951234567788'], keep: ['[卡號末4:7788]'], amounts: [1500] },
  { s: '轉帳到 808-12-345678-9 5000', gone: ['808-12-345678-9'], keep: ['[帳號末4:6789]'], amounts: [5000] },
  { s: '帳號 012345678901 薪水 52000', gone: ['012345678901'], keep: ['[帳號末4:8901]'], amounts: [52000] },
  { s: '身分證 a123456789 繳稅 3200', gone: ['a123456789'], keep: ['[身分證]'], amounts: [3200] },
  { s: '居留證 AC01234567 與 A812345678', gone: ['AC01234567', 'A812345678'], keep: ['[身分證]'] },
  { s: '手機 0912 345 678 話費 499', gone: ['0912 345 678'], keep: ['[手機]'], amounts: [499] },
  { s: '手機 +886 912-345-678', gone: ['912-345-678'], keep: ['[手機]'] },
  { s: '公司電話 (07)536-1234 或 02-2345-6789', gone: ['536-1234', '2345-6789'], keep: ['[電話]'] },
  { s: '收據寄 shark.shih+bill@ugomk.com', gone: ['shark.shih+bill@ugomk.com'], keep: ['[Email]'] },
  { s: '住 高雄市前鎮區中山二路5號12樓 管理費 2400', gone: ['中山二路5號', '12樓'], keep: ['[地址]', '管理費'], amounts: [2400] },
  { s: '台北市大安區忠孝東路四段 100 巷 5 弄 8 號 房租 25000', gone: ['忠孝東路', '8 號'], keep: ['[地址]'], amounts: [25000] },
  { s: '全形 ４３１１９５１２３４５６７７８８ 早餐 80', gone: ['4311951234567788'], keep: ['[卡號末4:7788]'], amounts: [80] },
];

test('測試字串集：全部被遮，遮罩後仍能抓出金額與日期', () => {
  for (const c of CASES) {
    const m = maskSensitive(c.s);
    for (const g of c.gone) assert.ok(!m.text.includes(g), `${c.s} → ${m.text}（不能有 ${g}）`);
    for (const k of c.keep) assert.ok(m.text.includes(k), `${c.s} → ${m.text}（要有 ${k}）`);
    if (c.amounts) assert.deepEqual(extractAmounts(m.text), c.amounts, `${c.s} → ${m.text} 金額`);
    assert.ok(m.total > 0);
  }
});

test('不該遮的：金額、日期、店名裡的路名（沒有門牌號）、9 碼以下數字', () => {
  const keep = [
    '午餐 120',
    '繳國泰卡 24261',
    '2026-10-03 房租 25,000',
    '全聯中正路店 1280',
    '公司 Zoom 15.99 美金',
    '統編 12345678 文具 350',
    '早餐 豆漿25 蛋餅35',
    '加油 1500 里程 123456789',
  ];
  for (const s of keep) {
    const m = maskSensitive(s);
    assert.equal(m.text, s, s);
    assert.equal(m.total, 0, s);
  }
});

test('冪等：遮過再遮結果不變、命中 0，代號數看得出來', () => {
  const once = maskSensitive(`刷 ${RAW.card} 手機 ${RAW.mobile} ${RAW.email} ${RAW.address}`);
  const twice = maskSensitive(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.total, 0);
  assert.equal(countMaskTokens(once.text), once.total);
});

test('姓名：最長的先換、少於 2 個字不遮', () => {
  const m = maskSensitive('施允瀚 與 允瀚 與 施', { names: ['允瀚', '施允瀚', '施'] });
  assert.equal(m.text, '[戶名B] 與 [戶名A] 與 施');
  assert.deepEqual(m.nameTokens, { '[戶名A]': 0, '[戶名B]': 1 });
  assert.equal(m.counts.name, 2);
});
