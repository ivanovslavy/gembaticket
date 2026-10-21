# Architecture

## High level

```
              ┌──────────────────────────────────────────────────────────┐
              │                      Cloudflare                          │
              └─────┬───────────┬───────────┬───────────┬──────────┬─────┘
                    │           │           │           │          │
                    ▼           ▼           ▼           ▼          ▼
              gembaticket  api.gemba…  dashboard.g…  scanner.g…  ipfs.g…
                    │           │           │           │          │
              ┌─────┴───────────┴───────────┴───────────┴──────────┴─────┐
              │                Apache (TLS + reverse proxy)              │
              └─────┬───────────┬───────────┬───────────┬──────────┬─────┘
                    │           │           │           │          │
             ┌──────▼──┐  ┌─────▼─────┐ ┌───▼─────┐ ┌──▼────┐ ┌───▼────┐
             │ :3103   │  │  :3100    │ │ :3104   │ │:3107  │ │ gateway│
             │ web SPA │  │ API       │ │ dashboard│ │scanner│ │ IPFS   │
             │         │  │ Express + │ │ SPA     │ │ PWA   │ │ public │
             │         │  │ Prisma    │ │         │ │       │ │ CID    │
             └─────────┘  └──┬───┬────┘ └─────────┘ └───────┘ └────────┘
                             │   │
                   ┌─────────┘   └─────────┐
                   ▼                       ▼
             ┌─────────┐             ┌─────────────┐        ┌────────────┐
             │PostgreSQL│             │  Redis 7    │        │  GembaPay  │
             │    16    │             │ (port 6380) │        │  webhook   │
             └─────────┘             └─────────────┘        └────────────┘
                   ▲                       ▲                       │
                   │                       │                       │
             ┌─────┴──────────────────┐    │                       │
             │  eventListener worker  │    │                       │
             │  chainActivationWorker │────┘                       │
             │  scannerServer worker  │                            │
             └──────────┬─────────────┘                            │
                        │                                          │
                        ▼                                          ▼
          ┌───────────────────────────┐                ┌─────────────────────┐
          │  PlatformRegistry (GembaBlockchain)│                │ hash-verified       │
          │  EventContract721 (clone) │◀───────────────│ webhook (HMAC-SHA256)│
          │  EventContract1155 (clone)│                └─────────────────────┘
          └───────────────────────────┘
```

## Components

| Component | Runtime | Purpose |
|---|---|---|
| **Storefront** (`gembaticket.com`) | React 19 SPA served by `serve` on :3103 | Event browsing, guest checkout, ticket view (`/ticket/:id`), NFT claim |
| **Dashboard** (`dashboard.`) | React 19 SPA on :3104 | Organizer UX — event creation, deploy payment, supply management, scanners, zones, action history |
| **API** (`api.`) | Node 20 + Express on :3100 | Public REST endpoints, webhook handlers, JWT auth, OTP, ticket lifecycle |
| **Scanner PWA** (`scanner.`) | Static Vite build on :3107 | Gate-staff app — QR decode, offline outbox (Dexie), zone enforcement |
| **Event listener** (worker) | Node 20 | Watches PlatformRegistry + Event contracts, mirrors on-chain state to Prisma (via `BlockSync`) |
| **Chain worker** (`chainActivationWorker`) | Node 20 | Processes the `ChainJob` queue — ticket activation + paid chain actions. Exponential backoff at `[30s, 2m, 10m, 1h, 4h]` up to 5 attempts |
| **Scanner server** (worker) | Node 20 | Hot-path validator for scanner devices (bcrypt apiKey compares happen in-process) |

## Subdomains

| Subdomain | Backend | TLS |
|---|---|---|
| `gembaticket.com` | :3103 (storefront) | Cloudflare Origin |
| `api.gembaticket.com` | :3100 (API) | Cloudflare Origin |
| `dashboard.gembaticket.com` | :3104 (dashboard SPA) | Cloudflare Origin |
| `scanner.gembaticket.com` | :3107 (scanner PWA) | Cloudflare Origin (HTTPS required for camera) |
| `listener.gembaticket.com` | worker health endpoint | Cloudflare Origin |
| `ipfs.gembaticket.com` | IPFS gateway | Cloudflare Origin |

## Data stores

- **PostgreSQL 16** — primary DB via Prisma.
- **Redis 7 on port 6380** (not default 6379) — OTP codes, verification tokens, rate-limit counters.

## Prisma schema highlights

