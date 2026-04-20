# Platform Admin Dashboard

> `admin.gembaticket.com` — the internal panel GembaTicket operators use to observe the platform, provision access, and triage on-chain jobs. **Source is in a private repository** (`frontend/ticket-admin`); this document describes the shape and responsibilities so the public docs make sense on their own.

Unlike the organizer dashboard, the admin panel is **not self-service**: only wallets on the `AdminWallet` table can reach it, and one wallet (the master) can never be removed. All auth is SIWE — there is no email/password path.

---

## Auth model

Admins sign in with **Sign-In With Ethereum (SIWE / EIP-4361)** only.

```
┌──────────────┐   GET /api/admin/auth/nonce   ┌──────────────────┐
│  Admin SPA   │──────────────────────────────▶│  Backend API     │
│ (wallet box) │◀── { nonce, issuedAt, ttl } ──│ (admin routes)   │
└──────┬───────┘                               └────────┬─────────┘
       │  wallet signs SIWE message                     │ verify sig
       │                                                │ check allowlist
       │  POST /api/admin/auth/verify { message, sig }  │    ↓
       ├───────────────────────────────────────────────▶│ AdminWallet ?
       │◀──────────── { token, wallet, isMaster } ──────│
       ▼
 localStorage.token  →  Authorization: Bearer <JWT>
```

- Nonce lives in Redis (5-minute TTL, single-use).
- SIWE message is verified with `viem`'s `verifyMessage` — no server-side key rotation.
- JWT carries `{ kind: "admin", wallet, isMaster }` and expires in 12 hours.
- **Allowlist is DB-backed** (`AdminWallet` table). Adding or removing an admin takes effect on the next API call; no restart, no env change, no deploy.
- `GET /api/admin/me` returns `{ wallet, isMaster }` for UI gating.

### The master wallet

One wallet on the `AdminWallet` table carries `isMaster = true`. The default master (`0x8eB8…e298`) is **re-seeded on every API boot** — if it were accidentally deleted from the table, the next restart would restore it. This is also the wallet that cannot be removed through the UI or API. Master is currently a single-wallet role; `isMaster` is a boolean, not a set.

### `AdminWallet` schema

```prisma
model AdminWallet {
  address         String   @id            // lowercase 0x-hex
  label           String?
  isMaster        Boolean  @default(false)
  createdAt       DateTime @default(now())
  createdByWallet String?
  @@index([isMaster])
}
```

