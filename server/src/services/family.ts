import { prisma } from '../prisma';
import { DEFAULT_CATEGORIES } from './categories';
import type { Family, FamilyMember } from '@prisma/client';

// 6 碼大寫英數家庭碼，避開易混淆字元（0/O/1/I）
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

async function genUniqueFamilyCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = genCode();
    const exists = await prisma.family.findUnique({ where: { familyCode: code } });
    if (!exists) return code;
  }
  throw new Error('failed to generate unique family code');
}

export async function createFamily(params: {
  ownerLineId: string;
  ownerDisplayName: string;
  familyName: string;
  ownerAvatarUrl?: string;
}): Promise<{ family: Family; member: FamilyMember }> {
  const code = await genUniqueFamilyCode();

  return prisma.$transaction(async (tx) => {
    const family = await tx.family.create({
      data: {
        name: params.familyName,
        familyCode: code,
        ownerLineId: params.ownerLineId,
      },
    });

    const member = await tx.familyMember.create({
      data: {
        familyId: family.id,
        lineUserId: params.ownerLineId,
        displayName: params.ownerDisplayName,
        avatarUrl: params.ownerAvatarUrl,
        role: 'OWNER',
      },
    });

    await tx.category.createMany({
      data: DEFAULT_CATEGORIES.map((c) => ({
        familyId: family.id,
        name: c.name,
        icon: c.icon,
        type: c.type,
        sortOrder: c.sortOrder,
        isDefault: true,
      })),
    });

    return { family, member };
  });
}

export async function joinFamily(params: {
  familyCode: string;
  lineUserId: string;
  displayName: string;
  avatarUrl?: string;
}): Promise<{ family: Family; member: FamilyMember } | { error: 'not_found' | 'already_joined' }> {
  const family = await prisma.family.findUnique({
    where: { familyCode: params.familyCode.toUpperCase() },
  });
  if (!family) return { error: 'not_found' };

  const existing = await prisma.familyMember.findUnique({
    where: { familyId_lineUserId: { familyId: family.id, lineUserId: params.lineUserId } },
  });
  if (existing) return { error: 'already_joined' };

  const member = await prisma.familyMember.create({
    data: {
      familyId: family.id,
      lineUserId: params.lineUserId,
      displayName: params.displayName,
      avatarUrl: params.avatarUrl,
      role: 'MEMBER',
    },
  });

  return { family, member };
}

export async function findMemberByLineId(lineUserId: string): Promise<(FamilyMember & { family: Family }) | null> {
  return prisma.familyMember.findFirst({
    where: { lineUserId },
    include: { family: true },
    orderBy: { joinedAt: 'desc' },
  });
}
