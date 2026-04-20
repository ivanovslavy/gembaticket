# Backend overview

> The API and worker services that power GembaTicket. **Source lives in a private repository** — this document describes the shape and responsibilities so the public docs make sense on their own.

## Runtime

- **Node.js 20**, Express, Prisma.
- **PostgreSQL 16** — primary store (organizers, events, tickets, chain actions, scanners, webhook log, block sync).
- **Redis 7** on port 6380 — OTP codes, verification tokens, rate-limit counters.
- **Ethers.js v6** — EIP-712 signing, contract calls, and a custom `FallbackJsonRpcProvider` (see below).
- **SMTP** — transactional email (organizer OTP, ticket delivery, chain-action notifications).
- **GembaPay** — hosted checkout + HMAC-SHA256 webhook for deploy / ticket / action charges.

## Process shape

Four long-lived services per machine (see [`DEPLOYMENT.md`](./DEPLOYMENT.md) for systemd units):

| Process | Role |
|---|---|
| `gembaticket-api` | Express HTTP server (REST + webhooks). |
| `gembaticket-chain-worker` | Pulls `ChainJob`s, submits transactions, writes receipts, handles refunds, sends emails. |
| `gembaticket-listener` | Watches `PlatformRegistry` + event contracts, hydrates Prisma from on-chain state via `BlockSync`. |
| `gembaticket-scanner` | Hot-path scanner validator (bcrypt compares happen here, not in the API process). |

## Subsystems

### Auth
JWT (HS256, 7-day expiry), bcrypt passwords. Three login modes co-exist on one `Organizer` table: email+password (with optional OTP-at-login), SIWE (EIP-4361), and ghost-wallet auto-created during guest checkout. See [`OTP_FLOW.md`](./OTP_FLOW.md).

### Payments
GembaPay issues hosted-checkout URLs for three order-id prefixes (`deploy-*`, `ticket-*`, `action-*`). A single webhook endpoint `/webhooks/gembapay` verifies HMAC-SHA256 over the raw request body (captured in `express.json({ verify })`), routes to the right service by prefix, and is idempotent against replays.

### Chain actions
Every organizer-initiated on-chain change after deploy flows through one pipeline: estimate → invoice → webhook → `ChainJob` → receipt → (confirm + mirror + email) or (revert + refund + email). See [`CHAIN_ACTIONS.md`](./CHAIN_ACTIONS.md).

### Lazy mint
Tickets don't hit the chain until the buyer clicks *Claim*. The API signs an EIP-712 message binding `(tokenId, buyerAddress, eventContract)` with `MINT_SIGNER_KEY`; the buyer's wallet submits `claim(…)` themselves. The mint-signer key is never used by the hot ticket-writing path.

### Scanner
Bcrypt `apiKeyHash` for hot-path auth, plus AES-256-GCM `(apiKeyEnc, apiKeyNonce)` for dashboard re-reveal, plus `apiKeyPrefix` (first 8 chars, indexed) to narrow bcrypt candidates to ≤5 rows. Master key is `SCANNER_KEY_SECRET` — 32-byte hex.

