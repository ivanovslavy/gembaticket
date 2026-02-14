# GembaTicket

Non-custodial event ticketing platform with optional NFT collectibles. Built on Polygon, powered by GembaPay.

**Company:** GEMBA EOOD (EIK: 208656371), Varna, Bulgaria
**Status:** Phase 1 complete (smart contracts deployed & audited)

---

## Overview

GembaTicket is a ticketing platform designed for users with zero blockchain knowledge. Organizers create events and sell tickets through a familiar web interface. Buyers purchase with credit cards or cryptocurrency. Under the hood, tickets are database records — but buyers who want an NFT collectible can optionally claim one by connecting a wallet and paying the gas fee themselves.

The system is fully non-custodial: the platform never holds user funds (fiat or crypto), never stores private keys, and never controls NFTs on behalf of users. All payments route directly from buyer to organizer through GembaPay.

---

## Documentation

| [Security Audit](./docs/audit_solidity.md) | English | Slither + Mythril + functional test results, findings, gas analysis |

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
              +--+--------+-------+
                 |        |
          +------+   +----+----+
          |          |         |
    +-----v------+  +--v----+ +--v----------+
    | Platform   |  | Event | | Event       |
    | Registry   |  | 721   | | 1155        |
    | (factory)  |  | clone | | clone       |
    +------------+  +-------+ +-------------+
