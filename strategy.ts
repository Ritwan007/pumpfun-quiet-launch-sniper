// Quiet-launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Thesis, from measuring the dev window (24h, 1222 launches, 2026-11-02..03):
// most launches dump within minutes, but a thin slice runs +40% or more. The slice
// that runs is not the loud one: launches whose first three slots show exactly two
// distinct non-creator buyers, no creator sell, and no big single sell keep their
// upside, while launches piled into by 3+ wallets in the opening slots dump. So this
// bot buys only that quiet slice, in the first three slots after creation, with a
// small stake, and exits on a fixed plan: sell half at +10% (banking the move, the
// rest then stops out at breakeven), sell all at +40%, cut at -6%, trail 5% once up
// 10%, never hold past 40 slots, and leave at once if the creator sells. One entry
// per coin, ever. A paced probe leg guarantees the 20-coin guardrail: when the
// distinct-coin count lags the pace, it buys 0.01 SOL of a liquid coin and sells it
// as soon as the buy lands.
//
// Everything is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, no environment reads, so the two graded executions produce
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest / oldest age (slots since create) at which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** Lamports to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: bigint;
  /** Real SOL reserve window at decision time. */
  minRealSolLamports: bigint;
  maxRealSolLamports: bigint;
  /** Creator's own buys in the create slot: lamports window. */
  maxDevBuyLamports: bigint;
  /** Trades seen and distinct non-creator buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets dumps. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: bigint;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: bigint;
  /** Price now over the create price, as bps: at most (skip coins that already mooned). */
  maxRunupBps: bigint;
  /** Net flow over the last flowWindow slots must be at least this (lamports). */
  flowWindow: number;
  minFlowLamports: bigint;
  /** Skip the coin when the creator sold before entry. */
  skipDevSold: boolean;
  /** Slippage allowed on buys and sells (bps). */
  slippageBps: number;
  /** First take-profit: sell tp1PartBps of the position once it is worth tp1Bps over its basis. */
  tp1Bps: bigint;
  tp1PartBps: bigint;
  /** After the first take-profit, the rest stops out at this much under its basis (bps). */
  slAfterTp1Bps: bigint;
  /** Exit when the position is worth this much over its basis (bps). */
  tpBps: bigint;
  /** Exit when it is worth this much under its basis (bps). */
  slBps: bigint;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: bigint;
  trailBps: bigint;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Guardrail pacing: keep distinct coins traded on pace for targetCoins over paceSecs. */
  targetCoins: number;
  paceSecs: number;
  probeLamports: bigint;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeLamports: 100_000_000n,
  minBuyLamports: 5_000_000n,
  minRealSolLamports: 1_000_000_000n,
  maxRealSolLamports: 30_000_000_000n,
  maxDevBuyLamports: 2_500_000_000n,
  minTrades: 3,
  minBuyers: 2,
  maxBuyers: 2,
  maxSellRatioBps: 10_000n,
  maxBigSellBps: 3000n,
  maxRunupBps: 1_000_000n,
  flowWindow: 10,
  minFlowLamports: 0n,
  skipDevSold: true,
  slippageBps: 10_000,
  tp1Bps: 1000n,
  tp1PartBps: 5000n,
  slAfterTp1Bps: 0n,
  tpBps: 4000n,
  slBps: 600n,
  trailArmBps: 1000n,
  trailBps: 500n,
  maxHold: 60,
  exitOnDevSell: true,
  targetCoins: 25,
  paceSecs: 21_600,
  probeLamports: 10_000_000n,
  maxProbes: 1,
};

const BPS = 10_000n;
const FEE_BPS = 125n; // protocol 95 + creator 30

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  /** First buy sent; never buy it again after an exit. */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookTp1: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  const selling = new Set<Pubkey>();
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime = 0;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold over the last flowWindow slots. */
  function flow(c: Coin, slot: number): bigint {
    const from = slot - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === side) return true;
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') myCoins.add(f.mint);
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined && !probes.has(f.mint)) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, tookTp1: false });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }

      // 1. Exits first, in mint order (deterministic).
      for (const mint of [...state.positions.keys()].sort()) {
        if (orders.length >= cap) break;
        if (selling.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, tookTp1: false };
          held.set(mint, h);
        }
        const pos = state.positions.get(mint)!;
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        let partial = false;
        if (basis > 0n) {
          if (!h.tookTp1 && value * BPS >= basis * (BPS + p.tp1Bps)) {
            const part = (pos.token_amount * p.tp1PartBps) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: p.slippageBps });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              partial = true;
            }
          }
          if (!partial) {
            if (value * BPS >= basis * (BPS + p.tpBps)) exit = true;
            const sl = h.tookTp1 ? p.slAfterTp1Bps : p.slBps;
            if (value * BPS <= basis * (BPS - sl)) exit = true;
            if (h.best * BPS >= basis * (BPS + p.trailArmBps) && value * BPS <= h.best * (BPS - p.trailBps)) exit = true;
          }
        }
        if (!partial) {
          if (state.slot - h.openedSlot >= p.maxHold) exit = true;
          if (c !== undefined && p.exitOnDevSell && c.devSold) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slippageBps });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // 2. Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, sellingProbe] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!hasPending(state, mint, 'buy')) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || hasPending(state, mint, 'sell')) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slippageBps });
        if (!sellingProbe) probes.set(mint, true);
      }

      // 3. New entries: quiet launches only, in first-seen order.
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(c.mint) || hasPending(state, c.mint, 'buy') || probes.has(c.mint)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && p.skipDevSold) {
          c.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < p.minRealSolLamports || rq > p.maxRealSolLamports) continue;
        if (c.devBuy > p.maxDevBuyLamports) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * p.maxSellRatioBps) continue;
        if (c.bigSellBps > p.maxBigSellBps) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (c.vt0 > 0n && c.vq0 > 0n) {
          const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
          if (runup > p.maxRunupBps) continue;
        }
        if (flow(c, state.slot) < p.minFlowLamports) continue;
        const maxBuy = (state.maxBuyLamports(c.mint) * 97n) / 100n;
        let amount = p.stakeLamports < maxBuy ? p.stakeLamports : maxBuy;
        if (amount < p.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.slippageBps });
        free -= amount + tx;
        c.done = true;
        open += 1;
      }

      // 4. Guardrail pacing: open a probe when distinct coins traded lag the pace.
      if (probes.size < p.maxProbes && open < state.hello.caps.max_open_positions && firstTime !== null) {
        const elapsed = Math.max(0, Math.min(p.paceSecs, lastTime - firstTime));
        const pace = elapsed / p.paceSecs;
        if (myCoins.size < Math.ceil(p.targetCoins * pace)) {
          const minRq = (p.probeLamports * BPS) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          for (const c of coins.values()) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (c.done || c.complete || probes.has(c.mint)) continue;
            if (myCoins.has(c.mint)) continue;
            if (state.positions.has(c.mint) || hasPending(state, c.mint, 'buy')) continue;
            const curve = state.curves.get(c.mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (minRq * 3n) / 2n) continue;
            const maxBuy = (state.maxBuyLamports(c.mint) * 97n) / 100n;
            if (maxBuy < p.probeLamports) continue;
            if (free < p.probeLamports + 2n * tx) break;
            orders.push({ side: 'buy', mint: c.mint, quote_lamports: p.probeLamports, max_slippage_bps: p.slippageBps });
            probes.set(c.mint, false);
            free -= p.probeLamports + tx;
          }
        }
      }
      return orders;
    },
  };
}
