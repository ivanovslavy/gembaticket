# Paid chain actions

After an event is deployed, every change to its on-chain state (supply, sale toggle, ticket types, operator) flows through a single **paid chain action** pipeline. This document is the canonical reference for how that pipeline is wired.

## Motivation

Organizers are email-and-password users who have never held an EVM wallet. Making them sign transactions would break the product. The contract therefore has an **Operator** role, held by the platform signer by default, that can call the day-to-day functions on the organizer's behalf. To prevent the platform from being free-riding labor, every operator-initiated call is metered: the organizer pays `gas + €5` in fiat via GembaPay before the platform sends the transaction.

Sovereignty is preserved — the organizer can swap the operator to any address, or revoke it entirely, with a free transaction at any time.

## Four-role model

| Role | Who holds it | What they can do |
|---|---|---|
| **Owner** | Organizer wallet (or an initial platform-held wallet that the organizer later claims) | `transferOwnership`, `cancelEvent`, `endEvent`, `setPlatform`, `setMintSigner`, `setOperator`, `renounceOperator`, plus everything Operator can do |
| **Operator** | Platform signer (default); `null` after `renounceOperator` | `toggleSale`, `increaseSupply`, `toggleTicketType`, `increaseTypeSupply`, `addTicketType`, `setTokenURI`, `setTypeURI`, `updateBaseURI`, `setURI` |
| **Platform** | Platform signer, one-time | `setupEvent` during deploy. Locked after setup. |
| **MintSigner** | Platform signer, EIP-712 | Signs off-chain claim messages for `claim(…)` |

The Owner ↔ Operator check is implemented as `modifier onlyOwnerOrOperator` on the relevant functions in `EventContract721.sol` and `EventContract1155.sol`.

## Supported actions

| fn | Contract | Paid? | Args |
|---|---|---|---|
| `increaseSupply` | ERC-721 | yes (gas + €5) | `{ additional: uint256 }` |
| `increaseTypeSupply` | ERC-1155 | yes | `{ typeId: uint256, additional: uint256 }` |
| `addTicketType` | ERC-1155 | yes | `{ typeId: uint256, name: string, maxSupply: uint256, zoneLevel: uint256 }` |
| `toggleTicketType` | ERC-1155 | yes | `{ typeId: uint256 }` |
| `toggleSale` | both | yes | `{}` |
| `setOperator` | both | **free** | `{ operator: address }` |
| `renounceOperator` | both | **free** | `{}` |

Operator-rotation is free so organizers can always reach safety without a wallet.

## Lifecycle

```
┌────────────────────┐
│ organizer clicks   │
│ "Add N tickets"    │
└────────┬───────────┘
         │ POST /api/dashboard/events/:eventId/actions { fn, args }
         ▼
┌────────────────────┐    ┌────────────────────┐    ┌────────────────────┐
│ chainActionService │───▶│ estimate gas + EUR │───▶│ ChainAction row    │
│   .createAction    │    │ (ratesService)     │    │ AWAITING_PAYMENT   │
└────────┬───────────┘    └────────────────────┘    └────────┬───────────┘
         │ paymentService.createPayment                       │
         ▼                                                    │
┌────────────────────┐                                        │
│ GembaPay checkout  │                                        │
│ opens in new tab   │                                        │
└────────┬───────────┘                                        │
         │ buyer pays                                         │
         ▼                                                    │
┌────────────────────┐                                        │
│ POST /webhooks/    │  (HMAC-verified, dispatched by         │
│   gembapay         │   orderId prefix "action-*")           │
└────────┬───────────┘                                        │
         │ chainActionService.onPaymentCompleted              │
         ▼                                                    ▼
┌────────────────────┐    ┌────────────────────┐    ┌────────────────────┐
│ ChainAction        │◀──▶│ ChainJob enqueued  │    │ worker polls every │
│  status=PAID       │    │ action=            │───▶│ CHAIN_WORKER_POLL_MS│
│  paid=true         │    │  paid_chain_action │    │ (default 5s)       │
└────────────────────┘    └────────────────────┘    └────────┬───────────┘
                                                             │ chainActivationWorker
                                                             ▼
                               ┌────────────────────────────────────────────┐
                               │ chainActionService.executeAction           │
                               │                                            │
                               │ status=SUBMITTED                           │
                               │ contract[fn](...args) → tx.hash saved      │
                               │ tx.wait()                                  │
                               └────────┬───────────────────────┬───────────┘
                                        │ receipt.status = 1    │ status = 0
                                        ▼                       ▼
                           ┌────────────────────────┐  ┌─────────────────────┐
                           │ onChainConfirmed       │  │ onChainReverted     │
                           │ status=CONFIRMED       │  │ status=REVERTED     │
                           │ syncEventMirror()      │  │ paymentService      │
                           │  updates Prisma        │  │   .refundPayment    │
                           │ sendActionEmail        │  │ status=REFUNDED     │
                           │  (confirmed)           │  │ sendActionEmail     │
                           └────────────────────────┘  │  (reverted/refunded)│
                                                       └─────────────────────┘
```

