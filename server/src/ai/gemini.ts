// Gemini-2.5-Flash — 同時負責文字記帳 parse + 收據圖片 OCR + PDF 帳單批次匯入
//
// 三個職責：
// 1. parseTransactionText: 「午餐 120」→ { amount, categoryName, note, type }
// 2. parseReceiptImage: 收據圖片 → 單筆 { totalAmount, items[], merchant, paidAt, suggestedCategory }
// 3. parseBillFile: PDF 帳單 → 多筆 ParsedTransaction[]（信用卡月帳單、水電瓦斯）

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { config } from '../config';
import { logger } from '../logger';

export const gemini = new GoogleGenerativeAI(config.gemini.apiKey);

export type ParsedTransaction = {
  amount: number;
  categoryName: string;
  note: string;
  type: 'EXPENSE' | 'INCOME';
};

export type ParsedReceipt = {
  totalAmount: number;
  merchant?: string;
  paidAt?: string;
  items: { name: string; amount: number }[];
  suggestedCategory?: string;
};

export type CategoryHint = { name: string; type: 'EXPENSE' | 'INCOME' };

// PDF 帳單的單筆交易（比文字記帳多一個日期）
export type ParsedBillItem = ParsedTransaction & { paidAt?: string };

// 階段 1：文字記帳 parse。把「午餐 120」「薪水 50000」「7-11 飲料 45 其他支出」
// 解析成結構化交易。categoryName 必須命中傳入的家庭分類之一；無法判斷金額時回 null。
export async function parseTransactionText(
  text: string,
  categories: CategoryHint[],
): Promise<ParsedTransaction | null> {
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
          isTransaction: {
            type: SchemaType.BOOLEAN,
            description: '這句話是否為一筆記帳（含金額的收入或支出）',
          },
          amount: {
            type: SchemaType.NUMBER,
            description: '金額，正數。無法判斷時填 0',
          },
          type: {
            type: SchemaType.STRING,
            format: 'enum',
            enum: ['EXPENSE', 'INCOME'],
            description: '支出或收入',
          },
          categoryName: {
            type: SchemaType.STRING,
            format: 'enum',
            enum: categoryNames,
            description: '從提供的分類清單挑一個最貼切的',
          },
          note: {
            type: SchemaType.STRING,
            description: '備註，通常是品項或描述，例如「午餐」「7-11 飲料」。沒有就空字串',
          },
        },
        required: ['isTransaction', 'amount', 'type', 'categoryName', 'note'],
      },
    },
  });

  const prompt = [
    '你是家庭記帳助理。使用者用一句話記一筆帳，請解析成結構化資料。',
    '',
    '規則：',
    '- 金額是句子中的數字，可能有「元」「塊」「$」等，取純數值。',
    '- 預設為支出 (EXPENSE)。只有明顯是收入（薪水、獎金、收到錢、賣東西收入）才用 INCOME。',
    `- 支出分類只能從：${expenseNames.join('、')}`,
    `- 收入分類只能從：${incomeNames.join('、')}`,
    '- 找不到完全對應的分類時，支出用「其他支出」、收入用「其他收入」。',
    '- note 放品項描述（去掉金額數字），例如「午餐 120」的 note 是「午餐」。',
    '- 如果這句話根本不是記帳（例如打招呼、問問題），isTransaction 設 false。',
    '',
    `使用者輸入：「${text}」`,
  ].join('\n');

  try {
    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    const parsed = JSON.parse(raw) as {
      isTransaction: boolean;
      amount: number;
      type: 'EXPENSE' | 'INCOME';
      categoryName: string;
      note: string;
    };

    if (!parsed.isTransaction || !parsed.amount || parsed.amount <= 0) return null;

    // 防呆：categoryName 萬一不在清單內，退回「其他」
    let categoryName = parsed.categoryName;
    if (!categoryNames.includes(categoryName)) {
      categoryName = parsed.type === 'INCOME' ? '其他收入' : '其他支出';
    }

    return {
      amount: Math.round(parsed.amount * 100) / 100,
      categoryName,
      note: (parsed.note ?? '').trim(),
      type: parsed.type === 'INCOME' ? 'INCOME' : 'EXPENSE',
    };
  } catch (err) {
    logger.error({ err, text }, 'parseTransactionText failed');
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
            description: '品項明細（最多 10 筆），看不出明細可空陣列',
            items: {
              type: SchemaType.OBJECT,
              properties: {
                name: { type: SchemaType.STRING },
                amount: { type: SchemaType.NUMBER },
              },
              required: ['name', 'amount'],
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
      items: { name: string; amount: number }[];
    };

    if (!parsed.isReceipt || !parsed.totalAmount || parsed.totalAmount <= 0) return null;

    let suggestedCategory = parsed.suggestedCategory;
    if (!expenseNames.includes(suggestedCategory)) suggestedCategory = '其他支出';

    return {
      totalAmount: Math.round(parsed.totalAmount * 100) / 100,
      merchant: parsed.merchant?.trim() || undefined,
      paidAt: /^\d{4}-\d{2}-\d{2}$/.test(parsed.paidAt) ? parsed.paidAt : undefined,
      items: Array.isArray(parsed.items) ? parsed.items.slice(0, 10) : [],
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
