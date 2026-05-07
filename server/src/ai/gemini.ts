// Gemini-2.5-Flash — 同時負責文字記帳 parse + 收據圖片 OCR
//
// 兩個職責：
// 1. parseTransactionText: 「午餐 120」→ { amount, categoryName, note, type }
// 2. parseReceiptImage: 收據圖片 → { totalAmount, items[], merchant, paidAt, suggestedCategory }

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

// TODO: 階段 2 實作
export async function parseReceiptImage(_imageBuffer: Buffer, _mimeType: string): Promise<ParsedReceipt | null> {
  throw new Error('not implemented');
}
