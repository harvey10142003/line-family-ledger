// 用法（在 server 容器裡）：node server/dist/scripts/rotate-field-key.js [--dry-run]
// 只輸出數量，不輸出任何密文或明文。
import { rotateFieldKeys } from '../services/field-key-rotation';
import { prisma } from '../prisma';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const report = await rotateFieldKeys({ dryRun });
  console.log(JSON.stringify({ dryRun, ...report }));
  await prisma.$disconnect();
  process.exit(report.failed > 0 ? 2 : 0);
}

main().catch(async (err) => {
  console.error(`rotate-field-key failed: ${err instanceof Error ? err.message : String(err)}`);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
