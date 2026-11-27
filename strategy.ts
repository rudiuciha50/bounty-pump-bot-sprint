// Pump.fun replay sprint — "deep survivor rider".
//
// Protocol: the grader sends one `hello`, then one `batch` per slot of the replay window, and reads
// back one reply of `orders` for that slot. A pump.fun price is a pure function of the bonding
// curve, so the only per-mint state worth carrying is the real SOL reserve (`real_quote_reserves`,
// rq below): market cap is proportional to rq*rq, and the curve is finished at about 85 SOL of rq,
// at which point the harness itself closes whatever we still hold.
//
// What the dev window taught (measured offline against the three published dataset parts first):
//   * Launch sniping looks free and is not. The median coin doubles within ~15 slots of its
//     CreateEvent, but the long tail collapses, and the 95 bps protocol fee plus the 30 bps creator
//     fee is charged on both legs of every round trip. Hundreds of tiny round trips leave the
//     account deep in the red even when the entry filter itself is fine.
//   * Coins that are already deep and busy are where the money is. Survivors of this window print
//     6 to 3350 trades over 300 to 2200 slots, so a coin that has already printed 400 trades has
//     proved it has real flow behind it. A handful of large, patient round trips pays the fee a
//     handful of times instead of hundreds.
//
// So: one buy per coin, armed only after the coin has printed 400 trade ticks, sized at the
// harness's own 1%-of-real-reserve cap (the most one reply may spend on one mint anyway) held under
// a 1 SOL ceiling, and held until rq reaches twice the entry rq — roughly a 4x on the market cap.
// There is deliberately no stop loss: the tail is the edge, and a stop pays the fee twice to cut it
// off. Positions still open when the tape ends are flattened by the harness.
//
// Determinism: nothing in this file reads the clock, the environment, the network or Math.random,
// and every iteration is over insertion-ordered structures, so the grader's two executions produce
// byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

/** Basis points per unit: 10 000 bps = 100%. */
const BPS = 10_000n;

/** A buy has to be worth its fee, and one reply's buy on one mint must stay under our ceiling. */
const MIN_STAKE = LAMPORTS_PER_SOL / 500n;
const MAX_STAKE = LAMPORTS_PER_SOL;
/** The harness caps one reply's buys on one mint at 1% of that mint's real reserve. */
const RESERVE_SHARE_BPS = 100n;

/** Trade ticks a coin must have printed before it counts as a survivor with real flow. */
const MIN_TICKS = 400;
/** Give a survivor this many slots to reach the target before the position is recycled. */
const MAX_HOLD_SLOTS = 250;
/** Exit at this multiple of the entry reserve (2x on rq is about 4x on the market cap). */
const TARGET_NUM = 2n;
const TARGET_DEN = 1n;

interface Coin {
  /** Trade ticks seen on this coin so far. */
  ticks: number;
  /** Real SOL reserve after the latest tick (0n before the first trade). */
  reserve: bigint;
  /** The one buy this coin gets has already been sent (or attempted). */
  entered: boolean;
  /** Reserve at our entry: 0n until the buy goes out, so an exit never fires on an unheld coin. */
  entryReserve: bigint;
  /** Slot of our entry, for the recycle timer. */
  entrySlot: number;
  /** A CompleteEvent was seen: the harness has closed any position in this coin. */
  complete: boolean;
}

/** Per-mint state, keyed by mint. Insertion order is the order coins were first seen. */
const book = new Map<string, Coin>();

function coinFor(mint: string): Coin {
  let c = book.get(mint);
  if (c === undefined) {
    c = { ticks: 0, reserve: 0n, entered: false, entryReserve: 0n, entrySlot: -1, complete: false };
    book.set(mint, c);
  }
  return c;
}

export const strategy: Bot = {
  onHello(state: BotState) {
    // stderr only: stdout carries the protocol replies.
    console.error(
      `hello: ${state.hello.protocol}, ${state.cash} lamports, ` +
        `${state.hello.caps.max_open_positions} positions, ` +
        `${state.hello.caps.max_orders_per_batch} orders per batch`,
    );
  },

  onBatch(state: BotState, batch: Batch) {
    const orders: OrderInput[] = [];

    // 1. Fold the slot in. A TradeEvent's reserve is post-trade, so the last trade of the slot is
    //    the mark every decision below is taken on.
    for (const ev of batch.events) {
      const c = coinFor(ev.mint);
      if (ev.event === 'CreateEvent') {
        c.ticks = 0;
        c.reserve = 0n; // a fresh curve holds no real SOL yet
        c.complete = false;
      } else if (ev.event === 'TradeEvent') {
        c.ticks += 1;
        c.reserve = BigInt(ev.real_quote_reserves);
      } else {
        c.complete = true;
      }
    }

    // 2. Exits first, so a sell frees a position slot for this same batch's entries.
    let freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    const held = new Set<string>();
    for (const [mint, position] of state.positions) {
      held.add(mint);
      const c = book.get(mint);
      if (c === undefined || c.entryReserve === 0n) continue;
      const reachedTarget = c.reserve * TARGET_DEN >= c.entryReserve * TARGET_NUM;
      const aged = state.slot - c.entrySlot >= MAX_HOLD_SLOTS;
      if (!reachedTarget && !aged) continue;
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: position.token_amount,
        max_slippage_bps: 10_000, // marks are fresh; the wide band only avoids a needless refusal
      };
      orders.push(sell);
      freeSlots += 1;
    }

    // 3. Enter survivors, one buy each, in the order this slot's events arrived.
    let free = state.freeCashLamports();
    const tx = state.txFeeLamports();
    let added = 0;
    for (const ev of batch.events) {
      if (freeSlots <= 0) break;
      if (orders.length + added >= state.hello.caps.max_orders_per_batch) break;
      if (ev.event !== 'TradeEvent') continue;
      const mint = ev.mint;
      const c = coinFor(mint);
      if (c.entered || c.complete || c.reserve <= 0n) continue;
      if (held.has(mint) || state.pending.has(mint)) continue;
      if (c.ticks < MIN_TICKS) continue;

      // Size to the mint's own cap (the harness enforces it per reply anyway) under our ceiling.
      const cap = state.maxBuyLamports(mint);
      const share = (c.reserve * RESERVE_SHARE_BPS) / BPS;
      let stake = share < MAX_STAKE ? share : MAX_STAKE;
      if (cap > 0n && cap < stake) stake = cap;
      if (stake < MIN_STAKE) continue;
      if (stake + tx > free) continue;

      const buy: BuyInput = { side: 'buy', mint, quote_lamports: stake, max_slippage_bps: 10_000 };
      orders.push(buy);
      c.entered = true;
      c.entryReserve = c.reserve;
      c.entrySlot = state.slot;
      free -= stake + tx;
      freeSlots -= 1;
      added += 1;
    }

    return orders;
  },

  onDone(state: BotState, done) {
    // Whatever was still open has been flattened by the harness before this line runs.
    // The book's size is the count of distinct coins the window carried, which is how a run is
    // sanity-checked against the dataset's own manifest without touching stdout.
    console.error(
      `done: ${done.reason}, ${book.size} coins seen, ${state.cash} lamports cash, ` +
        `${state.positions.size} open`,
    );
  },
};
