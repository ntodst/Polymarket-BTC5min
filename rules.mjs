// A binary long can lose its entire purchase cost, including entry fees.
export function maxEntryCost({ capital, cash, exposure, dollarCap = 10 }) {
  if (![capital, cash, exposure, dollarCap].every(Number.isFinite)) return 0;
  const limit = Math.max(0, Math.min(capital * 0.01 - exposure, cash, dollarCap));
  return Math.floor(limit * 100) / 100;
}

export const DEFAULT_EXIT_PLAN = Object.freeze({ takeProfit: 0.15, stopLoss: 0.10, trailingStop: 0.05,
  trailingArm: 0.08, maxHoldSeconds: 90, paused: false });

export function exitPlan(input = {}) {
  const plan = { ...DEFAULT_EXIT_PLAN, ...input };
  for (const [key, low, high] of [['takeProfit', 0.01, 2], ['stopLoss', 0.01, 0.8], ['trailingStop', 0, 0.5], ['trailingArm', 0.01, 1], ['maxHoldSeconds', 10, 300]]) {
    if (!Number.isFinite(plan[key]) || plan[key] < low || plan[key] > high) throw Error(`Invalid ${key}: expected ${low} to ${high}`);
  }
  if (typeof plan.paused !== 'boolean') throw Error('Invalid pause setting');
  return Object.fromEntries(Object.keys(DEFAULT_EXIT_PLAN).map(k => [k, plan[k]]));
}

export function exitReason({ secondsRemaining, netBid, probability, roi, peakRoi = 0, heldSeconds = 0,
  intent, plan = DEFAULT_EXIT_PLAN }) {
  if (secondsRemaining <= 0) return null;
  if (intent) return intent;
  if (Number.isFinite(roi) && roi <= -plan.stopLoss) return 'stop_loss';
  if (Number.isFinite(roi) && roi >= plan.takeProfit) return 'take_profit';
  if (plan.trailingStop > 0 && Number.isFinite(roi) && peakRoi >= plan.trailingArm && roi <= peakRoi - plan.trailingStop) return 'trailing_stop';
  if (heldSeconds >= plan.maxHoldSeconds) return 'time_limit';
  if (secondsRemaining <= 15) return 'expiry';
  return netBid > probability + 0.01 ? 'signal' : null;
}