Migration: `prisma/migrations/20260420_admin_wallets_and_master_scanners/migration.sql` — applied on prod via `npx prisma db execute` + `npx prisma migrate resolve --applied` (prod's Postgres role cannot run `migrate dev` because of the shadow-DB restriction).

Seeding (`server.js → seedAdminWallets()`):

1. **Always** upsert the master wallet with `isMaster: true`.
2. On first boot, read `ADMIN_WALLETS` from `.env` (comma-separated) and insert any missing rows as non-master admins.
3. On subsequent boots, the DB is the source of truth — `.env` is ignored.

### Middleware

`requireAdminAuth` (`src/middleware/auth.js`) verifies the JWT, then queries `AdminWallet.findUnique({ address })` on every request. If the row has been deleted since the JWT was issued, the request gets **403 immediately** — revoking an admin is effectively instant, bounded only by the current in-flight request.

---

## Navigation

The left rail lists ten destinations. All of them require admin auth.

| Path | Icon | Purpose |
|---|---|---|
| `/` | LayoutDashboard | Overview — health + KPIs |
| `/revenue` | Euro | Revenue breakdown |
| `/organizers` | Users | Organizer directory |
| `/events` | Ticket | Event directory |
| `/scanners` | Scan | Scanner devices (read-only across all organizers) |
| `/chain-jobs` | Cog | On-chain job queue + retry |
| `/webhooks` | Webhook | Inbound webhook log |
| `/monitoring` | Activity | Services, RPC, Redis, DB |
| `/access` | KeyRound | Admin wallets + master scanner keys |

`Login.jsx` is public; every other route is wrapped in `DashboardLayout`, which rejects non-admins.

---

## Pages

### Overview (`/`)

KPI strip + recent-activity list. Data comes from `GET /api/admin/monitoring` (subset). Shown: active organizers, active events, tickets sold (24h / 7d), active scanners, failing chain jobs, unhealthy services.

### Revenue (`/revenue`)

`GET /api/admin/revenue` — platform-fee earnings broken down by event and organizer over the last 30 days, plus a time-series for charting. Numbers are denominated in EUR (GembaPay's reporting currency), with optional ETH-equivalent for chain-action gas.

### Organizers (`/organizers`, `/organizers/:id`)

List view: all organizers, with `GET /api/admin/organizers` (paginated). Ghost accounts (`0x…@wallet.gembaticket.com`) are filtered out by default.

Detail view: event count, paid-ticket count, scanner count, last-login timestamp, connected wallet address (if SIWE-linked), ghost-merge history.

### Events (`/events`, `/events/:id`)

List: all events across all organizers, status-filterable.

Detail: full event state including ticket types, supply, on-chain contract address, IPFS hash, sale toggle, claim count, and a link out to Etherscan. The detail page also embeds the associated `ChainJob` history so you can see every `increaseSupply`, `addTicketType`, `toggleSale`, etc. that has ever been run against that event.

### Scanners (`/scanners`)

Read-only roll-up of `ScannerDevice` rows across every organizer. For active key rotation or revocation, go into the specific organizer / event context on their own dashboard — this admin view is for **observation** only. The [`Access`](#access--keys-access) page is where you provision platform-wide master keys.

### Chain jobs (`/chain-jobs`)

`GET /api/admin/chain-jobs` — paginated queue view with filters for `status`, `action`, and free-text organizer search. Each row has a **Retry** button that fires `POST /api/admin/chain-jobs/:id/retry`, which re-enqueues the job against the chain worker. Use this when a transient RPC failure or nonce collision left a job stuck in `FAILED`.

### Webhooks (`/webhooks`)

Inbound webhook log from `WebhookLog` — every GembaPay delivery, signature verification status, raw body preview, and the internal handler's response code. Helps when a payment "didn't land" — you can see at a glance whether the webhook arrived, whether the signature matched, and whether the handler errored.

### Monitoring (`/monitoring`)

`GET /api/admin/monitoring` — service health, RPC pool status, Redis liveness, Postgres connection count, and recent log-level counts. The page also lists the four systemd units (`gembaticket-api`, `gembaticket-listener`, `gembaticket-chain-worker`, `gembaticket-scanner`) with their uptime and last restart, pulled from systemd dbus.

### Access & keys (`/access`)

This page is the point of this document. It has two sections:

#### Admin wallets

Row list of every `AdminWallet`. The master row has an amber `ShieldCheck`; every other row has a gray `Shield`. Each row shows the address, optional label, "who added it" (via `createdByWallet`), and when it was added.

- **Add admin** — form collects `{ address, label? }`, validates `/^0x[0-9a-fA-F]{40}$/`, and POSTs to `/api/admin/admins`. Normalises address to lowercase before insert.
- **Remove admin** — trash icon. **Disabled** (with tooltip explaining why) for:
  - the master wallet
  - the currently-signed-in admin (you can't lock yourself out)

The "currently-signed-in admin" check is UI-only for ergonomics; the backend re-checks both conditions in `DELETE /api/admin/admins/:address` and returns 400 if either is violated.

#### Master scanner keys

A master scanner key validates tickets for **any event on the platform** — bypassing the per-event / per-zone restrictions that normal scanner keys enforce. Use cases: roving platform staff, failover at a venue where an organizer's own keys broke, spot audits.

Row list of every `ScannerDevice` where `isMaster = true`. Data shown: label, `apiKeyPrefix + "…"`, created-at, optional expiry (`activeUntil`), last-seen timestamp, revoked badge if revoked.

- **Create master key** — form collects `{ label, activeUntil? }`. POSTs to `/api/admin/master-scanners`. Response includes the **plain API key exactly once** (the same `gtscan_<64hex>` format organizer-scoped scanners use). The UI shows an amber one-time banner with a copy-to-clipboard button. After dismissing, there is no way to re-reveal (unlike organizer-owned keys, which can be re-revealed via the dashboard for operator convenience — master keys deliberately have no reveal path).
- **Revoke key** — trash icon. Soft-deletes by setting `revokedAt`; the scanner server rejects any JWT exchange using a revoked key on the next auth attempt.

Master `ScannerDevice` rows have `organizerId = null` and `eventId = null` — hence the migration that dropped the `NOT NULL` on `ScannerDevice.organizerId` and added `isMaster Boolean` + `createdByWallet String?`. The scanner hot path checks `isMaster` before applying event/zone filters and short-circuits the zone check when the flag is set.

---

## API surface

All admin routes live under `/api/admin/*` in `backend/src/routes/adminRoutes.js`.

### Auth

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/auth/nonce` | Issue SIWE nonce (Redis, 5-min TTL). |
| `POST` | `/api/admin/auth/verify` | Verify SIWE signature, return admin JWT. |
| `GET` | `/api/admin/me` | Return `{ wallet, isMaster }`. |

The auth endpoints are rate-limited (`rl:admin-auth`, 20 req / 60s per IP) because they're the brute-force surface.

### Observation

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/monitoring` | Service health snapshot. |
| `GET` | `/api/admin/logs` | Tail recent pino logs (last 500). |
| `GET` | `/api/admin/revenue` | Revenue breakdown (EUR + ETH). |
| `GET` | `/api/admin/organizers` | Paginated organizer list (ghost-filtered). |
| `GET` | `/api/admin/organizers/:id` | Organizer detail. |
| `GET` | `/api/admin/events` | Paginated event list. |
| `GET` | `/api/admin/events/:id` | Event detail + chain history. |
| `GET` | `/api/admin/operator-wallet` | Operator wallet balance + nonce (Sepolia). |
| `GET` | `/api/admin/scanner-devices` | Cross-organizer scanner roll-up. |
| `GET` | `/api/admin/webhooks` | Webhook log tail. |
| `GET` | `/api/admin/chain-jobs` | Chain job queue. |

### Ops

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/chain-jobs/:id/retry` | Re-enqueue a failed chain job. |

### Access management

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/admins` | List admin wallets. |
| `POST` | `/api/admin/admins` | Add admin. Body: `{ address, label? }`. |
| `DELETE` | `/api/admin/admins/:address` | Remove admin (rejects master + self). |
| `GET` | `/api/admin/master-scanners` | List master scanner keys. |
| `POST` | `/api/admin/master-scanners` | Create master key. Body: `{ label, activeUntil? }`. Returns plain key ONCE. |
| `DELETE` | `/api/admin/master-scanners/:id` | Revoke master key. |

---

## Non-obvious gotchas

- **Admin allowlist is DB-backed, not env-backed.** The `ADMIN_WALLETS` env var is only consulted on first boot to seed the table. After that, edits go through the `/access` page or direct SQL. Changing `.env` and restarting does **not** re-sync.
- **Master wallet is re-seeded on every API boot.** If you intentionally want the master replaced, change the `MASTER_WALLET` constant in `adminController.js` (currently `0x8eB8Bf106EbC9834a2586D04F73866C7436Ce298`); otherwise the boot-time upsert will restore it.
- **Removing your own wallet is blocked server-side, not only in the UI.** A curl call to `DELETE /api/admin/admins/:myOwnAddress` returns 400. This prevents the "last admin locks themselves out" foot-gun without needing a hard-coded minimum-admin rule.
- **Master scanner keys are one-reveal-only.** There is no decrypt-and-show endpoint for them (unlike organizer-scoped keys, which use the AES-GCM reveal path). If the operator loses the key, revoke and issue a new one.
- **`ScannerDevice.organizerId` is nullable** — as of the April 2026 migration. Callers that read this column must handle `null`.
