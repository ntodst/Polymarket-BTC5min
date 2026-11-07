import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export class Dashboard {
  constructor({ host, port, control }) {
    this.host = host; this.port = port; this.control = control;
    this.clients = new Set(); this.history = []; this.snapshot = { status: 'CONNECTING', time: Date.now() };
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
    this.assets = new Map(['index.html', 'app.css', 'app.js'].map(name => [name, fs.readFileSync(path.join(root, name))]));
    this.hosts = new Set(['localhost', '127.0.0.1', '[::1]', host, os.hostname(), `${os.hostname()}.local`]);
    for (const group of Object.values(os.networkInterfaces())) for (const item of group ?? []) this.hosts.add(item.address.includes(':') ? `[${item.address}]` : item.address);
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.headersTimeout = 10000; this.server.requestTimeout = 10000;
    this.ping = setInterval(() => {
      for (const client of this.clients) if (!client.write(': heartbeat\n\n')) { client.destroy(); this.clients.delete(client); }
    }, 15000); this.ping.unref();
  }
  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => { this.server.removeListener('error', reject); resolve(); });
    });
  }
  publish(snapshot) {
    this.snapshot = snapshot;
    const point = snapshot.btc?.timestamp;
    if (point && point !== this.history.at(-1)?.time) {
      this.history.push({ time: point, price: snapshot.btc.price });
      if (this.history.length > 300) this.history.shift();
    }
    const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of this.clients) if (!client.write(frame)) { client.destroy(); this.clients.delete(client); }
  }
  async handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); }
    catch { res.writeHead(400).end(); return; }
    if (!this.hosts.has(url.hostname)) { res.writeHead(403).end('Unknown dashboard host'); return; }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...this.snapshot, history: this.history })); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (this.clients.size >= 8) { res.writeHead(503).end('Dashboard client limit reached'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ ...this.snapshot, history: this.history })}\n\n`);
      this.clients.add(res); res.on('close', () => this.clients.delete(res)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/control') {
      let origin;
      try { origin = new URL(req.headers.origin).host; } catch { /* Browser controls require a same-origin request. */ }
      if (origin !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end('Same-origin control required'); return; }
      if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415).end(); return; }
      let body = '', bytes = 0;
      try {
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) throw Error('Request too large'); body += chunk; }
        const response = this.control(JSON.parse(body));
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
      } catch (error) {
        if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (req.method !== 'GET' || !this.assets.has(asset)) { res.writeHead(404).end('Not found'); return; }
    res.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css; charset=utf-8' : asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(this.assets.get(asset));
  }
  close() {
    clearInterval(this.ping); for (const client of this.clients) client.end(); this.clients.clear();
    this.server.close(); this.server.closeAllConnections();
  }
}
