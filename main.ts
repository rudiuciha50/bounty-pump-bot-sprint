// Entrypoint for the pump.fun replay sprint.
//
// The grader runs `node /bot/main.ts` from the repository root on a Node build that erases the
// TypeScript annotations while loading, so nothing is compiled and nothing is installed: this file
// plus strategy.ts plus the vendored protocol shim are the whole program.
//
// Responsibilities are split on purpose. vendor/makefun-bot.ts speaks the wire — it drains stdin one
// JSON line at a time, folds every batch into a BotState (account, holdings, curves, in-flight
// orders), writes exactly one reply per batch to stdout and stops at `done`. strategy.ts holds the
// opinions: when to open a curve, how much to put in, when to take the exit. This file is the glue
// between them and nothing else, which means it also owns the bookkeeping the other two must not
// care about:
//
//   * one supervised turn per batch, so a throw inside the strategy cannot take the run down
//     mid-replay and strand the remaining slots unanswered;
//   * a running tally of what the protocol charged us, split into curve fees and transaction fees;
//   * the closing report on stderr, where stdout stays clean for protocol replies.
//
// Determinism matters: the entry is replayed twice and both action logs have to hash the same, so
// there is no Date.now, no process.env read that changes behaviour and no Math.random anywhere below.

import { PROTOCOL, runBot } from './vendor/makefun-bot.ts';
import type { Batch, Bot, BotState, Done, OrderInput } from './vendor/makefun-bot.ts';
import { strategy } from './strategy.ts';

/** What the supervisor accumulated across the replay, printed once at the end. */
interface Ledger {
  /** Batches the shim asked us to answer. */
  batches: number;
  /** Orders we queued, split by side. */
  buys: number;
  sells: number;
  /** Lamports the curve itself charged (protocol + creator share). */
  curveFees: bigint;
  /** Lamports burned on base and priority fee, paid whether an order filled or not. */
  txFees: bigint;
  /** Turns where the strategy threw and we answered with an empty reply instead. */
  salvaged: number;
  /** Orders a reply had to drop to stay inside the protocol's per-reply cap. */
  trimmed: number;
}

const ledger: Ledger = {
  batches: 0,
  buys: 0,
  sells: 0,
  curveFees: 0n,
  txFees: 0n,
  salvaged: 0,
  trimmed: 0,
};

/** Cash at hello, so the closing report can state a return and not just a balance. */
let openingCash = 0n;

/**
 * Wrap the strategy in a supervisor. The wrapper is deliberately thin: it forwards the call, counts
 * what came back, and on a throw logs the batch's slot and replies with no orders at all rather than
 * letting the exception abort the replay. An empty reply is legal protocol; an unanswered batch is not.
 */
const supervised: Bot = {
  onHello(state: BotState): void {
    if (state.hello.protocol !== PROTOCOL) {
      console.error(`unexpected protocol ${state.hello.protocol}, expected ${PROTOCOL}`);
    }
    openingCash = state.cash;
    strategy.onHello?.(state);
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    ledger.batches += 1;
    for (const fill of batch.fills) {
      if (fill.status === 'rejected') continue;
      ledger.curveFees += BigInt(fill.fee_lamports);
      ledger.txFees += BigInt(fill.tx_fee_lamports);
    }

    let orders: OrderInput[];
    try {
      orders = (strategy.onBatch(state, batch) ?? []) as OrderInput[];
    } catch (error) {
      ledger.salvaged += 1;
      const why = error instanceof Error ? error.message : String(error);
      console.error(`slot ${batch.slot}: strategy threw (${why}), answering with no orders`);
      return [];
    }

    for (const order of orders) {
      if (order.side === 'buy') ledger.buys += 1;
      else ledger.sells += 1;
    }

    // Hard ceiling on the reply. The shim throws OrderError on a reply one order over the cap, and a
    // throw here would end the process mid-replay; trimming instead keeps the run alive and leaves a
    // line on stderr so a strategy change cannot silently overrun the protocol.
    const cap = state.hello.caps.max_orders_per_batch;
    if (orders.length > cap) {
      ledger.trimmed += orders.length - cap;
      console.error(`slot ${batch.slot}: reply held ${orders.length} orders, trimmed to ${cap}`);
      orders = orders.slice(0, cap);
    }
    return orders;
  },

  onDone(state: BotState, done: Done): void {
    strategy.onDone?.(state, done);
    const closed = state.cash;
    const delta = closed - openingCash;
    const sign = delta >= 0n ? '+' : '-';
    const abs = delta >= 0n ? delta : -delta;
    const sol = (lamports: bigint): string =>
      `${lamports / 1_000_000_000n}.${String(lamports % 1_000_000_000n).padStart(9, '0')}`;
    console.error(
      `run ${done.reason}: ${ledger.batches} batches, ${ledger.buys} buys and ${ledger.sells} sells, ` +
        `${ledger.salvaged} salvaged, ${ledger.trimmed} trimmed`,
    );
    console.error(
      `cash ${sol(closed)} SOL (${sign}${sol(abs)}), ` +
        `curve fees ${sol(ledger.curveFees)}, tx fees ${sol(ledger.txFees)}, ` +
        `${state.positions.size} still open`,
    );
  },
};

const result = await runBot(supervised);

// The shim resolves only after `done`, so reaching this line means the reply stream stayed in
// protocol the whole way. Print the shim's own count too: it is the independent witness of how many
// batches were answered, and a mismatch with our tally would mean the supervisor missed a turn.
console.error(`replay closed after ${result.batches} batches answered by the shim`);
