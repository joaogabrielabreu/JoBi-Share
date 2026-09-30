// Lado de quem assiste (celular ou PC).
import {
  $, icon, escapeHtml, toast, normalizeCode, formatCode, bindCodeInput, fmtBitrate, fmtMs, fmtPct,
  fmtInt, fmtFps, store, isTouch,
} from './util.js';
import { Signaling } from './signaling.js';
import { generateCert, parseFingerprint, commitFor, sasFor, shortFingerprint } from './crypto.js';
import * as Q from './quality.js';
import { readReceiverStats } from './stats.js';

const SERVER_ERRORS = {
  ROOM_NOT_FOUND: ['Sala não encontrada', 'Confira o código. A transmissão pode já ter terminado.'],
  HOST_OFFLINE: ['Anfitrião desconectado', 'Quem transmite perdeu a conexão com o servidor. Tente de novo em instantes.'],
  ROOM_FULL: ['Sala cheia', 'Essa transmissão atingiu o limite de espectadores.'],
};

const BYE_REASONS = {
  ended: ['Transmissão encerrada', 'O anfitrião encerrou a transmissão.', 'info'],
  removed: ['Você foi removido', 'O anfitrião encerrou sua participação.', 'info'],
  security: ['Conexão encerrada por segurança', 'O anfitrião indicou que o código de segurança não confere. Nenhuma imagem a mais foi enviada.', 'danger'],
  error: ['Falha na conexão', 'Não foi possível estabelecer a conexão com o anfitrião.', 'info'],
};

export class ViewerSession {
  constructor({ config, onExit }) {
    this.config = config;
    this.onExit = onExit;
    this.ac = new AbortController();
    this.sig = null;
    this.pc = null;
    this.dc = null;
    this.pendingIce = [];
    this.chain = Promise.resolve();
    this.hostName = 'Anfitrião';
    this.hostState = null;
    this.sas = null;
    this.viewerOk = false;
    this.hostOk = false;
    this.connected = false;
    this.flowing = false;
    this.restarts = 0;
    this.ended = false;
    this.sheetHidden = false;
    this.statsOpen = false;
    this.stats = null;
    this.tickCount = 0;
  }

  // ------------------------------------------------------------------ UI --

