# GembaTicket

Non-custodial event ticketing platform with optional NFT collectibles. Built on Polygon, powered by GembaPay.

**Company:** GEMBA EOOD (EIK: 208656371), Varna, Bulgaria
**Status:** Pre-development (architecture finalized)

---

## Overview

GembaTicket is a ticketing platform designed for users with zero blockchain knowledge. Organizers create events and sell tickets through a familiar web interface. Buyers purchase with credit cards or cryptocurrency. Under the hood, each ticket is backed by an NFT on Polygon — but this is entirely invisible to both parties unless they choose to engage with it.

The system is fully non-custodial: the platform never holds user funds (fiat or crypto), never stores private keys, and never controls NFTs on behalf of users. All payments route directly from buyer to organizer through GembaPay.

---

## Documentation

| Document | Language | Description |
|----------|----------|-------------|
| [Development Plan (EN)](./nft-ticket-platform-v2-plan-en.md) | English | Complete technical specification: smart contracts, backend, frontend, database, infrastructure, security, timeline |
| [Development Plan (BG)](./nft-ticket-platform-v2-plan.md) | Bulgarian | Same plan in Bulgarian |

Read the development plan before contributing or reviewing code. It contains the full architecture, all design decisions, and the reasoning behind them.

---

## Architecture

```
                    +-------------------+
                    |    Frontend        |
                    |    (React SPA)     |
                    +--------+----------+
                             |
                    +--------v----------+
                    |    Backend         |
                    |    (Node/Express)  |
                    +--+-----+-----+----+
                       |     |     |
              +--------+  +--+--+  +--------+
              |           |     |           |
     +--------v---+  +---v---+ +---v--------+
     | PostgreSQL  |  | Redis | | IPFS Node  |
     | (tickets,   |  | (cache| | (metadata, |
     |  users,     |  |  queue| |  images)   |
     |  scans)     |  |  s)   | |            |
     +-------------+  +------+ +------------+
                       
              +--------+----------+
              |  Smart Contracts   |
              |  (Polygon)         |
              +--+-----+-----+----+
                 |     |     |
          +------+  +--+--+ +------+
          |         |     |        |
    +-----v---+ +---v---+ +--v----+
    | Factory  | | Event | | Claim |
    | Facet    | | Contr.| | Contr.|
    +----------+ +-------+ +------+
```

### Layer Breakdown

**Smart Contracts (Solidity 0.8.28)**
- EventContract v2 — per-event ERC721/ERC1155 with embedded payment logic
- ClaimContract — autonomous NFT holding with renounced ownership
- FactoryFacet v2 — event deployment via Diamond Proxy (EIP-2535)
- TreasuryFacet — platform fee collection and gas funding
- Target: ~1,280 LOC total (down from ~4,150 in v1)

**Backend (Node.js + Express)**
- REST API with JWT authentication
- GembaPay webhook processing for payment verification
- Rotating QR generation with HMAC signatures (30-second rotation)
- Ticket lifecycle management (transfer, activate, lock)
- Dynamic NFT metadata generation and IPFS upload
- Platform signer service for gas-free user experience
- Scanner verification with zone-based access control
- Target: ~8,000 LOC (down from ~12,700 in v1)

**Frontend (React)**
- Public event browsing and ticket purchase (GembaPay widget)
- Live ticket page with rotating QR code
- 3-page NFT viewer with animated visuals and glow effects
- Organizer dashboard for event management
- Scanner PWA with camera, offline mode, and audio feedback
- Optional MetaMask integration for NFT claiming

**Database (PostgreSQL 16)**
- 9 tables: users, events, ticket_types, tickets, scanners, scan_logs, transfer_log, organizer_profiles, refund_tracking
- Partial indexes for active records
- No encrypted private keys stored (zero custody)

**Infrastructure**
- 2x Hetzner VPS (Falkenstein primary, Helsinki fallback)
- IPFS nodes on both servers with cross-pinning
- Cloudflare for DNS, load balancing, DDoS protection
- Redis for caching and Bull job queues

---

## Core Design Decisions

### Zero Custody Model

The platform never holds assets on behalf of users:

- **Fiat payments** flow directly from buyer to organizer via GembaPay/Stripe Connect. The platform receives only a 5% application fee through Stripe's built-in split mechanism.
- **Crypto payments** are split on-chain in the same transaction: 95% to organizer wallet, 5% to PlatformTreasury. The event contract never accumulates a balance.
- **NFTs** are minted to the ClaimContract (a smart contract with renounced ownership), not to platform-controlled wallets. Users claim NFTs to their own wallets when ready.
- **Private keys** are never generated, stored, or managed for users. The only private key the platform holds is the platform signer, which is used exclusively for paying gas fees.

### Gas Cost Model

All blockchain transaction costs are absorbed by the platform:

- A platform signer wallet (funded from PlatformTreasury) pays gas for minting, ticket activation, and event deployment
- On Polygon: ~$0.01-0.05 per mint, ~$0.005 per activation
- 1,000 tickets at $20 average generates $1,000 in platform fees vs ~$30-50 in gas costs
- Users never see, pay, or know about gas fees
- Event creation fee ($5-10) covers deployment gas and is presented as a flat platform fee

### Blockchain Invisible

Neither organizers nor ticket buyers need blockchain knowledge:

- Organizers create events through a standard web form. Contract deployment, IPFS upload, and on-chain configuration happen silently in the backend.
- Buyers purchase tickets with credit cards or crypto through a unified GembaPay widget. They receive an email with a live QR link for event entry.
- NFT claiming is entirely optional. The ticket works for event entry using only the rotating QR code and serial number.
- The only blockchain-facing feature is the optional "Claim as NFT" button, which requires connecting a wallet (MetaMask or similar).

