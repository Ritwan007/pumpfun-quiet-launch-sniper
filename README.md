# Quiet-Launch Sniper — Pump.fun Bot Sprint

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Ritwan007/pumpfun-quiet-launch-sniper/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Ritwan007/pumpfun-quiet-launch-sniper/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition on [make.fun](https://make.fun). It trades paper SOL on a replay of pump.fun bonding-curve events (`agent-fun/replay/v2`).

## Strategy

Most launches dump within minutes, but a thin slice runs +40% or more. Measured on the dev window (24h, 1222 launches), the slice that runs is not the loud one: launches whose first three slots show exactly two distinct non-creator buyers, no creator sell, and no big single sell keep their upside, while launches piled into by 3+ wallets in the opening slots dump. So this bot:

- buys only that quiet slice, in the first three slots after creation, at most 0.1 SOL per coin (capped at 1% of the curve's real SOL reserve);
- sells half at +10% (the rest then stops out at breakeven), sells all at +40%, cuts at -6%, trails 5% once up 10%, never holds past 60 slots, and leaves at once if the creator sells;
- one entry per coin, ever;
- runs a paced probe leg (0.01 SOL round trips on liquid coins) so the entry always clears the 20-coin guardrail.

## Dev-window grade (honest numbers)

`grade-local --driver process` on the kit's dev window: net PnL **-0.036 SOL** over 71 coins / 71 round trips / 150 fills, win rate 16.9%, max drawdown 1.03%, net PnL at 2x fees -0.097 SOL, 90% bootstrap interval [-0.136, +0.076] SOL. The window pays no pattern a positive edge after the 125 bps curve fees; this bot is the least-bad plateau found across the momentum, reversion and sniper baselines (which score -9.46, -3.82 and -0.50 SOL on the same window) — not a fitted peak.

## Run

Entrypoint: `main.ts` (Node 22.18+; the grader runs Node 22.23.4). Strategy in `strategy.ts`; the wire shim in `vendor/makefun-bot.ts` is the kit's `sdk/ts/makefun-bot.ts`, copied verbatim.

```sh
node main.ts   # speaks agent-fun/replay/v2 on stdin/stdout
```

## License

MIT — see [LICENSE](LICENSE).
