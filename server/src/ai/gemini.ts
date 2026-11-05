// Gemini-2.5-Flash — 同時負責文字記帳 parse + 收據圖片 OCR + PDF 帳單批次匯入
//
// 三個職責：
// 1. parseLedgerText: 「午餐 120」「台新轉 5000 到國泰」→ 每一筆的意圖＋欄位原文（數字、日期、帳戶由程式算）
// 2. parseReceiptImage: 收據圖片 → 單筆 { totalAmount, items[], merchant, paidAt, suggestedCategory }
// 3. parseBillFile: PDF 帳單 → 多筆 ParsedTransaction[]（信用卡月帳單、水電瓦斯）

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { config } from '../config';
import { logger } from '../logger';
import type { LedgerParseRaw } from '../lib/ledger-plan';

export const gemini = new GoogleGenerativeAI(config.gemini.apiKey);

export type ParsedTransaction = {
  amount: number;
  categoryName: string;
  note: string;
  type: 'EXPENSE' | 'INCOME';
  accountName?: string | null; // 付款帳戶提示，對不上家庭帳戶則 null
};

export type ParsedReceipt = {
  totalAmount: number;
  merchant?: string;
  paidAt?: string;
  items: { name: string; amount: number; categoryName?: string }[];
  suggestedCategory?: string;
};

export type CategoryHint = { name: string; type: 'EXPENSE' | 'INCOME' };

// PDF 帳單的單筆交易（比文字記帳多一個日期）
export type ParsedBillItem = ParsedTransaction & { paidAt?: string };

// 階段 1（財務中樞 P1-5／P1-6 改版）：文字記帳＋一句話建轉帳。
//
// Gemini 只回「意圖＋欄位原文」：每一筆是支出、收入還是轉帳，金額、日期原文、帳戶原文、歸屬人原文、幣別原文、
// 轉帳的來源／目的原文。日期換算、帳戶比對、金額複核、本金＋利息＝總額、公司／家庭、外幣換台幣，全部由程式做
// （lib/ledger-plan.ts、lib/ledger-resolve.ts）。
// 送出前必須先遮罩卡號、帳號、身分證、手機（lib/mask.ts），這裡只收已遮罩的文字。
// 回 null＝Gemini 失敗；isLedger=false＝不是記帳。
const TRANSFER_KIND_ENUM = ['', 'ACCOUNT', 'CARD_PAYMENT', 'CASH_WITHDRAW', 'CASH_DEPOSIT', 'TIME_DEPOSIT', 'LOAN_REPAY', 'LEND', 'BORROW', 'COLLECT', 'SPOUSE'];