  enter({ code = '', name = '', autoJoin = false } = {}) {
    const q = (id) => document.getElementById(id);
    this.el = {
      join: q('viewer-join'), formWrap: q('vj-form-wrap'), form: q('vj-form'), code: q('vj-code'), name: q('vj-name'),
      status: q('vj-status'), statusTitle: q('vj-status-title'), statusText: q('vj-status-text'), cancel: q('vj-cancel'),
      back: q('vj-back'),
      watch: q('viewer-watch'), video: q('viewer-video'), state: q('watch-state'), stateIcon: q('watch-state-icon'),
      stateTitle: q('watch-state-title'), stateText: q('watch-state-text'), host: q('watch-host'),
      quality: q('watch-quality'), sec: q('watch-sec'),
      sheet: q('verify-sheet'), vsHost: q('vs-host'), sasBox: q('viewer-sas'), vsYes: q('vs-yes'), vsNo: q('vs-no'),
      vsStatus: q('vs-status'), vsHide: q('vs-hide'), vsActions: q('vs-actions'),
      statsPanel: q('viewer-stats'), statsBody: q('viewer-stats-body'),
      audioBtn: q('wc-audio'), volume: q('wc-volume'), statsBtn: q('wc-stats'), pipBtn: q('wc-pip'),
      fsBtn: q('wc-fs'), leaveBtn: q('wc-leave'), unmute: q('unmute-hint'),
      ended: q('viewer-ended'), endedIcon: q('ve-icon'), endedTitle: q('ve-title'), endedText: q('ve-text'),
      endedHome: q('ve-home'), endedRetry: q('ve-retry'),
    };
    const e = this.el;
    this.showScreen('join');
    e.formWrap.hidden = false;
    e.status.hidden = true;
    e.code.value = formatCode(normalizeCode(code));
    e.name.value = name;
    e.video.srcObject = null;
    e.statsPanel.hidden = true;
    e.pipBtn.hidden = !document.pictureInPictureEnabled;
    e.volume.hidden = isTouch();

    const on = (el, type, fn, opts = {}) => el.addEventListener(type, fn, { ...opts, signal: this.ac.signal });
    bindCodeInput(e.code);
    on(e.form, 'submit', (ev) => {
      ev.preventDefault();
      this.join();
    });
    on(e.cancel, 'click', () => this.leave());
    on(e.back, 'click', () => this.leave());
    on(e.vsYes, 'click', () => this.confirmSas());
    on(e.vsNo, 'click', () => this.rejectSas());
    on(e.vsHide, 'click', () => {
      this.sheetHidden = true;
      this.render();
    });
    on(e.sec, 'click', () => {
      if (this.sas && !(this.viewerOk && this.hostOk)) this.sheetHidden = false;
      else this.statsOpen = !this.statsOpen;
      this.render();
    });
    on(e.statsBtn, 'click', () => {
      this.statsOpen = !this.statsOpen;
      this.render();
    });
    on(e.audioBtn, 'click', () => this.toggleMute());
    on(e.unmute, 'click', () => this.toggleMute(false));
    on(e.volume, 'input', () => {
      e.video.volume = Number(e.volume.value);
      if (e.video.muted && e.video.volume > 0) this.toggleMute(false);
    });
    on(e.fsBtn, 'click', () => this.toggleFullscreen());
    on(e.pipBtn, 'click', () => this.togglePip());
    on(e.leaveBtn, 'click', () => this.leave());
    on(e.video, 'dblclick', () => this.toggleFullscreen());
    on(e.video, 'resize', () => this.render());
    on(document, 'fullscreenchange', () => this.renderControls());
    on(document, 'webkitfullscreenchange', () => this.renderControls());
    on(e.endedHome, 'click', () => this.onExit());
    on(e.endedRetry, 'click', () => this.onExit({ retry: this.code, name: this.name }));
    on(document, 'keydown', (ev) => {
      if (this.el.watch.hidden || ev.target.closest('input, textarea, select')) return;
      if (ev.key === 'f' || ev.key === 'F') this.toggleFullscreen();
      else if (ev.key === 'm' || ev.key === 'M') this.toggleMute();
    });
    // Controles somem sozinhos durante a exibição.
    const poke = () => this.pokeUi();
    on(e.watch, 'pointermove', poke);
    on(e.watch, 'pointerdown', (ev) => {
      if (ev.pointerType === 'touch' && ev.target === e.video && e.watch.classList.contains('ui-on')) {
        e.watch.classList.remove('ui-on');
      } else poke();
    });

    if (autoJoin && normalizeCode(code).length === 6) this.join();
    else (normalizeCode(code).length === 6 ? e.name : e.code).focus();
  }

  showScreen(which) {
    const e = this.el;
    e.join.hidden = which !== 'join';
    e.watch.hidden = which !== 'watch';
    e.ended.hidden = which !== 'ended';
  }

  setStatus(title, text = '') {
    const e = this.el;
    e.formWrap.hidden = true;
    e.status.hidden = false;
    e.statusTitle.textContent = title;
    e.statusText.textContent = text;
  }

  pokeUi() {
    const w = this.el.watch;
    w.classList.add('ui-on');
    clearTimeout(this.uiTimer);
    this.uiTimer = setTimeout(() => {
      if (!w.querySelector('.watch-controls:hover, .watch-top:hover, .stats-panel:hover, .verify-sheet:hover')) {
        w.classList.remove('ui-on');
      }
    }, 3000);
  }

  // --------------------------------------------------------------- entrar --

