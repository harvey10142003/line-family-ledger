// 結構守門：/api/liff 的每一支路由（除了 /me）都必須掛在 requireMember 之後，
// 也就是一定先建好 AccessScope 才進路由。之後新增路由若放錯位置，這支會紅。不需要資料庫。
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('/api/liff：auth → /me → requireMember → 其他全部路由', async () => {
  process.env.LINE_LOGIN_CHANNEL_ID ??= '1234567890';
  const { buildLiffRouter } = await import('../src/routes/liff');
  const marker = function fakeAuth(_req: unknown, _res: unknown, next: () => void) {
    next();
  };
  const r = buildLiffRouter(marker as any) as any;
  const stack: any[] = r.stack;

  assert.equal(stack[0].handle, marker, '第一層是 ID token 驗證');
  const guardIdx = stack.findIndex((l) => !l.route && l.name === 'requireMember');
  assert.ok(guardIdx > 0, '有 requireMember');

  const routes = stack.map((l, i) => ({ i, path: l.route?.path as string | undefined })).filter((x) => x.path);
  const before = routes.filter((x) => x.i < guardIdx).map((x) => x.path);
  assert.deepEqual(before, ['/me'], '只有 /me 可以在 requireMember 前面');
  const after = routes.filter((x) => x.i > guardIdx);
  assert.ok(after.length >= 25, `requireMember 後面的路由數 ${after.length}`);
});
