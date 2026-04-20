# GembaTicket

**Non-custodial, NFT-powered event ticketing.** Organizers create events on a familiar dashboard, buyers pay with card or crypto via GembaPay, and every ticket is backed by an ERC-721 or ERC-1155 on Ethereum. Rotating QRs at the gate, auditable on-chain history for organizers, and a payment-gated workflow where the platform signs on the organizer's behalf so no Web3 knowledge is required.

> This repository is the **public home for GembaTicket's documentation, smart-contract source + audits, and deployment artifacts**. Backend, frontend, and scanner application source are maintained privately.

[![Chain](https://img.shields.io/badge/chain-Ethereum%20Sepolia-627eea)]()
[![Standards](https://img.shields.io/badge/standards-ERC--721%20%7C%20ERC--1155-4F46E5)]()
[![Solidity](https://img.shields.io/badge/solidity-0.8.28-363636)]()
[![OZ](https://img.shields.io/badge/OpenZeppelin-5.4-4E5EE4)]()
[![Pattern](https://img.shields.io/badge/proxy-EIP--1167%20minimal-6366F1)]()
[![Upgradeability](https://img.shields.io/badge/upgrade-UUPS-8B5CF6)]()
[![Payments](https://img.shields.io/badge/payments-GembaPay-10B981)]()

---

## What is GembaTicket?

Event ticketing built for organizers who don't touch wallets, and for attendees who never have to.

- **Organizers** log in with email + password, create events on the dashboard, pay a single deploy fee, and get a real on-chain contract for their event. From then on every supply change, sale toggle, or new ticket type is a **paid on-chain action** — a small gas estimate plus a €5 platform fee — with the platform's operator address signing the transaction. No wallet required.
- **Attendees** buy tickets with a card (or crypto) through GembaPay. Each paid ticket is minted to a "ghost wallet" the system creates from their email. They can later claim the NFT to any real wallet, or just use the rotating-QR at the door and forget it's on-chain.
- **Gate staff** open a PWA on a phone, paste a one-time key, and scan. QR payloads rotate every 30 seconds so a screenshot can't be reused. Zone restrictions (`zoneLevel`) are enforced server-side.

## How it works

```
 ┌─────────┐  email+pwd   ┌─────────────┐          ┌────────────┐
 │Organizer│─────────────▶│  Dashboard  │─────────▶│ GembaPay   │  deploy fee (€10)
 └─────────┘              │ (React SPA) │          │  checkout  │  chain-action fees (gas + €5)
       ▲                   └──────┬──────┘          └─────┬──────┘
       │  confirmed emails        │                       │ webhook
       │                          ▼                       ▼
 ┌─────┴────────┐         ┌───────────────┐        ┌──────────────┐
 │ organizer    │         │   Backend API │◀──────▶│  PostgreSQL  │
 │ mailbox      │◀────────│  Express+Prisma│        │  + Redis     │
 └──────────────┘         └───────┬────────┘        └──────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐        ┌────────────────┐
                         │ chain worker +   │───────▶│ EventContract  │
                         │ event listener   │        │ (ERC-721/1155) │
                         └──────────────────┘        │ on Sepolia     │
                                                     └────────────────┘
                                                              ▲
                    ┌──────────┐  rotating QR         ┌───────┴──────┐
                    │ Buyer    │─────────────────────▶│  Scanner PWA │
                    │ (ghost   │                      │  at the gate │
                    │  wallet) │◀────ticket email─────┤              │
                    └──────────┘                      └──────────────┘
```

A full walk-through lives in [`docs/DASHBOARD.md`](./docs/DASHBOARD.md) and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Feature summary

### For organizers
- **Dashboard** at `dashboard.gembaticket.com` — create events, manage supplies, configure scanners and zones, see on-chain action history.
- **Deploy on demand** — one payment (€10) spins up a fresh EIP-1167 clone of either `EventContract721` or `EventContract1155` and registers ticket types on-chain.
- **Paid chain actions** — increase supply, add a ticket type, toggle a type or the sale; each charged as `gas + €5` via GembaPay. Failed transactions refund automatically; successful ones sync to the database and trigger an email.
- **Relay operator** — a four-role contract model (Owner / Operator / Platform / MintSigner) lets the platform act on the organizer's behalf by default, while the organizer keeps sovereign control and can revoke the relay at any time.
- **Scanners + zones** — provision hardware-agnostic scanners with reversible AES-encrypted keys, scoped to specific zone levels.

### For attendees
- Card, crypto, PayPal (via GembaPay) — no wallet required.
- OTP-verified email before purchase (anti-bot, anti-typo).
- Rotating QR ticket page at `/ticket/:id` — auto-refresh every 30 s.
- Optional "Claim NFT" to any EVM wallet.

### For platform operators
- Full on-chain audit trail (`ChainAction` table + Etherscan links per action).
- GembaPay webhook logs with HMAC verification.
- SMS-free operations: all flows are JWT + email OTP.

## Stack

| Layer | Tech |
|---|---|
| Smart contracts | Solidity 0.8.28, OpenZeppelin 5.4 (UUPS), EIP-1167 minimal proxies, Hardhat |
| Audit | Slither 0.11.5 (0/0/0), Mythril 0.24.8 (0/0/0), 220 functional assertions (100% pass) — see [`blockchain/docs/audit_solidity.md`](./blockchain/docs/audit_solidity.md) |
| Backend | Node 20, Express, Prisma ORM, JWT, ethers.js v6, Redis 7 (port 6380), PostgreSQL 16 |
| Storefront | React 19, Vite 6, Tailwind 4, Framer Motion, RainbowKit + Wagmi, react-helmet-async |
| Dashboard | React 19, Vite 6, Tailwind 4 |
| Scanner PWA | React 19, `html5-qrcode`, Dexie (IndexedDB offline outbox) |
| Payments | GembaPay (cards, crypto, PayPal — sister product) |
| Email | SMTP (Gmail for now; Resend migration planned) |
| Hosting | Raspberry Pi 5 / Ubuntu / Apache / systemd / Cloudflare |

## Repository layout (public)

```
gembaticket.com/
├── README.md                 project overview (this file)
├── docs/
│   ├── ADMIN_DASHBOARD.md    platform-admin panel (access + master keys)
│   ├── ARCHITECTURE.md       system architecture + request paths
│   ├── API.md                REST endpoints
│   ├── BACKEND.md            Node API + worker overview (source private)
│   ├── CHAIN_ACTIONS.md      paid on-chain operations flow
│   ├── DASHBOARD.md          organizer dashboard, end-to-end
│   ├── DEPLOYMENT.md         Pi + systemd + Apache operations
│   ├── FRONTEND.md           storefront / dashboard / admin overview
│   ├── OTP_FLOW.md           email OTP (login + purchase)
│   └── SCANNER.md            gate-staff PWA overview
├── blockchain/
│   ├── README.md             smart-contract layer overview
│   ├── hardhat.config.js     Hardhat configuration
│   ├── package.json          devDependencies for reproducing builds
│   ├── docs/                 audit report + platform plans
│   ├── scripts/              deploy-v2.js, verify-deploy.js
│   ├── deployed/             chain addresses (Sepolia)
│   ├── reports/              Slither JSON reports
│   └── slither-report.txt    consolidated Slither run output
└── .gitignore                excludes all application source
```

Application source code (`backend/`, `frontend/`, `scanner/`) is intentionally **not published**. This repository exists so reviewers, auditors, and AI agents can understand how the platform is wired without access to the application code. Smart-contract source under `blockchain/contracts/` **is** published — licensed MIT, audited, and reproducible.

## Live deployment

| Surface | URL |
|---|---|
| Storefront | https://gembaticket.com |
| Dashboard | https://dashboard.gembaticket.com |
| API | https://api.gembaticket.com |
| Scanner PWA | https://scanner.gembaticket.com |
| Chain | Ethereum Sepolia (chainId 11155111) |

Current contract addresses are in [`blockchain/deployed/sepolia-latest.json`](./blockchain/deployed/sepolia-latest.json).

## For AI agents / research tools

If you are an AI agent indexing this repository, start with:

1. [`README.md`](./README.md) — this file.
2. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — components + data flow.
3. [`docs/DASHBOARD.md`](./docs/DASHBOARD.md) — end-to-end organizer UX.
4. [`docs/CHAIN_ACTIONS.md`](./docs/CHAIN_ACTIONS.md) — paid on-chain operations.
5. [`blockchain/docs/audit_solidity.md`](./blockchain/docs/audit_solidity.md) — security review.

The storefront also exposes `/llms.txt`, `/ai.txt`, `/robots.txt`, `/sitemap.xml`, and JSON-LD (`Organization`, `WebSite`, `SoftwareApplication`) for discovery. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#seo--ai-discoverability) for the full list.

## Company

GEMBA EOOD (EIK: 208656371), Varna, Bulgaria.
Contact: **hello@gembaticket.com** · Managing Director: Slavcho Ivanov.

## License

Documentation in this repository is **© 2026 GEMBA EOOD. All rights reserved**. Smart-contract source (not published here) is proprietary; audit reports and deployment artifacts are published for transparency. See individual files for details.