  async join() {
    const e = this.el;
    this.code = normalizeCode(e.code.value);
    this.name = e.name.value.trim().slice(0, 32) || 'Convidado';
    if (this.code.length !== 6) {
      e.code.classList.add('shake');
      setTimeout(() => e.code.classList.remove('shake'), 500);
      e.code.focus();
      return;
    }
    store.set('janela.name', e.name.value.trim());
    history.replaceState(null, '', `/?s=${this.code}`);

    // "Destrava" o <video> dentro do clique (iOS/Safari exigem gesto para tocar com som).
    e.video.muted = false;
    e.video.srcObject = new MediaStream();
    e.video.play().catch(() => {});

    this.setStatus('Conectando…', 'Falando com o servidor.');
    this.sig = new Signaling();
    this.sig
      .on('joined', (m) => {
        this.hostName = m.hostName || 'Anfitrião';
        this.setStatus(`Aguardando ${this.hostName} aceitar`, 'Seu pedido foi enviado. A tela aparece assim que for aceito.');
      })
      .on('approved', () => this.setStatus('Pedido aceito!', 'Criando uma conexão criptografada direta…'))
      .on('rejected', () => this.finish('Pedido recusado', 'O anfitrião não aceitou sua entrada.'))
      .on('kicked', () => this.finish(...BYE_REASONS.removed))
      .on('room-closed', () => {
        if (!this.connected) this.finish(...BYE_REASONS.ended);
      })
      .on('error', (m) => {
        const [title, text] = SERVER_ERRORS[m.code] || ['Não foi possível entrar', 'Erro no servidor.'];
        this.finish(title, text, 'info', true);
      })
      .on('signal', (m) => this.onSignal(m.data))
      .on('disconnect', () => {
        if (!this.connected) this.finish('Conexão perdida', 'A conexão com o servidor caiu antes de a transmissão começar.', 'info', true);
      });
    try {
      await this.sig.connect();
      this.sig.send({ type: 'join', code: this.code, name: this.name });
    } catch {
      this.finish('Servidor indisponível', 'Não foi possível falar com o servidor. Verifique o link e sua conexão.', 'info', true);
    }
  }

  // ------------------------------------------------------------ WebRTC --

  onSignal(data) {
    if (!data || this.ended) return;
    if (data.kind === 'hello') {
      if (this.pc || typeof data.commit !== 'string') return;
      this.commit = data.commit;
      this.hostName = String(data.hostName || this.hostName).slice(0, 32);
      this.chain = this.chain.then(() => this.startPeer(data.codec)).catch((err) => this.fail(err));
    } else if (data.kind === 'answer') {
      this.chain = this.chain.then(() => this.handleAnswer(data.sdp)).catch((err) => this.fail(err));
    } else if (data.kind === 'ice' && data.candidate) {
      if (this.pc?.remoteDescription) this.pc.addIceCandidate(data.candidate).catch(() => {});
      else this.pendingIce.push(data.candidate);
    }
  }

  fail(err) {
    console.error(err);
    this.finish('Falha na conexão', err?.message || String(err), 'info', true);
  }