## Status machine (`ChainAction.status`)

```
AWAITING_PAYMENT → PAID → SUBMITTED → CONFIRMED    ← happy path
                                    ↘ REVERTED → REFUNDED (normal revert)
                                              ↘ FAILED   (refund itself failed, ops needed)
                                                RETRIED  (superseded by a free retry)
```

## Free retries

A REVERTED or REFUNDED action exposes a **free retry** button in the dashboard. Retry semantics:

- `POST /api/dashboard/actions/:id/retry` creates a **new** `ChainAction` with `retryOfId = <parent.id>`.
- The parent is marked `RETRIED`.
- The child is created with `status=PAID` and `feeEur=0`, `estimatedEur=0` — no GembaPay charge.
- The child runs through the same worker path as a fresh action.

This means an organizer whose transaction reverts due to a transient issue (RPC hiccup, competing block inclusion) can re-run the same change without paying twice.

## Cost estimation (`ratesService`)

- Gas estimation uses `contract[fn].estimateGas(...args, { from: signer.address })`.
- Gas price comes from `provider.getFeeData().maxFeePerGas ?? gasPrice`.
- ETH → EUR conversion via CoinGecko `simple/price?ids=ethereum&vs_currencies=eur`, cached in-process for 30s. Fallback rate `2800 EUR/ETH` if unreachable.
- The charged total is `Math.round((gasEur + 5) * 100) / 100`. GembaPay handles final currency conversion at settlement — the platform is not exposed to FX drift.

## Database + mirror sync

After a CONFIRMED receipt, `syncEventMirror(action)` updates Prisma immediately (without waiting for the chain listener) so the dashboard renders live:

| fn | Prisma updates |
|---|---|
| `increaseSupply` | `Event.maxSupply += additional` |
| `increaseTypeSupply` | `TicketType.maxSupply += additional`, `Event.maxSupply += additional` |
| `addTicketType` | `TicketType` row created with `active=true`, `Event.maxSupply += maxSupply` |
| `toggleTicketType` | `TicketType.active = !active` |
| `toggleSale` | `Event.saleActive = !saleActive` |
| `setOperator` | `Event.operatorAddress = operator` |
| `renounceOperator` | `Event.operatorAddress = null` |

The chain listener re-hydrates the same fields on cold start — Prisma and on-chain state are eventually consistent regardless of worker liveness.

## Email notifications

Each terminal state triggers one email to the organizer via `emailService.sendChainActionEmail`:

| `kind` | Trigger | Subject |
|---|---|---|
| `confirmed` | Receipt `status=1` | *Update confirmed on-chain* |
| `reverted` | Receipt `status=0`, refund not attempted (free action) | *Update failed on-chain* |
| `refunded` | Receipt `status=0`, refund succeeded | *Refund issued* |
| `refund_failed` | Receipt `status=0`, refund threw | *Refund could not be completed — action needed* |

`ChainAction.emailSent` is flipped to `true` to enforce at-most-once.

## Operator rotation UX

`OperatorPanel.jsx` in the dashboard wraps `setOperator` / `renounceOperator` in the same `ChainActionPaymentModal`, but the modal short-circuits payment because the backend marks those fns as `paid: false`. The user experience is identical ("Submit → waiting → confirmed") without a checkout step.

Revoking the operator means the organizer must sign all future changes themselves from a wallet that holds Sepolia ETH — the dashboard's paid-action buttons will start failing gas estimation with a meaningful revert reason.

## Webhook dispatch

`webhookController.handleGembaPayWebhook` routes by `orderId` prefix:

| Prefix | Handler |
|---|---|
| `deploy-*` | `handleDeployPayment` — IPFS upload + `PlatformRegistry.createEvent` + `setupEvent` |
| `ticket-*` | `handleTicketPayment` — mark tickets PAID, send ticket emails |
| `action-*` | `chainActionService.onPaymentCompleted` — flip action to PAID, enqueue ChainJob |

All dispatches are idempotent — duplicate webhooks (retries, replays) short-circuit on `action.paid` / `ticket.status` guards.

## Files of record

- Service: `backend/src/services/chainActionService.js`
- Oracle: `backend/src/services/ratesService.js`
- Refund: `backend/src/services/paymentService.js`
- Worker handler: `backend/src/workers/chainActivationWorker.js` (`runPaidChainAction`)
- Controller: `backend/src/controllers/chainActionController.js`
- Routes: `backend/src/routes/chainActionRoutes.js`
- Dashboard UI: `frontend/ticket-dashboard/src/components/events/{ChainActionPaymentModal,SupplyPanel,ActionHistory,OperatorPanel}.jsx`

(Source is private — see the private application repository.)
