# API Reference

Base URL (prod): `https://api.gembaticket.com`
Base URL (dev): `http://localhost:3080`

Auth: `Authorization: Bearer <JWT>` unless noted "public". Scanner endpoints accept either a scanner-JWT or the plain `X-Scanner-Key: <apiKey>` header.

Response convention: `200 OK { … }` on success, `4xx { error: string }` on client error, `5xx { error: string }` on server error. `429` on rate limits.

---

## Auth (`/api/auth`)

| Method | Path | Body | Auth | Notes |
|---|---|---|---|---|
| POST | `/register` | `{ email, password, name, turnstileToken? }` | public | Returns `{ otpRequired: true }`. Follow with `/register-verify-otp`. |
| POST | `/register-verify-otp` | `{ email, code }` | public | Returns `{ token, organizer }`. |
| POST | `/login` | `{ email, password, turnstileToken? }` | public | Returns `{ token, organizer }` **or** `{ otpRequired: true }` if OTP-at-login is enabled (default). |
| POST | `/login-verify-otp` | `{ email, password, code }` | public | Returns `{ token, organizer }`. |
| POST | `/purchase-otp/send` | `{ email, eventId, ticketTypeId, quantity }` | public | Sends 6-digit code with event context (name, venue, date, type, qty). |
| POST | `/purchase-otp/verify` | `{ email, code }` | public | Returns opaque `{ token }` (15-min TTL, not a JWT). |
| POST | `/otp-login-pref` | `{ disabled: boolean }` | JWT | Toggles OTP-at-login for the current account. |
| GET  | `/me` | — | JWT | Returns `{ organizer }` including `otpLoginDisabled`. |
| GET  | `/nonce` | — | public | SIWE nonce. |
| POST | `/siwe` | `{ message, signature }` | public | Returns `{ token, organizer }`. |

Ghost-wallet emails (`/^0x[0-9a-f]+@wallet\.gembaticket\.com$/i`) skip OTP-at-login.

## Events (`/api/events`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET  | `/` | public | List published events. |
| GET  | `/:id` | public | Detail + ticket types + on-chain info (if deployed). |
| POST | `/` | JWT | Create event (organizer). |
| PATCH | `/:id` | JWT | Update event metadata. |
| POST | `/:id/deploy` | JWT | Creates GembaPay charge (€10). Returns `{ paymentUrl, orderId }` or `{ retry: true }` if already paid. |

## Tickets (`/api/tickets`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/buy` | JWT optional | Body: `{ eventId, ticketTypeId, quantity, email?, otpToken? }`. `otpToken` required iff no JWT. Returns `{ paymentUrl, ticketId }`. |
| GET  | `/:id` | public | Public ticket view (rotating QR). |
| GET  | `/my` | JWT | Current user's tickets. |
| GET  | `/event/:eventId` | JWT | Organizer view — tickets for their event. |

NFT claim is a dedicated namespace — see `/api/claim` below. There is no `POST /tickets/:id/claim`.

## Dashboard — events (`/api/dashboard/events`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET  | `/` | JWT | Organizer's events. |
| GET  | `/:id/tickets` | JWT | Paginated tickets for an event (`?limit`, `?status`, `?search`). |

## Dashboard — zones (`/api/dashboard`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET  | `/events/:eventId/zones` | JWT | List zones for an event. |
| POST | `/events/:eventId/zones` | JWT | `{ name, color?, level }`. |
| PUT  | `/zones/:id` | JWT | Update. |
| DELETE | `/zones/:id` | JWT | Remove. |

## Dashboard — scanners (`/api/dashboard/scanners`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET  | `/` | JWT | Organizer's scanners. |
| POST | `/` | JWT | `{ eventId?, label, zones?, activeFrom?, activeUntil? }`. Returns plain apiKey **once**. |
| POST | `/:id/reveal` | JWT | Re-reveal plain key from AES-GCM ciphertext; writes `ScanLog { action: "reveal" }`. |
| PATCH | `/:id` | JWT | Update label/zones/validity window. |
| DELETE | `/:id` | JWT | Revoke (`revokedAt = now()`). |

## Dashboard — chain actions (`/api/dashboard`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET  | `/events/:eventId/actions` | JWT | Last 100 `ChainAction` rows for an event. |
| POST | `/events/:eventId/actions/estimate` | JWT | Body: `{ fn, args }`. Returns `{ fn, paid, gasUnits, gasEth, gasEur, feeEur, totalEur, eurPerEth }`. |
| POST | `/events/:eventId/actions` | JWT | Body: `{ fn, args }`. Returns `{ action, paymentUrl, estimate }`. `paymentUrl` is `null` for free actions. |
| GET  | `/actions/:id` | JWT | Single action with current status. |
| POST | `/actions/:id/retry` | JWT | Free retry of a REVERTED / REFUNDED action. |

Supported `fn` values: `increaseSupply`, `increaseTypeSupply`, `addTicketType`, `toggleTicketType`, `toggleSale`, `setOperator`, `renounceOperator`. See [`CHAIN_ACTIONS.md`](./CHAIN_ACTIONS.md) for the full args contract.

## Scanner (`/api/scanner`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth` | scanner-key | Exchange `{ apiKey }` for a short-lived scanner-JWT + scanner/event context. |
| GET  | `/whoami` | scanner | Returns current scanner + event + zones. |
| POST | `/validate` | scanner | `{ payload }` — decodes rotating QR, enforces zone, writes `ScanLog`, enqueues activation. |
| POST | `/manual` | scanner | Manual claim-code entry fallback. |

## Claim (`/api/claim`)

The claim flow is three endpoints. The buyer's wallet submits `claimTicket(...)` directly to the event contract — the backend only *signs* the EIP-712 message, it never pays gas. Once the SPA sees `isConfirmed`, it POSTs `/confirm` so the UI flips to "claimed" without waiting for the block listener.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/sign` | JWT | Body: `{ ticketId, walletAddress }`. Returns `{ signature, claimHash, contractAddress, eventType, typeId }`. Validates ticket ownership, event state, and that the NFT is not already claimed, then returns an EIP-712 signature for the buyer wallet to submit on-chain. |
| POST | `/confirm` | public | Body: `{ ticketId, txHash }`. Reads the transaction receipt, parses the `TicketClaimed` log matching the ticket's `claimHash`, and marks `nftClaimed=true / tokenId / claimedWallet / claimedAt` in the DB. Idempotent — if already claimed, returns the current state. Returns `409` if the tx is not yet confirmed. |
| GET  | `/status/:ticketId` | public | Returns `{ ticketId, nftClaimed, claimedWallet, tokenId, claimedAt, contractAddress }`. |

The on-chain `eventListener` worker also watches `TicketClaimed` and writes the same row — `/confirm` is the *fast path*, the listener is the *fallback* for cases where the SPA tab is closed before the receipt arrives.

## Webhooks (`/webhooks`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/gembapay` | HMAC-SHA256 header | Handles `payment.completed`. Dispatches by orderId prefix: `deploy-*` (event deploy), `ticket-*` (ticket purchase), `action-*` (paid chain action). Raw body required for signature verification. |

## Health

| Method | Path | Notes |
|---|---|---|
| GET  | `/health` | API health (DB + Redis) + chain-worker queue counts. |

## Rate limits

| Group | Limit |
|---|---|
| Auth endpoints | 20/min per IP |
| OTP send | 5/min per IP + 30s cooldown per email |
| Ticket buy | 10/min per IP |
| Scanner validate | 120/min per scanner |