  async startPeer(codec) {
    const e = this.el;
    // Certificado DTLS novo e imprevisível a cada sessão.
    let cert = null;
    try {
      cert = await generateCert();
    } catch {}
    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers,
      bundlePolicy: 'max-bundle',
      ...(cert ? { certificates: [cert] } : {}),
    });
    this.pc = pc;
    const vt = pc.addTransceiver('video', { direction: 'recvonly' });
    const at = pc.addTransceiver('audio', { direction: 'recvonly' });
    if (codec && codec !== 'auto') Q.preferCodec(vt, codec);

    this.stream = new MediaStream([vt.receiver.track, at.receiver.track]);
    e.video.srcObject = this.stream;
    vt.receiver.track.addEventListener('unmute', () => this.tryPlay());

    this.setupDc(pc.createDataChannel('janela', { ordered: true }));
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sig.send({ type: 'signal', data: { kind: 'ice', candidate: ev.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => this.onPcState();

    await pc.setLocalDescription(await pc.createOffer());
    this.localFp = parseFingerprint(pc.localDescription.sdp);
    this.sig.send({ type: 'signal', data: { kind: 'offer', sdp: pc.localDescription.sdp } });

    e.host.textContent = `Tela de ${this.hostName}`;
    e.vsHost.textContent = this.hostName;
    this.showScreen('watch');
    this.pokeUi();
    this.render();
    if (!this.interval) this.interval = setInterval(() => this.tick(), 1000);
  }

  async handleAnswer(sdp) {
    if (!this.pc || this.ended) return;
    let fp;
    try {
      fp = parseFingerprint(sdp);
    } catch (err) {
      return this.securityAbort(`A resposta do anfitrião foi rejeitada: ${err.message}.`);
    }
    // O anfitrião se comprometeu com esta chave ANTES de ver a nossa.
    if ((await commitFor(fp)) !== this.commit) {
      return this.securityAbort(
        'A chave apresentada não corresponde à que o anfitrião anunciou antes. Alguém pode estar tentando interceptar a conexão. Nada foi exibido.',
      );
    }
    this.hostFp = fp;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    for (const c of this.pendingIce.splice(0)) this.pc.addIceCandidate(c).catch(() => {});
    if (!this.sas) {
      this.sas = await sasFor(this.localFp, fp);
      this.pokeUi();
    }
    this.render();
  }

  onPcState() {
    const s = this.pc.connectionState;
    clearTimeout(this.discTimer);
    if (s === 'connected') {
      this.connected = true;
      this.restarts = 0;
    } else if (s === 'failed') {
      this.restartIce();
    } else if (s === 'disconnected') {
      this.discTimer = setTimeout(() => this.pc?.connectionState === 'disconnected' && this.restartIce(), 4000);
    }
    this.render();
  }

  async restartIce() {
    if (this.ended || !this.pc) return;
    if (this.restarts >= 3 || !this.sig?.connected) {
      if (this.pc.connectionState === 'failed') {
        this.finish('Conexão perdida', 'Não foi possível manter a conexão direta com o anfitrião.', 'info', true);
      }
      return;
    }
    this.restarts++;
    try {
      this.pc.restartIce?.();
      await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
      this.sig.send({ type: 'signal', data: { kind: 'offer', sdp: this.pc.localDescription.sdp } });
    } catch (err) {
      console.warn('ICE restart', err);
    }
  }

  setupDc(dc) {
    this.dc = dc;
    dc.onopen = () => {
      if (this.viewerOk) dc.send(JSON.stringify({ t: 'verify', ok: true }));
      this.render();
    };
    dc.onmessage = (ev) => this.onDc(ev.data);
  }

  onDc(raw) {
    if (typeof raw !== 'string' || raw.length > 8192) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'state') {
      this.hostState = m;
      if (m.hostOk && !this.hostOk) {
        this.hostOk = true;
        if (this.viewerOk) toast('Conexão verificada dos dois lados.', { kind: 'success' });
      }
      this.render();
    } else if (m.t === 'verify' && m.ok === false) {
      this.finish(...BYE_REASONS.security);
    } else if (m.t === 'bye') {
      this.finish(...(BYE_REASONS[m.reason] || BYE_REASONS.ended));
    }
  }

  sendDc(obj) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(obj));
  }

  // ------------------------------------------------------- verificação --

  confirmSas() {
    if (!this.sas || this.viewerOk) return;
    this.viewerOk = true;
    this.sendDc({ t: 'verify', ok: true });
    if (this.hostOk) toast('Conexão verificada dos dois lados.', { kind: 'success' });
    this.render();
  }

  rejectSas() {
    this.sendDc({ t: 'verify', ok: false });
    setTimeout(
      () =>
        this.securityAbort(
          'Você indicou que os códigos são diferentes. Isso pode significar que alguém tentou se colocar no meio da conexão. Ela foi encerrada.',
        ),
      150,
    );
  }

  securityAbort(text) {
    this.finish('Conexão bloqueada por segurança', text, 'danger', true);
  }

  // -------------------------------------------------------------- mídia --

  async tryPlay() {
    const v = this.el.video;
    if (!v.paused && !this.autoMuted) return;
    try {
      v.muted = !!this.userMuted;
      await v.play();
    } catch {
      v.muted = true;
      this.autoMuted = true;
      await v.play().catch(() => {});
    }
    this.renderControls();
  }

  toggleMute(force) {
    const v = this.el.video;
    const mute = typeof force === 'boolean' ? force : !v.muted;
    v.muted = mute;
    this.userMuted = mute;
    this.autoMuted = false;
    if (!mute) v.play().catch(() => {});
    this.renderControls();
  }

  toggleFullscreen() {
    const w = this.el.watch;
    const v = this.el.video;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      return;
    }
    const req = w.requestFullscreen || w.webkitRequestFullscreen;
    if (req) {
      Promise.resolve(req.call(w, { navigationUI: 'hide' }))
        .then(() => screen.orientation?.lock?.('landscape').catch(() => {}))
        .catch(() => {});
    } else if (v.webkitEnterFullscreen) {
      v.webkitEnterFullscreen(); // iPhone
    }
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.el.video.requestPictureInPicture();
    } catch {}
  }

  // ------------------------------------------------------ estatísticas --

  async tick() {
    if (!this.pc || this.ended) return;
    try {
      const s = await readReceiverStats(this.pc, this.stats);
      const prevDecoded = this.stats?.framesDecoded;
      if (s.framesDecoded != null && s.framesDecoded !== prevDecoded) this.lastFrameAt = performance.now();
      if (s.audioBytes && this.stats?.audioBytes != null && s.audioBytes > this.stats.audioBytes) this.audioSeen = true;
      this.stats = s;
    } catch {
      return;
    }
    this.flowing = this.lastFrameAt && performance.now() - this.lastFrameAt < 2500;
    if (this.flowing && this.el.video.paused) this.tryPlay();
    if (++this.tickCount % 2 === 0 && this.stats) {
      const s = this.stats;
      this.sendDc({ t: 'rx', w: s.w, h: s.h, fps: s.fps, bps: s.bps, loss: s.windowLoss, freezes: s.freezes });
    }
    this.render();
  }

  // -------------------------------------------------------------- render --

  render() {
    if (this.ended || !this.el) return;
    this.renderOverlay();
    this.renderVerify();
    this.renderStats();
    this.renderControls();
  }

  renderOverlay() {
    const e = this.el;
    const hs = this.hostState;
    let view = null;
    if (!this.connected || !hs) view = ['spinner', 'Estabelecendo conexão segura…', 'Negociando chaves de criptografia com o anfitrião.'];
    else if (hs.sourceLost) view = ['monitor', 'Compartilhamento interrompido', `${this.hostName} está escolhendo outra tela.`];
    else if (!hs.released) view = ['shield', 'Aguardando verificação', `${this.hostName} precisa conferir o código de segurança antes de liberar a tela.`];
    else if (hs.paused) view = ['pause', 'Transmissão pausada', `${this.hostName} pausou a transmissão.`];
    else if (!this.flowing) view = ['spinner', 'Recebendo vídeo…', ''];
    e.state.hidden = !view;
    e.watch.classList.toggle('has-video', !view);
    if (view) {
      const [ic, title, text] = view;
      e.stateIcon.innerHTML = ic === 'spinner' ? '<div class="spinner"></div>' : icon(ic);
      e.stateTitle.textContent = title;
      e.stateText.textContent = text;
      e.stateText.hidden = !text;
    }
    e.quality.hidden = !hs?.quality;
    e.quality.textContent = hs?.quality || '';
  }

  renderVerify() {
    const e = this.el;
    const both = this.viewerOk && this.hostOk;
    const released = this.hostState?.released;
    e.sec.className = `chip sec ${both ? 'ok' : this.sas ? 'warn' : ''}`;
    e.sec.innerHTML = both
      ? `${icon('shield-check')}<span>Verificado</span>`
      : this.sas
        ? `${icon('shield-alert')}<span>Não verificado</span>`
        : `${icon('lock')}<span>Criptografando…</span>`;

    if (both && !this.bothSince) this.bothSince = performance.now();
    const showSheet = this.sas && (!both || performance.now() - this.bothSince < 1800) && !(this.sheetHidden && released);
    e.sheet.hidden = !showSheet;
    if (!showSheet) return;
    e.sasBox.textContent = this.sas;
    e.vsActions.hidden = this.viewerOk;
    e.vsHide.hidden = !released || both;
    let status = '';
    let tone = '';
    if (both) {
      status = 'Verificado dos dois lados. Ninguém está no meio da conexão.';
      tone = 'ok';
    } else if (this.viewerOk) status = `Você confirmou. Aguardando ${this.hostName} confirmar…`;
    else if (this.hostOk) status = `${this.hostName} já confirmou. Confira e confirme também.`;
    e.vsStatus.textContent = status;
    e.vsStatus.className = `verify-status ${tone}`;
    e.vsStatus.hidden = !status;
    e.sheet.classList.toggle('done', both);
  }

  renderStats() {
    const e = this.el;
    e.statsPanel.hidden = !this.statsOpen;
    e.statsBtn.classList.toggle('on', this.statsOpen);
    if (!this.statsOpen) return;
    const s = this.stats || {};
    const both = this.viewerOk && this.hostOk;
    const rows = [
      ['Qualidade', null],
      ['Resolução', s.w ? `${s.w}×${s.h}` : '—'],
      ['Quadros', fmtFps(s.fps)],
      ['Taxa', fmtBitrate(s.bps)],
      ['Codec', s.codec ? `${Q.codecLabel(s.codec)}${s.decoder ? ` (${s.decoder})` : ''}` : '—'],
      ['Rota', s.route ? `${s.route}${s.rtt != null ? ` · ${fmtMs(s.rtt)}` : ''}` : '—'],
      ['Integridade', null],
      ['Pacotes recebidos', fmtInt(s.packets)],
      ['Perdidos', s.packets != null ? `${fmtInt(s.lost || 0)} (${fmtPct(s.totalLoss)})` : '—'],
      ['Retransmissões pedidas', fmtInt(s.nack)],
      ['Congelamentos', fmtInt(s.freezes)],
      ['Jitter', fmtMs(s.jitter)],
      ['Segurança', null],
      ['Canal', [s.tls, s.srtpName].filter(Boolean).join(' · ') || (this.connected ? 'DTLS-SRTP' : '—')],
      ['Compromisso da chave', this.hostFp ? '✓ conferido' : '—'],
      ['Chave do anfitrião', shortFingerprint(this.hostFp)],
      ['Código', this.sas ? `${this.sas} · ${both ? 'verificado' : 'não verificado'}` : '—'],
    ];
    e.statsBody.innerHTML = rows
      .map(([k, v]) => (v === null ? `<dt class="group">${k}</dt>` : `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`))
      .join('');
  }

  renderControls() {
    const e = this.el;
    if (!e) return;
    const v = e.video;
    const hasAudio = this.hostState?.hasAudio || this.audioSeen;
    e.audioBtn.innerHTML = icon(v.muted ? 'volume-x' : 'volume');
    e.audioBtn.title = v.muted ? 'Ativar som (M)' : 'Silenciar (M)';
    e.audioBtn.classList.toggle('dim', !hasAudio);
    e.volume.value = v.muted ? 0 : v.volume;
    e.unmute.hidden = !(this.autoMuted && hasAudio && this.flowing);
    const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    e.fsBtn.innerHTML = icon(fs ? 'minimize' : 'maximize');
    e.fsBtn.title = fs ? 'Sair da tela cheia (F)' : 'Tela cheia (F)';
  }

  // ---------------------------------------------------------------- fim --

  cleanup() {
    this.ended = true;
    clearInterval(this.interval);
    clearTimeout(this.discTimer);
    clearTimeout(this.uiTimer);
    const pc = this.pc;
    setTimeout(() => pc?.close(), 200);
    this.sig?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (this.el) this.el.video.srcObject = null;
  }

  finish(title, text, kind = 'info', retry = false) {
    if (this.ended) return;
    this.cleanup();
    const e = this.el;
    e.endedTitle.textContent = title;
    e.endedText.textContent = text;
    e.endedIcon.className = `ended-icon ${kind}`;
    e.endedIcon.innerHTML = icon(kind === 'danger' ? 'shield-alert' : 'info');
    e.endedRetry.hidden = !retry;
    this.showScreen('ended');
  }

  leave() {
    if (!this.ended) {
      this.sendDc({ t: 'bye' });
      this.cleanup();
    }
    this.ac.abort();
    this.onExit();
  }

  destroy() {
    if (!this.ended) this.cleanup();
    this.ac.abort();
  }
}
