// Leitura das estatísticas WebRTC (qualidade + segurança do canal).

const TLS_NAMES = { FEFD: 'DTLS 1.2', FEFC: 'DTLS 1.3' };
const SRTP_NAMES = {
  AES_CM_128_HMAC_SHA1_80: 'AES-128 + HMAC-SHA1',
  SRTP_AES128_CM_HMAC_SHA1_80: 'AES-128 + HMAC-SHA1',
  AES_CM_128_HMAC_SHA1_32: 'AES-128 + HMAC-SHA1/32',
  SRTP_AES128_CM_HMAC_SHA1_32: 'AES-128 + HMAC-SHA1/32',
  AEAD_AES_128_GCM: 'AES-128-GCM',
  SRTP_AEAD_AES_128_GCM: 'AES-128-GCM',
  AEAD_AES_256_GCM: 'AES-256-GCM',
  SRTP_AEAD_AES_256_GCM: 'AES-256-GCM',
};

function transportOf(report) {
  let best = null;
  report.forEach((s) => {
    if (s.type === 'transport' && (!best || s.dtlsState === 'connected')) best = s;
  });
  return best;
}

function selectedPair(report, transport) {
  let pair = transport?.selectedCandidatePairId ? report.get(transport.selectedCandidatePairId) : null;
  if (!pair) {
    report.forEach((s) => {
      if (!pair && s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s;
    });
  }
  return pair;
}

function common(report) {
  const t = transportOf(report);
  const pair = selectedPair(report, t);
  const out = {};
  if (t) {
    out.dtlsState = t.dtlsState;
    out.tls = TLS_NAMES[String(t.tlsVersion || '').toUpperCase()] || (t.tlsVersion ? `DTLS ${t.tlsVersion}` : null);
    out.dtlsCipher = t.dtlsCipher || null;
    out.srtpCipher = t.srtpCipher || null;
    out.srtpName = SRTP_NAMES[t.srtpCipher] || t.srtpCipher || null;
  }
  if (pair) {
    const local = report.get(pair.localCandidateId);
    const remote = report.get(pair.remoteCandidateId);
    out.relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
    out.route = out.relayed ? 'Relay (TURN)' : 'Direta (P2P)';
    out.rtt = pair.currentRoundTripTime;
    out.availableOut = pair.availableOutgoingBitrate;
    out.protocol = local?.protocol;
  }
  return out;
}

const rate = (cur, prev, key, tsKey = 'statsTs') =>
  prev && cur[key] != null && prev[key] != null && cur[tsKey] > prev[tsKey]
    ? ((cur[key] - prev[key]) * 8) / ((cur[tsKey] - prev[tsKey]) / 1000)
    : null;

export async function readSenderStats(pc, prev) {
  const report = await pc.getStats();
  const out = common(report);
  report.forEach((s) => {
    if (s.type === 'outbound-rtp' && s.kind === 'video') {
      out.statsTs = s.timestamp;
      out.bytes = s.bytesSent;
      out.w = s.frameWidth;
      out.h = s.frameHeight;
      out.fps = s.framesPerSecond;
      out.limit = s.qualityLimitationReason;
      out.encoder = s.encoderImplementation;
      out.codec = report.get(s.codecId)?.mimeType;
      out.nack = s.nackCount;
      out.retransmitted = s.retransmittedPacketsSent;
      out.packets = s.packetsSent;
    }
    if (s.type === 'remote-inbound-rtp' && s.kind === 'video') {
      out.remoteLost = s.packetsLost;
      out.fractionLost = s.fractionLost;
      out.remoteRtt = s.roundTripTime;
    }
  });
  out.bps = rate(out, prev, 'bytes');
  return out;
}

export async function readReceiverStats(pc, prev) {
  const report = await pc.getStats();
  const out = common(report);
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      out.statsTs = s.timestamp;
      out.bytes = s.bytesReceived;
      out.w = s.frameWidth;
      out.h = s.frameHeight;
      out.fps = s.framesPerSecond;
      out.packets = s.packetsReceived;
      out.lost = s.packetsLost;
      out.nack = s.nackCount;
      out.pli = s.pliCount;
      out.freezes = s.freezeCount;
      out.framesDecoded = s.framesDecoded;
      out.framesDropped = s.framesDropped;
      out.jitter = s.jitter;
      out.decoder = s.decoderImplementation;
      out.codec = report.get(s.codecId)?.mimeType;
      if (s.jitterBufferEmittedCount) out.bufferDelay = s.jitterBufferDelay / s.jitterBufferEmittedCount;
    }
    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
      out.audioBytes = s.bytesReceived;
    }
  });
  out.bps = rate(out, prev, 'bytes');
  if (prev && out.packets != null && prev.packets != null) {
    const dRecv = out.packets - prev.packets;
    const dLost = Math.max(0, (out.lost ?? 0) - (prev.lost ?? 0));
    out.windowLoss = dRecv + dLost > 0 ? dLost / (dRecv + dLost) : 0;
  }
  out.totalLoss = out.packets ? (out.lost || 0) / (out.packets + (out.lost || 0)) : 0;
  return out;
}