export async function parseLedgerText(
  maskedText: string,
  categories: CategoryHint[],
  hints: { paymentNames?: string[]; memberNames?: string[] } = {},
): Promise<LedgerParseRaw | null> {
  const categoryNames = categories.map((c) => c.name);
  const expenseNames = categories.filter((c) => c.type === 'EXPENSE').map((c) => c.name);
  const incomeNames = categories.filter((c) => c.type === 'INCOME').map((c) => c.name);
  const paymentNames = hints.paymentNames ?? [];
  const memberNames = hints.memberNames ?? [];
  const str = (description: string) => ({ type: SchemaType.STRING, description });
  const numb = (description: string) => ({ type: SchemaType.NUMBER, description });

  const model = gemini.getGenerativeModel({
    model: config.gemini.model,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          isLedger: { type: SchemaType.BOOLEAN, description: '這句話是否為記帳或轉帳（含金額）' },
          sharedAccountText: str('整句共用的付款方式原文（例如「現金」「刷台新」→「台新」），沒有就空字串'),
          sharedDateText: str('整句共用的日期原文（例如句首的「昨天」），沒有就空字串'),
          items: {
            type: SchemaType.ARRAY,
            description: '每一個有獨立金額的收支或轉帳各一筆',
            items: {
              type: SchemaType.OBJECT,
              properties: {
                intent: { type: SchemaType.STRING, format: 'enum', enum: ['EXPENSE', 'INCOME', 'TRANSFER'] },
                segment: str('原句中屬於這一筆的那一段原文（照抄，不要改寫）'),
                amount: numb('這一筆的金額（轉帳＝使用者說的總額）。「2萬」＝20000'),
                categoryName: { type: SchemaType.STRING, format: 'enum', enum: categoryNames.length ? categoryNames : ['其他支出'] },
                note: str('品項＋商家／地點，去掉金額、日期、付款方式'),
                dateText: str('這一筆的日期原文（照抄「昨天」「10/3」「上週五」），沒寫就空字串；不要自己換算'),
                accountText: str('這一筆的付款方式原文，沒提到就空字串'),
                ownerText: str('只有「幫 X 記」「X 的…」時填 X（成員名稱原文）；「跟 X 一起」不算，空字串'),
                currencyText: str('外幣幣別原文（美金、日圓、USD），台幣或沒寫就空字串'),
                transferKind: { type: SchemaType.STRING, format: 'enum', enum: TRANSFER_KIND_ENUM },
                fromText: str('轉帳的來源原文（帳戶、卡、成員名稱或「我」），沒寫就空字串'),
                toText: str('轉帳的目的原文，沒寫就空字串'),
                counterpartyText: str('借出、借入、收回借款的對象（例如「小明」），沒有就空字串'),
                principal: numb('還貸款有講本金才填，沒講填 0'),
                interest: numb('有講利息才填，沒講填 0'),
                fee: numb('有講手續費才填，沒講填 0'),
              },
              required: ['intent', 'segment', 'amount', 'categoryName', 'note', 'dateText', 'accountText', 'ownerText', 'currencyText', 'transferKind', 'fromText', 'toText', 'counterpartyText', 'principal', 'interest', 'fee'],
            },
          },
        },
        required: ['isLedger', 'sharedAccountText', 'sharedDateText', 'items'],
      },
    },
  });

  const prompt = [
    '你是家庭記帳助理，只負責把使用者的一句話拆成「每一筆是什麼、欄位原文是什麼」。不要換算日期、不要猜帳戶、不要自己算金額。',
    '',
    '收支（EXPENSE／INCOME）：',
    '- 每個有獨立金額的品項各一筆，例如「早餐 豆漿25 蛋餅35」→ 兩筆；只有一個總金額（「午餐 120」）就一筆，不要自己拆。',
    '- 金額可能有「元」「塊」「$」「萬」「千」，取純數值。付款方式不是品項。商家或地點放進 note。',
    '- 預設支出，明顯是收入（薪水、獎金、收到錢）才 INCOME。',
    `- 支出分類只能從：${expenseNames.join('、')}；收入分類只能從：${incomeNames.join('、')}；找不到用「其他支出」「其他收入」。`,
    '- 有寫外幣（美金、日圓…）就把幣別原文放 currencyText，amount 照原幣金額，不要換台幣。',
    '- 有寫「公司」就讓 segment 保留「公司」兩個字。',
    '',
    '轉帳（TRANSFER，不算收支，只是錢從一個地方搬到另一個地方）：',
    '- ACCOUNT 一般轉帳（台新轉 5000 到國泰）／CARD_PAYMENT 繳信用卡／CASH_WITHDRAW 領現金／CASH_DEPOSIT 存現金到銀行／',
    '  TIME_DEPOSIT 存定存或定存解約／LOAN_REPAY 還貸款（房貸、車貸、信貸）／LEND 借錢給別人／BORROW 跟別人借錢／',
    '  COLLECT 別人還錢給我們／SPOUSE 家庭成員之間互轉（例如「Apple 轉 1 萬給我」：fromText＝Apple、toText＝我）。',
    '- fromText、toText 照抄原文（「臺銀」「國泰卡」「我的台新」「Apple」）；借貸對象放 counterpartyText。',
    '- 還貸款有寫本金、利息就分別填 principal、interest，amount 填總額；沒寫就填 0。',
    '- 同一句可以同時有轉帳和消費（「領現金 3000，然後午餐 120 用現金」→ 一筆轉帳＋一筆支出）。',
    '',
    '日期：照抄原文到 dateText（句首的日期也適用後面每一筆，直到出現新的日期）。',
    memberNames.length ? `家庭成員：${memberNames.join('、')}（「我」＝說話的人）。` : '',
    paymentNames.length ? `家庭現有的帳戶／卡名稱（只當參考，原文照抄）：${paymentNames.join('、')}` : '',
    '句子裡的 [卡號末4:1234]、[帳號末4:1234] 是遮罩過的號碼，照抄即可。',
    '如果根本不是記帳（打招呼、問問題），isLedger 設 false、items 空陣列。',
    '',
    `使用者輸入：「${maskedText}」`,
  ]
    .filter((x) => x !== '')
    .join('\n');

  try {
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text()) as LedgerParseRaw;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      isLedger: !!parsed.isLedger,
      sharedAccountText: typeof parsed.sharedAccountText === 'string' ? parsed.sharedAccountText : '',
      sharedDateText: typeof parsed.sharedDateText === 'string' ? parsed.sharedDateText : '',
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch (err) {
    // 只記錯誤，不記使用者原句（可能含個資）
    logger.error({ err }, 'parseLedgerText failed');
    return null;
  }
}

