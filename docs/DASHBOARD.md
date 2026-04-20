# Organizer Dashboard — end-to-end guide

> `dashboard.gembaticket.com` — the workspace an event organizer uses to launch an event on GembaTicket, sell tickets, staff the gates, and steer on-chain state after deploy.

This document describes every screen the organizer sees, in the order a first-time user meets them, and what happens behind each click. For the underlying paid-chain-action mechanics, see [`CHAIN_ACTIONS.md`](./CHAIN_ACTIONS.md).

---

## 1. Sign-up & sign-in

### Register

`POST /api/auth/register { email, password, name, turnstileToken? }`

- The server creates a `PENDING` organizer row and sends a 6-digit OTP to the email (Redis, 10-min TTL).
- UI prompts for the code → `POST /api/auth/register-verify-otp { email, code }` → JWT.

### Log in

Three routes coexist on the same login card:

1. **Email + password** — default. If the account has `otpLoginDisabled=false` (default), the server returns `{ otpRequired: true }` and sends a 6-digit code; UI then calls `/login-verify-otp` to exchange `(email, password, code)` for a JWT. OTP-at-login can be disabled once logged in via *Account → Security*.
2. **Sign-In With Ethereum (SIWE)** — for organizers who have connected a wallet. `GET /api/auth/nonce` → wallet signs → `POST /api/auth/siwe { message, signature }` → JWT. SIWE bypasses OTP entirely.
3. **Ghost-wallet login** — the dashboard never routes organizers here, but the API recognises `0x…@wallet.gembaticket.com` ghost addresses created by guest purchases and skips OTP for them so they can be upgraded later.

### Account screen

- Toggle OTP-at-login (`POST /api/auth/otp-login-pref`).
- Show connected wallet (if any).
- Show pending ghost-account merges.

---

## 2. Home — events list

After sign-in, the landing page is `/events`.

`GET /api/dashboard/events` returns the organizer's events with counts (paid tickets, activated tickets, zones, scanners). Each card shows:

| Badge | Meaning |
|---|---|
| **DRAFT** | Never deployed. Editable metadata + ticket types. |
| **PENDING_PAYMENT** | Deploy invoice issued, buyer has not paid. |
| **DEPLOYING** | Deploy paid; awaiting IPFS upload + `createEvent` + `setupEvent` on-chain. Dashboard polls every 5s. |
| **ACTIVE** | Contract deployed and live. Sale may or may not be toggled on. |
| **ENDED** | `endEvent()` called on-chain. |
| **CANCELED** | `cancelEvent()` called on-chain. Refunds flow automatically. |

A `+ New event` button opens the creator wizard.

---

## 3. Create event (wizard)

Four steps on the same page, no navigation between them:

1. **Basics** — name, description, venue, address, starts/ends, banner image (uploaded to backend, served from the storefront).
2. **Contract type** — `ERC721` (single supply) or `ERC1155` (multiple ticket types with different supplies). Locked after save.
3. **Ticket types**
   - ERC-721: one implicit type with `maxSupply` + `priceEur`.
   - ERC-1155: add N types, each with `name`, `maxSupply`, `priceEur`, `zoneLevel` (linked to Zone, see §5).
4. **Publish** — `POST /api/events` creates the `DRAFT`. `PATCH /api/events/:id` updates it.

Saving returns to the event detail page.

---

## 4. Event detail page (pre-deploy)

Visible while `status=DRAFT` or `PENDING_PAYMENT`:

- **Metadata card** — editable name / dates / venue / banner.
- **Ticket types card** — add / edit / remove types (free while DRAFT).
- **Zones card** — see §5. Can be defined pre- or post-deploy.
- **Deploy button** — opens the deploy modal.

### Deploy payment (€10)

```
POST /api/events/:id/deploy
      │
      ▼
  GembaPay charge (€10, orderId "deploy-{eventId}-{rand}")
      │ returns { paymentUrl, orderId }
      ▼
  dashboard opens paymentUrl in a new tab
      │
      ▼ buyer pays → webhook fires
  handleDeployPayment:
    1. upload event metadata → IPFS, note the CID
    2. PlatformRegistry.createEvent(...)        → clone address
    3. EventContract.setupEvent(ticketTypes)    → locks platform role
    4. Event.status = ACTIVE, contractAddress, ipfsHash saved
      │
      ▼
  dashboard polls GET /api/events/:id every 5s until ACTIVE
```

If a deploy already has a paid invoice attached, the endpoint returns `{ retry: true }` and the dashboard re-polls instead of double-charging.

---

## 5. Zones

Zones are named, colored gates (`VIP`, `Ground`, `Backstage`…). Each zone has a unique integer `level` within an event. Ticket types reference a zone by level; scanner devices carry an allowed-level array.

### UI

