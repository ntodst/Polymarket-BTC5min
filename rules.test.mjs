import test from 'node:test';
import assert from 'node:assert/strict';
import { maxEntryCost, exitReason, exitPlan } from './rules.mjs';

const cap = (capital, cash = capital, exposure = 0) => maxEntryCost({ capital, cash, exposure });
test('maximum loss falls with capital and never rounds above 1%', () => {
  assert.equal(cap(1000), 10);
  assert.equal(cap(999.54), 9.99);
  assert.equal(cap(500), 5);
  assert.equal(cap(2000), 10);
  for (let cents = 1; cents < 200000; cents += 37) assert.ok(cap(cents / 100) <= cents / 100 * 0.01);
});
test('all outstanding positions share a single 1% risk budget', () => {
  assert.equal(cap(1000, 1000, 6), 4);
  assert.equal(cap(1000, 1000, 9), 1);
  assert.equal(cap(1000, 1000, 10), 0);
  assert.equal(cap(1000, 1000, 11), 0);
  let exposure = 0;
  for (const requested of [3, 2, 4, 3]) {
    exposure += Math.min(requested, cap(1000, 1000 - exposure, exposure));
    assert.ok(exposure <= 10);
  }
  assert.equal(exposure, 10);
  // Closing a $3 position frees $3 for re-entry in the same market.
  assert.equal(cap(1000, 993, exposure - 3), 3);
});
test('cash, already committed risk, and invalid capital restrict entries', () => {
  assert.equal(cap(1000, 2), 2);
  assert.equal(cap(500, 500, 4), 1);
  assert.equal(cap(500, 500, 5), 0);
  assert.equal(cap(NaN), 0);
  assert.equal(cap(-1), 0);
});
test('a signal exit is cancelled when the latest probability reverses', () => {
  assert.equal(exitReason({ secondsRemaining: 200, netBid: 0.65, probability: 0.62 }), 'signal');
  assert.equal(exitReason({ secondsRemaining: 199, netBid: 0.65, probability: 0.70 }), null);
});
test('expiry exits remain enabled even without a model sell signal', () => {
  assert.equal(exitReason({ secondsRemaining: 15, netBid: 0.2, probability: 0.9 }), 'expiry');
  assert.equal(exitReason({ secondsRemaining: 0, netBid: 0.2, probability: 0.9 }), null);
});
test('take profit and stop loss trigger before expiry without model approval', () => {
  assert.equal(exitReason({ secondsRemaining: 200, roi: 0.16, probability: 1, netBid: 0 }), 'take_profit');
  assert.equal(exitReason({ secondsRemaining: 200, roi: -0.11, probability: 1, netBid: 0 }), 'stop_loss');
});
test('protective exits stay latched through a rebound or partial fill', () => {
  assert.equal(exitReason({ secondsRemaining: 180, intent: 'stop_loss', roi: 0.02 }), 'stop_loss');
  assert.equal(exitReason({ secondsRemaining: 180, intent: 'manual' }), 'manual');
});
test('trailing and holding limits are independent of settlement prediction', () => {
  assert.equal(exitReason({ secondsRemaining: 120, roi: 0.04, peakRoi: 0.10 }), 'trailing_stop');
  assert.equal(exitReason({ secondsRemaining: 120, roi: 0, heldSeconds: 91 }), 'time_limit');
  assert.equal(exitReason({ secondsRemaining: 120, roi: 0.04, peakRoi: 0.10, plan: exitPlan({ trailingStop: 0 }) }), null);
});
test('dashboard exit settings reject invalid values and cannot change the risk ceiling', () => {
  assert.throws(() => exitPlan({ stopLoss: -0.1 }));
  assert.throws(() => exitPlan({ takeProfit: NaN }));
  assert.throws(() => exitPlan({ maxHoldSeconds: 0 }));
  assert.equal(exitPlan({ riskFraction: 0.5 }).riskFraction, undefined);
  assert.equal(maxEntryCost({ capital: 1000, cash: 1000, exposure: 6 }), 4);
});