// 階段 2a：收據圖片 OCR。辨識總金額、商家、品項、日期，並從家庭分類挑一個建議分類。
export async function parseReceiptImage(
  imageBuffer: Buffer,
  mimeType: string,
  categories: CategoryHint[],
): Promise<ParsedReceipt | null> {
  const expenseNames = categories.filter((c) => c.type === 'EXPENSE').map((c) => c.name);

  const model = gemini.getGenerativeModel({
    model: config.gemini.model,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          isReceipt: {
            type: SchemaType.BOOLEAN,
            description: '這張圖是否為收據／發票／帳單（看得出消費金額）',
          },
          totalAmount: {
            type: SchemaType.NUMBER,
            description: '消費總金額，正數。看不出來填 0',
          },
          merchant: { type: SchemaType.STRING, description: '商家名稱，沒有就空字串' },
          paidAt: {
            type: SchemaType.STRING,
            description: '消費日期，格式 YYYY-MM-DD；看不出來就空字串',
          },
          suggestedCategory: {
            type: SchemaType.STRING,
            format: 'enum',
            enum: expenseNames,
            description: '從支出分類清單挑一個最貼切的',
          },
          items: {
            type: SchemaType.ARRAY,
            description: '品項明細（最多 20 筆），看不出明細可空陣列',
            items: {
              type: SchemaType.OBJECT,
              properties: {
                name: { type: SchemaType.STRING },
                amount: { type: SchemaType.NUMBER },
                categoryName: { type: SchemaType.STRING, format: 'enum', enum: expenseNames, description: '該品項的支出分類' },
              },
              required: ['name', 'amount', 'categoryName'],
            },
          },
        },
        required: ['isReceipt', 'totalAmount', 'merchant', 'paidAt', 'suggestedCategory', 'items'],
      },
    },
  });

  const prompt = [
    '你是家庭記帳助理。請辨識這張收據／發票／帳單的內容。',
    `- 支出分類只能從：${expenseNames.join('、')}；找不到對應就用「其他支出」。`,
    '- totalAmount 取「應付總額／合計」，不是單一品項金額。',
    '- items 盡量逐項列出每個有金額的品項（含各自分類），讓使用者可逐筆記帳。',
    '- 如果圖片根本不是收據（例如風景照、人像），isReceipt 設 false。',
  ].join('\n');

  try {
    const result = await model.generateContent([
      prompt,
      { inlineData: { data: imageBuffer.toString('base64'), mimeType } },
    ]);
    const parsed = JSON.parse(result.response.text()) as {
      isReceipt: boolean;
      totalAmount: number;
      merchant: string;
      paidAt: string;
      suggestedCategory: string;
      items: { name: string; amount: number; categoryName?: string }[];
    };

    if (!parsed.isReceipt || !parsed.totalAmount || parsed.totalAmount <= 0) return null;

    let suggestedCategory = parsed.suggestedCategory;
    if (!expenseNames.includes(suggestedCategory)) suggestedCategory = '其他支出';

    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .filter((it) => it.amount && it.amount > 0)
      .slice(0, 20)
      .map((it) => ({
        name: (it.name ?? '').trim(),
        amount: Math.round(it.amount * 100) / 100,
        categoryName: it.categoryName && expenseNames.includes(it.categoryName) ? it.categoryName : suggestedCategory,
      }));

    return {
      totalAmount: Math.round(parsed.totalAmount * 100) / 100,
      merchant: parsed.merchant?.trim() || undefined,
      paidAt: /^\d{4}-\d{2}-\d{2}$/.test(parsed.paidAt) ? parsed.paidAt : undefined,
      items,
      suggestedCategory,
    };
  } catch (err) {
    logger.error({ err }, 'parseReceiptImage failed');
    return null;
  }
}

