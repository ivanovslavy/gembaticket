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
| **Scanner PWA** (`scanner.`) | Static Vite build on :3107 | Gate-staff app — QR decode, offline mode (snapshot + decisions in Dexie, one offline entry right per ticket), zone enforcement |
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
| `ipfs.gembaticket.com` | IPFS gateway — serves ONLY our pinned content (kubo `Gateway.NoFetch`) | Cloudflare Origin |
| `*.ipfs.gembaticket.com` | IPFS subdomain gateway for wallets (MetaMask gateway `gembaticket.com`) — translator on .208 to `ipfs.gembaticket.com` | Let's Encrypt wildcard (DNS-01) |

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
| **Owner** | Always the platform's **cold owner key** (2026-10-23 — the clone is created platform-owned, the roles are set, ownership goes to the cold key, the roles are read back). An organizer gets ownership only on request (dashboard → *Request ownership*, 2FA), transferred by an admin with the cold wallet | Sovereign actions (`transferOwnership`, `cancelEvent`, `endEvent`, `setPlatform`, `setMintSigner`, `setOperator`, `setRelayer`) |
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
4. Offline: the PWA validates against `GET /api/scanner/snapshot` and replays decisions via `POST /api/scanner/sync`. Each ticket's offline entry right is held by ONE scanner (only it gets the seed; hand-over only with its acknowledgement — `POST /api/scanner/offline/heartbeat`), so two offline gates can never both admit a ticket.

## SEO + AI discoverability

Served from the storefront public root (Vite `/public`):

- `/robots.txt`
- `/sitemap.xml`
- ~~`/llms.txt`, `/llms-full.txt`, `/ai.txt`~~ — **retired 2026-08-09.** `og-server.cjs` holds them
  in an `AI_DESCRIPTORS` set and answers a hard 404 before the static-file branch, so writing the
  files into `public/` does not bring them back. To un-retire, remove the paths from that set.
- JSON-LD injected via `react-helmet-async` — 12 distinct `@type`s on the landing page (`Organization`, `WebSite`, `SoftwareApplication`, `FAQPage`, `Question`, `Answer`, `BreadcrumbList`, `ListItem`, `Offer`, `ContactPoint`, `PostalAddress`, `SearchAction`)
- Open Graph + Twitter Cards on every public page
- Canonical URLs via helmet

## Uploaded-poster metadata stripping

An event poster is pinned to IPFS, which is public and immutable, so it is scrubbed **before** it
leaves the API — `backend/src/utils/imageMetadata.js`, called from `createEvent`
(`backend/src/controllers/eventController.js`). Shipped 2026-10-30.

| Format | Removed | Kept |
|---|---|---|
| JPEG | APP1 (Exif, XMP), APP13 (Photoshop/IPTC), APP3–APP12, APP15, `COM` comments | APP0 (JFIF density), APP2 (ICC colour profile) |
| PNG | `eXIf`, `tEXt`, `zTXt`, `iTXt` (incl. historical "Raw profile type exif") | everything else |
| WebP | the RIFF container's `EXIF` and `XMP` chunks, with the container size fixed up | everything else |
| other / unparseable | re-encoded through `sharp`, which drops metadata by construction | — |

The strip is **lossless** for the three parsed formats: only metadata segments are removed, so the
pinned image is pixel-for-pixel the organizer's upload. The ICC profile is deliberately retained
because dropping it visibly shifts colours. If an upload cannot be cleaned even by the `sharp`
fallback, `createEvent` **refuses it with `400`** rather than pinning it.

> **Known gap.** `stripImageMetadata` has exactly one call site, inside `createEvent`.
> `updateEventDetails` accepts only `{eventDate, venue, code}` and never a poster, so there is no
> path that re-uploads an existing poster. **Posters pinned before 2026-10-30 therefore keep their
> original EXIF/XMP/IPTC under permanent, public CIDs** — they were never re-pinned clean.

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

See [`blockchain/docs/audit_solidity.md`](../blockchain/docs/audit_solidity.md) for the formal audit (Slither 0/0/0, Mythril 0/0/0, 81 contract test cases / 129 `expect()` assertions (`npx hardhat test` → 81 passing, 0 failing)).

## Data retention

