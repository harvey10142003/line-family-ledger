// Gemini-2.5-Flash — 同時負責文字記帳 parse + 收據圖片 OCR + PDF 帳單批次匯入
//
// 三個職責：
// 1. parseTransactionText: 「午餐 120」→ { amount, categoryName, note, type }
// 2. parseReceiptImage: 收據圖片 → 單筆 { totalAmount, items[], merchant, paidAt, suggestedCategory }
// 3. parseBillFile: PDF 帳單 → 多筆 ParsedTransaction[]（信用卡月帳單、水電瓦斯）

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';

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

// TODO: 階段 1 實作
export async function parseTransactionText(_text: string, _categoryNames: string[]): Promise<ParsedTransaction | null> {
  throw new Error('not implemented');
}

// TODO: 階段 2a 實作
export async function parseReceiptImage(_imageBuffer: Buffer, _mimeType: string): Promise<ParsedReceipt | null> {
  throw new Error('not implemented');
}

// TODO: 階段 2b 實作（mimeType=application/pdf，gemini multimodal inlineData）
export async function parseBillFile(_fileBuffer: Buffer, _mimeType: string): Promise<ParsedTransaction[] | null> {
  throw new Error('not implemented');
}
