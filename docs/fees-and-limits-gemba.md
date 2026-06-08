# Service fees disabled on GembaBlockchain + anti-spam rate limits (2026-06)

GembaTicket was built for Ethereum mainnet, where each on-chain write costs real
gas paid by the platform backend key. Organizers therefore paid a service fee for:
1. **Event creation** (deploy contract),
2. **Add ticket type**,
3. **Add promo ticket / supply changes**.

Now that GembaTicket runs on **GembaBlockchain** (gas ≈ 0), these fees are
**disabled** — but the fee/GembaPay logic is **kept intact**, gated behind a flag.

## How it's disabled (not deleted)
- Env flag **`FEES_ENABLED`** (default **`false`**).
- `backend/src/services/chainActionService.js`: `chargeable = spec.paid && FEES_ENABLED`.
  When false, every action goes straight to `PAID` and executes — no GembaPay charge.
  The `FN_SPECS` (paid:true), fee estimation and GembaPay charge code remain.
- `backend/src/controllers/eventController.js` `deployEvent`: when fees are off it
  deploys directly (no GembaPay), keeping the paid-deploy path for `FEES_ENABLED=true`.
- **Re-enable** anytime: set `FEES_ENABLED=true` in `backend/.env` and restart.

## Anti-spam rate limits (always on)
`backend/src/middleware/rateLimiter.js` → `chainWriteLimiter` (Redis), applied to the
deploy + chain-action endpoints. Enforced **per logged-in organizer AND per IP**:
- **5 / minute**, **50 / hour**, **200 / 24 h** (429 when exceeded).

## Related (same rollout)
- All logos switched to the animated Gemba mark; favicons use the static Gemba SVG
  (cache-busted `?v=gemba2`).
- SEO/AI metadata updated to GembaBlockchain (chainId 821207 testnet / 821206 mainnet).

> Backend/frontend source is private (.gitignore); these run live on the server. This
> note + the blockchain contracts are what the public repo tracks.
