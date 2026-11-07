#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { maxEntryCost, exitReason, exitPlan } from './rules.mjs';
import { ProbabilityModel } from './probability.mjs';
import { SettlementModel, settlementRules } from './settlement.mjs';
import { OracleFeed, syntheticPrice } from './oracle.mjs';
import { Dashboard } from './dashboard.mjs';

const { values: args } = parseArgs({ options: {
  demo: { type: 'boolean', default: false },
  duration: { type: 'string' },
  plain: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
  'data-dir': { type: 'string' },
  host: { type: 'string', default: '127.0.0.1' },
  port: { type: 'string', default: '3000' },
  terminal: { type: 'boolean', default: false },
  'no-web': { type: 'boolean', default: false },
} });
if (args.help) {
  console.log('node bot.mjs [--demo] [--host 127.0.0.1] [--port 3000] [--terminal] [--no-web] [--duration SECONDS] [--data-dir PATH]\nPaper trading only. Oracle pricing needs local POLYMARKET_API_* credentials; demo is offline. Ctrl+C stops.');
  process.exit(0);
}
const duration = args.duration === undefined ? Infinity : Number(args.duration);
if (!(duration > 0)) throw Error('--duration must be a positive number');
const port = Number(args.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('--port must be between 1 and 65535');
const cfg = { bankroll: 1000, tradeBudget: 10, lossLimit: 100,
  minEdge: 0.02, slippage: 0.005, participation: 0.25,
  maxSpread: 0.06, closeEntrySeconds: 30, latencyMs: 750 };
const directory = path.resolve(args['data-dir'] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', args.demo ? 'demo' : 'paper'));
fs.mkdirSync(directory, { recursive: true });
const stateFile = path.join(directory, 'state.json');
const lockFile = path.join(directory, 'bot.lock');
try {
  const pid = Number(fs.readFileSync(lockFile, 'utf8'));
  if (pid > 0) {
    try { process.kill(pid, 0); throw Error(`A bot already uses ${directory} (PID ${pid})`); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  } else throw Error(`Invalid lock file: ${lockFile}`);
  fs.unlinkSync(lockFile);
} catch (e) { if (e.code !== 'ENOENT') throw e; }
fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
const mode = args.demo ? 'demo' : 'paper';
let account;
try {
  account = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {
    version: 1, mode, initial: cfg.bankroll, cash: cfg.bankroll, realized: 0,
    fees: 0, trades: 0, wins: 0, losses: 0, positions: [], entered: [], lastTrade: 0,
  };
  if (account.version !== 1 || account.mode !== mode || !Number.isFinite(account.cash) || !Array.isArray(account.positions)) throw Error('Invalid or incompatible account state');
} catch (e) { fs.unlinkSync(lockFile); throw e; }
let probabilityModel;
try { probabilityModel = new ProbabilityModel(directory); }
catch (e) { fs.unlinkSync(lockFile); throw e; }
const oracle = new OracleFeed({ demo: args.demo }), settlementModel = new SettlementModel();
const controlsFile = path.join(directory, 'controls.json');
let settings;
try { settings = exitPlan(fs.existsSync(controlsFile) ? JSON.parse(fs.readFileSync(controlsFile, 'utf8')) : {}); }
catch (e) { fs.unlinkSync(lockFile); throw e; }
let market = null, books = [], history = [], pending = null, running = true;
let decision = 'Connecting to public market data…', estimate = null, status = 'CONNECTING';
let lastDiscovery = 0, lastSettlement = 0, lastRecord = 0, lastBookTime = 0;
const started = Date.now(), events = [], equityHistory = [];
const outcomeChecks = new Map();
const tty = process.stdout.isTTY && args.terminal && !args.plain;
let dashboard, observationBuffer = '', lastFlush = Date.now(), lastCheckpoint = Date.now();
const colors = { cyan: '\x1b[96m', green: '\x1b[92m', red: '\x1b[91m', yellow: '\x1b[93m', dim: '\x1b[90m', white: '\x1b[97m' };
const color = (s, c) => tty ? `${colors[c] ?? ''}${s}\x1b[0m` : String(s);
const money = n => `$${n.toFixed(2)}`;
const percent = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const save = () => {
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(account, null, 2));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
};
function log(type, message, extra = {}) {
  const event = { time: new Date().toISOString(), type, message, ...extra };
  events.unshift(event); events.splice(20);
  fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify(event) + '\n');
}
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': 'BTC-Paper-Lab/0.1', 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw Error(`HTTP ${response.status}: ${new URL(url).hostname}`);
  return response.json();
}
const array = x => Array.isArray(x) ? x : JSON.parse(x ?? '[]');
function normalize(raw) {
  const labels = array(raw.outcomes);
  const ids = array(raw.version === 'v2' ? raw.positionIds : raw.clobTokenIds);
  const up = labels.findIndex(x => /^up$/i.test(x));
  const down = labels.findIndex(x => /^down$/i.test(x));
  const start = Number(raw.slug?.match(/^btc-updown-5m-(\d+)$/)?.[1]) * 1000;
  const end = Date.parse(raw.endDate);
  if (up < 0 || down < 0 || !ids[up] || !ids[down] || !Number.isFinite(start) || Math.abs(end - start - 300000) > 1000) throw Error('Unsupported BTC 5-minute market metadata');
  let fee = null;
  if (raw.feesEnabled === false) fee = { rate: 0, exponent: 1 };
  else if (raw.feesEnabled === true && raw.feeSchedule) {
    const rate = Number(raw.feeSchedule.rate), exponent = Number(raw.feeSchedule.exponent);
    if (Number.isFinite(rate) && rate >= 0 && rate <= 1 && exponent === 1) fee = { rate, exponent };
  }
  return { slug: raw.slug, title: raw.question, condition: raw.conditionId, start, end,
    settlement: settlementRules(raw),
    ids: [String(ids[up]), String(ids[down])], fee, minSize: Math.max(1, Number(raw.orderMinSize) || 5),
    accepting: raw.acceptingOrders === true && raw.closed !== true && raw.active !== false };
}
function book(raw, asset, now) {
  if (String(raw.asset_id) !== asset) throw Error('Order book asset mismatch');
  const levels = (rows, sign) => (rows ?? []).map(r => ({ price: Number(r.price), size: Number(r.size) }))
    .filter(r => Number.isFinite(r.price) && Number.isFinite(r.size) && r.price > 0 && r.price < 1 && r.size > 0)
    .sort((a, b) => sign * (a.price - b.price));
  const bids = levels(raw.bids, -1), asks = levels(raw.asks, 1);
  const timestamp = Number(raw.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 10000) throw Error('Stale book or system clock mismatch');
  if (!bids.length || !asks.length || bids[0].price >= asks[0].price) throw Error('Empty or crossed order book');
  return { bids, asks, timestamp, mid: (bids[0].price + asks[0].price) / 2,
    spread: asks[0].price - bids[0].price };
}
async function discover(now) {
  const slug = `btc-updown-5m-${Math.floor(now / 300000) * 300}`;
  const raw = await get(`https://gamma-api.polymarket.com/markets/slug/${slug}`);
  const next = normalize(raw);
  if (!next.fee) {
    try {
      const info = await get(`https://clob.polymarket.com/clob-markets/${next.condition}`);
      if (info.fd && Number(info.fd.e) === 1 && Number.isFinite(Number(info.fd.r)) && Number(info.fd.r) >= 0 && Number(info.fd.r) <= 1) next.fee = { rate: Number(info.fd.r), exponent: 1 };
    } catch { /* Unknown fees prevent trading; prices can still be displayed. */ }
  }
  if (market?.slug !== next.slug) {
    history = []; pending = null; books = []; estimate = null;
    log('MARKET', next.title || next.slug);
  }
  market = next;
}
function model(now) {
  const shadow = probabilityModel.estimate(books, market, now);
  const settlement = settlementModel.estimate(market, oracle, now);
  const warm = now - probabilityModel.history[0].time >= 15000;
  const prediction = settlement.ready ? { ...shadow, ...settlement, version: 'btc-settlement-v1',
    ready: !shadow.quality && warm, reason: shadow.quality ?? (warm ? settlement.reason : 'Collecting 15 seconds of book history'),
    shadow: { pUp: shadow.pUp, trainMarkets: shadow.trainMarkets, validation: shadow.validation }, settlement }
    : { ...shadow, ready: false, reason: settlement.reason, settlement };
  history = probabilityModel.history;
  const edges = books.map((b, i) => {
    const price = Math.min(1, b.asks[0].price + cfg.slippage);
    return prediction.conservative[i] - prediction.executionBuffer - price - feePerShare(price);
  });
  return { ...prediction, edges };
}
const feePerShare = p => (market?.fee?.rate ?? 0) * p * (1 - p);
function fill(levels, { budget = Infinity, shares = Infinity, buy, limit }) {
  let quantity = 0, value = 0, fees = 0;
  const fills = [];
  for (const level of levels) {
    const p = clamp(level.price + (buy ? cfg.slippage : -cfg.slippage), 0, 1);
    if (buy ? p > limit : p < limit) break;
    const f = feePerShare(p);
    const q = Math.max(0, Math.min(level.size * cfg.participation, shares - quantity, buy ? (budget - value - fees) / (p + f) : Infinity));
    quantity += q; value += q * p; fees += q * f;
    if (q > 0) fills.push({ bookPrice: level.price, price: p, quantity: q, fees: q * f });
    if (quantity >= shares - 1e-8 || (buy && value + fees >= budget - 1e-8)) break;
  }
  return { quantity, value, fees, fills };
}
function nav() {
  // Unquoted / expired positions have zero liquidation value until official settlement.
  return account.cash + account.positions.reduce((sum, p) => {
    if (p.slug !== market?.slug || !books[p.side] || !market?.fee || Date.now() - lastBookTime > 5000 || Date.now() - books[p.side].timestamp > 5000 || Date.now() >= market.end) return sum;
    const quote = fill(books[p.side].bids, { shares: p.shares, buy: false, limit: 0 });
    return sum + quote.value - quote.fees;
  }, 0);
}
function entryLimit() {
  return maxEntryCost({ capital: riskCapital(), cash: account.cash,
    exposure: riskExposure(), dollarCap: cfg.tradeBudget });
}
const riskExposure = () => account.positions.reduce((sum, p) => sum + p.cost, 0);
// Funded capital = cash + committed cost = starting balance + realized P&L.
// Buying does not change this denominator; selling/settling updates it.
const riskCapital = () => account.cash + riskExposure();
function positionQuote(position, now) {
  if (position.slug !== market?.slug || !books[position.side] || !market?.fee || now - lastBookTime > 5000 || now - books[position.side].timestamp > 5000 || now >= position.end) return { roi: null, markPnl: null, fillable: 0 };
  const quote = fill(books[position.side].bids, { shares: position.shares, buy: false, limit: 0 });
  if (!quote.quantity || position.cost <= 0) return { roi: null, markPnl: null, fillable: 0 };
  const basis = position.cost * quote.quantity / position.shares;
  const roi = (quote.value - quote.fees - basis) / basis;
  return { roi, markPnl: position.cost * roi, fillable: quote.quantity / position.shares };
}
function currentExit(position, now) {
  const side = position.side, price = Math.max(0, books[side].bids[0].price - cfg.slippage);
  const quote = positionQuote(position, now);
  return exitReason({ secondsRemaining: (market.end - now) / 1000,
    netBid: price - feePerShare(price) - (estimate?.executionBuffer ?? 0.005),
    probability: estimate?.ready && !estimate.quality ? estimate.optimistic[side] : 1,
    roi: quote.roi, peakRoi: position.peakRoi ?? 0, heldSeconds: (now - position.opened) / 1000,
    intent: position.exitIntent, plan: settings });
}
function queueExit(position, reason, now) {
  const protective = ['stop_loss', 'trailing_stop', 'time_limit', 'expiry', 'manual'].includes(reason);
  if (protective && position.exitIntent !== reason) { position.exitIntent = reason; save(); }
  const bid = books[position.side].bids[0].price;
  pending = { buy: false, side: position.side, time: now, slug: market.slug,
    limit: protective ? 0 : Math.max(0, bid - 0.02), reason };
  decision = `Exit queued · ${reason} · next fresh order book`;
  log('EXIT', decision, { slug: position.slug, side: position.side, reason, ...positionQuote(position, now) });
}
function kellyBudget(side, capital, averageCost = null) {
  const price = Math.min(1, books[side].asks[0].price + cfg.slippage);
  const cost = (averageCost ?? price + feePerShare(price)) + estimate.executionBuffer;
  if (cost >= 1) return 0;
  // Binary payoff, using a conservative probability and ALL entry costs.
  return Math.max(0, capital * 0.25 * (estimate.conservative[side] - cost) / (1 - cost));
}
function executionEdge(side, result) {
  return result.quantity > 0 ? estimate.conservative[side] - estimate.executionBuffer
    - (result.value + result.fees) / result.quantity : -Infinity;
}
function trade(now) {
  const remaining = (market.end - now) / 1000;
  const block = !market.accepting ? 'Market is not accepting orders'
    : !market.fee ? 'Fee schedule unknown / unsupported; observing only'
    : books.some(b => now - b.timestamp > 5000) ? 'Waiting for fresh order books'
    : null;
  if (block) { pending = null; decision = block; return; }
  // Existing risk takes priority over another entry. Stops work while the
  // probability model warms up, the oracle is offline, or entries are paused.
  if (pending?.buy) {
    const exit = account.positions.find(p => p.slug === market.slug && currentExit(p, now));
    if (exit) { log('CANCEL', 'Entry cancelled: existing position needs an exit'); pending = null; queueExit(exit, currentExit(exit, now), now); return; }
    if (settings.paused) { pending = null; decision = 'Entries paused · exits remain active'; return; }
  }
  if (pending) {
    if (now - pending.time < cfg.latencyMs) return;
    const order = pending; pending = null;
    if (order.slug !== market.slug || remaining <= 0) return;
    if (order.buy) {
      if (settings.paused || !estimate.ready || books.some(b => b.spread > cfg.maxSpread) || remaining < cfg.closeEntrySeconds
        || estimate.edges[order.side] < cfg.minEdge || nav() < account.initial - cfg.lossLimit) {
        decision = 'Entry cancelled: edge, timing, or loss limit changed';
        log('CANCEL', decision, { slug: market.slug, side: order.side }); return;
      }
      const capitalBefore = riskCapital(), exposureBefore = riskExposure(), riskCap = entryLimit();
      const budget = Math.max(0, Math.min(order.budget, riskCap, kellyBudget(order.side, capitalBefore)) - 1e-9);
      let result = fill(books[order.side].asks, { budget, buy: true, limit: order.limit });
      if (result.quantity > 0) {
        const depthBudget = Math.max(0, Math.min(budget,
          kellyBudget(order.side, capitalBefore, (result.value + result.fees) / result.quantity)) - 1e-9);
        if (depthBudget < budget) result = fill(books[order.side].asks, { budget: depthBudget, buy: true, limit: order.limit });
      }
      if (result.quantity < market.minSize) {
        decision = 'Entry cancelled: liquidity / risk budget below minimum';
        log('CANCEL', decision, { slug: market.slug, riskCap }); return;
      }
      const cost = result.value + result.fees;
      const edgeAtFill = executionEdge(order.side, result);
      if (edgeAtFill < cfg.minEdge) {
        decision = 'Entry cancelled: depth-weighted edge below threshold';
        log('CANCEL', decision, { slug: market.slug, edgeAtFill }); return;
      }
      if (cost > riskCap || exposureBefore + cost > capitalBefore * 0.01) {
        decision = 'Entry cancelled: 1% combined maximum-loss cap';
        log('CANCEL', decision, { cost, riskCap, capitalBefore, exposureBefore }); return;
      }
      account.cash -= cost; account.fees += result.fees; account.trades++;
      const existing = account.positions.find(p => p.slug === market.slug && p.side === order.side);
      if (existing) {
        existing.shares += result.quantity; existing.cost += cost;
        existing.peakRoi = Math.max(0, positionQuote(existing, now).roi ?? 0);
      }
      else account.positions.push({ slug: market.slug, condition: market.condition, end: market.end, side: order.side,
        asset: market.ids[order.side], shares: result.quantity, cost, opened: now });
      decision = `BOUGHT ${order.side === 0 ? 'UP' : 'DOWN'} · combined risk ${money(riskExposure())} / ${money(capitalBefore * 0.01)}`;
      log('BUY', `${order.side === 0 ? 'UP' : 'DOWN'} ${result.quantity.toFixed(2)} shares @ ${money(result.value / result.quantity)} · ${money(cost)} total`,
        { ...result, slug: market.slug, side: order.side, capitalBefore, riskCap, maxLoss: cost, riskFraction: cost / capitalBefore,
          exposureBefore, exposureAfter: riskExposure(), portfolioRiskFraction: riskExposure() / capitalBefore,
          edgeAtFill, probability: estimate.pUp, conservativeProbability: estimate.conservative[order.side],
          executionBuffer: estimate.executionBuffer, modelVersion: estimate.version, validation: estimate.validation });
    } else {
      const position = account.positions.find(p => p.slug === order.slug && p.side === order.side);
      if (!position) return;
      const reason = currentExit(position, now);
      if (!reason) {
        decision = 'Exit cancelled: signal reversed during latency';
        log('CANCEL', decision, { slug: market.slug, side: order.side }); return;
      }
      const result = fill(books[order.side].bids, { shares: position.shares, buy: false, limit: order.limit });
      if (result.quantity < 0.001) { decision = 'Exit unfilled: insufficient liquidity'; return; }
      const basis = position.cost * result.quantity / position.shares;
      const pnl = result.value - result.fees - basis;
      account.cash += result.value - result.fees; account.realized += pnl; account.fees += result.fees; account.trades++;
      position.shares -= result.quantity; position.cost -= basis;
      if (position.shares < 0.001) account.positions = account.positions.filter(p => p !== position);
      decision = `SOLD ${order.side === 0 ? 'UP' : 'DOWN'} · realized ${money(pnl)}${position.shares >= 0.001 ? ' · partial exit' : ''}`;
      log('SELL', `${order.side === 0 ? 'UP' : 'DOWN'} · realized ${money(pnl)}`,
        { ...result, pnl, slug: market.slug, side: order.side, reason, remainingShares: Math.max(0, position.shares) });
    }
    account.lastTrade = now; save(); return;
  }
  const held = account.positions.find(p => p.slug === market.slug && currentExit(p, now));
  if (held) {
    queueExit(held, currentExit(held, now), now); return;
  }
  if (settings.paused) { decision = 'Entries paused · exits remain active'; return; }
  if (!estimate.ready) { decision = estimate.reason; return; }
  if (books.some(b => b.spread > cfg.maxSpread)) { decision = 'Spread too wide'; return; }
  if (remaining < cfg.closeEntrySeconds) { decision = 'No new entries in the final 30 seconds'; return; }
  if (nav() < account.initial - cfg.lossLimit) { decision = 'Loss limit reached · new entries paused'; return; }
  const side = estimate.edges[0] >= estimate.edges[1] ? 0 : 1;
  const edge = estimate.edges[side];
  if (edge < cfg.minEdge) { decision = `WAIT · best net edge ${percent(edge)} < ${percent(cfg.minEdge)}`; return; }
  // Quarter Kelly inside the SHARED 1% risk budget, never per-position 1%.
  const ask = books[side].asks[0].price;
  const capital = riskCapital(), riskCap = entryLimit();
  let budget = Math.min(riskCap, kellyBudget(side, capital));
  if (budget < market.minSize * (ask + cfg.slippage + feePerShare(ask))) { decision = 'Combined 1% risk budget / cash below minimum order'; return; }
  const limit = Math.min(0.995, ask + 0.015);
  let preview = fill(books[side].asks, { budget, buy: true, limit });
  if (preview.quantity > 0) {
    budget = Math.min(budget, kellyBudget(side, capital, (preview.value + preview.fees) / preview.quantity));
    preview = fill(books[side].asks, { budget, buy: true, limit });
  }
  if (preview.quantity < market.minSize || executionEdge(side, preview) < cfg.minEdge) {
    decision = 'WAIT · available depth erases the estimated edge'; return;
  }
  pending = { buy: true, time: now, side, slug: market.slug, budget, limit };
  decision = `BUY ${side === 0 ? 'UP' : 'DOWN'} queued · ${money(budget)} · edge ${percent(edge)}`;
  log('ORDER', decision, { slug: market.slug, side, capital, riskCap, budget });
}
async function settle(now) {
  const candidates = [...new Set([...account.positions.filter(p => p.end <= now).map(p => p.slug), ...probabilityModel.due(now).map(m => m.slug)])]
    .filter(slug => now - (outcomeChecks.get(slug) ?? 0) >= 60000).slice(0, 4);
  for (const slug of candidates) {
    outcomeChecks.set(slug, now);
    let winner;
    if (args.demo) {
      const start = Number(slug.split('-').at(-1)) * 1000;
      winner = syntheticPrice(start + 60000) >= syntheticPrice(start) ? 0 : 1;
    }
    else {
      const raw = await get(`https://gamma-api.polymarket.com/markets/slug/${slug}`);
      // Never infer a result from spot BTC or expiry alone.
      if (raw.closed !== true || raw.umaResolutionStatus !== 'resolved') continue;
      const labels = array(raw.outcomes), prices = array(raw.outcomePrices).map(Number);
      const index = prices.findIndex(p => p === 1);
      if (index < 0 || prices.some((p, i) => i !== index && p !== 0)) continue;
      winner = /^up$/i.test(labels[index]) ? 0 : /^down$/i.test(labels[index]) ? 1 : undefined;
    }
    if (winner === undefined) continue;
    const learned = probabilityModel.resolve(slug, winner === 0 ? 1 : 0, now);
    if (learned) log('MODEL', `Official outcome learned · ${learned.trainMarkets} training markets · ${learned.validation.markets} forward-scored`, learned);
    outcomeChecks.delete(slug);
    for (const position of account.positions.filter(p => p.slug === slug)) {
      const payout = position.side === winner ? position.shares : 0;
      const pnl = payout - position.cost;
      account.cash += payout; account.realized += pnl;
      account[pnl >= 0 ? 'wins' : 'losses']++;
      log('SETTLE', `${slug} · ${winner === 0 ? 'UP' : 'DOWN'} wins · realized ${money(pnl)}`, { payout, pnl });
    }
    account.positions = account.positions.filter(p => p.slug !== slug); save();
  }
}
function demo(now) {
  const epoch = Math.floor(started / 1000) * 1000;
  const start = epoch + Math.floor((now - epoch) / 60000) * 60000;
  if (market?.start !== start) {
    market = { slug: `demo-btc-${start / 1000}`, title: 'SIMULATED BTC Up / Down · 60-second demo window', start, end: start + 60000,
      fee: { rate: 0.07, exponent: 1 }, minSize: 5, ids: ['demo-up', 'demo-down'], accepting: true,
      settlement: { source: 'synthetic', threshold: oracle.spot.find(p => p.time >= start)?.value ?? oracle.spot.at(-1)?.value,
        kind: 'SPOT', windowSeconds: 0, tieUp: true, supported: true, reason: null } };
    history = []; pending = null; estimate = null; log('MARKET', market.title);
  }
  const t = (now - started) / 1000;
  const mid = clamp(0.5 + 0.13 * Math.sin(t / 14), 0.1, 0.9);
  const pressure = Math.sin(t / 9);
  const create = (p, sign) => ({ timestamp: now, mid: p, spread: 0.02,
    bids: Array.from({ length: 5 }, (_, i) => ({ price: p - 0.01 - i * 0.01, size: 1000 * (1 + sign * pressure * 0.92) / (i + 1) })),
    asks: Array.from({ length: 5 }, (_, i) => ({ price: p + 0.01 + i * 0.01, size: 1000 * (1 - sign * pressure * 0.92) / (i + 1) })) });
  books = [create(mid, 1), create(1 - mid, -1)];
}
function spark(points, width = 52) {
  const a = points.slice(-width), chars = '▁▂▃▄▅▆▇█';
  if (a.length < 2) return 'Collecting data…';
  const lo = Math.min(...a), range = Math.max(...a) - lo || 1;
  return a.map(x => chars[Math.round((x - lo) / range * 7)]).join('');
}
function controlDashboard(command) {
  if (command.action === 'settings') {
    const allowed = ['takeProfit', 'stopLoss', 'trailingStop', 'maxHoldSeconds'];
    if (!command.settings || Object.keys(command.settings).some(k => !allowed.includes(k))) throw Error('Unsupported exit setting');
    settings = exitPlan({ ...settings, ...command.settings });
  } else if (command.action === 'pause' || command.action === 'resume') {
    settings = { ...settings, paused: command.action === 'pause' };
    if (settings.paused && pending?.buy) pending = null;
  } else if (command.action === 'close') {
    const position = account.positions.find(p => p.slug === command.slug && p.side === command.side);
    if (!position) throw Error('Position not found');
    if (position.slug !== market?.slug || position.end <= Date.now()) throw Error('This market has ended; waiting for official settlement');
    position.exitIntent = 'manual'; if (pending?.buy) pending = null; save();
    log('CONTROL', 'Manual paper exit requested', { slug: position.slug, side: position.side });
    return { ok: true };
  } else throw Error('Unknown control action');
  fs.writeFileSync(`${controlsFile}.tmp`, JSON.stringify(settings, null, 2)); fs.renameSync(`${controlsFile}.tmp`, controlsFile);
  log('CONTROL', command.action === 'settings' ? 'Exit plan updated' : settings.paused ? 'New entries paused; exits remain active' : 'New entries resumed', { settings });
  return { ok: true, settings };
}
function dashboardSnapshot(now) {
  const latest = oracle.spot.at(-1);
  return { time: now, demo: args.demo, status, decision, settings, uptimeSeconds: Math.floor((now - started) / 1000),
    market: market ? { slug: market.slug, title: market.title, start: market.start, end: market.end, settlement: market.settlement } : null,
    btc: { price: latest?.value ?? null, timestamp: latest?.time ?? null, status: oracle.status },
    model: estimate,
    account: { initial: account.initial, cash: account.cash, nav: nav(), capital: riskCapital(), risk: riskExposure(),
      riskCap: riskCapital() * 0.01, realized: account.realized, fees: account.fees, fills: account.trades },
    positions: account.positions.map(p => ({ slug: p.slug, side: p.side, shares: p.shares, cost: p.cost,
      exitIntent: p.exitIntent, heldSeconds: Math.max(0, Math.floor((now - p.opened) / 1000)),
      status: p.end <= now ? 'AWAITING SETTLEMENT' : 'OPEN', ...positionQuote(p, now) })),
    books: books.map(b => ({ bids: b.bids.slice(0, 5), asks: b.asks.slice(0, 5), spread: b.spread, timestamp: b.timestamp })),
    events: events.slice(0, 12).map(({ time, type, message }) => ({ time, type, message })),
  };
}
function flushObservations() {
  if (!observationBuffer) return;
  const file = path.join(directory, 'observations.jsonl');
  // Bound disk use on an SD card: current file + two 20 MB archives.
  if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(observationBuffer) > 20 * 1024 * 1024) {
    fs.rmSync(`${file}.2`, { force: true });
    if (fs.existsSync(`${file}.1`)) fs.renameSync(`${file}.1`, `${file}.2`);
    fs.renameSync(file, `${file}.1`);
  }
  fs.appendFileSync(file, observationBuffer); observationBuffer = ''; lastFlush = Date.now();
}
function render(now, final = false) {
  if (!args.terminal) {
    if (final || now - lastRecord >= 30000) {
      console.log(`${new Date(now).toISOString()} ${status} · ${decision} · cash ${money(account.cash)} · risk ${money(riskExposure())}/${money(riskCapital() * 0.01)}`);
      lastRecord = now;
    }
    return;
  }
  const width = Math.min(process.stdout.columns || 108, 120);
  const line = '─'.repeat(Math.max(30, width - 2));
  const equity = nav(), pnl = equity - account.initial;
  const remaining = market ? Math.max(0, Math.ceil((market.end - now) / 1000)) : 0;
  const countdown = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  const row = (label, value) => `  ${label.padEnd(18)}${value}`;
  const lines = [color(`  ◈  BTC / FIVE MINUTE                                      ${args.demo ? 'DEMO · SYNTHETIC DATA' : 'LIVE DATA · PAPER MONEY'}`, 'cyan'),
    color(line, 'dim'), `  ${color(status, status === 'CONNECTED' ? 'green' : 'yellow')}  |  ${new Date(now).toLocaleTimeString()}  |  closes ${countdown}  |  ${final ? 'STOPPED' : 'Ctrl+C to stop'}`,
    `  ${market?.title || 'Discovering the current BTC Up/Down market…'}`, color(line, 'dim'),
    `  ${color('PAPER ACCOUNT', 'cyan')}`, row('Cash', money(account.cash)),
    row('Liquidation NAV', `${money(equity)}    ${color(`${pnl >= 0 ? '+' : ''}${money(pnl)} (${percent(pnl / account.initial)})`, pnl >= 0 ? 'green' : 'red')}`),
    row('Realized / fees', `${money(account.realized)}  /  ${money(account.fees)}    Fills: ${account.trades}`),
    row('Total risk / cap', `${money(riskExposure())} / ${money(riskCapital() * 0.01)}    ${account.positions.length} open`),
    color(line, 'dim'), `  ${color('ORDER BOOKS', 'cyan')}                 UP                                  DOWN`,
    '  Level       Bid     Size      Ask     Size       Bid     Size      Ask     Size'];
  for (let i = 0; i < 5; i++) {
    const cells = books.map(b => {
      const bid = b.bids[i], ask = b.asks[i];
      return `${bid ? (bid.price * 100).toFixed(1).padStart(5) : '    —'}¢ ${bid ? bid.size.toFixed(0).padStart(7) : '      —'}  ${ask ? (ask.price * 100).toFixed(1).padStart(5) : '    —'}¢ ${ask ? ask.size.toFixed(0).padStart(7) : '      —'}`;
    });
    lines.push(`  ${String(i + 1).padEnd(9)} ${cells[0] ?? 'Waiting for order books…'}     ${cells[1] ?? ''}`);
  }
  lines.push(color(line, 'dim'), `  ${color('MODEL · BTC SETTLEMENT BASELINE · EXPERIMENTAL', 'cyan')}`,
    row('Estimated UP', `${percent(estimate?.pUp)}    DOWN ${estimate ? percent(1 - estimate.pUp) : '—'}    Market ${percent(estimate?.base)}`),
    row('Net edge UP / DN', estimate ? `${percent(estimate.edges[0])} / ${percent(estimate.edges[1])}    Required ${percent(cfg.minEdge)}` : '—'),
    row('Book pressure', estimate ? `${estimate.pressure.toFixed(2)}    Momentum ${percent(estimate.momentum)}` : '—'),
    row('UP model bounds', estimate ? `${percent(estimate.lowerUp)} – ${percent(estimate.upperUp)}    Execution buffer ${percent(estimate.executionBuffer)}` : '—'),
    row('Shadow learning', estimate ? `${estimate.trainMarkets} / ${estimate.validation.markets} markets    ${estimate.ready ? 'PAPER BASELINE READY' : 'WAITING FOR DATA'}` : '—'),
    row('UP price history', color(spark(history.map(p => p.price)), 'cyan')),
    `  ${color(decision, pending ? 'green' : 'yellow')}`, color(line, 'dim'), `  ${color('POSITIONS / ACTIVITY', 'cyan')}`);
  for (const p of account.positions.slice(-3)) lines.push(`  ${p.side === 0 ? 'UP  ' : 'DOWN'} ${p.shares.toFixed(2)} shares · cost ${money(p.cost)} · ${p.end <= now ? 'AWAITING OFFICIAL RESULT' : 'OPEN'} · ${p.slug}`);
  for (const event of events.slice(0, 4)) lines.push(`  ${new Date(event.time).toLocaleTimeString('en-GB')}  ${event.type.padEnd(7)} ${event.message}`);
  lines.push(color(line, 'dim'), color('  COMBINED risk ≤1% funded capital, fees included · multiple entries allowed · 25% depth', 'dim'));
  const output = lines.map(l => l.replace(/[^\x1b\x20-\x7e\u00a2-\uffff]/g, '')).join('\n');
  // Clear each line's old tail when the replacement text is shorter.
  if (tty && !final) process.stdout.write('\x1b[H' + output.split('\n').join('\x1b[K\r\n') + '\x1b[K\x1b[J');
  else if (final || now - lastRecord >= 5000) { console.log(output + '\n'); lastRecord = now; }
  equityHistory.push(equity); equityHistory.splice(120);
}
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });
if (tty) process.stdout.write('\x1b[?1049h\x1b[?25l');
log('START', `${args.demo ? 'Synthetic demo' : 'Live public data'} · PAPER ONLY · ${money(account.cash)} cash`,
  { version: '0.5.0', modelVersion: 'btc-settlement-v1', riskFraction: 0.01, riskScope: 'all_open_positions', capitalBasis: 'cash_plus_open_cost', maxTradeCost: cfg.tradeBudget, exitRecheck: true, settings });