- **`Organizer`** — email+password / ghost-wallet / SIWE-only all coexist on this table.
- **`Event`** — `status ∈ { PENDING_PAYMENT, DEPLOYING, ACTIVE, ENDED, CANCELED }`, optional `contractAddress`, `ipfsHash`, `saleActive`, `operatorAddress` (relay operator; `null` = organizer revoked).
- **`TicketType`** — per-event, with `typeId` (on-chain), `zoneLevel` (linked to `Zone.level` / `ScannerDevice.zones[]`), `active`.
- **`Ticket`** — `status ∈ { PENDING_PAYMENT, PAID, MINTING, MINTED, CLAIMED, ACTIVATED, CANCELED, REFUNDED }`.
- **`ChainAction`** — every paid on-chain op (fn name, args JSON, GembaPay `paymentId`, `txHash`, `status`, `retryOfId`, `attempts`). See [`CHAIN_ACTIONS.md`](./CHAIN_ACTIONS.md).
- **`ChainJob`** — worker queue for async chain writes (activation + paid actions).
- **`ScannerDevice`** — bcrypt `apiKeyHash` (hot-path auth) + AES-GCM `apiKeyEnc/apiKeyNonce` (reversible for dashboard re-reveal) + `apiKeyPrefix` (first 8 chars, indexed for ≤5-candidate lookup).
- **`Zone`** — named, colored regions per event, `@@unique([eventId, level])`.
- **`ScanLog`** — audit trail for every scanner action (`scan`, `activate`, `reveal`).
- **`WebhookLog`** — GembaPay payload + HMAC-verified status.
- **`BlockSync`** — per-contract-type last-processed block, keyed by `(chainId, contractType)`.

## Smart contract model

Four roles per event contract:

| Role | Holder | Permissions |
|---|---|---|
| **Owner** | The organizer's wallet if they connected one; otherwise the platform's **cold owner key** (ownership is handed over after setup) | Sovereign actions (`transferOwnership`, `cancelEvent`, `endEvent`, `setPlatform`, `setMintSigner`, `setOperator`, `setRelayer`) |
| **Operator** | Platform signer (default) | Day-to-day ops (`increaseSupply`, `toggleSale`, `toggleTicketType`, `addTicketType`, `setTypeURI`, `updateBaseURI`). Organizer can revoke via `setOperator(0x0)` / `renounceOperator` |
| **Platform** | Platform role key | The setup phase (locked after), `activateTicket` at the gate, and a ONE-time `cancelEvent` / `endEvent` (used by the dashboard cancel and the automatic end) |
| **Relayer** | Relayer key | Broadcasts gasless NFT claims (`claimTicketFor`) |
| **MintSigner** | Mint signer key (EIP-191) | Signs off-chain claim messages; never sends transactions |

Details: [`CHAIN_ACTIONS.md`](./CHAIN_ACTIONS.md).

Each event contract is an **EIP-1167 minimal-proxy clone** of a UUPS-upgradeable template (`EventContract721` or `EventContract1155`), deployed via `PlatformRegistry.createEvent(...)`.

## Request paths

### Storefront — guest purchase

1. `POST /api/auth/purchase-otp/send { email, eventId, ticketTypeId, quantity }` → Redis `otp:purchase:{email}`, email via SMTP with event context.
2. `POST /api/auth/purchase-otp/verify { email, code }` → opaque `otpToken` (15-min TTL).
3. `POST /api/tickets/buy { eventId, ticketTypeId, quantity, email, otpToken }` → creates/finds ghost-wallet `Organizer`, PENDING tickets, GembaPay charge; returns `{ paymentUrl, ticketId }`.
4. Buyer pays in GembaPay; webhook `POST /webhooks/gembapay` → set `PAID`, enqueue mint if requested, send ticket email.

### Dashboard — deploy an event

1. Organizer creates the event on the dashboard (`POST /api/events`, wall-clock times + venue zone).
2. `POST /api/events/:id/deploy` — free while `FEES_ENABLED=false` (paid mode, dormant: a GembaPay charge `deploy-{eventId}-{ts}` first).
3. `handleDeployPayment` (queued — one deploy at a time across the API and the chain worker) → IPFS metadata, `PlatformRegistry.createEvent` (clone of the current template), `setupEvent(ticketTypes)`, `Event.status = ACTIVE`, then the role hand-off (relayer / operator / platform keys, ownership → cold owner).
4. Dashboard polls `GET /api/events/:id` every 5s while `DEPLOYING`.

Templates since 2026-10-21: 721V3 `0x3Ba630bF309249354F25a22c2f0A3EC6b34183D8`, 1155V3 `0x1a7722d1292cd5eB67A05fC8B51DFDe821055cDa` — G1-hardened (only canonical low-s signatures; `activateTicket` refuses a never-minted token), initialized with the cold owner so nobody can take them over. Events created earlier keep their own (immutable) code.

### Event lifecycle — cancel, end, refunds

