// Verificação de integridade da conexão.
//
// O WebRTC já cifra e autentica cada pacote (DTLS-SRTP), mas a troca inicial
// das chaves passa pelo servidor de sinalização. Para que nem o servidor
// consiga se colocar no meio, os dois lados calculam um código curto (SAS) a
// partir das impressões digitais DTLS realmente usadas na conexão.
//
// Para que um atacante não consiga "fabricar" um código coincidente, o
// anfitrião se compromete com a própria impressão digital (hash) ANTES de o
// espectador revelar a dele. Quando a resposta chega, o espectador confere o
// compromisso. Assim cada tentativa de interceptação tem 1 chance em 1 milhão.

const enc = new TextEncoder();

const COMMIT_TAG = 'jobi-share/commit/v1|';
const SAS_TAG = 'jobi-share/sas/v1|';

export async function sha256(text) {
  const data = enc.encode(text);
  if (globalThis.crypto?.subtle) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  }
  return sha256Fallback(data); // página aberta via http:// na rede local
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function generateCert() {
  if (!RTCPeerConnection.generateCertificate) return null;
  return RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
}

export async function certFingerprint(cert) {
  const fp = cert.getFingerprints?.().find((f) => f.algorithm === 'sha-256');
  if (fp) return fp.value.toUpperCase();
  // Navegadores sem getFingerprints(): lê do SDP gerado com o certificado.
  const pc = new RTCPeerConnection({ certificates: [cert] });
  try {
    pc.createDataChannel('fp');
    const offer = await pc.createOffer();
    return parseFingerprint(offer.sdp);
  } finally {
    pc.close();
  }
}

// Todas as linhas a=fingerprint de um SDP precisam ser idênticas e SHA-256.
// Um SDP com impressões digitais diferentes é tratado como adulterado.
export function parseFingerprint(sdp) {
  if (typeof sdp !== 'string') throw new Error('SDP inválido');
  const lines = sdp.match(/^a=fingerprint:.*$/gim) || [];
  if (!lines.length) throw new Error('SDP sem impressão digital DTLS');
  let value = null;
  for (const line of lines) {
    const m = /^a=fingerprint:(\S+)\s+([0-9A-F:]+)\s*$/i.exec(line.trim());
    if (!m || m[1].toLowerCase() !== 'sha-256') throw new Error('Impressão digital DTLS não suportada');
    const fp = m[2].toUpperCase();
    if (value && value !== fp) throw new Error('SDP com impressões digitais divergentes');
    value = fp;
  }
  return value;
}

export async function commitFor(fingerprint) {
  return toHex(await sha256(COMMIT_TAG + fingerprint));
}

// Código de 6 dígitos, igual nos dois lados apenas se ambos enxergarem as
// mesmas chaves (oferta = espectador, resposta = anfitrião).
export async function sasFor(offerFp, answerFp) {
  const h = await sha256(`${SAS_TAG}${offerFp}|${answerFp}`);
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const digits = String(n % 1_000_000).padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function shortFingerprint(fp) {
  if (!fp) return '—';
  const parts = fp.split(':');
  return `${parts.slice(0, 4).join(':')}…${parts.slice(-2).join(':')}`;
}

// ---- SHA-256 em JavaScript puro (FIPS 180-4) ------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const ror = (x, n) => (x >>> n) | (x << (32 - n));

export function sha256Fallback(msg) {
  const len = msg.length;
  const padded = new Uint8Array((((len + 9 + 63) >> 6) << 6));
  padded.set(msg);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = len * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ror(a, 7) ^ ror(a, 18) ^ (a >>> 3);
      const s1 = ror(b, 17) ^ ror(b, 19) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d;
    H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i]);
  return out;
}
