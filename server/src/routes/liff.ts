import { Router } from 'express';
import { prisma } from '../prisma';

export const liffRouter = Router();

// 給 LIFF 前端：以 LINE userId 查目前歸屬的家庭與成員資訊
liffRouter.get('/me', async (req, res) => {
  const lineUserId = req.header('x-line-user-id');
  if (!lineUserId) return res.status(400).json({ error: 'missing x-line-user-id' });

  const member = await prisma.familyMember.findFirst({
    where: { lineUserId },
    include: { family: true },
  });

  if (!member) return res.json({ joined: false });

  return res.json({
    joined: true,
    family: { id: member.family.id, name: member.family.name, code: member.family.familyCode },
    member: { id: member.id, role: member.role, displayName: member.displayName },
  });
});