try {
  if (!args['no-web']) {
    dashboard = new Dashboard({ host: args.host, port, control: controlDashboard });
    dashboard.publish(dashboardSnapshot(Date.now())); await dashboard.start();
    console.log(`Paper dashboard: http://${args.host === '0.0.0.0' ? '<raspberry-pi-ip>' : args.host}:${port}`);
  }
  oracle.start();
  while (running && Date.now() - started < duration * 1000) {
    const tick = Date.now();
    try {
      if (args.demo) { oracle.updateDemo(tick); demo(tick); }
      else {
        if (!market || tick >= market.end || tick - lastDiscovery > 15000) {
          lastDiscovery = tick; await discover(tick);
        }
        const data = await Promise.all(market.ids.map(id => get(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(id)}`)));
        books = data.map((r, i) => book(r, market.ids[i], Date.now()));
      }
      lastBookTime = Date.now(); status = 'CONNECTED';
      for (const p of account.positions) {
        const mark = positionQuote(p, lastBookTime);
        if (Number.isFinite(mark.roi)) p.peakRoi = Math.max(p.peakRoi ?? 0, mark.roi);
      }
      if (Date.now() < market.end) { estimate = model(Date.now()); trade(Date.now()); }
      else { pending = null; decision = 'Window ended · awaiting next market'; }
    } catch (error) {
      const reason = `${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`;
      if (status !== 'OFFLINE' || decision !== `Trading paused: ${reason}`) log('FEED', reason);
      status = 'OFFLINE'; decision = `Trading paused: ${reason}`; pending = null; estimate = null;
    }
    if (Date.now() - lastSettlement > 15000) {
      lastSettlement = Date.now();
      try { await settle(Date.now()); } catch (e) { log('RESULT', `Will retry settlement: ${e.message}`); }
    }
    if (estimate && Date.now() - lastBookTime < 5000) observationBuffer += JSON.stringify({ time: Date.now(), slug: market.slug, ...estimate, bids: books.map(b => b.bids[0]), asks: books.map(b => b.asks[0]), depth: books.map(b => ({ timestamp: b.timestamp, bids: b.bids.slice(0, 5), asks: b.asks.slice(0, 5) })), feeSchedule: market.fee, decision, nav: nav(), riskCapital: riskCapital(), exposure: riskExposure(), maxRisk: riskCapital() * 0.01 }) + '\n';
    if (Date.now() - lastFlush >= 10000 || observationBuffer.length > 262144) flushObservations();
    if (Date.now() - lastCheckpoint >= 30000) { save(); lastCheckpoint = Date.now(); }
    dashboard?.publish(dashboardSnapshot(Date.now()));
    render(Date.now());
    const delay = Math.min(1000, Math.max(0, duration * 1000 - (Date.now() - started)));
    if (running && delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
} finally {
  oracle.close(); dashboard?.close(); flushObservations();
  save();
  if (tty) process.stdout.write('\x1b[?25h\x1b[?1049l');
  render(Date.now(), true);
  fs.unlinkSync(lockFile);
  console.log(`Paper account saved to ${stateFile}`);
}
