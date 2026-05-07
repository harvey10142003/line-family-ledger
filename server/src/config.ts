import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',

  line: {
    channelSecret: required('LINE_CHANNEL_SECRET'),
    channelAccessToken: required('LINE_CHANNEL_ACCESS_TOKEN'),
    liffId: required('LINE_LIFF_ID'),
  },

  gemini: {
    apiKey: required('GEMINI_API_KEY'),
    // 同一個模型負責文字記帳 parse 跟收據圖片 OCR
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  },
};
