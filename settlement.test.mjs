import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementRules, varianceWeight, timeIntegral, normalCDF, SettlementModel } from './settlement.mjs';

const metadata = {
  slug: 'btc-updown-5m-1800000000', description: 'This market will resolve to "Up" if Bitcoin is greater than or equal to the price at the beginning.',
  resolutionSource: 'https://data.chain.link/streams/btc-usd-twap-60s-streams',
  cryptoMarketConfig: { asset: 'btc', duration: '5m', twapEnabled: true, twapLookbackSeconds: 60 },
  events: [{ slug: 'btc-updown-5m-1800000000', eventMetadata: { priceToBeat: 100 } }],
};
test('reads official threshold, averaging window and tie rule', () => {
  const r = settlementRules(metadata);
  assert.equal(r.supported, true); assert.equal(r.threshold, 100); assert.equal(r.windowSeconds, 60); assert.equal(r.tieUp, true);
});
test('unknown thresholds, sources, and conflicting windows block pricing', () => {
  assert.equal(settlementRules({ ...metadata, events: [] }).supported, false);
  assert.equal(settlementRules({ ...metadata, resolutionSource: 'https://example.com/price' }).supported, false);
  assert.equal(settlementRules({ ...metadata, cryptoMarketConfig: { ...metadata.cryptoMarketConfig, twapLookbackSeconds: 30 } }).supported, false);
});
test('conditional TWAP variance shrinks as the final averaging window fills', () => {
  assert.equal(varianceWeight(0, 300, 300, 0), 300);
  assert.equal(varianceWeight(0, 300, 300, 60), 260);
  assert.equal(varianceWeight(270, 300, 300, 60), 2.5);
  assert.equal(varianceWeight(300, 300, 300, 60), 0);
});
test('known price integrals use time weights and reject gaps', () => {
  const rows = Array.from({ length: 61 }, (_, i) => ({ time: i * 1000, value: 100 }));
  assert.equal(timeIntegral(rows, 0, 60000), 6000);
  assert.equal(timeIntegral([{ time: 0, value: 100 }, { time: 10000, value: 100 }], 0, 10000), null);
  assert.equal(timeIntegral(rows, -1000, 60000), null);
});
test('normal probability calculation is symmetric', () => {
  assert.ok(Math.abs(normalCDF(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCDF(1) + normalCDF(-1) - 1) < 1e-6);
});
test('settlement model needs actual fresh oracle data', () => {
  const model = new SettlementModel(), now = 1800000000000;
  const market = { slug: metadata.slug, start: now, end: now + 300000, settlement: settlementRules(metadata) };
  assert.equal(model.estimate(market, { spot: [], status: 'Missing credentials' }, now).ready, false);
  const spot = Array.from({ length: 181 }, (_, i) => ({ time: now - (180 - i) * 1000, value: 100 }));
  const estimate = model.estimate(market, { spot, twap: [{ time: now, value: 100 }] }, now);
  assert.equal(estimate.ready, true);
  assert.ok(Math.abs(estimate.gaussian - 0.5) < 1e-6);
  assert.ok(estimate.lowerUp <= 0.5 && estimate.upperUp >= 0.5);
  assert.equal(model.estimate(market, { spot, twap: [{ time: now, value: 100 }] }, now + 6000).ready, false);
});