```

### Layer Breakdown

**Smart Contracts (Solidity 0.8.28)**
- PlatformRegistry — factory + treasury + admin (singleton, deploys event clones via EIP-1167)
- EventContract721 — per-event ERC721, single ticket type, signature-based claiming
- EventContract1155 — per-event ERC1155, multiple ticket types with zone-based access
- No ClaimContract, no escrow — NFTs mint directly to buyer's wallet
- No payment logic in contracts — fully payment-agnostic (GembaPay handles all payments off-chain)
- Three-role security: owner (organizer), platformSigner (gas/deploy), mintSigner (claim signatures only)
- 1,264 LOC total across 3 contracts + 1 interface (down from ~4,150 in v1)

**Backend (Node.js + Express)**
- REST API with JWT authentication
- GembaPay webhook processing for payment verification
- Rotating QR generation with HMAC signatures (30-second rotation)
- Ticket lifecycle management (transfer, activate, lock)
- Dynamic NFT metadata generation and IPFS upload
- EIP-712 signature service for NFT claim authorization
- Scanner verification with zone-based access control
- Target: ~8,000 LOC (down from ~12,700 in v1)

**Frontend (React)**
- Public event browsing and ticket purchase (GembaPay widget)
- Live ticket page with rotating QR code
- 3-page NFT viewer with animated visuals and glow effects
- Organizer dashboard for event management
- Scanner PWA with camera, offline mode, and audio feedback
- Optional wallet connect for NFT claiming (buyer pays gas)

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
- **NFTs** are minted directly to the buyer's wallet when they choose to claim. No escrow, no intermediary contract. The buyer connects their wallet, the backend signs an EIP-712 message, and the buyer's transaction mints the NFT to their own address.
- **Private keys** are never generated, stored, or managed for users. The platform holds two keys: a platform signer (for gas/deploy) and a mint signer (for claim authorization, zero balance).

### Lazy Mint + Signature-Based Claiming

The v2 architecture separates ticket ownership from NFT minting:

- **Standard tickets (90%):** Database record only, zero gas cost. Ticket works for event entry via rotating QR code.
- **NFT tickets (10%):** Buyer connects wallet → backend signs EIP-712 claim message → buyer submits transaction → NFT minted directly to buyer's wallet. Buyer pays gas.
- **Gas economics (Polygon PoS):** Deploy ~$1, mint ~$0.003 per NFT. 1,000 NFT claims = platform $1 deploy + buyers $3 total gas.
- **Signature security:** Backend signs `keccak256(contractAddress, typeId, claimHash, walletAddress)` with the mintSigner key. Contract verifies via `ecrecover`. Each claimHash is single-use — replay and cross-contract attacks are rejected.

### Blockchain Invisible

Neither organizers nor ticket buyers need blockchain knowledge:

- Organizers create events through a standard web form. Contract deployment, IPFS upload, and on-chain configuration happen silently in the backend.
- Buyers purchase tickets with credit cards or crypto through a unified GembaPay widget. They receive an email with a live QR link for event entry.
- NFT claiming is entirely optional. The ticket works for event entry using only the rotating QR code and serial number.
- The only blockchain-facing feature is the optional "Claim as NFT" button, which requires connecting a wallet (MetaMask or similar) and paying a small gas fee on Polygon.

### Three-Role Security Model

Each event contract enforces strict role separation:

- **Owner (organizer):** Toggle sale, increase supply, add ticket types, cancel/end event, rotate keys. Full control after setup phase completes.
- **Platform Signer:** Deploy events, run setup phase (create ticket types, enable sale, set base URI, complete setup). One-time emergency cancel after setup. Cannot mint or sign claims.
- **Mint Signer:** Signs EIP-712 claim messages. Zero ETH balance — a compromised mint signer can only authorize NFT claims, not steal funds or modify contracts. Rotatable by owner.

### Setup Phase

Event contracts have a two-phase lifecycle:

- **Setup phase (platform-only):** Platform creates ticket types, enables sale, sets base URI, and calls `completeSetup()`. Owner cannot interfere during this phase.
- **Post-setup (owner controls):** Setup functions are permanently locked. Owner has full control. Platform retains only one-time emergency functions (cancel, update URI, toggle sale) — each usable exactly once and then permanently locked.

This prevents race conditions during deployment while giving organizers full autonomy afterward.

### Ticket Security

Anti-fraud is handled through a layered approach:

- **Rotating QR codes** regenerate every 30 seconds using HMAC-SHA256 signatures. A screenshot or forwarded QR becomes invalid within 60 seconds.
- **Device binding** associates the ticket with a browser fingerprint on first access. Accessing from a new device requires email verification.
- **Activation lock** permanently binds a ticket to a specific user after the first scan. No transfer is possible after entry, whether on-chain or off-chain.
- **Zone-based access control** uses ERC1155 token types to represent access tiers (General, VIP, Backstage, All Access). Each scanner is configured for a specific zone.

### Transfer Rules

- Before first scan: free transfer (off-chain via email, or on-chain via NFT transfer)
- After first scan: transfer blocked (on-chain via `_update` hook, off-chain via `is_activated` flag)
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
| Smart Contracts | Solidity 0.8.28, Hardhat, OpenZeppelin v5 |
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
│   ├── EventContract721.sol    # ERC721 per-event (EIP-1167 template)
│   ├── EventContract1155.sol   # ERC1155 per-event (EIP-1167 template)
│   ├── PlatformRegistry.sol    # Factory + treasury + admin (singleton)
│   └── interfaces/
│       └── IEventContract.sol
├── test/                       # Hardhat unit tests (57 tests)
│   └── GembaTicketV2.test.js
├── scripts/                    # Deployment & integration tests
│   ├── deploy.js               # Deploy to any network
│   ├── test-erc721-lifecycle.js
│   ├── test-erc1155-lifecycle.js
│   ├── test-platform-security.js
│   └── test-all.js             # Run all integration tests
├── deployed/                   # Deployment artifacts (auto-generated)
│   └── <network>-latest.json
├── docs/
│   ├── nft-ticket-platform-v2-plan-en.md
│   ├── nft-ticket-platform-v2-plan.md
│   └── audit_solidity.md
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
├── hardhat.config.js
├── .env.example
└── README.md
```

---

## Development Timeline

| Phase | Duration | Scope | Status |
|-------|----------|-------|--------|
| Phase 1: Smart Contracts | Weeks 1-3 | EventContract721, EventContract1155, PlatformRegistry, tests, Slither + Mythril audit | ✅ Complete |
| Phase 2: Backend | Weeks 4-6 | DB schema, scanner service, transfer service, metadata, GembaPay webhooks, API | ⏳ Next |
| Phase 3: Frontend | Weeks 7-9 | Event pages, ticket viewer, NFT viewer, scanner PWA, organizer dashboard | |
| Phase 4: Infrastructure | Weeks 10-11 | IPFS nodes, production deploy, load testing, security review, soft launch | |

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
PLATFORM_SIGNER_KEY=          # Private key for gas payments and event deployment
MINT_SIGNER_KEY=              # Private key for EIP-712 claim signatures (zero balance)
MINT_SIGNER_ADDRESS=          # Public address of mint signer
PLATFORM_REGISTRY_ADDRESS=    # PlatformRegistry contract address

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
