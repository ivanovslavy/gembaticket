# Frontends overview

> Four React applications fronting the GembaTicket platform. **Source lives in a private repository** — this document describes their shape and relationships so the public docs stand on their own.

## Apps

| App | Subdomain | Port | Purpose |
|---|---|---|---|
| **Storefront** | `gembaticket.com` | :3083 | Event browsing, guest checkout, public ticket view, NFT claim. |
| **Dashboard** | `dashboard.gembaticket.com` | :3084 | Organizer workspace — events, supply, scanners, zones, chain actions. |
| **Scanner PWA** | `scanner.gembaticket.com` | :3087 | Gate-staff app — QR decode, offline outbox, zone enforcement. |
| **Admin** | internal | :3085 | Operator console — refund review, webhook replay, block-sync diagnostics. |

## Common stack

- **React 19** + **Vite 6**, ES modules.
- **Tailwind CSS 4** + a small shared design-token layer.
- **React Router 6** for routing, **react-helmet-async** for SEO head tags.
- **Framer Motion** for page and modal transitions.
- **Wagmi 2 + Viem** for EVM interactions, **WalletConnect v2** for wallet connect.
- **Ethers.js v6** for EIP-712 signing in the claim flow.
- Served in production by `serve` (static), behind Apache + Cloudflare.

## Storefront (`ticket-web`)

Public marketing + ticketing. Entry points:

- `/` — hero + featured events.
- `/events` — list (SSR-style via React Helmet for crawlers + JSON-LD).
- `/events/:id` — event detail + buy widget.
- `/ticket/:id` — public ticket with rotating QR (60s cadence, signed by the API).
- `/claim/:claimHash` — standalone claim landing (sharable URL).

Checkout is guest-first: email → purchase OTP → `POST /tickets/buy` → GembaPay tab → ticket email. Logged-in organizers skip OTP.

**SEO / AI discoverability** — served from `/public`:
- `robots.txt`, `sitemap.xml`
- `llms.txt` (summary + entry points for LLM crawlers)
- `ai.txt` (data-use policy)
- JSON-LD (`Organization`, `WebSite`, `SoftwareApplication`)
- Open Graph + Twitter Cards on every public route
- Canonical URLs via helmet

## Dashboard (`ticket-dashboard`)

Organizer workspace. End-to-end walkthrough in [`DASHBOARD.md`](./DASHBOARD.md). Highlights:

- Event wizard (metadata → contract type → ticket types → publish).
- Deploy flow with €10 GembaPay charge.
- Post-deploy panels: **SupplyPanel**, **OperatorPanel**, **ActionHistory**, sale toggle — all funnelled through a single **ChainActionPaymentModal** that estimates gas in EUR, opens GembaPay checkout, and polls `/api/dashboard/actions/:id` until terminal.
- Scanner management (create with once-shown plain key, re-reveal via AES-GCM, edit, revoke).
- Zones CRUD.
- Tickets table with status filters + search.

## Scanner PWA (`scanner`)

Progressive web app that runs in the browser on any Android/iOS device with a camera.

- **Auth**: paste the plain `apiKey` issued in the dashboard → `POST /api/scanner/auth` → short-lived scanner-JWT, stored in IndexedDB.
- **Camera**: uses `getUserMedia` — requires HTTPS origin, hence the dedicated `scanner.` subdomain with `Permissions-Policy: camera=(self)` on Apache.
- **QR decode**: rotating payloads (HMAC-signed by the API, 60s TTL) → `POST /api/scanner/validate`.
- **Offline outbox**: **Dexie** (IndexedDB) buffer for scans made without connectivity; flushes on reconnect.
- **Zone enforcement**: server-side, but the UI shows a clear red/green badge based on the zone levels baked into the scanner's JWT.

## Admin (`ticket-admin`)

Small internal console — refund review, webhook log browser, block-sync lag dashboard. Not exposed publicly.

## Build & ship

See [`DEPLOYMENT.md`](./DEPLOYMENT.md#build--ship). Each app is a Vite static build served by `serve`; Apache terminates TLS and reverse-proxies by subdomain.

## Environment

Each app reads a small `.env` at build time:

- `VITE_API_URL` — typically `https://api.gembaticket.com`.
- `VITE_WALLETCONNECT_PROJECT_ID` — WalletConnect Cloud project id.
- `VITE_SEPOLIA_RPC_URL` — public Sepolia RPC fallback.
- `VITE_TURNSTILE_SITE_KEY` — optional, enables Turnstile on register/login.
- `VITE_ETHERSCAN_BASE` — for the dashboard's on-chain links.

No secrets live in the frontend bundles — payment capture, OTP, and signing all round-trip through the API.
