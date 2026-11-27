// Deep-survivor rider for the pump.fun replay sprint.
//
// The harness replays a tape slot by slot. For every slot it hands us that slot's chain events and
// reads back the orders we want filled a few slots later; the only thing a pump curve exposes is its
// real SOL reserve, and everything else about the coin — price, market cap, how far the curve still
// has to run — follows from it arithmetically. So the desk below keeps one small record per mint and
// makes every decision from two numbers: how many trades that mint has printed, and where its
// reserve stands right now.
//
// The shape of the edge, measured on the published dev dataset before any of this was written:
//
//   * Grabbing fresh launches is a losing habit. A coin that has just been created trades on a curve
//     holding no real SOL at all, where the 100 bps curve fee plus the 30 bps creator fee is charged
//     on both legs of a round trip that is usually a few percent wide. Do that a few hundred times
//     and the fees alone eat the account.
//   * Coins with a real tape behind them behave differently. In this window the ones that survive
//     print somewhere between six hundred and a few thousand trades across a thousand-odd slots, and
//     a coin that has already printed several hundred has demonstrated there is flow to ride. Big,
//     infrequent round trips pay the fee a handful of times instead of constantly.
//
// Hence: a coin becomes eligible only once it has printed MATURITY_TICKS trades, we take at most one
// entry per coin, and the stake is sized to the harness's own per-mint ceiling under a hard cap so a
// single name cannot dominate the book. The exit is a reserve multiple — two times the reserve we
// bought at, which is roughly a fourfold on market cap — or the patience timer, whichever lands
// first. There is no stop loss on purpose: the payoff lives in the right tail, and a stop pays the
// round trip fee twice to cut that tail off. Anything still held when the tape ends is flattened by
// the harness itself.
//
// Purity: no clock, no environment, no randomness. Every loop walks insertion-ordered maps, so the
// two graded executions of the same tape emit byte-identical replies.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type BuyInput,
  type Done,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------------------- tuning

/** Fee arithmetic is quoted in basis points: 10 000 of them make a whole. */
const FEE_UNITS = 10_000n;

/** Below this a fill cannot clear its own transaction fee, so it is not worth sending. */
const MIN_NOTIONAL = LAMPORTS_PER_SOL / 500n;

/** Never put more than one SOL into a single name, whatever its curve would allow. */
const CEILING = LAMPORTS_PER_SOL;

/** The share of the mint's real reserve the harness lets one reply spend, in basis points. */
const ATTACK_BPS = 100n;

/** Trades a mint must have printed before the desk will consider it at all. */
const MATURITY_TICKS = 400;

/**
 * Refuse curves that are nearly spent. A pump curve ends around eighty-five SOL of real reserve, so
 * an entry taken at sixty has at most a fifth of a doubling left in it: the target is arithmetically
 * out of reach and the position slot is better spent on a coin that still has room.
 */
const DEPTH_LIMIT = 60n * LAMPORTS_PER_SOL;

/** Slots a position may sit before the desk recycles it, whether or not it reached its target. */
const PATIENCE_SLOTS = 250;

/** Exit multiple on the real reserve: two means the market cap has roughly quadrupled. */
const EXIT_NUM = 2n;
const EXIT_DEN = 1n;

/**
 * Fade guard, in thousandths. A survivor whose reserve has slipped since the previous batch it
 * traded in is a curve on the way down, and a doubling is exactly what a curve on the way down does
 * not do. Passing on it costs nothing — the entry flag is only burned when a buy is actually
 * queued — so the desk simply looks again on a later slot. The window is how stale that earlier
 * reading may be before the comparison stops meaning anything.
 */
const FADE_WINDOW_SLOTS = 30;
const FADE_TOLERANCE = 990n;
const FADE_UNITS = 1_000n;

// ---------------------------------------------------------------------------- per-mint record

interface Watch {
  /** TradeEvents folded in so far. Created coins start at zero. */
  trades: number;
  /** Real SOL reserve after the most recent trade; zero until the first one lands. */
  reserve: bigint;
  /** Reserve after the trade before this one, kept so a fade can be spotted (the v2 gate uses it). */
  previous: bigint;
  /** Slot the `previous` reading was taken on, so a stale comparison can be ignored. */
  previousSlot: number;
  /** Slot the current `reserve` reading came from; -1 before the first trade. */
  reserveSlot: number;
  /** Our single entry for this mint has been sent, filled or rejected. */
  spent: boolean;
  /** Real reserve at the moment we bought; zero while we hold nothing, which blocks exits. */
  basis: bigint;
  /** Slot our buy was decided on; negative until then. */
  openedAt: number;
  /** The curve migrated: the harness closed any position here and no order will be accepted. */
  retired: boolean;
}

/** One record per mint, in the order the tape first revealed it. */
const desk = new Map<string, Watch>();

function watchOf(mint: string): Watch {
  const found = desk.get(mint);
  if (found !== undefined) return found;
  const fresh: Watch = {
    trades: 0,
    reserve: 0n,
    previous: 0n,
    previousSlot: -1,
    reserveSlot: -1,
    spent: false,
    basis: 0n,
    openedAt: -1,
    retired: false,
  };
  desk.set(mint, fresh);
  return fresh;
}

// ---------------------------------------------------------------------------- helpers

