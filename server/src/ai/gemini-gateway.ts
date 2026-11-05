// 送 Gemini 的唯一出口（規格 6.6，P0-2）。
//
// 全專案只有這支可以 import @google/generative-ai、呼叫 generateContent（靜態棘輪 gemini-egress-ratchet.test.ts 守門）。
// 每次送出：
// 1. 所有文字段落一律先過 lib/mask.ts 的 maskSensitive()（卡號／帳號／身分證／手機／市話／Email／地址，留末四碼；
//    有給 maskNames 就連真實姓名一起換成代號）。
// 2. 圖片、PDF 這類二進位內容沒辦法先遮（AI 要看圖才讀得出字），呼叫端必須寫明 binaryReason，否則直接丟錯；
//    之後文字型 PDF 要先在後端抽文字、走文字段落（P2）。
// 3. 送出前後各寫一行 log：用途、段落數、遮罩前後長度、各類命中數、遮罩代號數、二進位大小與型別、回應長度、耗時。
//    **絕不寫原文、遮罩後文字、姓名對照或回應內容**。
import { GoogleGenerativeAI, SchemaType, type GenerationConfig, type Part } from '@google/generative-ai';
import { config } from '../config';
import { logger } from '../logger';
import { countMaskTokens, maskSensitive, type MaskCounts } from '../lib/mask';

export { SchemaType };

export type GeminiPurpose = 'text-ledger' | 'receipt-ocr' | 'bill-pdf' | 'document-text' | 'passbook-ocr';

export type GeminiPart = string | { inlineData: { data: Buffer; mimeType: string } };

export interface GeminiRequest {
  purpose: GeminiPurpose;
  generationConfig: GenerationConfig;
  parts: GeminiPart[];
  /** 要換成 [戶名A] 代號的真實姓名（帳單戶名）；對照表從回傳的 nameTokens 拿 */
  maskNames?: readonly string[];
  /** 有二進位段落（圖片、PDF）時必填：為什麼不能先遮罩（寫進 log） */
  binaryReason?: 'image-ocr-needs-pixels' | 'pdf-not-yet-text-extracted';
}

export interface GeminiResult {
  text: string;
  /** 代號 → maskNames 索引 */
  nameTokens: Record<string, number>;
}

/** 真正打出去的那一層。測試換成假的，看「實際送出去的內容」有沒有被遮。 */
export interface GeminiTransport {
  generate(model: string, generationConfig: GenerationConfig, parts: Part[]): Promise<string>;
}

let client: GoogleGenerativeAI | null = null;
const realTransport: GeminiTransport = {
  async generate(model, generationConfig, parts) {
    client ??= new GoogleGenerativeAI(config.gemini.apiKey);
    const result = await client.getGenerativeModel({ model, generationConfig }).generateContent(parts);
    return result.response.text();
  },
};

let transport: GeminiTransport = realTransport;

/** 只給測試用：換掉真正的傳輸層；回傳還原函式。 */
export function setGeminiTransportForTest(t: GeminiTransport): () => void {
  transport = t;
  return () => {
    transport = realTransport;
  };
}

export class GeminiEgressError extends Error {}

function addCounts(a: MaskCounts, b: MaskCounts): MaskCounts {
  const out = { ...a };
  for (const k of Object.keys(b) as (keyof MaskCounts)[]) out[k] += b[k];
  return out;
}

export async function generateWithGemini(req: GeminiRequest): Promise<GeminiResult> {
  let counts: MaskCounts = { email: 0, address: 0, idNumber: 0, mobile: 0, phone: 0, card: 0, account: 0, name: 0 };
  const nameTokens: Record<string, number> = {};
  let lenIn = 0;
  let lenOut = 0;
  let tokens = 0;
  const binaries: { mimeType: string; bytes: number }[] = [];
  const parts: Part[] = [];

  for (const p of req.parts) {
    if (typeof p === 'string') {
      const m = maskSensitive(p, { names: req.maskNames });
      counts = addCounts(counts, m.counts);
      Object.assign(nameTokens, m.nameTokens);
      lenIn += p.length;
      lenOut += m.text.length;
      tokens += countMaskTokens(m.text);
      parts.push({ text: m.text });
    } else {
      if (!req.binaryReason) throw new GeminiEgressError(`gemini ${req.purpose}: binary part without binaryReason`);
      binaries.push({ mimeType: p.inlineData.mimeType, bytes: p.inlineData.data.length });
      parts.push({ inlineData: { data: p.inlineData.data.toString('base64'), mimeType: p.inlineData.mimeType } });
    }
  }

  const hits = Object.values(counts).reduce((a, b) => a + b, 0);
  logger.info(
    {
      gemini: {
        purpose: req.purpose,
        model: config.gemini.model,
        textParts: parts.length - binaries.length,
        lenIn,
        lenOut,
        hits,
        counts,
        maskTokens: tokens,
        binaries,
        ...(binaries.length ? { binaryReason: req.binaryReason } : {}),
      },
    },
    'gemini request (masked)',
  );

  const started = Date.now();
  try {
    const text = await transport.generate(config.gemini.model, req.generationConfig, parts);
    logger.info({ gemini: { purpose: req.purpose, responseLen: text.length, ms: Date.now() - started } }, 'gemini response');
    return { text, nameTokens };
  } catch (err) {
    // 錯誤物件可能夾帶請求內容（SDK 會把部分 payload 放進 message）→ 只記類型與耗時
    logger.error({ gemini: { purpose: req.purpose, ms: Date.now() - started, error: err instanceof Error ? err.name : typeof err } }, 'gemini request failed');
    throw err;
  }
}
