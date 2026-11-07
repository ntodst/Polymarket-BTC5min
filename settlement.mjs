const positive = x => Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null;
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function settlementRules(raw) {
  const source = raw.resolutionSource ?? '', config = raw.cryptoMarketConfig;
  const description = raw.description ?? '';
  const event = raw.events?.find(e => e.slug === raw.slug);
  const threshold = positive(event?.eventMetadata?.priceToBeat ?? raw.eventMetadata?.priceToBeat);
  const match = source.match(/^https:\/\/data\.chain\.link\/streams\/btc-usd(?:-twap-(\d+)s-streams)?\/?$/);
  const windowSeconds = match?.[1] ? Number(match[1]) : 0;
  const tieUp = /greater than or equal to/i.test(description) ? true
    : /greater than/i.test(description) && !/equal/i.test(description) ? false : null;
  let reason = !match ? 'Unrecognized settlement oracle' : tieUp === null ? 'Unrecognized tie rule' : null;
  if (config && (config.asset !== 'btc' || config.duration !== '5m'
    || Boolean(config.twapEnabled) !== Boolean(windowSeconds)
    || (windowSeconds && Number(config.twapLookbackSeconds) !== windowSeconds))) reason = 'Conflicting settlement metadata';
  if (windowSeconds !== 0 && windowSeconds !== 60) reason = 'Only Chainlink spot / 60-second TWAP is supported';
  if (!threshold) reason ??= 'Waiting for official price to beat';
  return { source, threshold, windowSeconds, tieUp, kind: windowSeconds ? 'TWAP' : 'SPOT', reason, supported: !reason };
}

export function normalCDF(x) {
  const a = Math.abs(x), t = 1 / (1 + 0.2316419 * a);
  const tail = Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI)
    * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

// Integral of the squared Brownian loading for a final trailing average.
export function varianceWeight(from, to, end, windowSeconds) {
  if (!windowSeconds) return Math.max(0, to - from);
  const start = end - windowSeconds;
  const before = Math.max(0, Math.min(to, start) - from);
  const lo = Math.max(from, start), hi = Math.min(to, end);
  return before + (hi > lo ? ((end - lo) ** 3 - (end - hi) ** 3) / (3 * windowSeconds ** 2) : 0);
}

export function timeIntegral(points, from, to) {
  if (to <= from) return 0;
  if (!points.length || points[0].time > from) return null;
  const at = time => {
    let previous = points[0];
    for (const p of points) {
      if (p.time >= time) {
        if (p.time - previous.time > 5000) return null;
        return previous.value + (p.value - previous.value) * (time - previous.time) / Math.max(1, p.time - previous.time);
      }
      previous = p;
    }
    return time - previous.time <= 5000 ? previous.value : null;
  };
  const boundaries = [from, ...points.filter(p => p.time > from && p.time < to).map(p => p.time), to];
  let integral = 0;
  for (let i = 1; i < boundaries.length; i++) {
    const a = at(boundaries[i - 1]), b = at(boundaries[i]);
    if (a === null || b === null || boundaries[i] - boundaries[i - 1] > 5000) return null;
    integral += (a + b) / 2 * (boundaries[i] - boundaries[i - 1]) / 1000;
  }
  return integral;
}

function generator(seed) {
  let state = seed >>> 0, spare;
  const uniform = () => { state += 0x6D2B79F5; let x = state; x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61); return ((x ^ x >>> 14) >>> 0) / 4294967296; };
  return () => {
    if (spare !== undefined) { const n = spare; spare = undefined; return n; }
    const radius = Math.sqrt(-2 * Math.log(Math.max(1e-12, uniform()))), angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle); return radius * Math.cos(angle);
  };
}