- **Zone editor card** on event detail — list + inline add/edit/delete.
- Color chip, name, level. The level is used on-chain (baked into `TicketType.zoneLevel`) so changing it after deploy is a chain action, not a DB edit.

### API

```
GET    /api/dashboard/events/:eventId/zones
POST   /api/dashboard/events/:eventId/zones   { name, color?, level }
PUT    /api/dashboard/zones/:id               { name?, color? }
DELETE /api/dashboard/zones/:id
```

Validation enforces `@@unique([eventId, level])` on the Prisma side.

---

## 6. Event detail page (post-deploy)

Once `status=ACTIVE`, the page grows three new panels plus the chain-action history. The top of the page shows:

- Contract address (linked to Etherscan).
- Operator address (editable via OperatorPanel).
- Sale status + toggle button.
- IPFS hash.

### 6a. SupplyPanel

The behaviour branches by contract type.

**ERC-721** — one card showing:

- Minted / max supply.
- *Increase supply* form → `increaseSupply({ additional: N })`.

**ERC-1155** — one row per ticket type:

- Name, typeId, minted / max, active/inactive badge.
- *Add N* form → `increaseTypeSupply({ typeId, additional })`.
- *Toggle* button → `toggleTicketType({ typeId })`.

Below the rows, an *Add new ticket type* form (auto-calculates the next `typeId`, asks for `name`, `maxSupply`, `zoneLevel`) → `addTicketType({ typeId, name, maxSupply, zoneLevel })`.