/** Fold this slot's events into the desk. A trade's reserve is post-trade, so the last one wins. */
function absorb(batch: Batch): void {
  for (const event of batch.events) {
    const watch = watchOf(event.mint);
    switch (event.event) {
      case 'CreateEvent':
        watch.trades = 0;
        watch.reserve = 0n;
        watch.previous = 0n;
        watch.previousSlot = -1;
        watch.reserveSlot = -1;
        watch.retired = false;
        break;
      case 'TradeEvent':
        // Two or more trades in one slot make the "previous" reading this same slot's, which is
        // still the right comparison: it is the tick immediately before the current one.
        watch.previous = watch.reserve;
        watch.previousSlot = watch.reserveSlot;
        watch.trades += 1;
        watch.reserve = BigInt(event.real_quote_reserves);
        watch.reserveSlot = event.slot;
        break;
      default:
        watch.retired = true;
        break;
    }
  }
}

/**
 * True when the coin has visibly lost reserve since the most recent earlier tick and that tick is
 * recent enough to mean something. A coin with no earlier reading (its first trade) is not fading.
 */
function fading(state: BotState, watch: Watch): boolean {
  if (watch.previous === 0n) return false;
  if (watch.previousSlot < 0) return false;
  if (state.slot - watch.previousSlot > FADE_WINDOW_SLOTS) return false;
  return watch.reserve * FADE_UNITS < watch.previous * FADE_TOLERANCE;
}

/** True when the reserve has doubled since our entry. */
function atTarget(watch: Watch): boolean {
  if (watch.basis === 0n) return false;
  return watch.reserve * EXIT_DEN >= watch.basis * EXIT_NUM;
}

/** True when the position has been open for PATIENCE_SLOTS slots or more. */
function tooOld(state: BotState, watch: Watch): boolean {
  if (watch.openedAt < 0) return false;
  return state.slot - watch.openedAt >= PATIENCE_SLOTS;
}

// ---------------------------------------------------------------------------- the strategy

export const strategy: Bot = {
  onHello(state: BotState): void {
    // stderr is ours; stdout belongs to the protocol replies.
    console.error(
      `desk open: ${state.cash} lamports, ${state.hello.caps.max_open_positions} slots, ` +
        `${state.hello.caps.max_orders_per_batch} orders per reply, ` +
        `latency ${state.hello.latency_slots} slots`,
    );
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    absorb(batch);

    const cap = state.hello.caps.max_open_positions;
    const perReply = state.hello.caps.max_orders_per_batch;
    const fee = state.txFeeLamports();
    const queued: OrderInput[] = [];

    // Exits are planned first: a sell queued in this reply hands its slot back to an entry decided a
    // few lines below, which is the only way a full book can rotate inside one slot.
    let open = state.committedPositionCount();
    const holding = new Set<string>();
    for (const [mint, position] of state.positions) {
      holding.add(mint);
      const watch = desk.get(mint);
      if (watch === undefined || watch.basis === 0n) continue;
      if (!atTarget(watch) && !tooOld(state, watch)) continue;
      if (queued.length >= perReply) break;
      const order: SellInput = {
        side: 'sell',
        mint,
        token_amount: position.token_amount,
        // The mark we decided on is the freshest one the harness has; the band is only slack against
        // an ordinary tick between decision and fill.
        max_slippage_bps: 10_000,
      };
      queued.push(order);
      open -= 1;
      watch.basis = 0n; // the position is spoken for; no second sell for the same mint
      watch.spent = true; // a recycled coin does not get a second entry either
    }

    // Entries: one buy per mint, walking this slot's events in the order they arrived.
    let cash = state.freeCashLamports();
    for (const event of batch.events) {
      if (open >= cap) break;
      if (queued.length >= perReply) break;
      if (event.event !== 'TradeEvent') continue;

      const mint = event.mint;
      const watch = watchOf(mint);
      if (watch.spent || watch.retired) continue;
      if (watch.reserve <= 0n) continue;
      if (watch.trades < MATURITY_TICKS) continue;
      if (watch.reserve >= DEPTH_LIMIT) continue;
      if (fading(state, watch)) continue;
      if (holding.has(mint) || state.pending.has(mint)) continue;

      // Size: the harness's own 1%-of-reserve rule, our one SOL ceiling, and whatever the shim
      // reports as this mint's cap today, taken as the smallest of the three.
      const allowed = state.maxBuyLamports(mint);
      const curveShare = (watch.reserve * ATTACK_BPS) / FEE_UNITS;
      let stake = curveShare < CEILING ? curveShare : CEILING;
      if (allowed > 0n && allowed < stake) stake = allowed;
      if (stake < MIN_NOTIONAL) continue;
      if (stake + fee > cash) continue;

      const buy: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: stake,
        max_slippage_bps: 10_000,
      };
      queued.push(buy);
      watch.spent = true;
      watch.basis = watch.reserve;
      watch.openedAt = state.slot;
      cash -= stake + fee;
      open += 1;
    }

    return queued;
  },

  onDone(state: BotState, done: Done): void {
    // Everything still held has already been flattened by the harness at this point, so this is only
    // a sanity line: the desk's size is how many distinct coins the tape carried.
    let entered = 0;
    for (const watch of desk.values()) if (watch.spent) entered += 1;
    console.error(
      `desk closed (${done.reason}): ${desk.size} mints seen, ${entered} entered, ` +
        `${state.cash} lamports left, ${state.positions.size} open`,
    );
  },
};
