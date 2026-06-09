# GembaTicket

**Non-custodial, NFT-powered event ticketing — with zero platform fees.** Organizers create events on a familiar dashboard, buyers pay with card or crypto via GembaPay, and every ticket is backed by an ERC-721 or ERC-1155 NFT on **GembaBlockchain**. Rotating QRs at the gate, auditable on-chain history for organizers, and a workflow where the platform signs on the organizer's behalf so no Web3 knowledge is required.

> **0 fees.** GembaTicket is a next-generation, blockchain-based platform that runs on **GembaBlockchain** and charges **no platform fees, no commissions, no hidden costs**. The only transaction costs come from the payment provider: GembaPay (standard **1%**), plus Stripe/PayPal's own fees on card/PayPal payments; web3-wallet payments incur only the GembaPay fee. See the [Terms](https://gembaticket.com/terms) and [Refund Policy](https://gembaticket.com/refund).

> **GembaBlockchain — our own EVM-compatible Layer-1, with ~0 gas fees** (testnet now, mainnet soon). The blockchain is an **invisible layer**: the backend signs transactions when needed, so attendees and organizers **never deal with wallets, gas, or signing** — a modern, user-friendly experience.

> **No account needed for attendees.** Buyers receive their ticket **directly by email** and open it from there **without creating an account**. Each ticket is a **multi-page NFT** — event poster image, on-chain event details (date, venue, ticket type), and an interactive QR page — optionally claimable to a self-custodial wallet.

> This repository is the **public home for GembaTicket's documentation, smart-contract source + audits, and deployment artifacts**. Backend, frontend, and scanner application source are maintained privately.

