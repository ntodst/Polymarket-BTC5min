export const syntheticPrice = time => 75000 + 35 * Math.sin(time / 19000) + 12 * Math.sin(time / 3100);

export class OracleFeed {
  constructor({ demo = false } = {}) {
    this.demo = demo; this.connected = demo; this.spot = []; this.twap = []; this.sequences = new Map();
    this.status = demo ? 'Synthetic BTC feed' : 'Oracle credentials not configured';
    this.stopped = false; this.retry = null; this.heartbeat = null; this.authTimer = null; this.socket = null;
  }
  start() {
    if (this.demo) return;
    const { POLYMARKET_API_KEY: apiKey, POLYMARKET_API_SECRET: secret, POLYMARKET_API_PASSPHRASE: passphrase } = process.env;
    if (!apiKey || !secret || !passphrase) return;
    this.credentials = { apiKey, secret, passphrase }; this.connect();
  }
  connect() {
    if (this.stopped) return;
    this.connected = false; this.status = 'Connecting to Chainlink reference feed';
    this.spot = []; this.twap = []; this.sequences.clear();
    const ws = new WebSocket('wss://ws-live-v2.polymarket.com/ws'); this.socket = ws;
    let lastMessage = Date.now(), authenticated = false;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ op: 'auth', rid: 'oracle-auth', auth: this.credentials }));
      this.authTimer = setTimeout(() => ws.close(), 10000); this.authTimer.unref();
      this.heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 45000) ws.close();
        else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
      }, 20000); this.heartbeat.unref();
    });
    ws.addEventListener('message', event => {
      lastMessage = Date.now();
      let msg; try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.op === 'authed' && !authenticated) {
        authenticated = true; clearTimeout(this.authTimer);
        this.status = 'Waiting for Chainlink price snapshots';
        ws.send(JSON.stringify({ op: 'subscribe', subscriptions: [
          { channel: 'price.crypto', filter: { symbol: 'btcusd', provider: 'chainlink' } },
          { channel: 'price.crypto.twap', filter: { symbol: 'btcusd', window_seconds: 60, provider: 'chainlink' } },
        ] })); return;
      }
      if (msg.op === 'error') { this.status = `Oracle protocol error: ${String(msg.code ?? 'unknown').replace(/[^a-z0-9_]/gi, '')}`; return; }
      if (!['price.crypto', 'price.crypto.twap'].includes(msg.channel)) return;
      const p = msg.payload;
      if (!p || p.symbol !== 'btcusd' || p.source !== 'chainlink'
        || (msg.channel === 'price.crypto.twap' && Number(p.window_seconds) !== 60)) return;
      const previous = this.sequences.get(msg.channel);
      if (msg.dropped > 0 || (previous !== undefined && msg.seq !== previous + 1)) {
        this.status = 'Oracle sequence gap; reconnecting for fresh history'; this.spot = []; this.twap = []; ws.close(); return;
      }
      this.sequences.set(msg.channel, msg.seq);
      const key = msg.channel === 'price.crypto' ? 'spot' : 'twap';
      const rows = msg.snapshot ? (Array.isArray(p.data) ? p.data : []) : [p];
      this.ingest(key, rows.map(r => ({ time: Number(r.timestamp), value: Number(r.full_accuracy_value ?? r.value) })));
      this.connected = true; this.status = 'Chainlink connected';
    });
    ws.addEventListener('error', () => { this.status = 'Oracle connection unavailable'; ws.close(); });
    ws.addEventListener('close', event => {
      this.connected = false;
      clearTimeout(this.authTimer); clearInterval(this.heartbeat);
      if (this.stopped) return;
      if ([4001, 4008].includes(event.code)) { this.status = `Oracle rejected connection (${event.code}); check local credentials/configuration`; return; }
      this.status = 'Oracle disconnected; reconnecting';
      this.retry = setTimeout(() => this.connect(), 3000 + Math.random() * 2000); this.retry.unref();
    });
  }
  ingest(key, rows) {
    const cutoff = Date.now() - 900000;
    const merged = new Map(this[key].map(p => [p.time, p.value]));
    for (const r of rows) if (Number.isFinite(r.time) && r.time >= cutoff && r.time <= Date.now() + 1000 && Number.isFinite(r.value) && r.value > 0) merged.set(r.time, r.value);
    this[key] = [...merged].filter(([time]) => time >= cutoff).sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
  }
  updateDemo(now) {
    if (!this.demo) return;
    const second = Math.floor(now / 1000) * 1000;
    const start = this.spot.length ? this.spot.at(-1).time + 1000 : second - 180000;
    for (let t = start; t <= second; t += 1000) {
      this.spot.push({ time: t, value: syntheticPrice(t) });
      const trailing = this.spot.filter(p => p.time > t - 60000 && p.time <= t);
      if (trailing.length >= 60) this.twap.push({ time: t, value: trailing.reduce((s, p) => s + p.value, 0) / trailing.length });
    }
    this.spot = this.spot.filter(p => p.time >= now - 900000); this.twap = this.twap.filter(p => p.time >= now - 900000);
  }
  close() { this.stopped = true; clearTimeout(this.retry); clearTimeout(this.authTimer); clearInterval(this.heartbeat); this.socket?.close(); }
}
