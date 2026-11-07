import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProbabilityModel, fitResidual, validationReport } from './probability.mjs';

const sample = (sign = 1) => ({ base: 0.5, features: [1, sign, 0, 0, 0, 0], prediction: sign > 0 ? 0.8 : 0.2, trainMarkets: 30 });
const dataset = Array.from({ length: 64 }, (_, i) => ({ slug: `market-${i}`, end: i * 300000, outcome: i % 2, samples: [sample(i % 2 ? 1 : -1)] }));

test('without outcomes the residual model is exactly neutral', () => {
  const fit = fitResidual([]);
  assert.deepEqual(fit.beta, [0, 0, 0, 0, 0, 0]);
  assert.ok(fit.covariance[0][0] > 0);
});
test('learns a labelled relationship and contracts parameter uncertainty', () => {
  const fit = fitResidual(dataset);
  assert.ok(fit.beta[1] > 0);
  assert.ok(Math.abs(fit.beta[0]) < 1e-7);
  assert.ok(fit.covariance[1][1] < fitResidual([]).covariance[1][1]);
});
test('repeated snapshots of the SAME market do not create more evidence', () => {
  const original = fitResidual(dataset);
  const duplicated = fitResidual(dataset.map(m => ({ ...m, samples: Array.from({ length: 20 }, () => ({ ...m.samples[0] })) })));
  original.beta.forEach((b, i) => assert.ok(Math.abs(b - duplicated.beta[i]) < 1e-7));
  original.covariance.forEach((row, i) => row.forEach((v, j) => assert.ok(Math.abs(v - duplicated.covariance[i][j]) < 1e-7)));
});
test('validation rejects insufficient history, baseline parity, and worse predictions', () => {
  assert.equal(validationReport(dataset.slice(0, 29)).ready, false);
  assert.equal(validationReport(dataset.map(m => ({ ...m, samples: [{ ...m.samples[0], prediction: 0.5 }] }))).ready, false);
  assert.equal(validationReport(dataset.map(m => ({ ...m, samples: [{ ...m.samples[0], prediction: 1 - m.samples[0].prediction }] }))).ready, false);
  assert.equal(validationReport(dataset).ready, true);
  assert.equal(validationReport(dataset.map(m => ({ ...m, samples: [{ ...m.samples[0], trainMarkets: 0 }] }))).markets, 0);
});

function environment(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btc-probability-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = new ProbabilityModel(dir), start = 1800000000000;
  const market = { slug: 'test-market', start, end: start + 300000 };
  const books = now => [
    { mid: 0.5, spread: 0.02, timestamp: now, bids: [{ price: 0.49, size: 1000 }], asks: [{ price: 0.51, size: 100 }] },
    { mid: 0.5, spread: 0.02, timestamp: now, bids: [{ price: 0.49, size: 100 }], asks: [{ price: 0.51, size: 1000 }] },
  ];
  return { dir, model, start, market, books };
}
test('cold start abstains despite strong book imbalance; bounds remain complementary', t => {
  const e = environment(t);
  e.model.estimate(e.books(e.start), e.market, e.start);
  const p = e.model.estimate(e.books(e.start + 16000), e.market, e.start + 16000);
  assert.equal(p.pUp, p.base);
  assert.equal(p.ready, false);
  assert.ok(p.lowerUp < p.pUp && p.upperUp > p.pUp);
  assert.equal(p.conservative[1], 1 - p.upperUp);
  assert.equal(p.optimistic[1], 1 - p.lowerUp);
});
test('freezes forecasts before outcomes, persists learning, and prevents double training', t => {
  const e = environment(t);
  e.model.estimate(e.books(e.start), e.market, e.start);
  e.model.estimate(e.books(e.start + 16000), e.market, e.start + 16000);
  e.model.estimate(e.books(e.start + 17000), e.market, e.start + 17000);
  assert.equal(e.model.state.pending[e.market.slug].samples.length, 1);
  const frozen = structuredClone(e.model.state.pending[e.market.slug].samples);
  assert.equal(e.model.resolve(e.market.slug, 1, e.start + 18000), null);
  assert.ok(e.model.resolve(e.market.slug, 1, e.market.end + 1));
  assert.deepEqual(e.model.state.resolved[0].samples, frozen);
  assert.equal(e.model.resolve(e.market.slug, 1, e.market.end + 2), null);
  assert.equal(new ProbabilityModel(e.dir).state.resolved.length, 1);
});
test('stale or incoherent quotes cannot pass data quality gates', t => {
  const e = environment(t), now = e.start + 20000;
  const stale = e.books(e.start);
  assert.match(e.model.estimate(stale, e.market, now).quality, /older/);
  const incoherent = e.books(now);
  incoherent[1] = { ...incoherent[1], mid: 0.8, bids: [{ price: 0.79, size: 100 }], asks: [{ price: 0.81, size: 100 }] };
  assert.match(e.model.estimate(incoherent, e.market, now).quality, /disagree/);
});
