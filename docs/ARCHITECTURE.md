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
             │ :3083   │  │  :3080    │ │ :3084   │ │:3087  │ │ gateway│
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
          │  PlatformRegistry (Sepolia)│                │ hash-verified       │
          │  EventContract721 (clone) │◀───────────────│ webhook (HMAC-SHA256)│
          │  EventContract1155 (clone)│                └─────────────────────┘
          └───────────────────────────┘
```

## Components

| Component | Runtime | Purpose |
|---|---|---|
| **Storefront** (`gembaticket.com`) | React 19 SPA served by `serve` on :3083 | Event browsing, guest checkout, ticket view (`/ticket/:id`), NFT claim |
| **Dashboard** (`dashboard.`) | React 19 SPA on :3084 | Organizer UX — event creation, deploy payment, supply management, scanners, zones, action history |
| **API** (`api.`) | Node 20 + Express on :3080 | Public REST endpoints, webhook handlers, JWT auth, OTP, ticket lifecycle |
| **Scanner PWA** (`scanner.`) | Static Vite build on :3087 | Gate-staff app — QR decode, offline outbox (Dexie), zone enforcement |
| **Event listener** (worker) | Node 20 | Watches PlatformRegistry + Event contracts, mirrors on-chain state to Prisma (via `BlockSync`) |
| **Chain worker** (`chainActivationWorker`) | Node 20 | Processes the `ChainJob` queue — ticket activation + paid chain actions. Exponential backoff at `[30s, 2m, 10m, 1h, 4h]` up to 5 attempts |
| **Scanner server** (worker) | Node 20 | Hot-path validator for scanner devices (bcrypt apiKey compares happen in-process) |

## Subdomains

| Subdomain | Backend | TLS |
|---|---|---|
| `gembaticket.com` | :3083 (storefront) | Cloudflare Origin |
| `api.gembaticket.com` | :3080 (API) | Cloudflare Origin |
| `dashboard.gembaticket.com` | :3084 (dashboard SPA) | Cloudflare Origin |
| `scanner.gembaticket.com` | :3087 (scanner PWA) | Cloudflare Origin (HTTPS required for camera) |
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
| **Owner** | Organizer wallet | Sovereign actions (`transferOwnership`, `cancelEvent`, `endEvent`, `setPlatform`, `setMintSigner`, `setOperator`) |
| **Operator** | Platform signer (default) | Day-to-day ops (`increaseSupply`, `toggleSale`, `toggleTicketType`, `addTicketType`, `setTypeURI`, `updateBaseURI`). Organizer can revoke via `setOperator(0x0)` / `renounceOperator` |
| **Platform** | Platform signer (one-time) | Initial `setupEvent` phase only; locked after |
| **MintSigner** | Platform signer (EIP-712) | Signs off-chain claim messages for lazy mint |

Details: [`CHAIN_ACTIONS.md`](./CHAIN_ACTIONS.md).

Each event contract is an **EIP-1167 minimal-proxy clone** of a UUPS-upgradeable template (`EventContract721` or `EventContract1155`), deployed via `PlatformRegistry.createEvent(...)`.

## Request paths

### Storefront — guest purchase

1. `POST /api/auth/purchase-otp/send { email, eventId, ticketTypeId, quantity }` → Redis `otp:purchase:{email}`, email via SMTP with event context.
2. `POST /api/auth/purchase-otp/verify { email, code }` → opaque `otpToken` (15-min TTL).
3. `POST /api/tickets/buy { eventId, ticketTypeId, quantity, email, otpToken }` → creates/finds ghost-wallet `Organizer`, PENDING tickets, GembaPay charge; returns `{ paymentUrl, ticketId }`.
4. Buyer pays in GembaPay; webhook `POST /webhooks/gembapay` → set `PAID`, enqueue mint if requested, send ticket email.

### Dashboard — deploy an event

1. Organizer creates the event on the dashboard (`POST /api/events`, `POST /api/events/:id/ticket-types`).
2. `POST /api/events/:id/deploy` → GembaPay charge (€10), orderId `deploy-{eventId}-{rand}`.
3. Webhook `POST /webhooks/gembapay` → `handleDeployPayment` → upload metadata to IPFS, `PlatformRegistry.createEvent`, `setupEvent(ticketTypes)`, `Event.status = ACTIVE`.
4. Dashboard polls `GET /api/events/:id` every 5s while `DEPLOYING`.

### Dashboard — paid chain action

See [`CHAIN_ACTIONS.md`](./CHAIN_ACTIONS.md). Full flow: estimate → GembaPay → webhook → ChainJob → receipt → (sync DB + email) or (refund + email).

### Scanner — validate at the gate

1. Scanner app sends `Authorization: Bearer <scanner-JWT>` (or `X-Scanner-Key: <plain apiKey>`).
2. `POST /api/scanner/validate { payload }` — decodes the rotating QR, checks `Ticket.status`, enforces `ScannerDevice.zones ⊇ ticket.zoneLevel`, writes `ScanLog`, enqueues `activate_ticket` ChainJob.
3. Worker submits `EventContract.activateTicket(tokenId)`; short-circuits if already activated on-chain.

## SEO + AI discoverability

Served from the storefront public root (Vite `/public`):

- `/robots.txt`
- `/sitemap.xml`
- `/llms.txt` — summary + entry points for LLM crawlers
- `/ai.txt` — data-use policy
- JSON-LD (`Organization`, `WebSite`, `SoftwareApplication`) injected via `react-helmet-async`
- Open Graph + Twitter Cards on every public page
- Canonical URLs via helmet

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
- **On-chain**: EIP-712 claim signatures bind to `(tokenId, buyerAddress, eventContract)` with a mint-signer private key that is **never on the ticket-writing hot path**.

See [`blockchain/docs/audit_solidity.md`](../blockchain/docs/audit_solidity.md) for the formal audit (Slither 0/0/0, Mythril 0/0/0, 220 functional assertions).