### Ticket Security

Anti-fraud is handled through a layered approach:

- **Rotating QR codes** regenerate every 30 seconds using HMAC-SHA256 signatures. A screenshot or forwarded QR becomes invalid within 60 seconds.
- **Device binding** associates the ticket with a browser fingerprint on first access. Accessing from a new device requires email verification.
- **Activation lock** permanently binds a ticket to a specific user after the first scan. No transfer is possible after entry, whether on-chain or off-chain.
- **Zone-based access control** uses ERC1155 token types to represent access tiers (General, VIP, Backstage, All Access). Each scanner is configured for a specific zone.

### Transfer Rules

- Before first scan: free transfer (off-chain via email, or on-chain via NFT transfer)
- After first scan: transfer blocked (on-chain via _beforeTokenTransfer hook, off-chain via is_activated flag)
- After event ends: NFT transfer unlocked for secondary market / collectible value

### Refund Responsibility

The platform does not hold funds and cannot issue refunds:

- For fiat payments: the organizer must refund from their own Stripe account
- For crypto payments: the organizer must send funds back manually
- The platform tracks refund status, sends reminders, and enforces a reputation scoring system with escalating consequences (warnings, score reduction, ban)

---

## NFT Ticket Design

Each ticket NFT contains 3 pages of content stored on IPFS:

**Page 1 — Event Poster**
Static image (1000x1000) uploaded by the organizer. Displayed as the primary image in OpenSea, MetaMask, and other NFT viewers.

**Page 2 — Ticket Information**
Generated image containing event name, date, time, location, ticket type, zone, and serial number. Clean typographic layout.

**Page 3 — Animated QR**
HTML-based interactive viewer (served via animation_url). Displays a QR code that changes color based on ticket status:

| Status | Color | Condition |
|--------|-------|-----------|
| Ready | White | Not yet scanned |
| Inside | Green (pulsing) | After entry scan |
| Outside | Blue (breathing) | After exit scan |
| VIP Zone | Gold (fast pulse) | Inside VIP area |
| Backstage | Red (pulse) | Inside backstage |
| Event Attended | Dark + rainbow border | After event ends |

The visual state updates in near-real-time through a backend API that the HTML viewer polls.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Smart Contracts | Solidity 0.8.28, Hardhat, OpenZeppelin |
| Blockchain | Polygon (primary), BSC, Ethereum |
| Backend | Node.js 20, Express, ethers.js v6 |
| Database | PostgreSQL 16 |
| Cache / Queues | Redis 7, Bull |
| File Storage | IPFS (Kubo), Pinata (backup) |
| Frontend | React 18, Tailwind CSS |
| Payments | GembaPay (Stripe Connect + crypto protocol) |
| Auth | JWT + Google OAuth |
| Infrastructure | Hetzner VPS, Cloudflare, Nginx, PM2 |
| Testing | Hardhat (contracts), Jest (backend), Cypress (e2e) |

---

## Project Structure

```
gembaticket/
├── contracts/                  # Solidity smart contracts
│   ├── EventContract721.sol
│   ├── EventContract1155.sol
│   ├── ClaimContract.sol
│   ├── facets/
│   │   ├── FactoryFacet.sol
│   │   ├── TreasuryFacet.sol
│   │   └── AdminFacet.sol
│   └── interfaces/
├── test/                       # Contract tests (Hardhat)
├── scripts/                    # Deployment scripts
├── backend/
│   ├── src/
│   │   ├── app.js
│   │   ├── middleware/
│   │   ├── routes/
│   │   ├── services/
│   │   └── utils/
│   ├── database/
│   │   └── migrations/
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── services/
│   └── package.json
├── scanner/                    # Scanner PWA (separate build)
├── docs/
│   ├── nft-ticket-platform-v2-plan-en.md
│   └── nft-ticket-platform-v2-plan.md
├── hardhat.config.js
├── .env.example
└── README.md
```

---

## Development Timeline

| Phase | Duration | Scope |
|-------|----------|-------|
| Phase 1: Smart Contracts | Weeks 1-3 | EventContract, ClaimContract, Factory, Treasury, tests, audit |
| Phase 2: Backend | Weeks 4-6 | DB schema, scanner service, transfer service, metadata, GembaPay webhooks, API |
| Phase 3: Frontend | Weeks 7-9 | Event pages, ticket viewer, NFT viewer, scanner PWA, organizer dashboard |
| Phase 4: Infrastructure | Weeks 10-11 | IPFS nodes, production deploy, load testing, security review, soft launch |

MVP (contracts + backend + basic frontend): 6-7 weeks
Full launch: 10-11 weeks

---

## Environment Variables

```bash
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=gembaticket
DB_USER=
DB_PASSWORD=

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Blockchain
POLYGON_RPC_URL=
PLATFORM_SIGNER_KEY=          # Private key for gas payments (never user funds)
FACTORY_ADDRESS=
CLAIM_CONTRACT_ADDRESS=
TREASURY_ADDRESS=

# IPFS
IPFS_HOST=localhost
IPFS_PORT=5001
IPFS_GATEWAY=https://ipfs.gembapay.com

# GembaPay
GEMBAPAY_API_KEY=
GEMBAPAY_WEBHOOK_SECRET=
GEMBAPAY_PLATFORM_FEE_BPS=500  # 5%

# Auth
JWT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Email
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASSWORD=
```

---

## License

Proprietary. Copyright 2024-2026 GEMBA EOOD. All rights reserved.
