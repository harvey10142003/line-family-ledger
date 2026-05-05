import liff from '@line/liff';

let initialized = false;

export async function initLiff(): Promise<void> {
  if (initialized) return;
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
  if (!liffId) throw new Error('Missing NEXT_PUBLIC_LIFF_ID');
  await liff.init({ liffId });
  initialized = true;
}

export async function getProfile() {
  if (!liff.isLoggedIn()) {
    liff.login();
    return null;
  }
  return liff.getProfile();
}

export { liff };