- **Cancel** (dashboard, 2FA): event + live tickets CANCELED in one transaction, buyers e-mailed, `cancelEvent()` on-chain; refunds automatic (one GembaPay v1 refund per order on the organizer's key, `Idempotency-Key gt-cancel-<orderId>`) or manual (organizer refunds in GembaPay; `payment.refunded` marks tickets).
- **End**: a 60-second background tick ends every ACTIVE event whose last entry window has closed and calls `endEvent()`; the same tick drives pending refunds and retries a transient chain failure.
- **Single refunds**: dashboard *Refund* (2FA) → partial GembaPay refund of the ticket's `pricePaid`.

### Dashboard — paid chain action

See [`CHAIN_ACTIONS.md`](./CHAIN_ACTIONS.md). Full flow: estimate → GembaPay → webhook → ChainJob → receipt → (sync DB + email) or (refund + email).

### Storefront — NFT claim (gasless)

1. The holder connects a wallet and signs a **free** ownership message (no transaction, no gas).
2. `POST /api/claim/relay { ticketId, walletAddress, ownershipSignature, claimCode }` — the API checks the claim code and the signature, the mint signer signs `(contract, typeId?, claimHash, recipient)`, and the **relayer** broadcasts `claimTicketFor()` and pays the gas. The recipient is bound into the signature, so a relayer cannot redirect the NFT; `usedClaims[claimHash]` prevents a double mint.
3. The `TicketClaimed` log gives the token id; `nftClaimed / tokenId / claimedWallet` are written. Canceled or refunded tickets cannot be claimed.

The client-pays `claimTicket` path still exists in the contract; its `/api/claim/sign` + `/confirm` routes are disabled.

### Scanner — validate at the gate

1. Scanner app sends `Authorization: Bearer <scanner-JWT>` (or `X-Scanner-Key: <plain apiKey>`).
2. `POST /api/scanner/scan` (preview) / `POST /api/scanner/activate` (admit) — verifies the rotating QR, the device's event / organizer / zone scope, the entry window, and refuses canceled or ended events and canceled / refunded / unpaid tickets; writes `ScanLog`.
3. For a claimed NFT the activation is mirrored on-chain: an `activate_ticket` ChainJob → the worker calls `activateTicket(tokenId)` as the platform role key.
4. Offline: the PWA validates against `GET /api/scanner/snapshot` and replays decisions via `POST /api/scanner/sync`; an admission made elsewhere meanwhile returns as a flagged conflict.

## SEO + AI discoverability

Served from the storefront public root (Vite `/public`):

- `/robots.txt`
- `/sitemap.xml`
- `/llms.txt` — summary + entry points for LLM crawlers
- `/ai.txt` — data-use policy
- JSON-LD (`Organization`, `WebSite`, `SoftwareApplication`) injected via `react-helmet-async`
- Open Graph + Twitter Cards on every public page
- Canonical URLs via helmet

## RPC fallback pool

All read/write calls to GembaBlockchain flow through `backend/src/utils/fallbackProvider.js` — a `FallbackJsonRpcProvider` that wraps 15 endpoints (`backend/src/config/rpcEndpoints.js`). Public nodes (publicnode, drpc, 1rpc, blastapi, omniatech, Ankr) are tried first so keyed endpoints (Infura, Alchemy, QuickNode, Moralis, Ankr-keyed) don't burn their quota; on a transient error (`429`, `5xx`, `-32090 retry-after`, missing-response / timeout) the provider rotates to the next endpoint and honours the advertised cooldown. Contract reverts bubble up unchanged. The active pool targets **GembaBlockchain** RPC endpoints (`rpc1`/`rpc2`/`rpc3.gembascan.io`) — GembaTicket's own EVM Layer-1 (the platform was originally planned for Polygon; it now runs on GembaBlockchain).

## Observability

- `journalctl -u gembaticket-api -f` — API logs.
- `journalctl -u gembaticket-chain-worker -f` — chain worker.
- `journalctl -u gembaticket-listener -f` — listener.
- Health: `GET /health` on every service.

## Security surface

- **JWT** (HS256, `JWT_SECRET`) for organizer + scanner auth.
- **Email OTP** (Redis-backed, 6-digit, 10-min TTL, 5 attempts, 30s resend cooldown).
- **Cloudflare Turnstile** on `register` / `login` (optional).
- **GembaPay webhooks** verified via HMAC-SHA256 over `req.rawBody` (captured in `express.json` `verify:` callback — do not strip).
- **AES-256-GCM** for scanner key re-reveal (master key `SCANNER_KEY_SECRET` — 32-byte hex, or a passphrase stretched via SHA-256).
- **On-chain**: claim signatures (EIP-191) bind `(eventContract, typeId?, claimHash, recipient)`; the mint-signer key never sends transactions. New events use the G1 templates (low-s only, no activation of unminted tokens).
- **2FA** (email code or authenticator app) on every money- or event-changing action: date/venue edit, cancel, refunds.
- **Deploy key**: one writer at a time (Redis lock shared by the API and the chain worker).
- **Backups**: nightly, age-encrypted (database, service state, all IPFS pins), private key off the server, off-site copy checksum-verified, restore tested in isolation.

See [`blockchain/docs/audit_solidity.md`](../blockchain/docs/audit_solidity.md) for the formal audit (Slither 0/0/0, Mythril 0/0/0, 220 functional assertions).
