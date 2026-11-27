// Entry point: the grader runs `node /bot/main.ts` with this repository mounted at /bot, on Node
// 22.18+, which strips the TypeScript types on the fly — no build step, no install, no network.
//
// The protocol machinery (reading `hello` / `batch` / `done` lines from stdin, keeping the account,
// the curves and the pending orders current, writing exactly one reply per batch to stdout) lives
// in the vendored SDK shim at vendor/makefun-bot.ts. This file does nothing but hand our strategy
// to it and pin the two market rules that are easy to get wrong:
//
//   * buys on one coin inside one reply share a single size cap (1% of that curve's real reserve),
//     so the strategy sends one buy per coin rather than splitting a stake across several;
//   * a coin counts against the 5-position cap from the moment its buy is written, pending or not,
//     which is what the shim's committedPositionCount() already reports.
//
// Nothing here reads the clock, the environment or Math.random, so the two graded executions of
// this program produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { strategy } from './strategy.ts';

const result = await runBot(strategy);

console.error(
  `replay run finished: ${result.batches} batches answered, ` +
    `closing cash ${result.done.account.cash_lamports} lamports, ` +
    `${result.done.account.positions.length} positions left open`,
);
