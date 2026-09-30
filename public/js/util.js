export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const icon = (name, cls = '') =>
  `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
export const formatCode = (c) => (c && c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c || '');

export function bindCodeInput(input) {
  input.addEventListener('input', () => {
    const c = normalizeCode(input.value);
    input.value = formatCode(c);
  });
}

const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export function fmtBitrate(bps) {
  if (bps == null || !isFinite(bps)) return '—';
  if (bps >= 1_000_000) return `${nf1.format(bps / 1_000_000)} Mbps`;
  return `${nf0.format(bps / 1000)} kbps`;
}
export const fmtMs = (sec) => (sec == null || !isFinite(sec) ? '—' : `${nf0.format(sec * 1000)} ms`);
export const fmtPct = (x) => (x == null || !isFinite(x) ? '—' : `${nf1.format(x * 100)}%`);
export const fmtInt = (n) => (n == null || !isFinite(n) ? '—' : nf0.format(n));
export const fmtFps = (f) => (f == null || !isFinite(f) ? '—' : `${nf0.format(f)} fps`);

export function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }
}

export function toast(message, { kind = 'info', timeout = 4200 } = {}) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const ic = { success: 'check', danger: 'shield-alert', warn: 'alert', info: 'info' }[kind] || 'info';
  el.innerHTML = `${icon(ic)}<span>${escapeHtml(message)}</span>`;
  host.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const close = () => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  };
  el.addEventListener('click', close);
  if (timeout) setTimeout(close, timeout);
  return close;
}

export const initials = (name) =>
  String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase() || '?';

export const isTouch = () => matchMedia('(pointer: coarse)').matches;
