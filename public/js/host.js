// Lado de quem transmite.
import {
  $, $$, icon, escapeHtml, toast, copyText, formatCode, fmtBitrate, fmtMs, fmtPct,
  fmtClock, initials, store,
} from './util.js';
import { Signaling } from './signaling.js';
import { generateCert, certFingerprint, parseFingerprint, commitFor, sasFor } from './crypto.js';
import * as Q from './quality.js';
import { readSenderStats } from './stats.js';
import { getConfig } from './config.js';

const SERVER_ERRORS = { SERVER_FULL: 'O servidor está cheio. Tente novamente em instantes.' };
const LIMIT_REASONS = { cpu: 'limitado pela CPU', bandwidth: 'limitado pela rede', other: 'limitado' };
const SURFACES = { monitor: 'Tela inteira', window: 'Janela', browser: 'Aba' };

class SecurityError extends Error {}

export class HostSession {
  constructor({ config, name, onExit }) {
    this.config = config;
    this.name = name || 'Anfitrião';
    this.onExit = onExit;
    this.quality = Q.loadQuality();
    this.wantAudio = store.get('janela.audio', true);
    this.requireVerify = store.get('janela.requireVerify', true);
    this.sig = null;
    this.room = null;
    this.peers = new Map();
    this.requests = new Map();
    this.stream = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.paused = false;
    this.sourceLost = false;
    this.ended = false;
    this.linkKind = null;
    this.qrVisible = false;
    this.ac = new AbortController();
  }

  // ------------------------------------------------------------------ UI --

