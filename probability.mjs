import fs from 'node:fs';
import path from 'node:path';

export const MODEL_VERSION = 'market-residual-v1';
const D = 6, RIDGE = 16, MAX_MARKETS = 512, MIN_TRAIN = 30, MIN_VALIDATION = 30;
const Z = 1.645; // Approximate one-sided parameter uncertainty, NOT guaranteed coverage.
const clip = (x, a, b) => Math.max(a, Math.min(b, x));
const logit = p => Math.log(clip(p, 0.001, 0.999) / (1 - clip(p, 0.001, 0.999)));
const sigmoid = x => x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const eye = scale => Array.from({ length: D }, (_, i) => Array.from({ length: D }, (_, j) => i === j ? scale : 0));
const average = a => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const loss = (p, y) => -y * Math.log(clip(p, 1e-9, 1 - 1e-9)) - (1 - y) * Math.log(clip(1 - p, 1e-9, 1 - 1e-9));

function inverse(matrix) {
  const a = matrix.map((row, i) => [...row, ...eye(1)[i]]);
  for (let c = 0; c < D; c++) {
    let pivot = c;
    for (let r = c + 1; r < D; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    if (!Number.isFinite(a[c][c]) || Math.abs(a[c][c]) < 1e-12) throw Error('Singular probability model');
    const divisor = a[c][c];
    a[c] = a[c].map(x => x / divisor);
    for (let r = 0; r < D; r++) {
      if (r === c) continue;
      const factor = a[r][c];
      a[r] = a[r].map((x, j) => x - factor * a[c][j]);
    }
  }
  return a.map(row => row.slice(D));
}

// Every resolved market has TOTAL weight one. Its correlated snapshots do not
// count as hundreds of independent Bernoulli outcomes.
export function fitResidual(markets) {
  const rows = markets.flatMap(m => m.samples.map(s => ({ ...s, y: m.outcome, weight: 1 / m.samples.length })));
  let beta = Array(D).fill(0);
  const derivatives = b => {
    const gradient = b.map(x => RIDGE * x), hessian = eye(RIDGE);
    let objective = RIDGE * dot(b, b) / 2;
    for (const s of rows) {
      const eta = logit(s.base) + dot(b, s.features), p = sigmoid(eta);
      objective += s.weight * (Math.max(eta, 0) + Math.log1p(Math.exp(-Math.abs(eta))) - s.y * eta);
      for (let i = 0; i < D; i++) {
        gradient[i] += s.weight * (p - s.y) * s.features[i];
        for (let j = 0; j < D; j++) hessian[i][j] += s.weight * p * (1 - p) * s.features[i] * s.features[j];
      }
    }
    return { gradient, hessian, objective };
  };
  for (let iteration = 0; iteration < 20; iteration++) {
    const current = derivatives(beta), covariance = inverse(current.hessian);
    const step = covariance.map(row => dot(row, current.gradient));
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
    let rate = 1, candidate;
    while (rate >= 1 / 1024) {
      candidate = beta.map((x, i) => x - rate * step[i]);
      if (derivatives(candidate).objective <= current.objective) break;
      rate /= 2;
    }
    if (rate < 1 / 1024) break;
    beta = candidate;
  }
  return { beta, covariance: inverse(derivatives(beta).hessian) };
}

export function validationReport(markets) {
  const evaluated = [...markets].sort((a, b) => a.end - b.end).flatMap(m => {
    const samples = m.samples.filter(s => s.trainMarkets >= MIN_TRAIN);
    if (!samples.length) return [];
    return [{ gain: average(samples.map(s => loss(s.base, m.outcome) - loss(s.prediction, m.outcome))),
      brier: average(samples.map(s => (s.prediction - m.outcome) ** 2)),
      baselineBrier: average(samples.map(s => (s.base - m.outcome) ** 2)) }];
  }).slice(-128);
  const n = evaluated.length, gains = evaluated.map(r => r.gain), mean = average(gains);
  // Bartlett / Newey-West correction over nearby market outcomes. Do not let
  // negative estimated autocorrelation reduce the independent-market estimate.
  const variance = average(gains.map(x => (x - mean) ** 2));
  let longRun = variance;
  const lags = Math.min(3, n - 1);
  for (let k = 1; k <= lags; k++) {
    let covariance = 0;
    for (let i = k; i < n; i++) covariance += (gains[i] - mean) * (gains[i - k] - mean) / n;
    longRun += 2 * (1 - k / (lags + 1)) * covariance;
  }
  const gainSE = n > 1 ? Math.sqrt(Math.max(variance, longRun, 0) / (n - 1)) : Infinity;
  const brier = n ? average(evaluated.map(r => r.brier)) : null;
  const baselineBrier = n ? average(evaluated.map(r => r.baselineBrier)) : null;
  const ready = n >= MIN_VALIDATION && mean > Z * gainSE && brier < baselineBrier;
  return { markets: n, logLossGain: mean, gainSE: Number.isFinite(gainSE) ? gainSE : null,
    brier, baselineBrier, ready,
    reason: n < MIN_VALIDATION ? `Collecting forward validation: ${n}/${MIN_VALIDATION} resolved markets`
      : ready ? 'Forward validation gate passed (experimental)' : 'No demonstrated improvement over market prices' };
}

export class ProbabilityModel {
  constructor(directory) {
    this.file = path.join(directory, 'model-state.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { version: MODEL_VERSION, resolved: [], pending: {} };
    if (this.state.version !== MODEL_VERSION || !Array.isArray(this.state.resolved) || !this.state.pending || typeof this.state.pending !== 'object') throw Error('Invalid probability model state');
    for (const m of [...this.state.resolved, ...Object.values(this.state.pending)]) {
      if (!Array.isArray(m.samples) || !m.samples.length || m.samples.some(s => !Array.isArray(s.features) || s.features.length !== D
        || !s.features.every(Number.isFinite) || !(s.base > 0 && s.base < 1) || !(s.prediction > 0 && s.prediction < 1)
        || !Number.isFinite(s.trainMarkets))) throw Error('Invalid probability model samples');
    }
    if (this.state.resolved.some(m => m.outcome !== 0 && m.outcome !== 1)) throw Error('Invalid probability model outcomes');
    this.refit(); this.reset();
  }
  reset() { this.history = []; this.slug = null; this.pressure = 0; this.returnVariance = 0.0004; }
  refit() {
    Object.assign(this, fitResidual(this.state.resolved));
    this.validation = validationReport(this.state.resolved);
  }
  save() {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  estimate(books, market, now) {
    if (this.slug !== market.slug) { this.reset(); this.slug = market.slug; }
    const [u, d] = books;
    const wU = 1 / Math.max(0.005, u.spread) ** 2, wD = 1 / Math.max(0.005, d.spread) ** 2;
    const base = clip((wU * u.mid + wD * (1 - d.mid)) / (wU + wD), 0.001, 0.999);
    const imbalance = b => {
      const depth = side => side.slice(0, 5).reduce((sum, r, i) => sum + r.size / (i + 1), 0);
      const bid = depth(b.bids), ask = depth(b.asks);
      return (bid - ask) / Math.max(1, bid + ask);
    };
    const rawPressure = (imbalance(u) - imbalance(d)) / 2;
    const previous = this.history.at(-1), dt = previous ? Math.max(0.001, (now - previous.time) / 1000) : 1;
    const alpha = 1 - Math.exp(-Math.min(dt, 5) / 5);
    this.pressure += alpha * (rawPressure - this.pressure);
    if (previous) {
      const rate = clip(logit(base) - logit(previous.price), -0.5, 0.5) ** 2 / dt;
      this.returnVariance += (1 - Math.exp(-Math.min(dt, 5) / 30)) * (rate - this.returnVariance);
    }
    this.history.push({ time: now, price: base });
    this.history = this.history.filter(r => now - r.time <= 65000);
    const past = seconds => this.history.find(r => now - r.time <= seconds * 1000) ?? this.history[0];
    const momentum = base - past(15).price;
    const trend = seconds => {
      const old = past(seconds), elapsed = Math.max(1, (now - old.time) / 1000);
      return clip((logit(base) - logit(old.price)) / Math.max(0.08, Math.sqrt(this.returnVariance * elapsed)), -3, 3) / 3;
    };
    const fraction = clip((market.end - now) / (market.end - market.start), 0, 1);
    const features = [1, this.pressure, this.pressure * Math.sqrt(fraction), trend(15), trend(60), logit(base) / 7];
    const eta = logit(base) + dot(this.beta, features), pUp = clip(sigmoid(eta), 1e-6, 1 - 1e-6);
    const sigma = Math.sqrt(Math.max(0, dot(features, this.covariance.map(row => dot(row, features)))));
    // Parameter uncertainty + fixed misspecification floor; neither is a
    // distribution-free confidence interval or evidence of profitable trading.
    const lowerUp = clip(sigmoid(eta - Z * sigma) - 0.005, 0, 1);
    const upperUp = clip(sigmoid(eta + Z * sigma) + 0.005, 0, 1);
    const executionBuffer = Math.min(0.05, Math.max(0.0025, Z * base * (1 - base) * Math.sqrt(this.returnVariance * 0.75)));
    const lower = Math.max(u.bids[0].price, 1 - d.asks[0].price);
    const upper = Math.min(u.asks[0].price, 1 - d.bids[0].price);
    const quality = Math.abs(u.timestamp - d.timestamp) > 1500 ? 'Books sampled too far apart'
      : now - Math.min(u.timestamp, d.timestamp) > 5000 ? 'Book data older than 5 seconds'
      : lower > upper + 1e-8 ? 'UP/DOWN quotes disagree; waiting for coherent books' : null;
    const warm = now - this.history[0].time >= 15000;
    const ready = warm && !quality && this.state.resolved.length >= MIN_TRAIN && this.validation.ready;
    const reason = quality ?? (!warm ? 'Collecting 15 seconds of stable features'
      : this.state.resolved.length < MIN_TRAIN ? `Learning official outcomes: ${this.state.resolved.length}/${MIN_TRAIN} markets`
        : this.validation.reason);
    const prediction = { version: MODEL_VERSION, base, pUp, pressure: this.pressure, rawPressure, momentum, features,
      lowerUp, upperUp, conservative: [lowerUp, 1 - upperUp], optimistic: [upperUp, 1 - lowerUp],
      executionBuffer, sigmaLogit: sigma, trainMarkets: this.state.resolved.length,
      validation: this.validation, quality, ready, reason };
    // Freeze forecasts BEFORE outcomes arrive. No more than one snapshot per
    // minute of a market; use them later for genuinely forward-scored metrics.
    const phase = Math.floor((now - market.start) / 60000);
    if (warm && !quality && market.end - now > 30000 && phase >= 0 && phase < 5
      && !this.state.resolved.some(m => m.slug === market.slug)) {
      const group = this.state.pending[market.slug] ?? { slug: market.slug, end: market.end, samples: [] };
      if (!group.samples.some(s => s.phase === phase)) {
        group.samples.push({ time: now, phase, base, features, prediction: pUp, trainMarkets: this.state.resolved.length });
        this.state.pending[market.slug] = group; this.save();
      }
    }
    return prediction;
  }
  due(now) { return Object.values(this.state.pending).filter(m => m.end <= now).sort((a, b) => a.end - b.end); }
  resolve(slug, outcome, now) {
    const group = this.state.pending[slug];
    if (!group || now < group.end || (outcome !== 0 && outcome !== 1)) return null;
    this.state.resolved.push({ ...group, outcome, resolvedAt: now });
    this.state.resolved = this.state.resolved.slice(-MAX_MARKETS);
    delete this.state.pending[slug];
    this.refit(); this.save();
    return { slug, outcome, trainMarkets: this.state.resolved.length, validation: this.validation, coefficients: this.beta };
  }
}