// 階段 2b：PDF 帳單批次解析（信用卡月帳單 / 水電瓦斯）。回傳多筆交易。
export async function parseBillFile(
  fileBuffer: Buffer,
  mimeType: string,
  categories: CategoryHint[],
): Promise<ParsedBillItem[] | null> {
  const categoryNames = categories.map((c) => c.name);
  const expenseNames = categories.filter((c) => c.type === 'EXPENSE').map((c) => c.name);
  const incomeNames = categories.filter((c) => c.type === 'INCOME').map((c) => c.name);

  const model = gemini.getGenerativeModel({
    model: config.gemini.model,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          isBill: {
            type: SchemaType.BOOLEAN,
            description: '這份檔案是否為帳單／對帳單／消費明細',
          },
          transactions: {
            type: SchemaType.ARRAY,
            description: '帳單上的每一筆消費明細',
            items: {
              type: SchemaType.OBJECT,
              properties: {
                amount: { type: SchemaType.NUMBER, description: '金額正數' },
                type: { type: SchemaType.STRING, format: 'enum', enum: ['EXPENSE', 'INCOME'] },
                categoryName: { type: SchemaType.STRING, format: 'enum', enum: categoryNames },
                note: { type: SchemaType.STRING, description: '商家／品項描述' },
                paidAt: { type: SchemaType.STRING, description: '消費日期 YYYY-MM-DD，沒有就空字串' },
              },
              required: ['amount', 'type', 'categoryName', 'note', 'paidAt'],
            },
          },
        },
        required: ['isBill', 'transactions'],
      },
    },
  });

  const prompt = [
    '你是家庭記帳助理。請從這份帳單／對帳單擷取每一筆消費明細。',
    '規則：',
    '- 每筆 amount 取消費金額正數。退刷／退款視為 INCOME，其餘為 EXPENSE。',
    `- 支出分類只能從：${expenseNames.join('、')}；找不到對應用「其他支出」。`,
    `- 收入分類只能從：${incomeNames.join('、')}；找不到對應用「其他收入」。`,
    '- 略過小計、本期應繳總額、上期餘額、循環利息、繳款這類「彙總列」，只抓真正的單筆消費。',
    '- note 放商家名稱或品項。',
    '- 如果檔案不是帳單，isBill 設 false、transactions 空陣列。',
  ].join('\n');

  try {
    const result = await model.generateContent([
      prompt,
      { inlineData: { data: fileBuffer.toString('base64'), mimeType } },
    ]);
    const parsed = JSON.parse(result.response.text()) as {
      isBill: boolean;
      transactions: { amount: number; type: string; categoryName: string; note: string; paidAt: string }[];
    };

    if (!parsed.isBill || !Array.isArray(parsed.transactions)) return null;

    const items: ParsedBillItem[] = parsed.transactions
      .filter((t) => t.amount && t.amount > 0)
      .map((t) => {
        const type = t.type === 'INCOME' ? 'INCOME' : 'EXPENSE';
        let categoryName = t.categoryName;
        if (!categoryNames.includes(categoryName)) {
          categoryName = type === 'INCOME' ? '其他收入' : '其他支出';
        }
        return {
          amount: Math.round(t.amount * 100) / 100,
          type,
          categoryName,
          note: (t.note ?? '').trim(),
          paidAt: /^\d{4}-\d{2}-\d{2}$/.test(t.paidAt) ? t.paidAt : undefined,
        };
      });

    return items.length > 0 ? items : null;
  } catch (err) {
    logger.error({ err }, 'parseBillFile failed');
    return null;
  }
}
