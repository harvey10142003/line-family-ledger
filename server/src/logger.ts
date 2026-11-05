import pino, { type LoggerOptions } from 'pino';

// log 遮蔽（規格 6.5／P0-3）：密碼、真實姓名、身分證、ID token、加密金鑰不論放在哪一層物件都換成 [已遮蔽]。
// pino 的萬用字元只到一層，所以同時列「頂層」與「*.欄位」。新增敏感欄位名稱時加在 SENSITIVE_KEYS。
export const SENSITIVE_KEYS = [
  'password',
  'pdfPassword',
  'passwordPlain',
  'legalName',
  'legalNameEnc',
  'idNumber',
  'idToken',
  'id_token',
  'accessToken',
  'authorization',
  'LEDGER_FIELD_KEY',
  'LEDGER_FIELD_KEYS_OLD',
] as const;

export const REDACT_PATHS: string[] = [
  ...SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`]),
  'req.headers.authorization',
  'headers.authorization',
  '*.headers.authorization',
];

export const REDACT_CENSOR = '[已遮蔽]';

export const loggerOptions: LoggerOptions = {
  redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
};

export const logger = pino({
  ...loggerOptions,
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
});