Every one of these buttons opens the **shared** [`ChainActionPaymentModal`](#7-chain-action-payment-modal).

### 6b. OperatorPanel

Collapsible *Advanced* panel. Two actions — both **free** (no GembaPay charge):

| Action | What it does |
|---|---|
| *Set operator* | `setOperator({ operator: address })` — rotate platform relay to any address. |
| *Revoke operator* | `renounceOperator()` — after this, the organizer must sign future changes themselves. |

Still routed through the payment modal for UX consistency — the modal short-circuits payment when the backend responds with `paid=false` and no `paymentUrl`.

### 6c. Sale toggle

A single button on the event header → `toggleSale({})`. Paid (gas + €5). This is the most-used chain action; it flips `Event.saleActive` both on-chain and (after receipt) in Prisma.

### 6d. ActionHistory

`GET /api/dashboard/events/:eventId/actions` (last 100). Each row:

| Column | Source |
|---|---|
| fn | `action.fn` |
| args | pretty-printed from `action.args` JSON |
| status | `AWAITING_PAYMENT` / `PAID` / `SUBMITTED` / `CONFIRMED` / `REVERTED` / `REFUNDED` / `FAILED` / `RETRIED` |
| when | `createdAt` |
| cost | `estimatedEur` (or *free*) |
| tx | Etherscan link if `txHash` is set |
| retry | button shown for `REVERTED` / `REFUNDED` rows (see §8) |

In-flight rows (`AWAITING_PAYMENT`, `PAID`, `SUBMITTED`) are polled every ~6s until terminal.

---

## 7. Chain-action payment modal

`ChainActionPaymentModal.jsx` is the single UI everything routes through. Two steps:

### Step 1 — estimate

`POST /api/dashboard/events/:eventId/actions/estimate { fn, args }` returns:

```json
{
  "fn": "increaseSupply",
  "paid": true,
  "gasUnits": "64123",
  "gasEth": "0.0042",
  "gasEur": "11.76",
  "feeEur": "5.00",
  "totalEur": "16.76",
  "eurPerEth": 2800
}
```

The modal renders the breakdown. For free actions (`setOperator`, `renounceOperator`), the cost block is replaced with an "Operator rotation is free" notice.

### Step 2 — submit

`POST /api/dashboard/events/:eventId/actions { fn, args }` creates the action row and, for paid ones, a GembaPay invoice.

- **Paid**: response `{ action, paymentUrl, estimate }`. The modal opens `paymentUrl` in a new tab. From here the flow is the GembaPay checkout → webhook → ChainJob → receipt → Prisma mirror + email.
- **Free**: response `{ action, paymentUrl: null, estimate }`. The action is already marked `PAID` server-side and the ChainJob was enqueued in the same request.

In either case, the modal polls `GET /api/dashboard/actions/:id` every ~4s and shows progress: *Awaiting payment → Payment received → Submitted to chain → Confirmed* (or *Reverted / Refunded*). On `CONFIRMED`, the parent page fires its `onActionDone()` callback to reload the event + action history.

---

## 8. Free retries

Transient chain failures (RPC hiccup, competing-block revert) reach `REVERTED` → refund flow → `REFUNDED`. The ActionHistory row exposes a *Retry* button.

- `POST /api/dashboard/actions/:id/retry` creates a **new** action with `retryOfId = parent.id`, `feeEur=0`, `estimatedEur=0`, `status=PAID`.
- Parent row flips to `RETRIED` and loses its retry button.
- The new action runs through the worker with no checkout.

This matters because we do not want to charge an organizer twice for what amounts to one logical operation.

---

## 9. Scanners tab

Scanner devices authenticate gate staff against `/api/scanner/*`. From the dashboard:

### Create a scanner

`POST /api/dashboard/scanners { eventId?, label, zones?, activeFrom?, activeUntil? }`:

- `eventId` optional — omit for an all-events master key.
- `zones` is an array of zone levels the device is allowed to admit.
- Response includes `apiKey` (plain, shown **once**). Written to the DB as:
  - `apiKeyHash` (bcrypt, hot-path compare on `/api/scanner/auth`).
  - `apiKeyPrefix` (first 8 chars, indexed — narrows the bcrypt candidate set to ≤5 rows).
  - `apiKeyEnc` + `apiKeyNonce` (AES-256-GCM ciphertext of the full key — lets the dashboard re-reveal later).

### Re-reveal

`POST /api/dashboard/scanners/:id/reveal` decrypts the ciphertext, writes a `ScanLog { action: "reveal" }` for audit, and returns the plain key. The master AES key is `SCANNER_KEY_SECRET` (32-byte hex), held only in backend env.

### Edit / revoke

`PATCH /api/dashboard/scanners/:id` updates label / zones / validity window. `DELETE /api/dashboard/scanners/:id` sets `revokedAt=now()` — the hot-path check refuses revoked devices immediately.

### How staff use it

1. The organizer sends the plain `apiKey` to the gate operator.
2. Operator opens `scanner.gembaticket.com`, pastes the key → PWA stores it in IndexedDB.
3. `POST /api/scanner/auth { apiKey }` → short-lived scanner-JWT bound to the device.
4. QR scans call `/api/scanner/validate` with the JWT; offline scans buffer in a Dexie outbox and sync when online.

---

## 10. Tickets tab

`GET /api/dashboard/events/:eventId/tickets?limit=…&status=…&search=…` returns a paginated list. Columns:

| Column | Value |
|---|---|
| # | Ticket number |
| Status | PENDING_PAYMENT / PAID / MINTING / MINTED / CLAIMED / ACTIVATED / CANCELED / REFUNDED |
| Buyer | email, wallet (if claimed) |
| Type / Zone | ticket type + zone chip |
| Paid | amount + GembaPay order link |
| Links | `/ticket/:id` public view, Etherscan token link (if minted) |

Search is substring on email / ticket number.

---

## 11. Ending / cancelling an event

Two owner-only chain actions that the dashboard currently exposes only via a *Danger zone* card (not yet in the ChainActionPaymentModal flow — they're signed by the organizer wallet, not the operator):

- **End event** — `endEvent()`. Prevents further claims/activations. Leaves minted NFTs intact.
- **Cancel event** — `cancelEvent()`. Marks the contract as cancelled; Prisma triggers automatic refunds for PAID tickets via GembaPay.

These require an organizer wallet holding enough Sepolia ETH to pay gas themselves. If the operator has already been revoked, every chain write falls into this category — the dashboard surfaces a banner explaining so.

---

## 12. Rate-limits the organizer will meet

| Where | Limit |
|---|---|
| `/api/auth/*` | 20/min per IP |
| OTP send | 5/min per IP, 30s cooldown per email |
| Ticket `/buy` | 10/min per IP (matters for ops testing) |
| Scanner `/validate` | 120/min per scanner |

Chain-action endpoints inherit the auth limit only (no separate gate — GembaPay is the economic brake).

---

## 13. Glossary

| Term | Meaning |
|---|---|
| **Operator** | Platform signer that executes organizer-initiated chain writes on their behalf. See [`CHAIN_ACTIONS.md`](./CHAIN_ACTIONS.md). |
| **Ghost wallet** | Deterministic `0x…@wallet.gembaticket.com` organizer row created when a guest checks out. |
| **Zone level** | Integer that both ticket types and scanners carry — a scanner admits a ticket iff its zones array contains the ticket type's zone level. |
| **Claim hash** | `keccak256(eventContract, tokenId, secret)` prefix; used in `/ticket/:claimHash` URLs so tickets can be shared without leaking full ownership data. |
| **Action fn** | One of seven strings the backend whitelists: `increaseSupply`, `increaseTypeSupply`, `addTicketType`, `toggleTicketType`, `toggleSale`, `setOperator`, `renounceOperator`. |

---

## 14. Where to look next

- [`CHAIN_ACTIONS.md`](./CHAIN_ACTIONS.md) — full pipeline for the paid chain actions.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the dashboard fits into the wider system.
- [`API.md`](./API.md) — every endpoint referenced here.
- [`OTP_FLOW.md`](./OTP_FLOW.md) — the login OTP shape.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — how the dashboard gets built + shipped to the Raspberry Pi.