  enter() {
    const q = (id) => document.getElementById(id);
    this.el = {
      live: q('host-live'), timer: q('host-timer'), liveText: q('host-live-text'),
      switchBtn: q('host-switch'), pauseBtn: q('host-pause'), endBtn: q('host-end'),
      preview: q('host-preview'), empty: q('host-empty'), captureBtn: q('host-capture'),
      badges: q('host-badges'), overlay: q('host-overlay'), overlayTitle: q('host-overlay-title'),
      overlayText: q('host-overlay-text'), overlayBtn: q('host-overlay-btn'),
      invite: q('invite-card'), roomCode: q('room-code'), linkTabs: q('link-tabs'), link: q('invite-link'),
      copyLink: q('copy-link'), linkHint: q('link-hint'), qrBtn: q('qr-toggle'), qr: q('invite-qr'),
      segRes: q('seg-res'), segFps: q('seg-fps'), segMode: q('seg-mode'), modeHint: q('q-mode-hint'),
      estimate: q('q-estimate'), codec: q('sel-codec'), optAudio: q('opt-audio'), optVerify: q('opt-verify'),
      requests: q('requests'), viewerList: q('viewer-list'), viewerCount: q('viewer-count'), viewersEmpty: q('viewers-empty'),
    };
    const e = this.el;
    e.invite.hidden = true;
    e.live.hidden = true;
    e.requests.innerHTML = '';
    e.viewerList.innerHTML = '';
    e.preview.srcObject = null;
    e.optAudio.checked = this.wantAudio;
    e.optVerify.checked = this.requireVerify;
    e.codec.innerHTML = [{ id: 'auto', label: 'Automático' }, ...Q.availableCodecs()]
      .map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`)
      .join('');
    if (![...e.codec.options].some((o) => o.value === this.quality.codec)) this.quality.codec = 'auto';
    e.codec.value = this.quality.codec;

    const on = (el, type, fn) => el.addEventListener(type, fn, { signal: this.ac.signal });
    on(e.captureBtn, 'click', () => this.capture());
    on(e.switchBtn, 'click', () => this.capture());
    on(e.overlayBtn, 'click', () => (this.sourceLost ? this.capture() : this.togglePause()));
    on(e.pauseBtn, 'click', () => this.togglePause());
    on(e.endBtn, 'click', () => this.confirmEnd());
    on(e.segRes, 'click', (ev) => this.pick(ev, (v) => ({ res: v })));
    on(e.segFps, 'click', (ev) => this.pick(ev, (v) => ({ fps: Number(v) })));
    on(e.segMode, 'click', (ev) => this.pick(ev, (v) => ({ mode: v })));
    on(e.codec, 'change', () => this.setQuality({ codec: e.codec.value }));
    on(e.optAudio, 'change', () => this.setAudio(e.optAudio.checked));
    on(e.optVerify, 'change', () => this.setRequireVerify(e.optVerify.checked));
    on(e.copyLink, 'click', () => this.copy(e.link.value, 'Link copiado'));
    on(e.roomCode, 'click', () => this.room && this.copy(this.room.code, 'Código copiado'));
    on(e.qrBtn, 'click', () => {
      this.qrVisible = !this.qrVisible;
      this.renderInvite();
    });
    on(e.linkTabs, 'click', (ev) => {
      const b = ev.target.closest('button[data-kind]');
      if (b) {
        this.linkKind = b.dataset.kind;
        this.renderInvite();
      }
    });
    on(e.requests, 'click', (ev) => {
      const b = ev.target.closest('button[data-action]');
      const id = b?.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (b.dataset.action === 'accept') this.approve(id);
      else this.deny(id);
    });
    on(e.viewerList, 'click', (ev) => {
      const b = ev.target.closest('button[data-action]');
      const ctx = this.peers.get(b?.closest('[data-id]')?.dataset.id);
      if (!ctx) return;
      if (b.dataset.action === 'sas-yes') this.confirmSas(ctx);
      else if (b.dataset.action === 'sas-no') this.rejectSas(ctx);
      else if (b.dataset.action === 'kick') this.removePeer(ctx.id, { kick: true, bye: 'removed', reason: `${ctx.name} foi removido(a).` });
    });
    on(window, 'beforeunload', (ev) => {
      if (this.room && !this.ended) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    });

    this.renderQuality();
    this.renderStage();
    this.renderPeersMeta();
  }

  pick(ev, patch) {
    const b = ev.target.closest('button[data-v]');
    if (b) this.setQuality(patch(b.dataset.v));
  }

  renderQuality() {
    const e = this.el;
    const seg = (items, current) =>
      items
        .map((it) => `<button type="button" role="radio" aria-checked="${String(it.id) === String(current)}" data-v="${it.id}" title="${escapeHtml(it.hint || '')}">${escapeHtml(it.label)}</button>`)
        .join('');
    e.segRes.innerHTML = seg(Q.RESOLUTIONS, this.quality.res);
    e.segFps.innerHTML = seg(Q.FRAMERATES.map((f) => ({ id: f, label: `${f} fps` })), this.quality.fps);
    e.segMode.innerHTML = seg(Q.MODES, this.quality.mode);
    e.modeHint.textContent = Q.MODES.find((m) => m.id === this.quality.mode)?.hint || '';
    const d = this.describe();
    e.estimate.textContent = `≈ ${fmtBitrate(d.bitrate)}`;
    e.estimate.title = `${d.width}×${d.height} a ${d.fps} fps — taxa máxima por espectador`;
  }

  renderStage() {
    const e = this.el;
    const has = !!this.stream;
    e.empty.hidden = has;
    e.preview.hidden = !has;
    e.switchBtn.hidden = !has;
    e.pauseBtn.hidden = !has || this.sourceLost;
    e.pauseBtn.innerHTML = this.paused ? `${icon('play')}<span>Retomar</span>` : `${icon('pause')}<span>Pausar</span>`;
    e.pauseBtn.classList.toggle('on', this.paused);
    e.endBtn.className = this.room ? 'btn danger' : 'btn ghost';
    e.endBtn.innerHTML = this.room ? `${icon('stop')}<span>Encerrar</span>` : `${icon('arrow-left')}<span>Voltar</span>`;
    const overlay = has && (this.sourceLost || this.paused);
    e.overlay.hidden = !overlay;
    if (this.sourceLost) {
      e.overlayTitle.textContent = 'Compartilhamento interrompido';
      e.overlayText.textContent = 'A captura foi encerrada. Os espectadores continuam conectados aguardando.';
      e.overlayBtn.innerHTML = `${icon('monitor')}<span>Escolher tela</span>`;
    } else if (this.paused) {
      e.overlayTitle.textContent = 'Transmissão pausada';
      e.overlayText.textContent = 'Nada está sendo enviado. Os espectadores veem um aviso de pausa.';
      e.overlayBtn.innerHTML = `${icon('play')}<span>Retomar</span>`;
    }
    this.renderBadges();
  }

  renderBadges() {
    const e = this.el;
    if (!this.videoTrack) {
      e.badges.hidden = true;
      return;
    }
    const s = this.videoTrack.getSettings();
    const d = this.describe();
    const surface = SURFACES[s.displaySurface] || 'Captura';
    e.badges.hidden = false;
    e.badges.innerHTML = [
      `<span class="badge-pill">${escapeHtml(surface)} · ${s.width || '?'}×${s.height || '?'}</span>`,
      `<span class="badge-pill accent">Enviando ${escapeHtml(d.label)} · ${escapeHtml(fmtBitrate(d.bitrate))}</span>`,
      this.audioTrack ? `<span class="badge-pill">${icon('volume')}Áudio</span>` : '',
    ].join('');
  }

  renderInvite() {
    const e = this.el;
    if (!this.room) return;
    e.invite.hidden = false;
    e.roomCode.textContent = formatCode(this.room.code);

    const cfg = this.config;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const kinds = [];
    if (cfg.publicUrl || cfg.tunnel === 'starting') kinds.push({ id: 'public', label: 'Internet', base: cfg.publicUrl });
    if (!local && location.origin !== cfg.publicUrl) kinds.push({ id: 'here', label: 'Este endereço', base: location.origin });
    if (cfg.lanUrl && !cfg.lanUrl.includes('127.0.0.1') && cfg.lanUrl !== location.origin) {
      kinds.push({ id: 'lan', label: 'Mesma rede', base: cfg.lanUrl });
    }
    if (!kinds.length) kinds.push({ id: 'here', label: 'Link', base: location.origin });
    if (!kinds.some((k) => k.id === this.linkKind)) this.linkKind = kinds[0].id;
    const kind = kinds.find((k) => k.id === this.linkKind);

    e.linkTabs.hidden = kinds.length < 2;
    e.linkTabs.innerHTML = kinds
      .map((k) => `<button type="button" role="tab" data-kind="${k.id}" aria-selected="${k.id === kind.id}">${escapeHtml(k.label)}</button>`)
      .join('');

    const link = kind.base ? `${kind.base}/?s=${this.room.code}` : '';
    e.link.value = link || 'Gerando link público…';
    e.copyLink.disabled = !link;
    e.qrBtn.disabled = !link;
    let hint = '';
    if (kind.id === 'public') {
      hint = link
        ? 'Funciona de qualquer lugar. O vídeo continua indo direto entre vocês, sem passar pelo servidor.'
        : 'Criando um link seguro (https) para a internet… leva alguns segundos.';
    } else if (kind.id === 'lan') {
      hint = 'Para celulares e PCs conectados na mesma rede Wi-Fi/cabo que este computador.';
      if (cfg.tunnel === 'off') hint += ' Para quem está longe, inicie pelo "Iniciar.bat" (link de internet).';
    }
    e.linkHint.textContent = hint;
    e.linkHint.hidden = !hint;

    const showQr = this.qrVisible && !!link;
    e.qrBtn.setAttribute('aria-pressed', String(showQr));
    e.qr.hidden = !showQr;
    const qrSrc = link ? `/api/qr?text=${encodeURIComponent(link)}` : '';
    if (showQr && e.qr.dataset.src !== qrSrc) {
      e.qr.dataset.src = qrSrc;
      e.qr.src = qrSrc;
    }

    if (cfg.tunnel === 'starting' && !this.polling) this.pollTunnel();
  }

  async pollTunnel() {
    this.polling = true;
    for (let i = 0; i < 60 && !this.ended; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      this.config = await getConfig(true);
      if (this.config.tunnel !== 'starting') break;
    }
    this.polling = false;
    if (!this.ended) {
      if (this.config.publicUrl) toast('Link de internet pronto.', { kind: 'success' });
      else if (this.config.tunnel === 'error') toast('Não foi possível criar o link de internet. Use o link da rede local.', { kind: 'warn' });
      this.renderInvite();
    }
  }

  async copy(text, message) {
    if (!text) return;
    if (await copyText(text)) toast(message, { kind: 'success', timeout: 2000 });
  }

  // ------------------------------------------------------- qualidade/áudio --

  srcSize() {
    const s = this.videoTrack?.getSettings?.() || {};
    return [s.width, s.height];
  }

  describe() {
    return Q.describe(this.quality, ...this.srcSize());
  }

  setQuality(patch) {
    const codecChanged = 'codec' in patch && patch.codec !== this.quality.codec;
    this.quality = { ...this.quality, ...patch };
    Q.saveQuality(this.quality);
    this.renderQuality();
    if (this.videoTrack) Q.applyTrackHints(this.videoTrack, this.quality);
    this.applyAll();
    this.broadcastState();
    this.renderBadges();
    if (codecChanged && this.peers.size) toast('O novo codec vale para quem entrar a partir de agora.');
  }

  applySender(ctx) {
    if (ctx.videoSender) Q.applyToSender(ctx.videoSender, this.quality, ...this.srcSize()).catch(() => {});
  }

  applyAll() {
    for (const ctx of this.peers.values()) this.applySender(ctx);
  }

  setAudio(on) {
    this.wantAudio = on;
    store.set('janela.audio', on);
    if (this.audioTrack) {
      this.audioTrack.enabled = on;
      toast(on ? 'Áudio do sistema ativado.' : 'Áudio do sistema silenciado.', { timeout: 2200 });
    } else if (on && this.stream) {
      toast('Para enviar áudio, clique em "Trocar tela" e marque "Compartilhar áudio" na janela de seleção.', { kind: 'info', timeout: 6500 });
    }
    this.broadcastState();
  }

  setRequireVerify(on) {
    this.requireVerify = on;
    store.set('janela.requireVerify', on);
    if (!on) {
      for (const ctx of this.peers.values()) {
        if (!ctx.released) {
          ctx.released = true;
          this.attachTracks(ctx);
          this.applySender(ctx);
          this.sendState(ctx);
          this.renderPeer(ctx);
        }
      }
    } else if (this.peers.size) {
      toast('A exigência de verificação vale para quem entrar a partir de agora.');
    }
  }

  // --------------------------------------------------------------- captura --

  async capture() {
    if (this.capturing || this.ended) return false;
    this.capturing = true;
    try {
      const q = this.quality;
      const audio = this.wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false;
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: q.fps, max: q.fps } },
          audio,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          systemAudio: this.wantAudio ? 'include' : 'exclude',
        });
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'AbortError') return false;
        if (!['TypeError', 'OverconstrainedError', 'NotSupportedError'].includes(err.name)) throw err;
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: this.wantAudio });
      }
      this.useStream(stream);
      if (!this.room) await this.openRoom();
      return true;
    } catch (err) {
      console.error(err);
      toast(`Não foi possível iniciar: ${err.message || err.name}`, { kind: 'danger', timeout: 7000 });
      return false;
    } finally {
      this.capturing = false;
    }
  }

  useStream(stream) {
    const old = this.stream;
    this.stream = stream;
    this.videoTrack = stream.getVideoTracks()[0] || null;
    this.audioTrack = stream.getAudioTracks()[0] || null;
    Q.applyTrackHints(this.videoTrack, this.quality);
    this.videoTrack?.addEventListener('ended', () => this.onSourceEnded(stream));
    this.audioTrack?.addEventListener('ended', () => {
      if (this.stream !== stream) return;
      this.audioTrack = null;
      this.attachAll();
      this.renderBadges();
    });
    if (this.audioTrack) this.audioTrack.enabled = this.wantAudio;
    if (old && old !== stream) old.getTracks().forEach((t) => t.stop());
    this.el.preview.srcObject = stream;
    this.el.preview.play().catch(() => {});
    this.sourceLost = false;
    if (this.wantAudio && !this.audioTrack) {
      toast('Transmitindo sem áudio. Para enviar som, marque "Compartilhar áudio" na janela de seleção (tela inteira ou aba, no Chrome/Edge).', { kind: 'warn', timeout: 8000 });
    }
    [this.lastW, this.lastH] = this.srcSize();
    this.attachAll();
    this.applyAll();
    this.broadcastState();
    this.renderStage();
    this.renderQuality();
  }

  onSourceEnded(stream) {
    if (this.stream !== stream || this.ended) return;
    this.videoTrack = null;
    this.sourceLost = true;
    this.attachAll();
    this.broadcastState();
    this.renderStage();
    toast('O compartilhamento foi interrompido. Escolha uma tela para continuar.', { kind: 'warn' });
  }

  togglePause() {
    if (!this.stream || this.sourceLost) return;
    this.paused = !this.paused;
    this.attachAll();
    this.broadcastState();
    this.renderStage();
    for (const ctx of this.peers.values()) this.renderPeer(ctx);
  }

  attachTracks(ctx) {
    const live = ctx.released && !this.paused;
    const v = live ? this.videoTrack : null;
    const a = live ? this.audioTrack : null;
    if (ctx.videoSender && ctx.videoSender.track !== v) ctx.videoSender.replaceTrack(v).catch((err) => console.warn(err));
    if (ctx.audioSender && ctx.audioSender.track !== a) ctx.audioSender.replaceTrack(a).catch((err) => console.warn(err));
  }

  attachAll() {
    for (const ctx of this.peers.values()) this.attachTracks(ctx);
  }

  // ------------------------------------------------------------------ sala --

  openRoom() {
    this.sig = new Signaling({ autoReconnect: true });
    const created = new Promise((resolve, reject) => {
      this.resolveCreated = resolve;
      setTimeout(() => reject(new Error('o servidor não respondeu')), 10_000);
    });
    this.sig
      .on('created', (m) => this.onCreated(m))
      .on('resumed', () => this.setServerOnline(true))
      .on('resume-failed', () => this.onResumeFailed())
      .on('join-request', (m) => this.onJoinRequest(m))
      .on('peer-left', (m) => this.onPeerLeft(m))
      .on('signal', (m) => this.onSignal(m))
      .on('error', (m) => toast(SERVER_ERRORS[m.code] || 'Erro no servidor.', { kind: 'danger' }))
      .on('disconnect', () => this.setServerOnline(false))
      .on('open', ({ reconnect }) => {
        if (reconnect && this.room) this.sig.send({ type: 'resume', code: this.room.code, secret: this.room.secret });
      });
    return this.sig.connect().then(() => {
      this.sig.send({ type: 'create', name: this.name });
      return created;
    });
  }

  onCreated({ code, secret }) {
    this.room = { code, secret };
    this.startedAt ||= Date.now();
    this.el.live.hidden = false;
    this.setServerOnline(true);
    this.renderInvite();
    this.renderStage();
    if (!this.interval) this.interval = setInterval(() => this.tick(), 1000);
    this.tick();
    this.resolveCreated?.();
  }

  onResumeFailed() {
    this.room = null;
    this.sig.send({ type: 'create', name: this.name });
    toast('A sala anterior expirou e um novo código foi gerado. Quem já está assistindo continua conectado.', { kind: 'warn', timeout: 8000 });
  }

  setServerOnline(online) {
    this.el.live.classList.toggle('offline', !online);
    this.el.liveText.textContent = online ? 'AO VIVO' : 'RECONECTANDO';
  }

  confirmEnd() {
    if (this.room && this.peers.size && !window.confirm('Encerrar a transmissão para todos?')) return;
    this.end();
  }

  destroy() {
    this.end();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const id of [...this.peers.keys()]) this.removePeer(id, { bye: 'ended' });
    const sig = this.sig;
    sig?.send({ type: 'close' });
    setTimeout(() => sig?.close(), 300);
    this.stream?.getTracks().forEach((t) => t.stop());
    clearInterval(this.interval);
    this.ac.abort();
    this.el.preview.srcObject = null;
    document.title = 'Janela';
    this.onExit();
  }

  // ----------------------------------------------------- pedidos de entrada --

  onJoinRequest({ peerId, name }) {
    if (!peerId || this.peers.has(peerId) || this.requests.has(peerId)) return;
    const el = document.createElement('div');
    el.className = 'request';
    el.dataset.id = peerId;
    el.innerHTML = `
      <div class="avatar">${escapeHtml(initials(name))}</div>
      <div class="req-main"><b>${escapeHtml(name)}</b><span>quer assistir</span></div>
      <div class="req-actions">
        <button class="btn sm ghost" data-action="deny">Recusar</button>
        <button class="btn sm primary" data-action="accept">Aceitar</button>
      </div>`;
    this.el.requests.append(el);
    this.requests.set(peerId, { id: peerId, name, el });
    toast(`${name} quer assistir à sua tela.`);
    this.renderPeersMeta();
  }

  removeRequest(id) {
    const req = this.requests.get(id);
    if (!req) return null;
    req.el.remove();
    this.requests.delete(id);
    this.renderPeersMeta();
    return req;
  }

  deny(id) {
    if (this.removeRequest(id)) this.sig.send({ type: 'reject', peerId: id });
  }

  async approve(id) {
    const req = this.removeRequest(id);
    if (!req) return;
    const ctx = {
      id, name: req.name, state: 'new', pc: null, dc: null, pendingIce: [], chain: Promise.resolve(),
      sas: null, hostOk: false, viewerOk: false, released: !this.requireVerify, prev: null, stats: null, rx: null,
    };
    this.peers.set(id, ctx);
    this.renderPeer(ctx);
    this.sig.send({ type: 'approve', peerId: id });
    try {
      // Certificado DTLS novo para cada espectador: o compromisso só vale uma vez.
      ctx.cert = await generateCert();
      if (!ctx.cert) throw new Error('navegador sem suporte a certificados WebRTC');
      ctx.fp = await certFingerprint(ctx.cert);
      const commit = await commitFor(ctx.fp);
      if (this.peers.get(id) !== ctx) return;
      this.sig.send({
        type: 'signal', to: id,
        data: { kind: 'hello', v: 1, commit, hostName: this.name, codec: this.quality.codec, requireVerify: this.requireVerify },
      });
      ctx.state = 'negotiating';
      this.renderPeer(ctx);
    } catch (err) {
      console.error(err);
      toast(`Falha ao preparar a conexão: ${err.message}`, { kind: 'danger' });
      this.removePeer(id, { kick: true });
    }
  }

  onPeerLeft({ peerId }) {
    if (this.removeRequest(peerId)) return;
    const ctx = this.peers.get(peerId);
    if (!ctx) return;
    // A conexão P2P não depende do servidor: se já está de pé, continua.
    if (ctx.pc?.connectionState === 'connected') ctx.sigGone = true;
    else this.removePeer(peerId, { reason: `${ctx.name} saiu.` });
  }

  // ------------------------------------------------------------ WebRTC --

  onSignal({ from, data }) {
    const ctx = this.peers.get(from);
    if (!ctx || !data) return;
    if (data.kind === 'offer') {
      ctx.chain = ctx.chain
        .then(() => this.handleOffer(ctx, data.sdp))
        .catch((err) => {
          console.error(err);
          if (err instanceof SecurityError) this.securityFail(ctx, err.message);
          else {
            toast(`Falha ao conectar com ${ctx.name}: ${err.message}`, { kind: 'danger' });
            this.removePeer(ctx.id, { kick: true, bye: 'error' });
          }
        });
    } else if (data.kind === 'ice' && data.candidate) {
      if (ctx.pc?.remoteDescription) ctx.pc.addIceCandidate(data.candidate).catch(() => {});
      else ctx.pendingIce.push(data.candidate);
    }
  }

  async handleOffer(ctx, sdp) {
    if (this.peers.get(ctx.id) !== ctx || !ctx.cert) return;
    let remoteFp;
    try {
      remoteFp = parseFingerprint(sdp);
    } catch (err) {
      throw new SecurityError(`Oferta de ${ctx.name} rejeitada: ${err.message}.`);
    }
    if (ctx.remoteFp && ctx.remoteFp !== remoteFp) {
      throw new SecurityError(`A chave de ${ctx.name} mudou no meio da sessão. Conexão encerrada.`);
    }
    if (!ctx.pc) this.createPc(ctx);
    const pc = ctx.pc;
    const startKbps = Q.startBitrateKbps(this.quality, ...this.srcSize());
    await pc.setRemoteDescription({ type: 'offer', sdp: Q.withStartBitrate(sdp, startKbps) });
    if (!ctx.configured) {
      for (const t of pc.getTransceivers()) {
        const kind = t.receiver.track.kind;
        t.direction = 'sendonly';
        if (kind === 'video') {
          ctx.videoSender = t.sender;
          Q.preferCodec(t, this.quality.codec);
        } else if (kind === 'audio') {
          ctx.audioSender = t.sender;
        }
      }
      ctx.configured = true;
      this.attachTracks(ctx);
    }
    await pc.setLocalDescription(await pc.createAnswer());
    if (parseFingerprint(pc.localDescription.sdp) !== ctx.fp) {
      throw new SecurityError('O navegador não usou o certificado esperado.');
    }
    this.sig.send({ type: 'signal', to: ctx.id, data: { kind: 'answer', sdp: pc.localDescription.sdp } });
    for (const c of ctx.pendingIce.splice(0)) pc.addIceCandidate(c).catch(() => {});
    if (!ctx.remoteFp) {
      ctx.remoteFp = remoteFp;
      ctx.sas = await sasFor(remoteFp, ctx.fp);
    }
    this.applySender(ctx);
    this.renderPeer(ctx);
  }

  createPc(ctx) {
    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers,
      certificates: [ctx.cert],
      bundlePolicy: 'max-bundle',
    });
    pc.onicecandidate = (e) => {
      if (e.candidate) this.sig.send({ type: 'signal', to: ctx.id, data: { kind: 'ice', candidate: e.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => this.onPcState(ctx);
    pc.ondatachannel = (e) => this.setupDc(ctx, e.channel);
    ctx.pc = pc;
  }

  onPcState(ctx) {
    if (this.peers.get(ctx.id) !== ctx) return;
    const s = ctx.pc.connectionState;
    ctx.state = s;
    clearTimeout(ctx.failTimer);
    if (s === 'failed' || s === 'disconnected') {
      // O espectador tenta reiniciar o ICE; se não voltar, remove.
      ctx.failTimer = setTimeout(() => {
        if (this.peers.get(ctx.id) === ctx && ctx.pc.connectionState !== 'connected') {
          this.removePeer(ctx.id, { kick: true, reason: `Conexão com ${ctx.name} perdida.` });
        }
      }, s === 'failed' ? 20_000 : 30_000);
    } else if (s === 'closed') {
      this.removePeer(ctx.id);
    }
    this.renderPeer(ctx);
  }

  setupDc(ctx, dc) {
    if (dc.label !== 'janela') return;
    ctx.dc = dc;
    dc.onopen = () => {
      this.sendState(ctx);
      this.renderPeer(ctx);
    };
    dc.onmessage = (e) => this.onDc(ctx, e.data);
    dc.onclose = () => {
      if (this.peers.get(ctx.id) === ctx) this.removePeer(ctx.id, { kick: true, reason: `${ctx.name} saiu.` });
    };
    if (dc.readyState === 'open') dc.onopen();
  }

  // Mensagens pelo canal de dados — dentro do túnel DTLS, autenticadas
  // ponta a ponta. O servidor não consegue forjar estas confirmações.
  onDc(ctx, raw) {
    if (typeof raw !== 'string' || raw.length > 8192) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'verify') {
      if (m.ok === true && !ctx.viewerOk) {
        ctx.viewerOk = true;
        toast(`${ctx.name} confirmou o código de segurança.`, { kind: 'success' });
      } else if (m.ok === false) {
        this.securityFail(ctx, `${ctx.name} informou que o código NÃO confere. A conexão foi encerrada por segurança.`);
        return;
      }
    } else if (m.t === 'rx') {
      const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
      ctx.rx = { w: num(m.w), h: num(m.h), fps: num(m.fps), bps: num(m.bps), loss: num(m.loss), freezes: num(m.freezes) };
    } else if (m.t === 'bye') {
      this.removePeer(ctx.id, { kick: true, reason: `${ctx.name} saiu.` });
      return;
    }
    this.renderPeer(ctx);
  }

  sendState(ctx) {
    if (ctx.dc?.readyState !== 'open') return;
    ctx.dc.send(JSON.stringify({
      t: 'state',
      released: ctx.released,
      paused: this.paused,
      sourceLost: !this.videoTrack,
      hostOk: ctx.hostOk,
      quality: this.describe().label,
      hasAudio: !!this.audioTrack && this.wantAudio,
      requireVerify: this.requireVerify,
    }));
  }

  broadcastState() {
    for (const ctx of this.peers.values()) this.sendState(ctx);
  }

  confirmSas(ctx) {
    if (!ctx.sas || ctx.hostOk) return;
    ctx.hostOk = true;
    ctx.released = true;
    this.attachTracks(ctx);
    this.applySender(ctx);
    this.sendState(ctx);
    this.renderPeer(ctx);
  }

  rejectSas(ctx) {
    try {
      ctx.dc?.readyState === 'open' && ctx.dc.send(JSON.stringify({ t: 'verify', ok: false }));
    } catch {}
    this.securityFail(ctx, `Código não confere: ${ctx.name} foi desconectado(a) por segurança.`);
  }

  securityFail(ctx, message) {
    toast(message, { kind: 'danger', timeout: 10_000 });
    this.removePeer(ctx.id, { kick: true, bye: 'security' });
  }

  removePeer(id, { kick = false, reason = null, bye = null } = {}) {
    const ctx = this.peers.get(id);
    if (!ctx) return;
    this.peers.delete(id);
    clearTimeout(ctx.failTimer);
    try {
      if (bye && ctx.dc?.readyState === 'open') ctx.dc.send(JSON.stringify({ t: 'bye', reason: bye }));
    } catch {}
    const pc = ctx.pc;
    setTimeout(() => pc?.close(), 250);
    if (kick) this.sig?.send({ type: 'kick', peerId: id });
    ctx.el?.remove();
    if (reason) toast(reason);
    this.renderPeersMeta();
  }

  // ------------------------------------------------------ estatísticas --

  async tick() {
    if (this.ended) return;
    if (this.startedAt) this.el.timer.textContent = fmtClock(Date.now() - this.startedAt);
    const [w, h] = this.srcSize();
    if (w && (w !== this.lastW || h !== this.lastH)) {
      // A janela capturada mudou de tamanho: recalcula a escala.
      this.lastW = w;
      this.lastH = h;
      this.applyAll();
      this.renderQuality();
      this.renderBadges();
    }
    for (const ctx of this.peers.values()) {
      if (!ctx.pc || ctx.pc.connectionState === 'closed') continue;
      try {
        ctx.stats = await readSenderStats(ctx.pc, ctx.prev);
        ctx.prev = ctx.stats;
      } catch {}
      this.renderPeer(ctx);
    }
  }

  renderPeersMeta() {
    const e = this.el;
    e.viewerCount.textContent = String(this.peers.size);
    e.viewersEmpty.hidden = this.peers.size > 0 || this.requests.size > 0;
    document.title = this.requests.size ? `(${this.requests.size}) Janela` : 'Janela';
  }

  renderPeer(ctx) {
    if (this.peers.get(ctx.id) !== ctx) return;
    if (!ctx.el) {
      const li = document.createElement('li');
      li.className = 'peer';
      li.dataset.id = ctx.id;
      li.innerHTML = `
        <div class="peer-top">
          <div class="avatar">${escapeHtml(initials(ctx.name))}</div>
          <div class="peer-main">
            <div class="peer-name"><span class="peer-label">${escapeHtml(ctx.name)}</span><span class="tag" data-f="badge"></span></div>
            <div class="peer-status"><span class="dot" data-f="dot"></span><span data-f="status"></span></div>
          </div>
          <button class="btn icon ghost sm" data-action="kick" title="Remover espectador">${icon('x')}</button>
        </div>
        <div class="peer-verify" data-f="verify">
          <div class="peer-sas"><span>Código de segurança</span><strong class="sas sm" data-f="sas"></strong></div>
          <p class="peer-hint" data-f="hint"></p>
          <div class="peer-actions" data-f="actions">
            <button class="btn sm danger-ghost" data-action="sas-no">Não confere</button>
            <button class="btn sm success" data-action="sas-yes">${icon('check')}<span>Confere</span></button>
          </div>
        </div>
        <div class="peer-stats" data-f="stats"></div>`;
      ctx.el = li;
      ctx.f = Object.fromEntries($$('[data-f]', li).map((n) => [n.dataset.f, n]));
      this.el.viewerList.append(li);
      this.renderPeersMeta();
    }
    const f = ctx.f;
    const s = ctx.stats || {};
    const verified = ctx.hostOk && ctx.viewerOk;

    const states = {
      new: ['Preparando chaves…', 'wait'],
      negotiating: ['Estabelecendo conexão segura…', 'wait'],
      connecting: ['Conectando…', 'wait'],
      connected: [`Conectado · ${s.route || 'P2P'}${s.rtt != null ? ` · ${fmtMs(s.rtt)}` : ''}`, 'ok'],
      disconnected: ['Instável — tentando reconectar…', 'warn'],
      failed: ['Falha na rota — tentando outra…', 'bad'],
    };
    const [label, tone] = states[ctx.state] || [ctx.state, 'wait'];
    f.status.textContent = label;
    f.dot.className = `dot ${tone}`;

    f.badge.textContent = verified ? 'Verificado' : ctx.sas ? 'Não verificado' : '';
    f.badge.className = `tag ${verified ? 'ok' : 'warn'}`;
    f.badge.hidden = !ctx.sas;

    f.verify.hidden = !ctx.sas || verified;
    f.sas.textContent = ctx.sas || '';
    f.actions.hidden = ctx.hostOk;
    if (!ctx.hostOk) {
      f.hint.textContent =
        `Confirme com ${ctx.name} (ligação ou mensagem): o código na tela da outra pessoa deve ser idêntico.` +
        (ctx.released ? '' : ' A tela só é liberada depois da sua confirmação.');
    } else {
      f.hint.textContent = `Você confirmou. Aguardando ${ctx.name} confirmar também.`;
    }

    let stats = '';
    if (ctx.state === 'connected') {
      if (!ctx.released) stats = 'Tela bloqueada até a verificação do código.';
      else if (this.paused) stats = 'Pausado.';
      else if (this.sourceLost) stats = 'Sem fonte de vídeo.';
      else {
        const parts = [];
        if (s.w) parts.push(`${s.w}×${s.h}`);
        if (s.fps != null) parts.push(`${Math.round(s.fps)} fps`);
        if (s.bps != null) parts.push(fmtBitrate(s.bps));
        if (s.limit && s.limit !== 'none') parts.push(LIMIT_REASONS[s.limit] || s.limit);
        stats = parts.length ? `Enviando ${parts.join(' · ')}` : 'Iniciando envio…';
        if (ctx.rx && ctx.rx.loss != null) stats += ` — recebido com perda de ${fmtPct(ctx.rx.loss)}`;
      }
    }
    f.stats.textContent = stats;
    f.stats.hidden = !stats;
  }
}
