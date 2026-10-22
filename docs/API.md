# API Reference

Base URL (prod): `https://api.gembaticket.com`
Base URL (dev): `http://localhost:3100`

Auth: `Authorization: Bearer <JWT>` unless noted "public". Scanner endpoints accept either a scanner-JWT or the plain `X-Scanner-Key: <apiKey>` header.

Response convention: `200 OK { … }` on success, `4xx { error: string }` on client error, `5xx { error: string }` on server error. `429` on rate limits.

Times: every date/time an organizer sends (event date, ticket-type sale and entry windows, discount-code validity) may be the venue's **wall-clock** (`"2026-12-01T18:00"`), read in the event's IANA time zone (`Event.timezone`); an ISO string with an offset is taken as-is. Instants are stored in UTC.

*Reference re-checked against the route files on 2026-10-21.*

---

## Auth (`/api/auth`)

| Method | Path | Body | Auth | Notes |
|---|---|---|---|---|
| POST | `/register` | `{ email, password, name, company?, wallet?, turnstileToken? }` | public | Validates + emails OTP. Returns `{ otpRequired: true, email }`. No DB row written yet. |
| POST | `/register-verify-otp` | `{ email, password, name, company?, wallet?, phone?, code }` | public | Verifies OTP, creates organizer with `verified=true`, returns `{ token, organizer }`. |
| POST | `/login` | `{ email, password, turnstileToken? }` | public | Returns `{ token, organizer }`, `{ otpRequired: true }` (email code) or `{ totpRequired: true }` (authenticator app). |
| POST | `/login-verify-otp` | `{ email, password, code }` | public | Returns `{ token, organizer }`. |
| POST | `/login-verify-totp` | `{ email, password, code }` | public | Returns `{ token, organizer }`. |
| POST | `/purchase-otp/send` | `{ email, eventId, ticketTypeId, quantity }` | public | Sends 6-digit code with event context (name, venue, date, type, qty). |
| POST | `/purchase-otp/verify` | `{ email, code }` | public | Returns opaque `{ token }` (15-min TTL, not a JWT). |
| GET  | `/nonce` · POST `/wallet-login` | — | public | Sign-in with a wallet (SIWE). |
| GET  | `/me` | — | JWT | Current account incl. the derived `twoFactorMethod` (`email` / `totp` / `none`). |
| POST | `/logout` | — | JWT | Revokes the token (denylist). |
| PUT  | `/profile` · POST `/link-wallet` · `/unlink-wallet` · `/link-email` | — | JWT | Profile and identity links. |
| POST | `/2fa/method` · `/2fa/totp/setup` · `/2fa/totp/enable` · `/otp-login-pref` | — | JWT | Login second factor. |