export class SettlementModel {
  constructor() { this.cache = null; }
  estimate(market, oracle, now) {
    const rules = market.settlement;
    const blocked = reason => ({ ready: false, reason, rules, source: 'settlement-baseline' });
    if (!rules?.supported) return blocked(rules?.reason ?? 'Settlement metadata unavailable');
    if (oracle.connected === false) return blocked(oracle.status || 'Oracle disconnected');
    const points = oracle.spot ?? [], last = points.at(-1);
    if (!last || now - last.time > 5000 || last.time > now + 1000) return blocked(oracle.status || 'Waiting for fresh Chainlink BTC prices');
    if (rules.windowSeconds && (!oracle.twap?.length || now - oracle.twap.at(-1).time > 5000)) return blocked('Waiting for fresh official Chainlink 60-second TWAP');
    if (this.cache?.slug === market.slug && this.cache.rulesKey === JSON.stringify(rules)
      && now - this.cache.at < 3000 && now - this.cache.timestamp <= 5000) return this.cache.result;
    const recent = points.filter(p => p.time >= last.time - 600000);
    const returns = [];
    for (let i = 1; i < recent.length; i++) {
      const dt = (recent[i].time - recent[i - 1].time) / 1000;
      if (dt > 0 && dt <= 5) returns.push({ dt, r: Math.log(recent[i].value / recent[i - 1].value) });
    }
    const span = returns.reduce((s, r) => s + r.dt, 0);
    if (returns.length < 30 || span < 60) return blocked(`Collecting BTC volatility: ${Math.floor(span)}/60 seconds`);
    let fast = returns.reduce((s, x) => s + x.r ** 2, 0) / span, slow = fast;
    for (const r of returns) {
      fast += (1 - Math.exp(-r.dt / 60)) * (r.r ** 2 / r.dt - fast);
      slow += (1 - Math.exp(-r.dt / 300)) * (r.r ** 2 / r.dt - slow);
    }
    const sigmaLog = Math.sqrt(Math.max(fast, slow, 1e-10));
    if (sigmaLog > 0.02) return blocked('BTC volatility / feed outlier too extreme');
    const sigma = last.value * sigmaLog, end = market.end / 1000, time = last.time / 1000;
    if (time >= end) return blocked('Settlement window ended');
    const window = rules.windowSeconds, averageStart = end - window;
    let known = 0;
    if (window && time > averageStart) {
      known = timeIntegral(points, averageStart * 1000, last.time);
      if (known === null) return blocked('Missing observed BTC prices inside the settlement average');
    }
    if (window) {
      const twap = oracle.twap?.at(-1);
      if (!twap || now - twap.time > 5000 || twap.time > now + 1000) return blocked('Waiting for fresh official Chainlink 60-second TWAP');
      // Cross-check our spot history against the oracle's observed average.
      const observed = timeIntegral(points, twap.time - window * 1000, twap.time);
      if (observed === null) return blocked('Incomplete BTC history for TWAP cross-check');
      if (Math.abs(observed / window - twap.value) > Math.max(last.value * 0.0001, sigma * 3)) return blocked('Spot history and published TWAP disagree');
    }
    const mean = window ? (known + last.value * (end - Math.max(time, averageStart))) / window : last.value;
    const weights = [];
    for (let t = time; t < end; t += 5) weights.push(Math.sqrt(varianceWeight(t, Math.min(end, t + 5), end, window)));
    const totalWeight = weights.reduce((s, w) => s + w * w, 0), scales = [0.7, 1, 1.4];
    const gaussian = scales.map(scale => normalCDF((mean - rules.threshold) / Math.max(1e-9, sigma * scale * Math.sqrt(totalWeight))));
    // Common random numbers keep Monte Carlo scenarios comparable across updates.
    // Unit-variance Student-t(5) shocks represent a heavy-tailed alternative,
    // not a fitted claim about the true BTC return distribution.
    const seed = [...market.slug].reduce((s, c) => Math.imul(s ^ c.charCodeAt(0), 16777619), 2166136261);
    const normal = generator(seed), paths = 512, counts = [0, 0, 0];
    const up = value => rules.tieUp ? value >= rules.threshold : value > rules.threshold;
    for (let i = 0; i < paths; i++) {
      let noise = 0;
      for (const weight of weights) {
        const z = normal(); let chi = 0;
        for (let j = 0; j < 5; j++) chi += normal() ** 2;
        noise += weight * z * Math.sqrt(3 / Math.max(chi, 1e-12));
      }
      scales.forEach((scale, j) => { if (up(mean + sigma * scale * noise)) counts[j]++; });
    }
    const heavy = counts.map(n => n / paths);
    const error = heavy.map(p => 1.96 * Math.sqrt(Math.max(p * (1 - p), 1 / paths) / paths));
    const priceError = Math.max(0.5, last.value * 0.00001);
    const oracleMargin = Math.min(0.1, priceError / Math.max(1, sigma * Math.sqrt(totalWeight)) / Math.sqrt(2 * Math.PI));
    const lowerUp = clip(Math.min(...gaussian, ...heavy.map((p, i) => p - error[i])) - oracleMargin, 0, 1);
    const upperUp = clip(Math.max(...gaussian, ...heavy.map((p, i) => p + error[i])) + oracleMargin, 0, 1);
    const result = { ready: true, reason: 'Experimental BTC settlement model; not a proven trading edge', source: 'settlement-baseline',
      pUp: (gaussian[1] + heavy[1]) / 2, lowerUp, upperUp, conservative: [lowerUp, 1 - upperUp], optimistic: [upperUp, 1 - lowerUp],
      gaussian: gaussian[1], heavyTail: heavy[1], scenarios: { scales, gaussian, heavy }, sigmaLog, sigmaDollars: sigma,
      expectedSettlement: mean, btcPrice: last.value, timestamp: last.time, paths, rules };
    this.cache = { slug: market.slug, rulesKey: JSON.stringify(rules), at: now, timestamp: last.time, result };
    return result;
  }
}
