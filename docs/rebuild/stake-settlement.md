# Pooled-stake settlement rules (design — not yet enabled)

Status: **proposal for review. Paid-stake mode is disabled.** No debits,
payouts or reservations are performed yet.

## Pool model

- Optional room-level stake in the bot's coin currency; every participant
  contributes the same fixed amount; host picks from an allowlist.
- Default is a free match. Stake is locked when the match starts and can
  never change mid-match.
- The match may start only after every participant's reserve succeeded.
- All amounts are integers; the pot is conserved exactly (no fees).

## Settlement policy (single Durak loser)

One player remains with cards when the deck is empty — the Durak loser.

| Outcome | Loser | Non-losing participants |
| --- | --- | --- |
| Normal finish | receives nothing | split the pool equally |
| 2-player game | receives nothing | winner takes the whole pool |
| Draw (everyone out simultaneously, no forfeits) | — | full refund to everyone |
| Interrupted match (24h absence, server loss) | — | full refund to everyone |
| Cancelled before start / reservation failure | — | full refund of any held reserves |

Integer split: `share = floor(pool / winners)`, remainder `pool % winners`
distributed one coin each to the first `remainder` winners in seat order
(deterministic, sum == pool).

## Forfeits (`surrender` action)

Forfeited players are **always losers** and receive nothing, in every
multiplayer outcome:

- **One surrender, 3–6 players:** match continues; at the end the
  forfeiter + the final card-holder are losers; everyone else splits
  the pool. If the match is later drawn among the remaining players,
  the forfeiter still loses and the others split the pool.
- **Multiple surrenders:** each forfeiter is a loser; pool splits among
  the players who neither forfeited nor ended as Durak.
- **Surrender reduces seats to ≤1:** match ends immediately; every
  forfeited seat loses; if exactly one non-forfeited player remains they
  take the whole pool (equivalent to a 2-player win).
- **2-player surrender:** forfeiter loses, opponent takes the whole pool.
- **Interrupted after forfeits:** forfeits are already recorded in the
  match result; an interrupted match refunds everyone **including**
  forfeited players? — **Open question, see below.**

## Open questions requiring confirmation before enabling payouts

1. Interrupted/cancelled match **after** forfeits occurred: refund all
   reserves (forfeits voided by interruption) or honour forfeits?
   Recommendation: refund all — interruption is infrastructure failure,
   not a game outcome; forfeits only settle on a recorded result.
2. Player disconnects without surrender: no effect on settlement; seat
   is auto-played by timeouts until the match ends or is interrupted.
3. Forfeited player who already left the room: settlement must still
   reach their wallet — payouts are per-participant, not per-member.
4. Balance cap (`MAX_BALANCE = 100000`): winnings that would exceed the
   cap are clipped by the bot's `add_balance`; the clipped amount is
   burned, not redirected — acceptable or should excess go to losers?
   Recommendation: accept clipping (matches bot semantics), log it.

## Transaction state machine (future)

`EconomyOperation` (arcade schema) + bot-side ledger:

CREATED → RESERVING → FUNDED → IN_PROGRESS → SETTLING → SETTLED
Any state → REFUNDING → REFUNDED (cancel/interrupt/insufficient funds)
Any ambiguous state → NEEDS_RECONCILIATION (manual review, never retried
blindly).

- Operation ID = match ID + purpose (`stake:<matchId>`,
  `payout:<matchId>:<playerId>`, `refund:<matchId>:<playerId>`).
- Every bot-side mutation carries the operation ID; replays are
  idempotent (unique constraint / conditional update).
- Debits use `UPDATE user_balance SET balance = balance - $n
  WHERE guild_id=$g AND user_id=$u AND balance >= $n` — atomic,
  fixes the check-then-update race in `subtract_balance`.
- Cross-database consistency is reconciled by polling operation status,
  never assumed atomic.