## Events (`/api/events`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET  | `/` | public | Active events (organizers also see their own). |
| GET  | `/:id` | public | Detail, ticket types with sale gates, stats, `endsAt` (when the event ends on its own), `hasDiscountCodes`. The organizer additionally gets `refunds` (refund progress after a cancel). |
| POST | `/` | JWT | Create event (multipart, optional poster). Wall-clock times + `timezone`. Requires a connected GembaPay account. |
| POST | `/:id/deploy` | JWT | Deploys the event contract. Free while fees are off (`FEES_ENABLED=false`): returns `{ free: true, deploying: true }`. Deploys are queued one at a time. |
| POST | `/:id/edit/request-otp` | JWT | Starts the 2FA confirmation for a date/venue change. |
| PATCH | `/:id` | JWT | `{ eventDate, timezone?, venue, code }` — 2FA-confirmed date/time/venue change; `eventDate` is venue wall-clock in `timezone` (default: the event's zone). |
| POST | `/:id/share-promo` · `/:id/promo-type` | JWT | Send free promo tickets / add promo supply. |

## Tickets (`/api/tickets`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/buy` | JWT optional | `{ eventId, ticketTypeId, quantity, buyerEmail?, otpToken?, discountCode? }`. `otpToken` required iff no JWT. A discount code is checked inside the purchase transaction. Returns `{ ticketIds, paymentUrl, total, currency, discount }`. |
| POST | `/discount/check` | public (20/min per IP) | `{ eventId, ticketTypeId, quantity, code }` → price preview `{ valid, unitPrice, unitDiscount, total, totalBefore }` or `400 { valid: false, error }`. |
| GET  | `/:id` · `/by-token/:token` | public | Ticket view (rotating QR). |
| GET  | `/my` | JWT | Current user's tickets. |
| GET  | `/event/:eventId` | JWT | Organizer view — tickets for their event. |

## Dashboard (`/api/dashboard`, JWT, own events only)

| Method | Path | Notes |
|---|---|---|
| GET  | `/stats` · `/events` · `/events/:id` | Overview, organizer's events, one event with stats (revenue = price actually paid). |
| PUT  | `/events/:id` | Name / description / image (date and venue go through the 2FA route above). |
| GET  | `/events/:id/tickets` | Paginated tickets (`?limit`, `?status`, `?search`), incl. `pricePaid` and the discount code. |
| GET  | `/events/:id/tickets.csv` | **CSV export** of every ticket: type, zone, buyer, list price, code, discount, paid, NFT claim, purchase / scan / cancel / refund times (venue zone), refund status. UTF-8 with BOM. |
| GET / POST | `/events/:id/discount-codes` | List / create a **discount code** `{ code, kind: "percent"\|"fixed", value, ticketTypeIds?, maxUses?, validFrom?, validUntil? }` (percent 1–99; the price may not fall below 0.50). |
| PATCH / DELETE | `/discount-codes/:id` | Switch on/off, change limits; delete only an unused code. |
| POST | `/events/:id/cancel/request-otp` · `/events/:id/cancel` | **Cancel the event** `{ refundMode: "auto"\|"manual", reason?, code }` (2FA). Voids every ticket, e-mails buyers, marks the contract canceled; `auto` refunds every paid order through the organizer's GembaPay key (needs `refunds:write`). |
| POST | `/events/:id/refunds/retry` | Retry failed automatic refunds. |
| POST | `/refunds/request-otp` · `/tickets/:id/refund` | **Refund one ticket** `{ code }` (2FA) — the price paid, from the organizer's GembaPay account; the buyer is e-mailed, the gate refuses the ticket. |
| POST | `/events/:id/refunds/refund-all` | `{ code }` (2FA) — a canceled event with manual refunds: refund every buyer now. |
| PATCH | `/ticket-types/:id/schedule` | Sale window, unlock rules, sort order, entry window (venue wall-clock). |
| GET / PUT | `/payment-connection` | The organizer's GembaPay API key + webhook secret (stored encrypted). |
| GET / POST / PUT | `/notifications`, `/notifications/read`, `/notifications/prefs` | In-app notifications (incl. `event_canceled`, `event_ended`, `refund_failed`). |

## Dashboard — zones, scanners, chain actions

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/api/dashboard/events/:eventId/zones` | List / create `{ name, color?, level }`. |
| PUT / DELETE | `/api/dashboard/zones/:id` | Update / remove. |
| GET / POST | `/api/dashboard/scanners` | Organizer's scanners / create `{ eventId?, label, zones?, activeUntil? }` — plain key returned **once**. |
| POST | `/api/dashboard/scanners/:id/reveal` | Re-reveal the key from its AES-GCM copy; audit-logged. |
| GET | `/api/dashboard/scanners/:id/logs` | Scan log. |
| DELETE | `/api/dashboard/scanners/:id` | Revoke. |
| GET | `/api/dashboard/events/:eventId/actions` | Last 100 chain actions. |
| POST | `/api/dashboard/events/:eventId/actions/estimate` · `/actions` | `{ fn, args }` — on-chain changes (supply, ticket types, sale toggle, operator). Free while fees are off. |
| GET / POST | `/api/dashboard/actions/:id` · `/actions/:id/retry` | Status / free retry of a reverted or refunded action. |

## Scanner (`/api/scanner`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth` | scanner-key | Exchange `{ apiKey }` for a short-lived scanner-JWT + scanner/event context. |
| GET  | `/me` | scanner | Current scanner + event + zones. |
| POST | `/scan` | scanner | `{ payload }` — read-only check of the rotating QR. `403 { valid: false, reason }` for a wrong event/zone, outside the entry window, a canceled or ended event, or a canceled / refunded / unpaid ticket. |
| POST | `/activate` | scanner | Admit + burn (same checks). `409` on a second activation. `423 { heldBy }` when another gate holds the ticket's offline right and cannot be reached (a reachable one is asked and the call waits ≤ 6 s). The on-chain `activateTicket` follows asynchronously (chain worker) for claimed NFTs. |
| POST | `/activate-manual` | scanner | Admit by ticket id when the QR cannot be read (same `423` rule). |
| GET  | `/snapshot` | scanner | Offline mode: active events + valid tickets, ETag'd. Send `X-Offline-Protocol: 2`: a ticket's QR seed comes only to the scanner holding its **offline entry right** (`own`), others carry `holder` (the gate that holds it); `leaseSeq` = the scanner's release counter. Without the header: no seeds. |
| POST | `/offline/heartbeat` | scanner | `{ released: [ticketId], since }` → `{ seq, release: [ticketId], stale, used: [{ id, activatedAt }], serverTime }` — every 3 s while online: acknowledge dropped rights, get the ones to drop, `stale` = refetch the snapshot, `used` = tickets this scanner holds that were used since `since` (send back `serverTime` next time) — mark them used locally. |
| POST | `/sync` | scanner | Replay offline door decisions (idempotent per `clientId`; `conflict` = another scanner admitted it first). |

## Platform admin (`/api/admin`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET · POST | `/auth/nonce` · `/auth/verify` | public | Wallet sign-in (signature). |
| POST | `/auth/login` | public | `{ email, password }` → `{ token, admin }` or `{ requires2fa, method: "email"\|"totp", challengeToken }`. |
| POST | `/auth/login/2fa` | public | `{ challengeToken, code }` — the e-mail code, the app code or a backup code. Single-use challenge, 10 min, 5 tries. |
| POST | `/auth/logout` | admin | Revokes the token. |
| GET  | `/me` · `/account` | admin | Session / own account (e-mail, wallet, password set, 2FA method, backup codes left). |
| POST | `/account/password` | admin | `{ currentPassword?, newPassword }` (min 12). |
| POST | `/account/email/start` · `/account/email/confirm` | admin | Code to the NEW address → confirm. |
| GET · POST | `/account/wallet/nonce` · `/account/wallet` | admin | The NEW wallet signs the server-built message → new session; old wallet out. |
| POST | `/account/2fa/totp/setup` · `/totp/enable` · `/email/enable` · `/disable` · `/backup-codes` | admin | Two-factor (off by default). |

The rest of `/api/admin` (monitoring, organizers, events, chain jobs, admins, master scanners) is internal to the admin panel.

## Claim (`/api/claim`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/relay` | JWT | `{ ticketId, walletAddress, ownershipSignature, claimCode }` — gasless NFT claim: the holder signs a free message, the platform relayer mints (`claimTicketFor`). Refused for canceled / refunded tickets and canceled events. |
| GET  | `/status/:ticketId` | public | `{ nftClaimed, claimedWallet, tokenId, claimedAt, contractAddress }`. |

The original client-pays `/sign` + `/confirm` routes are disabled (kept in the code).

## Webhooks (`/webhooks`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/gembapay` | HMAC-SHA256 header | `payment.completed` dispatched by orderId prefix: `deploy-*`, `ticket-*`, `action-*`. `payment.refunded` for `ticket-*`: a full refund marks the order's tickets REFUNDED; a single-ticket refund is matched by its refund id. A ticket order paid after its event was canceled is queued for refund. Signed with the organizer's webhook secret (ticket orders) or the platform secret. |

## Health

| Method | Path | Notes |
|---|---|---|
| GET  | `/health` | API health (DB + Redis) + chain-worker queue counts. |

## Rate limits

| Group | Limit |
|---|---|
| Auth / OTP endpoints | 10/min per IP (fail-closed) + 30s resend cooldown per email |
| Public reads (`/api/events`, `/api/tickets`) | 120/min per IP |
| Discount-code check | 20/min per IP (fail-closed) |
| Deploy and chain actions | 5/min, 50/h, 200/day per IP and per organizer |
| Scanner | 120/min **per scanner device** (2026-10-21 — was per IP, which every door behind one venue NAT shared), heartbeat 60/min per device, 600/min per IP in front of auth; `/auth` 10/min |
| Admin e-mail login | 10 / 15 min per IP + 10 failures per e-mail → 15 min lock; 2FA codes 15 / 15 min; account changes 15 / 15 min; codes to a new e-mail 5 / h (all fail closed) |
| Webhooks | 100/min |
