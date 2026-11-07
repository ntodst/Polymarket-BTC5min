# Five / BTC Paper Desk

Local BTC five-minute paper-trading bot and web dashboard for a Raspberry Pi running a **64-bit OS and Node.js 22+**. No npm dependencies, frontend build, external fonts, cloud service, or real-order execution code.

## Start on the Pi

Copy this directory to the Pi. Keep `data/paper/` to resume your balance and history. Avoid copying an active `bot.lock`; stop the original bot cleanly first. Never run two processes against the same account directory.

```sh
node bot.mjs --host 0.0.0.0 --port 3000
```

Open **http://YOUR_PI_IP:3000** on your local network. Default binding without `--host` is localhost only. The LAN dashboard has paper-trading controls and no login; use a trusted LAN or the localhost default with an SSH tunnel. Credentials are never included in browser snapshots.

Offline UI / synthetic market demo:

```sh
node bot.mjs --demo --host 0.0.0.0
```

Optional terminal view: `--terminal`. Disable the web server with `--no-web`. Other options: `--duration 30`, `--data-dir /path/to/account`, `--port 3001`, and `--plain` with the terminal view. Ctrl+C saves and stops. These changes have **not been run or tested by the agent**, as requested. Checks for you: `npm run check` and `npm test`.

## Live BTC reference feed

Order books and discovery are public. The independent settlement model requires **Polymarket CLOB API credentials** for the current Chainlink PolyBolt feed. No wallet private key is used by this bot.

Copy `.env.example` to `.env` and fill in `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, and `POLYMARKET_API_PASSPHRASE` locally. Start with:

```sh
node --env-file=.env bot.mjs --host 0.0.0.0 --port 3000
```

Without credentials the dashboard shows order books and existing position exits remain available, but new settlement-model entries wait for oracle data. Feed failures never substitute exchange prices or synthetic data for Chainlink. Demo data uses a separate account.

## Operator interface

The dashboard shows BTC versus the official price to beat, countdown, source/averaging rule, Gaussian and heavy-tail probabilities, model range, depth-adjusted edge, UP/DOWN books, cash, realized P&L, liquidation equity, and combined risk.

Open positions have quoted net returns and a **Close position** button. **Pause entries** leaves exits active. Edit the exit plan in the browser; it saves to `controls.json`:

| Exit | Default |
| --- | --- |
| Take profit | +15% net return on position cost |
| Stop loss | -10% net return on position cost |
| Trailing stop | 5 percentage points below peak return, armed after +8% |
| Maximum holding time | 90 seconds |
| Expiry reduction | Begin exits in the final 15 seconds |

Returns include entry fees, estimated exit fees, adverse slippage, and available bid depth. Protective exits and manual closes stay latched through rebounds and partial fills until the position is sold or expires. Take-profit and model signals are rechecked before execution. All exits need fresh quotes; **stop losses are not guaranteed fill prices**. Quoted ROI applies to currently fillable depth; liquidation equity values unquoted remainder at zero. Unfilled expired inventory waits for official settlement.

## Model and risk

The bot reads the resolution source, BTC configuration, official `priceToBeat`, TWAP window, and tie rule. Only known Chainlink spot and 60-second TWAP formats are accepted. Missing/conflicting rules block entries. Already observed prices in a final averaging window contribute a known integral; future uncertainty shrinks as that window fills.

The active **experimental baseline** combines zero-drift arithmetic Brownian pricing with a Student-t heavy-tail simulation. Volatility adapts to Chainlink log returns. Scenarios at 0.7x, 1x, and 1.4x volatility, Monte Carlo error, reference-price error allowance, and an execution buffer widen the valuation range. These are assumptions, not calibrated confidence guarantees. Entries require a further two-percentage-point edge after full depth-weighted purchase cost and fees. See [MODEL.md](MODEL.md).

The independent baseline can paper trade after 60 seconds of usable oracle return history (the initial snapshot may provide it), complete TWAP history where needed, and 15 seconds of live book history. **The previous 30+30 market gate applies only to the separate book-based learner**, which now collects and scores forecasts in shadow mode. It does not authorize or blend into baseline trades. Neither model has demonstrated profitability.

**Combined outstanding risk is capped at 1% of funded paper capital**, including purchase fees, across every open and unresolved position. Funded capital is cash plus open-position cost basis (starting balance plus realized P&L). Opposing positions get no risk offset. Multiple entries/re-entries share that single budget. A $10 per-order ceiling, conservative quarter Kelly, and $100 session loss gate can reduce activity further. Stops do not justify larger entries. The 1% ceiling concerns outstanding risk, not cumulative session losses.

## Pi resources and persistence

- Built-in Node HTTP, cached static assets, vanilla browser JS, server-sent events; no framework or browser polling loop.
- 512 simulation paths, five-second innovations, three-second pricing cache, and a 300-point browser chart. At most eight streaming clients; slow clients reconnect instead of growing a queue.
- Observation logs flush every 10 seconds, capped at 20 MB per file with two archives. Abrupt termination may lose recent buffered observations.
- Account saves on fills, protective exit intents, every 30 seconds, and clean shutdown. Uncheckpointed trailing peaks may be lost on a crash.
- `events.jsonl` records executions and controls. `model-state.json` holds the shadow learner. Files live under `data/paper/` or `data/demo/`.

For unattended operation, adapt [deploy/five-btc.service.example](deploy/five-btc.service.example) to your username, Node binary, and project directory. Create `data/` owned by that user before enabling the service. systemd loads the optional `.env` file directly.

References: [market metadata](https://docs.polymarket.com/market-data/market-details), [feed authentication](https://docs.polymarket.com/migrate/rtds-to-polybolt), [PolyBolt protocol](https://docs.polymarket.com/api-reference/wss/polybolt), [fees](https://docs.polymarket.com/trading/fees).
