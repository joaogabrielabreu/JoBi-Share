// Predefinições de qualidade e aplicação no encoder (sem renegociar).
import { store } from './util.js';

export const RESOLUTIONS = [
  { id: '720', label: '720p', height: 720 },
  { id: '1080', label: '1080p', height: 1080 },
  { id: '1440', label: '1440p', height: 1440 },
  { id: 'source', label: 'Nativa', height: null },
];

export const FRAMERATES = [15, 30, 60];

export const MODES = [
  { id: 'motion', label: 'Movimento', hint: 'Jogos e vídeos: prioriza a fluidez' },
  { id: 'detail', label: 'Nitidez', hint: 'Texto e código: prioriza a definição' },
];

const CODEC_NAMES = { 'video/AV1': 'AV1', 'video/VP9': 'VP9', 'video/H264': 'H.264', 'video/VP8': 'VP8' };

export const DEFAULT_QUALITY = { res: '1080', fps: 30, mode: 'motion', codec: 'auto' };

export function loadQuality() {
  const saved = store.get('jobi-share.quality', {});
  const q = { ...DEFAULT_QUALITY, ...saved };
  if (!RESOLUTIONS.some((r) => r.id === q.res)) q.res = DEFAULT_QUALITY.res;
  if (!FRAMERATES.includes(q.fps)) q.fps = DEFAULT_QUALITY.fps;
  if (!MODES.some((m) => m.id === q.mode)) q.mode = DEFAULT_QUALITY.mode;
  return q;
}

export const saveQuality = (q) => store.set('jobi-share.quality', q);

// Dimensões finais e fator de escala a partir do tamanho real da captura.
export function target(q, srcW, srcH) {
  const res = RESOLUTIONS.find((r) => r.id === q.res) || RESOLUTIONS[1];
  const w0 = srcW || 1920;
  const h0 = srcH || 1080;
  // A "altura" do preset vale para o menor lado (telas em pé também funcionam).
  const short = Math.min(w0, h0);
  const scale = res.height && short > res.height ? short / res.height : 1;
  return { scale, width: Math.round(w0 / scale), height: Math.round(h0 / scale) };
}

// Bits por pixel por quadro — conteúdo de tela comprime bem, mas texto
// em movimento precisa de folga. 1080p30 ≈ 4,4 Mbps, 1080p60 ≈ 7,6 Mbps.
export function bitrateFor(width, height, fps, mode) {
  const bpp = mode === 'detail' ? 0.09 : 0.07;
  const effectiveFps = fps <= 30 ? fps : 30 + (fps - 30) * 0.75;
  const bps = width * height * effectiveFps * bpp;
  return Math.round(Math.min(25_000_000, Math.max(600_000, bps)));
}

export function describe(q, srcW, srcH) {
  const t = target(q, srcW, srcH);
  const shortSide = Math.min(t.width, t.height);
  return {
    ...t,
    fps: q.fps,
    bitrate: bitrateFor(t.width, t.height, q.fps, q.mode),
    label: `${shortSide}p${q.fps}`,
  };
}

export function applyTrackHints(track, q) {
  if (!track) return;
  try {
    track.contentHint = q.mode === 'detail' ? 'detail' : 'motion';
  } catch {}
  track.applyConstraints({ frameRate: { ideal: q.fps, max: q.fps } }).catch(() => {});
}

export async function applyToSender(sender, q, srcW, srcH) {
  if (!sender) return;
  const d = describe(q, srcW, srcH);
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  const e = params.encodings[0];
  e.maxBitrate = d.bitrate;
  e.maxFramerate = q.fps;
  e.scaleResolutionDownBy = d.scale;
  e.priority = 'high';
  e.networkPriority = 'high';
  params.degradationPreference = q.mode === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
  try {
    await sender.setParameters(params);
  } catch {
    // Alguns navegadores não aceitam degradationPreference; tenta sem.
    delete params.degradationPreference;
    await sender.setParameters(params).catch((err) => console.warn('setParameters', err));
  }
}

// O estimador de banda do WebRTC começa em ~300 kbps. Como o vídeo só é
// liberado após a verificação, o encoder partiria de 270p e demoraria a subir.
// Aqui o anfitrião informa uma taxa inicial realista nos parâmetros de codec
// da oferta (só linhas a=fmtp de vídeo; impressões digitais não são tocadas).
export function withStartBitrate(sdp, kbps) {
  const lines = sdp.split(/\r\n/);
  const videoPts = new Set();
  const withFmtp = new Set();
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    else if (inVideo) {
      const rtp = /^a=rtpmap:(\d+) ([\w-]+)\//.exec(l);
      if (rtp && !/^(rtx|red|ulpfec|flexfec-03)$/i.test(rtp[2])) videoPts.add(rtp[1]);
      const fmtp = /^a=fmtp:(\d+) /.exec(l);
      if (fmtp) withFmtp.add(fmtp[1]);
    }
  }
  const param = `x-google-start-bitrate=${Math.round(kbps)}`;
  const out = [];
  inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const fmtp = inVideo && /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (fmtp && videoPts.has(fmtp[1]) && !fmtp[2].includes('x-google-start-bitrate')) {
      out.push(`${l};${param}`);
      continue;
    }
    out.push(l);
    const rtp = inVideo && /^a=rtpmap:(\d+) /.exec(l);
    if (rtp && videoPts.has(rtp[1]) && !withFmtp.has(rtp[1])) out.push(`a=fmtp:${rtp[1]} ${param}`);
  }
  return out.join('\r\n');
}

export function startBitrateKbps(q, srcW, srcH) {
  return Math.min(3500, Math.max(800, (describe(q, srcW, srcH).bitrate * 0.75) / 1000));
}

export function availableCodecs() {
  const caps = RTCRtpSender.getCapabilities?.('video');
  if (!caps) return [];
  const seen = new Set();
  for (const c of caps.codecs) if (CODEC_NAMES[c.mimeType]) seen.add(c.mimeType);
  return ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8']
    .filter((m) => seen.has(m))
    .map((m) => ({ id: m, label: CODEC_NAMES[m] }));
}

export const codecLabel = (mime) => CODEC_NAMES[mime] || mime?.replace('video/', '') || '—';

export function preferCodec(transceiver, mime) {
  if (!mime || mime === 'auto' || !transceiver.setCodecPreferences) return;
  const caps = RTCRtpReceiver.getCapabilities?.('video') || RTCRtpSender.getCapabilities?.('video');
  if (!caps) return;
  const match = (c) => c.mimeType.toLowerCase() === mime.toLowerCase();
  const first = caps.codecs.filter(match);
  if (!first.length) return;
  try {
    transceiver.setCodecPreferences([...first, ...caps.codecs.filter((c) => !match(c))]);
  } catch (err) {
    console.warn('setCodecPreferences', err);
  }
}
