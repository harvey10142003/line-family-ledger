// DeepSeek-V4-Flash — 文字記帳 parse + 自動分類
// 待實作：把「午餐 120」之類的訊息 parse 成 { amount, categoryName, note, type }
// API 與 OpenAI 相容，使用 openai SDK + base_url 切換

import OpenAI from 'openai';
import { config } from '../config';

export const deepseek = new OpenAI({
  apiKey: config.deepseek.apiKey,
  baseURL: config.deepseek.baseUrl,
});

export type ParsedTransaction = {
  amount: number;
  categoryName: string;
  note: string;
  type: 'EXPENSE' | 'INCOME';
};

// TODO: 階段 1 實作
export async function parseTransactionText(_text: string, _categoryNames: string[]): Promise<ParsedTransaction | null> {
  throw new Error('not implemented');
}
