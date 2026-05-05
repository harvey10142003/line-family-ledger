import { PrismaClient } from '@prisma/client';
import { DEFAULT_CATEGORIES } from '../server/src/services/categories';

const prisma = new PrismaClient();

async function main() {
  console.log(`Seed: 預設分類已定義 ${DEFAULT_CATEGORIES.length} 種，會在建立家庭時自動套用`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