Platform admins can additionally provision **master scanner keys** (`ScannerDevice.isMaster = true`, `organizerId = null`, `eventId = null`) that validate tickets for any event. They are one-reveal-only — no decrypt path — and live alongside organizer-scoped keys on the same table. See [`ADMIN_DASHBOARD.md`](./ADMIN_DASHBOARD.md#access--keys-access).

### Admin allowlist
Admin access to `admin.gembaticket.com` is gated by the `AdminWallet` table, not by an environment variable. `requireAdminAuth` re-checks the row on every request, so revoking an admin is effectively instant. A single master wallet is flagged `isMaster = true`, cannot be removed, and is re-seeded on every API boot (`seedAdminWallets()` in `server.js`). The `ADMIN_WALLETS` env var is only consulted on first boot. See [`ADMIN_DASHBOARD.md`](./ADMIN_DASHBOARD.md#auth-model).

### RPC resilience (`FallbackJsonRpcProvider`)
Public Sepolia RPCs rate-limit aggressively (600 req/60s on `publicnode.com`), so a single `new ethers.JsonRpcProvider(url)` would burn 75-second internal retry loops on every 429 and deadlock the API under normal dashboard polling. Instead, `src/config/blockchain.js` constructs a pool-based provider from `src/config/rpcEndpoints.js` — public endpoints first, then keyed providers (Infura, Alchemy, Ankr x5, QuickNode, Moralis) — and rotates through them on transient failures.

- **Transient → rotate**: HTTP 429, 5xx, timeouts, network errors (`ECONNRESET`, `ETIMEDOUT`, etc.).
- **Permanent → surface**: contract reverts, `INSUFFICIENT_FUNDS`, `NONCE_EXPIRED`, `CALL_EXCEPTION`.
- **Per-endpoint timeout**: 4s. Ethers' built-in retry loop is disabled (`retryFunc = () => false`) so the outer rotation drives backoff.
- **Health tracking**: a failing endpoint is marked unhealthy for 30s and skipped on the first pass; three full rotations are attempted before the error surfaces.
- **Chain support**: Sepolia (currently live), plus ready-to-use pools for Ethereum mainnet, BSC mainnet/testnet, and Polygon in `rpcEndpoints.js`.

The listener (`gembaticket-listener`) and chain worker share the same provider — any `getBlockNumber`, `queryFilter`, `estimateGas`, `getFeeData`, `waitForTransaction`, or `broadcastTransaction` call transparently fails over.

**Retry-after parsing.** Some providers (drpc.org, specifically) respond to bursts with a JSON-RPC error `code: -32090` whose message carries a Go-formatted duration — `"rate limit exceeded, retry in 10m0s"`. The provider parses that duration and marks the endpoint unhealthy for the exact window rather than using the default 30s cool-off, so a one-minute burst doesn't cause ten minutes of pointless retries.

### Listener hardening (`eventListener.js`)

The block-watcher worker is resumable via a `BlockSync` table (one row per contract — `platformRegistry` plus one row per `event_<address>`). Several guards keep it from degenerate behaviour:

- **Scan window clamped.** A newly-registered `EventCreated` contract has no `BlockSync` row, so the naïve default of "start from block 0" would try to scan ~10.7M Sepolia blocks in a single poll. The listener seeds `BlockSync` with the registration block when it processes `EventCreated`, and also clamps any single poll window to `MAX_CATCHUP_BLOCKS = 5000`. A contract that somehow lost its row catches up over several polls instead of locking the worker for minutes.
- **Block range 500.** `MAX_BLOCK_RANGE = 500` for `queryFilter`. Most public RPCs cap at 1000; 500 stays safely inside that envelope while still being 50× the old value.
- **Polling mutex.** Polls are serialised with an in-process mutex, so a slow poll can't overlap with the next scheduled one. A `skipped` log is emitted if the next tick fires while the previous poll is still running.
- **Single `getBlockNumber` per poll.** Fetched once at the top of the tick and passed down to every per-contract scan — avoids N+1 RPC hits when dozens of event contracts are tracked.
- **Timing logs.** Every poll logs its duration; polls over 5 seconds log at a higher level so they show up in the monitoring tail.

### Rate limits
Per-IP limits on auth/OTP/ticket endpoints, per-scanner on `/validate`. See [`API.md`](./API.md#rate-limits).

## Data model highlights

See [`ARCHITECTURE.md`](./ARCHITECTURE.md#prisma-schema-highlights). Core tables: `Organizer`, `Event`, `TicketType`, `Ticket`, `ChainAction`, `ChainJob`, `ScannerDevice`, `Zone`, `ScanLog`, `WebhookLog`, `BlockSync`, `AdminWallet`.

## Security posture

- HMAC-verified webhooks (raw body captured at parse time, never reconstructed).
- EIP-712 claim signatures bound to contract address (mint-signer key isolated from the API hot path).
- Reversible AES-256-GCM for scanner-key re-reveal only (not for any user-facing secret).
- Cloudflare Turnstile on register/login (optional).
- Solidity contracts audited (Slither 0/0/0, Mythril 0/0/0, 220 functional assertions) — see [`blockchain/docs/audit_solidity.md`](../blockchain/docs/audit_solidity.md).

## Where it runs

Raspberry Pi 5 (ARM64), Ubuntu Server, behind Apache + Cloudflare. [`DEPLOYMENT.md`](./DEPLOYMENT.md) has the full runbook.