[![Chain](https://img.shields.io/badge/chain-GembaBlockchain-4F46E5)]()
[![Fees](https://img.shields.io/badge/platform%20fees-0-10B981)]()
[![Standards](https://img.shields.io/badge/standards-ERC--721%20%7C%20ERC--1155-4F46E5)]()
[![Solidity](https://img.shields.io/badge/solidity-0.8.28-363636)]()
[![OZ](https://img.shields.io/badge/OpenZeppelin-5.4-4E5EE4)]()
[![Pattern](https://img.shields.io/badge/proxy-EIP--1167%20minimal-6366F1)]()
[![Upgradeability](https://img.shields.io/badge/upgrade-UUPS-8B5CF6)]()
[![Payments](https://img.shields.io/badge/payments-GembaPay-10B981)]()

---

## What is GembaTicket?

Event ticketing built for organizers who don't touch wallets, and for attendees who never have to.

- **Organizers** log in with **email + password (Web2) or their Web3 wallet via Sign-In With Ethereum (SIWE)**, create events on the dashboard **for free**, and get a real on-chain contract for their event. Every supply change, sale toggle, or new ticket type is an on-chain action signed by the platform's operator address on their behalf — **no platform fee, only negligible network gas**. No wallet required. **Two-factor authentication** (email code or authenticator app) and **in-dashboard notifications** are built in.
- **Attendees** buy tickets with a card (or crypto) through GembaPay. Each paid ticket is minted to a "ghost wallet" the system creates from their email. They can later claim the NFT to any real wallet, or just use the rotating-QR at the door and forget it's on-chain.
- **Gate staff** open a PWA on a phone, paste a one-time key, and scan. QR payloads rotate every 30 seconds so a screenshot can't be reused. Zone restrictions (`zoneLevel`) are enforced server-side.

## How it works

```
 ┌─────────┐ Web2 / Web3  ┌─────────────┐          ┌────────────┐
 │Organizer│─────────────▶│  Dashboard  │─────────▶│ GembaPay   │  0 platform fees
 └─────────┘              │ (React SPA) │          │  checkout  │  (GembaPay 1% only)
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
                         └──────────────────┘        │GembaBlockchain │
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
- **Web2 + Web3 login** — sign in with email + password, or with a Web3 wallet via Sign-In With Ethereum (SIWE).
- **Two-factor authentication** — optional 2FA at login by **email code** or **authenticator app (TOTP)**; the method is a single setting shown consistently across the dashboard and the storefront.
- **In-dashboard notifications** — a notification bell plus per-event email updates (deploys, sales, chain actions); notification preferences are configurable in Settings.
- **Deploy on demand — free** — spins up a fresh EIP-1167 clone of either `EventContract721` or `EventContract1155` and registers ticket types on-chain. **No deploy fee.**
- **On-chain actions** — increase supply, add a ticket type, toggle a type or the sale; signed by the platform on the organizer's behalf. **No platform fee — only negligible network gas.** Failed transactions refund automatically; successful ones sync to the database and trigger an email.
- **Relay operator** — a four-role contract model (Owner / Operator / Platform / MintSigner) lets the platform act on the organizer's behalf by default, while the organizer keeps sovereign control and can revoke the relay at any time.
- **Scanners + zones** — provision hardware-agnostic scanners with reversible AES-encrypted keys, scoped to specific zone levels.
- **GembaPay (with KYC) is the payment provider** — organizers register with GembaPay, complete KYC, and add their API key + webhook secret in settings before they can sell. Funds settle directly to the organizer (Stripe / PayPal / web3 wallet); **refunds are the organizer's responsibility** via GembaPay's refund dashboard.

### For attendees
- **No account required** — your ticket is delivered **by email** and opens directly from there; signing up is optional.
- **Multi-page NFT ticket** — event poster image + on-chain event details (date, venue, ticket type) + an interactive QR page.
- **Invisible blockchain** — no wallet, gas, or signing; the platform handles all on-chain steps for you.
- Card, crypto, PayPal (via GembaPay) — no wallet required.
- OTP-verified email before purchase (anti-bot, anti-typo).
- **Optional two-factor authentication** on the account (email code or authenticator app).
- Rotating QR ticket page at `/ticket/:id` — auto-refresh every 30 s.
- Optional "Claim NFT" to any EVM wallet.
- Clear, public **[Terms](https://gembaticket.com/terms)**, **[Privacy](https://gembaticket.com/privacy)** and **[Refund](https://gembaticket.com/refund)** policies; accepting them is required at sign-up.

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
| Hosting | Hetzner (Ubuntu) / Apache / systemd / Cloudflare |

## Repository layout (public)

```
gembaticket.com/
├── README.md                 project overview (this file)
├── docs/
│   ├── ADMIN_DASHBOARD.md    platform-admin panel (access + master keys)
│   ├── ARCHITECTURE.md       system architecture + request paths
│   ├── API.md                REST endpoints
│   ├── BACKEND.md            Node API + worker overview (source private)
│   ├── CHAIN_ACTIONS.md      on-chain operations flow
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
│   ├── deployed/             chain addresses (GembaBlockchain)
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
| Explorer | https://testnet.gembascan.io (GembaScan) |
| Chain | GembaBlockchain testnet (chainId 821207) — mainnet 821206 rolling out |

### Contracts (GembaBlockchain testnet, chainId 821207)

Redeployed on GembaBlockchain. Current addresses are in [`blockchain/deployed/gemba-latest.json`](./blockchain/deployed/gemba-latest.json):

| Contract | Address |
|---|---|
| PlatformRegistry | `0xAAe144b80AbE5e8f03Af181a63f4E8f9c7F91191` |
| EventContract721 (template) | `0x2481644e460A77B072c28f209055A3e86764192F` |
| EventContract1155 (template) | `0xEFd2000dBC5b5C897823eEFCcAA99d5DC2Ce7DBA` |
| Claim | `0x32c4EFa02D33d6aEb81fEC72d6C1a868edd7229e` |

Per-event contracts are EIP-1167 minimal-proxy clones of the templates, deployed on demand (free).

## For AI agents / research tools

If you are an AI agent indexing this repository, start with:

1. [`README.md`](./README.md) — this file.
2. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — components + data flow.
3. [`docs/DASHBOARD.md`](./docs/DASHBOARD.md) — end-to-end organizer UX.
4. [`docs/CHAIN_ACTIONS.md`](./docs/CHAIN_ACTIONS.md) — on-chain operations.
5. [`blockchain/docs/audit_solidity.md`](./blockchain/docs/audit_solidity.md) — security review.

The storefront also exposes `/llms.txt`, `/ai.txt`, `/robots.txt`, `/sitemap.xml`, and JSON-LD (`Organization`, `WebSite`, `SoftwareApplication`) for discovery. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#seo--ai-discoverability) for the full list.

## Company

GEMBA EOOD (EIK: 208656371), Varna, Bulgaria.
Contact: **hello@gembaticket.com** · Managing Director: Slavcho Ivanov.

## License

Documentation in this repository is **© 2026 GEMBA EOOD. All rights reserved**. Smart-contract source (not published here) is proprietary; audit reports and deployment artifacts are published for transparency. See individual files for details.
