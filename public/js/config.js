let cached = null;

const FALLBACK = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  publicUrl: null,
  lanUrl: null,
  tunnel: 'off',
  maxViewers: 8,
};

export async function getConfig(force = false) {
  if (!cached || force) {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      cached = await res.json();
    } catch {
      cached = cached || FALLBACK;
    }
  }
  return cached;
}
