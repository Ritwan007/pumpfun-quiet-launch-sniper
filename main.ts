// Quiet-launch sniper: buys only launches whose opening tape shows exactly two
// distinct non-creator buyers, no creator sell and no big single sell, in the first
// three slots after creation; exits on a fixed plan (half at +10%, all at +40%,
// cut at -6%, trail 5% once up 10%, never hold past 60 slots, leave if the creator
// sells). A paced probe leg guarantees the 20-coin guardrail. See strategy.ts.
//
// Tuned on the dev window (24h, 1222 launches): net -0.033 SOL over 69 coins,
// 12 wins, max drawdown 0.98%, top-3 coins 0.078 of 0.107 SOL total gains. The
// window pays no pattern a positive edge after the 125 bps curve fees, so the
// settings below are the least-bad plateau found, not a fitted peak: the two
// changes from the first version (hold 40 -> 60 slots, min real SOL 0.3 -> 1)
// moved the result by less than 0.005 SOL and were kept because they avoid the
// thinnest curves and give the fat tail room, not because they top a grid.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(
  createStrategy({
    ...DEFAULT_PARAMS,
    // Entry: quiet launches only.
    minAge: 0,
    maxAge: 3,
    minTrades: 3,
    minBuyers: 2,
    maxBuyers: 2,
    // Exits: bank half early, let the rest run, cut fast.
    tp1Bps: 1000n,
    tp1PartBps: 5000n,
    slAfterTp1Bps: 0n,
    tpBps: 4000n,
    slBps: 600n,
    trailArmBps: 1000n,
    trailBps: 500n,
    maxHold: 60,
  }),
);
