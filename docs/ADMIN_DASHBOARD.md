# Platform Admin Dashboard

> `admin.gembaticket.com` — the internal panel GembaTicket operators use to observe the platform, provision access, and triage on-chain jobs. **Source is in a private repository** (`frontend/ticket-admin`); this document describes the shape and responsibilities so the public docs make sense on their own.

Unlike the organizer dashboard, the admin panel is **not self-service**: only admins on the `AdminWallet` table can reach it, and one admin (the master) can never be removed. An admin signs in with the **wallet** (a signature) or — once they have set one up — with **e-mail + password**, optionally with two-factor.

---

## Auth model (2026-10-21)

The login page has two tabs, **Email** and **Wallet** — the same model as the GembaPay owner dashboard.

| Way in | How | Second factor |
|---|---|---|
| Wallet | `GET /api/admin/auth/nonce` → the wallet signs a SIWE-style message → `POST /api/admin/auth/verify` | none (the signature is the proof) |
| E-mail | `POST /api/admin/auth/login { email, password }` | optional — chosen by the admin under **My account**: a 6-digit **code by e-mail** or an **authenticator app** (TOTP); **off by default**. With it on, the login returns a challenge and `POST /api/admin/auth/login/2fa { challengeToken, code }` finishes it. One of 8 backup codes works instead of the code, once. |

- **Session token** `{ kind: "admin", wallet, via: "wallet"|"email", jti }`, `JWT_EXPIRES` (7 days). `POST /api/admin/auth/logout` puts the `jti` on the denylist; changing the wallet revokes the session used for it.
- **Challenge token** (2FA, e-mail change) has its own kind (`admin-challenge`), lives 10 minutes, is **single-use** (Redis), and dies after **5 wrong codes**. It is never accepted as a session; organizer tokens are refused on the admin API and admin tokens on the organizer API. The e-mail code is carried only as an HMAC keyed with the server secret.
- **Passwords**: at least 12 characters, bcrypt cost 12. **TOTP secret** AES-256-GCM encrypted at rest; **backup codes** stored as sha256. A TOTP code cannot be replayed within its time step.
- **Brute force**: e-mail login 10 / 15 min per IP and **10 failures per e-mail → that e-mail locked 15 min**; 2FA codes 15 / 15 min per IP; account changes 15 / 15 min per IP; codes to a new e-mail 5 / hour. All fail closed. "No such e-mail" and "wrong password" get the same answer and cost the same time.
- **Allowlist is DB-backed** (`AdminWallet`). Adding or removing an admin takes effect on the next API call. `GET /api/admin/me` returns `{ wallet, isMaster, via, email, twoFactorMethod }`.

### My account (`/account`)

| Change | Needs |
|---|---|
| Add / change the e-mail | the current password (once one is set) + a code sent to the **new** address |
| Set / change the password | an e-mail first; the current password to change it |
| Change the sign-in wallet | the current password (once set) + a signature from the **new** wallet over a server-built message; the old wallet stops working at once |
| Two-factor: off / code by e-mail / authenticator app | e-mail + password set; the current password; the app is confirmed with a code before it is switched on; new backup codes each time |

Every change is e-mailed to the admin (an e-mail change to the old and the new address). Errors on these routes are `400` — the admin client ends the session on `401`/`403`.

### The master wallet

One row on `AdminWallet` carries `isMaster = true` (the owner's — linked to the e-mail `ivanovslavy@gmail.com` on 2026-10-21; the password is set by the owner under My account). It cannot be removed through the UI or API.

### `AdminWallet` schema

```prisma
model AdminWallet {
  address          String    @id          // lowercase 0x-hex — the sign-in wallet
  label            String?
  isMaster         Boolean   @default(false)
  createdAt        DateTime  @default(now())
  createdByWallet  String?
  email            String?   @unique      // e-mail login (2026-10-21)
  emailVerifiedAt  DateTime?
  passwordHash     String?               // bcrypt
  twoFactorMethod  String?               // null | "email" | "totp"
  totpSecretEnc    String?   ; totpSecretNonce  String?
  totpPendingEnc   String?   ; totpPendingNonce String?
  backupCodes      String[]  @default([]) // sha256
  updatedAt        DateTime  @updatedAt
  @@index([isMaster])
}
```

Migrations: `20260420_admin_wallets_and_master_scanners`, `20261021_admin_email_login` — applied on prod via `npx prisma db execute` + `npx prisma migrate resolve --applied`.

Seeding (`server.js → seedAdminWallets()`): **only into an empty table** — `MASTER_ADMIN_WALLET` as master plus `ADMIN_WALLETS`. Afterwards the DB is the only source of truth: a removed admin stays removed and a changed wallet is not re-added on restart (until 2026-10-21 every boot upserted them back). If no row is master any more, the env master is restored as master.

The admin list (`GET /api/admin/admins`) never returns the password hash, TOTP secret or backup codes — only whether e-mail login and two-factor are on.

### Middleware

`requireAdminAuth` (`src/middleware/auth.js`) verifies the JWT, checks the `jti` denylist, then queries `AdminWallet.findUnique({ address })` on every request. If the row has been deleted since the JWT was issued, the request gets **403 immediately** — revoking an admin is effectively instant, bounded only by the current in-flight request.

---

## Navigation

The left rail lists eleven destinations. All of them require admin auth.

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
| `/access` | KeyRound | Admins + master scanner keys |
| `/account` | UserCog | My account — e-mail, password, wallet, two-factor |

`Login.jsx` is public; every other route is wrapped in `DashboardLayout`, which rejects non-admins.

---

## Pages

### Overview (`/`)

KPI strip + recent-activity list. Data comes from `GET /api/admin/monitoring` (subset). Shown: active organizers, active events, tickets sold (24h / 7d), active scanners, failing chain jobs, unhealthy services.

### Revenue (`/revenue`)

`GET /api/admin/revenue` — platform-fee earnings broken down by event and organizer over the last 30 days, plus a time-series for charting. Numbers are denominated in EUR (GembaPay's reporting currency), with optional GMB-equivalent for chain-action gas.

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
| `GET` | `/api/admin/revenue` | Revenue breakdown (EUR + GMB). |
| `GET` | `/api/admin/organizers` | Paginated organizer list (ghost-filtered). |
| `GET` | `/api/admin/organizers/:id` | Organizer detail. |
| `GET` | `/api/admin/events` | Paginated event list. |
| `GET` | `/api/admin/events/:id` | Event detail + chain history. |
| `GET` | `/api/admin/operator-wallet` | Operator wallet balance + nonce (GembaBlockchain). |
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
