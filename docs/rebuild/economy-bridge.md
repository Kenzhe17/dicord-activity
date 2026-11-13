# Economy Bridge — cross-project architecture

Status: **balance lookup + pooled-stake escrow/settle/refund, paid stakes
gated by `ARCADE_STAKES_ENABLED` (default off) and
`ECONOMY_BRIDGE_WRITES_ENABLED` on the bot.**

## Constraint discovered in production

Arcade (`feisty-trust`) and the bot (`industrious-hope`) live in
**different Railway projects**. Railway private networking
(`*.railway.internal`) does not route across projects, so the bridge
must use authenticated public HTTPS instead.

## Chosen design (short-term)

```
Browser ──HTTPS──> Arcade server ──HTTPS──> Bot public domain
                      │                        │
                      │  GET /api/economy/     │  aiohttp listener
                      │      balance           │  GET /internal/economy/balance
                      │  (session auth)        │  (X-Bridge-Token + rate limit)
                      ▼                        ▼
                Arcade Postgres          Bot Postgres (source of truth)
                (never touched by        user_balance(guild_id,user_id,balance)
                 the bridge)
```

- The bot's `services/economy_bridge.py` listener is the only new
  network surface. It is **off unless** `ECONOMY_BRIDGE_TOKEN` and
  `ECONOMY_BRIDGE_PORT` are set.
- Railway terminates TLS on the bot service's public domain and forwards
  to `ECONOMY_BRIDGE_PORT`. The endpoint is never reachable without the
  shared secret (`hmac.compare_digest`, constant time) and is rate
  limited per IP (`ECONOMY_BRIDGE_RATE_LIMIT`, default 600/min — all
  Arcade calls share the service egress IP, so the limit must cover
  aggregate traffic, not per-user).
- The bridge performs a **plain SELECT** on `user_balance`. It never
  calls `user_balance_store.get_balance()` (which can INSERT a default
  wallet and apply daily decay), never writes, and never exposes the
  database or credentials.
- The Arcade server adapter (`apps/server/src/economy.ts`) sends the
  token only in the `x-bridge-token` header, uses a 3s timeout, treats
  any failure as "unavailable" (never a fake balance), and is disabled
  unless all three `ARCADE_ECONOMY_*` variables are set.
- The browser only ever sees `GET /api/economy/balance`, which requires
  a valid Arcade session and returns `{enabled, available, reason?,
  balance, walletExists, writesEnabled}`. `reason` classifies bridge
  failures (`unavailable`, `unauthorized`, `rate_limited`,
  `invalid_response`, `bad_request`) so the UI never mistakes an outage
  for "not configured" and never shows a fake balance. `writesEnabled`
  mirrors the bot's `ECONOMY_BRIDGE_WRITES_ENABLED` flag so the UI can
  warn that stakes are disabled bot-side before a paid match is tried.
  No database URL or bridge token reaches the client.
- `GET /internal/economy/health` on the bot is a token-protected
  liveness probe (`{ok, writes_enabled}`) for Railway-side diagnostics —
  it touches no balances.

## Railway variables (names only — set values in the dashboard)

Bot service (`industrious-hope`):

| Variable | Value |
| --- | --- |
| `ECONOMY_BRIDGE_TOKEN` | strong random shared secret (same as Arcade) |
| `ECONOMY_BRIDGE_PORT` | port the aiohttp listener binds (e.g. `8080`) |
| `ECONOMY_BRIDGE_HOST` | `0.0.0.0` (required for the public domain to reach it) |
| `ECONOMY_BRIDGE_RATE_LIMIT` | optional, default `600` requests/IP/minute |
| Networking | generate a **public domain** targeting `ECONOMY_BRIDGE_PORT` |

Arcade service (`feisty-trust`):

| Variable | Value |
| --- | --- |
| `ARCADE_ECONOMY_BRIDGE_URL` | `https://<bot-public-domain>` (no path, no port) |
| `ARCADE_ECONOMY_BRIDGE_TOKEN` | same shared secret |
| `ARCADE_ECONOMY_GUILD_ID` | the Discord guild ID the wallet belongs to |

The bridge token must never appear in logs, commits, or client code.
Rotate by updating both services together; during rotation one side
simply reports "unavailable" — no data risk (read-only).

## Balance consistency rules

- `user_balance` remains the single source of truth; Arcade stores no
  coins.
- A missing wallet row is reported as `{balance: null, exists: false}`;
  the Arcade UI shows `—` plus an explanatory note, **not** `0` — the
  bot's `get_balance()` would create the wallet with the default
  `STARTING_BALANCE` (100) on the user's next bot interaction, and the
  read path must not create it.
- Daily decay above the threshold is applied lazily by the bot inside
  `get_balance()`/`subtract_balance()`. The read-only bridge returns the
  **stored** amount; a bot command may display a slightly different
  (post-decay) value until the next wallet write persists it. This is
  documented behavior, not a bug — Arcade never mutates balances.
- When paid stakes are eventually implemented, debits MUST use atomic
  conditional updates (`UPDATE … WHERE balance >= $n`) plus an
  operation ledger — the existing check-then-update `subtract_balance()`
  is not safe for concurrent stakes (see audit).

## Alternative considered: project consolidation

Moving the bot service into the `feisty-trust` project (or Arcade into
`industrious-hope`) would restore private networking, but it requires
migrating Railway services and re-pointing the bot's database,
discord connections and secrets — a production change that needs a
maintenance window and explicit approval. Not attempted.

## Paid-stake enablement checklist

- Bot-side operation ledger + atomic conditional debit/credit endpoints
  (idempotent by operation ID) — **implemented** (`arcade_escrow` /
  `arcade_ledger` / `arcade_pending_credit`, advisory locks, replay-safe).
- Arcade-side stake hold/payout/refund state machine — **implemented**
  (`stake_hold`/`stake_payout` `EconomyOperation` rows, deterministic
  escrow op IDs per request, orphan-refund reconciliation scan).
- Remaining before flipping `ARCADE_STAKES_ENABLED=true` in production:
  verify the public bridge URL end-to-end (`/internal/economy/health`
  then a real escrow/settle/refund cycle on test wallets), confirm
  `ECONOMY_BRIDGE_WRITES_ENABLED=true` on the bot, and run a live
  paid-match smoke test.
