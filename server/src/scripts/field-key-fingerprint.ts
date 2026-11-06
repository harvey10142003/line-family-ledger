// 用法：node server/dist/scripts/field-key-fingerprint.js，然後貼上金鑰按 Enter（從標準輸入讀，不進 shell 歷史）。
// 只輸出指紋（sha256 前 8 碼），跟 /health 的 fieldKeyFingerprint 比對：一樣＝離線備份的就是線上在用的那把。
import { fingerprintOfKeyString } from '../lib/field-crypto';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  if (buf.includes('\n')) done();
});
process.stdin.on('end', done);

let finished = false;
function done() {
  if (finished) return;
  finished = true;
  const key = buf.split(/\r?\n/)[0].trim();
  try {
    console.log(fingerprintOfKeyString(key));
    process.exit(0);
  } catch (err) {
    console.error(`invalid key: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