Personal data is removed on a schedule, not on request only: `gembaticket-retention.timer` runs
`backend/scripts/retention.js` at 05:20 UTC daily, anonymising rows that still have accounting value
(a ticket keeps its amount and loses its buyer) and deleting rows that have none (scan logs, webhook
logs, finished chain jobs). The clock is measured from the **event's end**, not the row's age, so a
ticket to an event that has not happened is never touched. Periods, guards and audit trail:
[`RETENTION.md`](./RETENTION.md).

---

## Poster metadata — the re-clean of 2026-11-01, and why no chain write happened

The four events whose posters carried metadata were re-pinned clean on 2026-10-31 and the
application was repointed at the clean copies on 2026-11-01. **No transaction was sent.** Two
measurements, both taken before anything was changed, say why one would have been impossible and
pointless:

**`setupComplete` is `true` on all four contracts.** `setBaseURI` is `onlyPlatformSetup`, which
requires `msg.sender == platform` **and** `setupComplete == false`; `completeSetup()` is documented
as "Lock setup permanently. Platform loses setup access." Simulated as the platform address, the
call reverts on each of the four. That is the contract working as designed, not a fault.

**Nothing was ever minted, and the chain holds no URI anyway.** `totalMinted()` returns 0 on all
four. `_baseTokenURI` is the empty string — slot 6 of `EventContract721`'s storage reads zero on
Dogs Play, where slot 5 holds the event name as an inline short string; there is no public getter,
no `BaseURIUpdated` event was ever emitted, and the explorer's log for each contract contains no
IPFS string. So no NFT ever referenced the old metadata, and unpinning it could not break one.

What actually points at the metadata is the **database**: `claimController.js:201-205` sets a
per-token URI from `Event.ipfsHash` at claim time, as the operator — which still works after
`setupComplete`, because `setTokenURI` is `onlyOwnerOrOperator`. Repointing `Event.baseURI` and
`Event.ipfsHash` therefore repoints every future claim, which is the whole of the exposure.

| event | contract | old metadata CID | new metadata CID |
|---|---|---|---|
| QR Party (ENDED) | `0xeCAa810CdBDAaf86A286d697f20e9BF8faDB0209` | `QmYzmxKRV61ZYar94ifJGmdCGtkm6oBtgwr7E47sGA1ahm` | `QmY6jCcGrmcna2hKYqgSVMstpiVDqHdSmN4oE4VzXVQj2K` |
| AI Content (ENDED) | `0xcAF8Cb4e30B570c648D49B737B0Fb31744F68FA3` | `QmPURH4AWiEWzFEFx2N55FiEZwyLAgdBRNWkpmSBac3HyZ` | `QmUZrBYo4dHGGSKLjCdXrcSAor57N5REJGtxSsioe6VYNs` |
| Ne6to Si (ACTIVE) | `0xa3C9cA0Ba3942e0FD68a9a80F1A429A81D478817` | `QmPjkVvbwXdG5QSQkb4sfYm2fr4LnS9BQCUeXDbQxSywEJ` | `Qma4gv8ML7VSzEY6jeLQNDwPmNnqK3xJBmkfT4pRvadYkW` |
| Dogs Play (ACTIVE) | `0x2493A1AC0c694281B4AedF88311b66aCeA8572b0` | `QmcurJ7UnoE9bhGo9KE4kUWF4DRP8K8QKoFcKQPc6GULCK` | `QmaqWthg1ddFMHM5BKbJKrV2qXuCHpvECrxw4wA6iJMHni` |

The poster and ticket-page CIDs moved with them — twelve old CIDs in total (metadata, page, poster
for each event), all unpinned and garbage-collected from our node. The gateway is `Gateway.NoFetch`,
so an unpinned CID is simply no longer served: all twelve return **404** through
`ipfs.gembaticket.com`, and all twelve replacements return **200**.

What the cleaning removed, from `file(1)` rather than from a claim: Dogs Play's poster went from
`JPEG image data, Exif standard` to `JPEG image data, baseline` and lost 65 536 bytes; the three
PNG posters each lost a `tEXt` chunk (95 bytes). The storefront's own posters
(`api.gembaticket.com/posters/*.webp`) were checked and carry no metadata at all — they are
re-encoded WebP, so that surface was never exposed.

🔑 The old CIDs remain valid IPFS addresses. Anyone who pinned them elsewhere still has the
metadata-bearing bytes; what changed is that **we** no longer serve them. That is the whole of what
unpinning can achieve, and it is worth stating plainly rather than implying the bytes were recalled.
