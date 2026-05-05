// Gemini-2.5-Flash — 收據圖片 OCR
// 待實作：吃 image buffer → 回 { totalAmount, items[], merchant, paidAt }

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';

export const gemini = new GoogleGenerativeAI(config.gemini.apiKey);

export type ParsedReceipt = {
  totalAmount: number;
  merchant?: string;
  paidAt?: string;
  items: { name: string; amount: number }[];
  suggestedCategory?: string;
};

// TODO: 階段 2 實作
export async function parseReceiptImage(_imageBuffer: Buffer, _mimeType: string): Promise<ParsedReceipt | null> {
  throw new Error('not implemented');
}
