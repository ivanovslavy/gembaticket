# Deployment

## Target

Raspberry Pi 5 (ARM64), Ubuntu Server, Apache 2.4 reverse proxy, systemd services. Cloudflare in front for DNS, DDoS, caching, and origin-cert TLS.

## Systemd services

```
gembaticket-api              node backend/src/server.js                :3080
gembaticket-web              serve frontend/ticket-web/dist            :3083
gembaticket-dashboard        serve frontend/ticket-dashboard/dist      :3084
gembaticket-admin            serve frontend/ticket-admin/build         :3085
gembaticket-scanner-pwa      serve scanner/dist                        :3087
gembaticket-scanner          node backend/src/workers/scannerServer.js
gembaticket-listener         node backend/src/workers/eventListener.js
gembaticket-chain-worker     node backend/src/workers/chainActivationWorker.js
```

All run as an unprivileged user, all restart on failure.

## Common operations

```bash
# Restart a surface after deploy
sudo systemctl restart gembaticket-api gembaticket-dashboard

# Tail live logs
sudo journalctl -u gembaticket-api -n 100 -f
sudo journalctl -u gembaticket-chain-worker -f

# Health
curl -s https://api.gembaticket.com/health | jq
```

## Apache (sketch)

Each subdomain has its own vhost. Origin cert from Cloudflare, wildcard for `*.gembaticket.com`.

```apache
<VirtualHost *:443>
  ServerName api.gembaticket.com
  SSLEngine on
  SSLCertificateFile /etc/ssl/cloudflare/origin.pem
  SSLCertificateKeyFile /etc/ssl/cloudflare/origin.key

  ProxyPreserveHost On
  ProxyPass        / http://127.0.0.1:3080/
  ProxyPassReverse / http://127.0.0.1:3080/

  # Raw body for GembaPay webhook HMAC verification
  # (handled by the Node layer via req.rawBody)

  Header always set Permissions-Policy "camera=()"
</VirtualHost>

<VirtualHost *:443>
  ServerName scanner.gembaticket.com
  SSLEngine on
  ...
  ProxyPass        / http://127.0.0.1:3087/
  ProxyPassReverse / http://127.0.0.1:3087/

  # Camera access requires explicit policy on this subdomain
  Header always set Permissions-Policy "camera=(self)"
</VirtualHost>
```

## Ports

| Service | Port |
|---|---|
| Apache (public) | 80 / 443 |
| API (`gembaticket-api`) | 3080 |
| Storefront | 3083 |
| Dashboard | 3084 |
| Admin | 3085 |
| Scanner PWA | 3087 |
| PostgreSQL | 5432 |
| Redis | **6380** (not default 6379) |
| chain worker health | 3086 |

## Build & ship

```bash
# Backend
cd backend && npm ci && npx prisma migrate deploy

# Frontends
cd frontend/ticket-web        && npm ci && npm run build
cd ../ticket-dashboard         && npm ci && npm run build
cd ../../scanner               && npm ci && npm run build

sudo systemctl restart \
  gembaticket-api \
  gembaticket-web \
  gembaticket-dashboard \
  gembaticket-scanner-pwa \
  gembaticket-chain-worker \
  gembaticket-listener
```

## Prisma migrations (prod caveat)

The production Postgres role does not have shadow-DB permission — `prisma migrate dev` fails with `P3014`. Workaround:

```bash
# hand-written SQL with IF NOT EXISTS / DO $$ ... $$ blocks, placed in
# backend/prisma/migrations/<timestamp>_<name>/migration.sql

npx prisma db execute --file backend/prisma/migrations/<…>/migration.sql
npx prisma migrate resolve --applied <…>
npx prisma generate
sudo systemctl restart gembaticket-api gembaticket-chain-worker gembaticket-listener
```

## Environment variables (secrets in `.env`, never in code)

### Backend — `backend/.env`

- `DATABASE_URL`, `JWT_SECRET`
- `REDIS_URL` (port 6380)
- `ETHEREUM_RPC_URL`, `CHAIN_ID`, `REGISTRY_ADDRESS`, `ERC721_TEMPLATE`, `ERC1155_TEMPLATE`, `PLATFORM_SIGNER_KEY`, `MINT_SIGNER_KEY`
- Fallback RPC pool (optional, appended after the public endpoints in `src/config/rpcEndpoints.js` — see [`BACKEND.md`](./BACKEND.md#rpc-resilience-fallbackjsonrpcprovider)): `INFURA_API_KEY`, `ALCHEMY_API_KEY`, `QUICKNODE_SEPOLIA_URL`, `ANKR_API_KEY_1`…`ANKR_API_KEY_5`, `MORALIS_API_KEY`, `GETBLOCK_BSC_TESTNET_URL`, `CHAINSTACK_BSC_MAINNET_URL`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_REPLY_TO`
- `GEMBAPAY_API_URL`, `GEMBAPAY_API_KEY`, `GEMBAPAY_WEBHOOK_SECRET`
- `SCANNER_KEY_SECRET` — 32-byte hex, reversible AES-256-GCM master key
- `DASHBOARD_URL`, `PUBLIC_URL`, `ETHERSCAN_BASE`

### Frontend — per app `.env`

- `VITE_API_URL` (`https://api.gembaticket.com`)
- `VITE_WALLETCONNECT_PROJECT_ID`
- `VITE_SEPOLIA_RPC_URL`
- `VITE_TURNSTILE_SITE_KEY` (optional)
- `VITE_ETHERSCAN_BASE` (dashboard)

## Backups

- **PostgreSQL** — `pg_dump` nightly to `~/backups/`.
- **Redis** — append-only persistence enabled; OTP codes are transient (10-min TTL) so no recovery needed.
- **On-chain** — ticket ownership and event state survive any DB loss; `eventListener` re-hydrates `BlockSync`-tracked state from the chain.

## Rollback

Each systemd unit runs from a versioned directory. Deploys are atomic symlink swaps:

```bash
# in ~/deploys/gembaticket-api/
ln -sfn 2026-04-20-abc123/ current
sudo systemctl restart gembaticket-api
```

To roll back, repoint `current` at the previous release directory and restart.
