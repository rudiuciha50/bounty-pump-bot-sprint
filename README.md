# bounty-pump-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rudiuciha50/bounty-pump-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rudiuciha50/bounty-pump-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading pump.fun bot for the make.fun **Pump.fun Bot Sprint: Make Bot And Win** bounty.
It reads the replay's `hello` / `batch` / `done` protocol on stdin, answers each slot with at most
one reply of orders, and is scored on net PnL over six hours of bonding-curve events.

## The strategy: deep survivor rider

A pump.fun price is a pure function of the bonding curve, so the only state worth keeping per mint
is its real SOL reserve (`real_quote_reserves`). Two things the dev window showed, measured offline
against the published dataset first:

- **Launch sniping is not the edge.** The median coin doubles within ~15 slots of its `CreateEvent`,
  but the tail collapses, and the 95 bps protocol plus 30 bps creator fee is paid on *both* legs of
  every round trip. Hundreds of tiny round trips leave the account deep in the red even when the
  entry filter itself is fine.
- **Deep, busy coins are.** Survivors print 6 to 3350 trades over 300 to 2200 slots, so a coin that
  has already printed 400 trades has proved there is real flow behind it. A handful of large,
  patient round trips pays the fee a handful of times instead of hundreds.

So the bot:

- waits for **400 trade ticks** on a mint before it counts as a survivor;
- **never enters a curve past 60 SOL of real reserve** — the curve finishes near 85 SOL, so a coin
  bought that late can no longer reach the 2x target and only occupies a slot;
- sends **one buy per coin** (buys on one mint inside one reply share a single 1%-of-real-reserve
  cap, so splitting a stake would just be refused), sized to that per-mint cap under a 1 SOL ceiling;
- exits at **2x the entry reserve** — about 4x on market cap — or **recycles after 250 slots** so
  stale positions free their slot and at least 20 distinct coins get a round trip;
- takes **no stop loss**: the tail is the edge, and a stop pays the fee twice to cut it off.

## Guardrails

| guardrail | bar | this bot on the dev window |
| --- | --- | --- |
| round trips of ≥ 0.01 SOL | ≥ 20 coins | 73 coins |
| max drawdown | ≤ 50% | 8.4% |
| determinism | two runs byte-identical | reproduced byte for byte |

Dev-window grade (`grade-local`, process driver): **net PnL +1.464526599 SOL**, 142 fills over 73
coins, win rate 0.438, and still **+0.941746200 SOL at 2x fees**.

## Run it

```sh
node main.ts            # speaks the replay protocol on stdin/stdout
```

Node 22.18+ runs the TypeScript as it is; on 22.6–22.17 use
`node --experimental-strip-types main.ts`. Nothing reads the clock, the environment, the network or
`Math.random`, so the grader's two executions produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint: hands `strategy` to the vendored SDK shim.
- `strategy.ts` — the survivor-rider logic described above.
- `vendor/makefun-bot.ts` — the kit's protocol shim (stdlib only, no install, no network).

---

<sub>Entered on [make.fun](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed).</sub>
