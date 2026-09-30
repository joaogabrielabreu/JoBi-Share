// Canal de sinalização (WebSocket). Só transporta SDP/ICE e controle de sala.
export class Signaling {
  constructor({ autoReconnect = false } = {}) {
    this.autoReconnect = autoReconnect;
    this.handlers = new Map();
    this.queue = [];
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this.everOpened = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, arg) {
    for (const fn of this.handlers.get(type) || []) {
      try {
        fn(arg);
      } catch (err) {
        console.error(err);
      }
    }
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        const reconnect = this.everOpened;
        this.everOpened = true;
        this.ws = ws;
        this.attempt = 0;
        this.emit('open', { reconnect });
        this.flush();
        resolve();
      };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg && typeof msg.type === 'string') this.emit(msg.type, msg);
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        if (!opened) reject(new Error('Não foi possível conectar ao servidor'));
        if (this.closed) return;
        if (opened) this.emit('disconnect');
        if (this.autoReconnect && opened) this.reconnectLater();
      };
    });
  }

  reconnectLater() {
    const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
    setTimeout(() => {
      if (this.closed) return;
      this.connect().catch(() => !this.closed && this.reconnectLater());
    }, delay);
  }

  send(msg) {
    if (this.connected) this.ws.send(JSON.stringify(msg));
    else if (this.autoReconnect && !this.closed) this.queue.push(msg);
  }

  flush() {
    for (const msg of this.queue.splice(0)) this.send(msg);
  }

  close() {
    this.closed = true;
    this.queue = [];
    this.ws?.close();
  }
}
