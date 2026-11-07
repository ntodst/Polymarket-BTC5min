# Five: valuation, exits, and risk

This is an experimental paper-trading system. Its models are assumptions to evaluate, not demonstrated forecasting or profitability advantages.

## Active BTC settlement baseline

Contract metadata supplies the Chainlink reference source, official price to beat K, final averaging window L, and whether equality resolves UP. Only recognized BTC spot and 60-second TWAP contracts are accepted. Conflicting metadata or missing thresholds stop new entries. The model does not derive K from a convenient exchange candle.

The reference feed uses authenticated PolyBolt subscriptions pinned to Chainlink for BTC spot and 60-second TWAP. Prices are timestamped and sequence-checked, with initial historical snapshots. Freshness, missing intervals, wrong sources, reconnects, and disagreement between published TWAP and reconstructed spot history block pricing. Reconstruction from sampled spot values remains an approximation to the published oracle.

Volatility comes from recent log returns divided by elapsed time. Exponentially weighted estimates with 60- and 300-second time constants adapt to changes; the larger estimate is used, with an explicit small volatility floor. At least 30 usable returns spanning 60 seconds are required. Dollar volatility is current BTC price times log-return volatility.

The benchmark assumes zero-drift arithmetic Brownian BTC price evolution over the short remaining horizon. For spot settlement, the final price has current-price mean and variance sigma² times remaining seconds.

For TWAP ending at T over [T-L,T], already observed prices contribute a fixed time integral. Future prices have conditional mean equal to the latest spot value S. If observation time is t, the expected average is:

```
mean = (known_integral + S * (T - max(t, T-L))) / L
```

The conditional variance is sigma² times:

```
T-L-t + L/3                   if t <= T-L
(T-t)^3 / (3*L^2)             if t > T-L
```

This accounts for an averaging window progressively becoming known. The UP probability is the upper normal tail above K. The interval is based on the latest actual oracle timestamp; elapsed time is not silently treated as a fresh observation.

A second scenario replaces Gaussian five-second innovations with unit-variance Student-t(5) shocks and uses 512 Monte Carlo paths. Its linear loadings preserve the Brownian variance contribution of each interval. This is a heavy-tail sensitivity analysis, not a fitted claim about real returns. Common seeded random numbers limit computational jitter between updates. The model is cached for up to three seconds and rechecks feed freshness before using a cache entry.

Both alternatives use volatility scales 0.7, 1, and 1.4. The displayed point forecast averages the central Gaussian and simulated probabilities. Conservative/optimistic bounds envelope the scenarios, widen for Monte Carlo sampling error, and include a reference-price precision allowance. These bounds are not statistical coverage guarantees and do not account for every source of model misspecification.

## Trading and early exits

The baseline becomes eligible for experimental paper entries once reference history, settlement rules, and fresh coherent order books are available. It does not claim to have passed the separate learner's out-of-sample validation. Entries require conservative expected value greater than full depth-weighted price, fees, slippage, a volatility-dependent execution buffer, and a further two-percentage-point threshold. Both queueing and execution recheck these conditions. Conservative quarter Kelly is reduced when walking depth worsens the effective cost.

Take profit (+15% by default) and stop loss (-10%) use net executable bid value relative to purchase cost including entry fees. A trailing stop arms after +8% and triggers after a five-percentage-point giveback. Maximum holding time defaults to 90 seconds. These settings are editable in the web dashboard and apply immediately to open positions. Manual closes are also available.

Profit and signal exits are rechecked before execution. Stop-loss, trailing, holding-time, expiry, and manual intents stay latched through rebounds and partial fills; they need not wait for a model forecast or official settlement. Empty/stale books cannot produce a simulated sale. The final 15 seconds trigger expiry reduction, but unavailable liquidity can leave inventory awaiting official resolution. Stop thresholds are triggers, not guaranteed sale prices.

**All open and unresolved positions share one maximum purchase-cost risk budget: 1% of funded paper capital, entry fees included.** Cash plus open cost basis defines that capital. Stops do not increase the allowable position size. Opposing bets receive no risk offset. Cumulative session losses are separate from this outstanding-risk limit.

## Shadow book learner

The earlier regularized model remains a separate shadow experiment:

```
P(UP) = sigmoid(logit(market_prior) + features · beta)
```

Features include smoothed depth pressure, its time interaction, volatility-normalized 15/60-second log-odds changes, and market log odds. Ridge-penalized likelihood is fitted with damped Newton steps over the latest 512 resolved markets. Each market receives total weight one regardless of snapshot count.

Forecasts are saved before outcomes and scored after official resolution. Thirty training markets precede at least thirty eligible forward-scored markets. Brier and paired log-loss improvements are compared with the market baseline; a three-lag Bartlett/Newey-West adjustment approximates serial dependence. Passing this monitoring gate does not prove profitability or formal confidence coverage. This learner does not automatically blend into active baseline decisions.

References: [Polymarket market metadata](https://docs.polymarket.com/market-data/market-details), [PolyBolt feed](https://docs.polymarket.com/api-reference/wss/polybolt), [logistic likelihood](https://web.stanford.edu/class/stats305b/slides/Logistic-regression.html), [proper probability scoring](https://cs229.stanford.edu/notes2021fall/section6notes-evaluation-metrics.pdf). [Queue imbalance research](https://arxiv.org/abs/1512.03492) concerns next-tick equity price movements, not BTC binary settlement prediction.
