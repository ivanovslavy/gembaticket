#!/bin/bash
# GembaTicket v2 — Project Structure Setup
# Run from ~/gembaticket directory
# Usage: bash setup_structure.sh

set -e

echo "Creating GembaTicket v2 project structure..."

# ============================================
# DIRECTORIES
# ============================================
mkdir -p contracts/facets
mkdir -p contracts/interfaces
mkdir -p test
mkdir -p scripts
mkdir -p backend/src/middleware
mkdir -p backend/src/routes
mkdir -p backend/src/services/auth
mkdir -p backend/src/services/gembapay
mkdir -p backend/src/utils
mkdir -p backend/database/migrations
mkdir -p frontend/src/pages/organizer
mkdir -p frontend/src/components/tickets
mkdir -p frontend/src/components/nft
mkdir -p frontend/src/components/payment
mkdir -p frontend/src/components/scanner
mkdir -p frontend/src/components/common
mkdir -p frontend/src/hooks
mkdir -p frontend/src/services
mkdir -p scanner/src

# ============================================
# ROOT FILES
# ============================================
cat > .gitignore << 'EOF'
node_modules/
package-lock.json
.env
.env.local
.env.production
dist/
build/
artifacts/
cache/
typechain-types/
.vscode/
.idea/
.DS_Store
Thumbs.db
*.log
logs/
coverage/
coverage.json
.ipfs/
EOF

cat > .env.example << 'EOF'
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=gembaticket
DB_USER=
DB_PASSWORD=

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Blockchain
POLYGON_RPC_URL=
BSC_RPC_URL=
ETHEREUM_RPC_URL=
PLATFORM_SIGNER_KEY=
FACTORY_ADDRESS=
CLAIM_CONTRACT_ADDRESS=
TREASURY_ADDRESS=

# IPFS
IPFS_HOST=localhost
IPFS_PORT=5001
IPFS_GATEWAY=https://ipfs.gembapay.com

# GembaPay
GEMBAPAY_API_KEY=
GEMBAPAY_WEBHOOK_SECRET=
GEMBAPAY_PLATFORM_FEE_BPS=500

# Auth
JWT_SECRET=
JWT_EXPIRES_IN=7d
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Email
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
EMAIL_FROM=tickets@gembapay.com

# Server
PORT=3000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
EOF

cat > hardhat.config.js << 'EOF'
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    polygon_amoy: {
      url: process.env.POLYGON_RPC_URL || "",
      accounts: process.env.PLATFORM_SIGNER_KEY ? [process.env.PLATFORM_SIGNER_KEY] : [],
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL || "",
      accounts: process.env.PLATFORM_SIGNER_KEY ? [process.env.PLATFORM_SIGNER_KEY] : [],
    },
  },
  gasReporter: { enabled: true, currency: "USD" },
};
EOF

# ============================================
# SMART CONTRACTS
# ============================================
cat > contracts/EventContract721.sol << 'EOF'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// EventContract721 v2 — ERC721 ticket contract with embedded payment logic
//
// Responsibilities:
//   - Crypto payments with on-chain split (95% organizer, 5% treasury)
//   - Fiat proof minting (called by platform signer after GembaPay webhook)
//   - Ticket lifecycle: activate on first scan, lock transfers
//   - Event management: cancel, end, toggle sale
//   - Mint to ClaimContract (non-custodial NFT holding)
//
// See docs/nft-ticket-platform-v2-plan-en.md Section 2.2
EOF

cat > contracts/EventContract1155.sol << 'EOF'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// EventContract1155 v2 — ERC1155 ticket contract with zone-based ticket types
//
// Extends EventContract721 logic with:
//   - Multiple ticket types (General, VIP, Backstage, All Access)
//   - Per-type pricing, supply limits, and zone levels
//   - Zone-based access control for scanner verification
//
// See docs/nft-ticket-platform-v2-plan-en.md Section 2.2
EOF

cat > contracts/ClaimContract.sol << 'EOF'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// ClaimContract — Autonomous NFT holding with renounced ownership
//
// Responsibilities:
//   - Hold NFTs minted by EventContracts until users claim them
//   - Verify claim codes (keccak256 hash matching)
//   - Transfer NFTs to user wallets on claim
//   - Transfer claim ownership on ticket transfer (before activation)
//   - Register new event contracts (called by Factory)
//
// Ownership is renounced after deployment.
//
// See docs/nft-ticket-platform-v2-plan-en.md Section 2.3
EOF

cat > contracts/facets/FactoryFacet.sol << 'EOF'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// FactoryFacet v2 — Event deployment via Diamond Proxy (EIP-2535)
//
// See docs/nft-ticket-platform-v2-plan-en.md Section 2.4
EOF

cat > contracts/facets/TreasuryFacet.sol << 'EOF'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// TreasuryFacet — Platform fee collection and gas funding
//
// See docs/nft-ticket-platform-v2-plan-en.md Section 2.5
EOF

cat > contracts/facets/AdminFacet.sol << 'EOF'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// AdminFacet — Platform settings management
//
// See docs/nft-ticket-platform-v2-plan-en.md Section 2.1
EOF

cat > contracts/interfaces/IEventContract.sol << 'EOF'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IEventContract {
    function initialize(bytes calldata _initData, address _owner, address _platform, address _treasury, address _claimContract) external;
    function activateTicket(uint256 _tokenId) external;
    function cancelEvent() external;
    function endEvent() external;
}
EOF

cat > contracts/interfaces/IClaimContract.sol << 'EOF'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IClaimContract {
    function lockForClaim(bytes32 _claimHash, uint256 _tokenId, address _buyer) external;
    function registerEvent(address _eventContract) external;
    function transferClaim(bytes32 _claimHash, address _newBuyer) external;
}
EOF

# ============================================
# TEST + SCRIPTS
# ============================================
cat > test/EventContract721.test.js << 'EOF'
// EventContract721 unit tests (Hardhat)
// See docs/nft-ticket-platform-v2-plan-en.md Phase 1
EOF

cat > test/ClaimContract.test.js << 'EOF'
// ClaimContract unit tests (Hardhat)
EOF

cat > test/FactoryFacet.test.js << 'EOF'
// FactoryFacet integration tests (Hardhat)
EOF

cat > scripts/deploy.js << 'EOF'
// Production deployment script (Polygon)
// See docs/nft-ticket-platform-v2-plan-en.md Phase 1
EOF

# ============================================
# BACKEND
# ============================================
cat > backend/package.json << 'EOF'
{
  "name": "gembaticket-backend",
  "version": "2.0.0",
  "description": "GembaTicket API server",
  "main": "src/app.js",
  "scripts": {
    "start": "node src/app.js",
    "dev": "nodemon src/app.js",
    "test": "jest",
    "migrate": "node database/migrations/run.js"
  },
  "dependencies": {},
  "devDependencies": {}
}
EOF

cat > backend/src/app.js << 'EOF'
// GembaTicket Backend — Main entry point
// See docs/nft-ticket-platform-v2-plan-en.md Section 3
EOF

# Middleware
for f in auth security validation; do
cat > backend/src/middleware/$f.js << EOF
// ${f} middleware — KEPT from v1
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.2
EOF
done

cat > backend/src/middleware/hmac.js << 'EOF'
// HMAC verification middleware for rotating QR codes — NEW
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.4.2
EOF

# Routes
cat > backend/src/routes/auth.js << 'EOF'
// Auth routes: register, login, google oauth, verify email, refresh token — KEPT
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.5
EOF

cat > backend/src/routes/events.js << 'EOF'
// Event CRUD routes — MODIFIED (new deployment flow via platform signer)
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.5
EOF

cat > backend/src/routes/tickets.js << 'EOF'
// Ticket routes: rotating QR, transfer, live page — MODIFIED
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.5
EOF

cat > backend/src/routes/scanner.js << 'EOF'
// Scanner routes: scan QR, register, stats, live feed — REWRITTEN
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.5
EOF

cat > backend/src/routes/claims.js << 'EOF'
// NFT claim routes: claim with code, check status — NEW
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.5
EOF

cat > backend/src/routes/webhooks.js << 'EOF'
// GembaPay webhook handler — NEW
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.4.5
EOF

cat > backend/src/routes/organizer.js << 'EOF'
// Organizer routes: register, my events, upload poster — NEW
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.5
EOF

# Services
cat > backend/src/services/auth/userAuth.js << 'EOF'
// User auth service — KEPT (remove wallet generation fields)
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.2
EOF

cat > backend/src/services/auth/googleAuth.js << 'EOF'
// Google OAuth service — KEPT
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.2
EOF

cat > backend/src/services/blockchain.js << 'EOF'
// Blockchain interaction service — REWRITTEN (new ABIs, platform signer)
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.1
EOF

cat > backend/src/services/ipfs.js << 'EOF'
// IPFS client service — KEPT (extended with 3-page metadata upload)
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.2
EOF

cat > backend/src/services/ticketGenerator.js << 'EOF'
// Ticket image generator — MODIFIED (3-page design, no base64 DB storage)
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.2
EOF

cat > backend/src/services/notificationService.js << 'EOF'
// Email notification service — KEPT (add claim code + live QR link)
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.2
EOF

cat > backend/src/services/queue.js << 'EOF'
// Bull queue service — KEPT (add metadata + claim queue types)
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.2
EOF

cat > backend/src/services/redis.js << 'EOF'
// Redis cache service — KEPT
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.2
EOF

cat > backend/src/services/database.js << 'EOF'
// PostgreSQL connection pool — KEPT (new schema migration)
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.2
EOF

cat > backend/src/services/platformSigner.js << 'EOF'
// Platform signer service — NEW
// Wallet for paying gas fees, funded from PlatformTreasury
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.4.1
EOF

cat > backend/src/services/scannerService.js << 'EOF'
// Scanner service — NEW
// Rotating QR generation, HMAC verification, device binding, activation lock
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.4.2
EOF

cat > backend/src/services/claimService.js << 'EOF'
// Claim service — NEW
// Generate claim codes, verify claims, track status
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.4
EOF

cat > backend/src/services/transferService.js << 'EOF'
// Transfer service — NEW
// Ticket transfer logic, security token regeneration
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.4.3
EOF

cat > backend/src/services/metadataService.js << 'EOF'
// Metadata service — NEW
// Dynamic NFT metadata generation, IPFS upload, visual states
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.4.4
EOF

cat > backend/src/services/gembapay/webhookHandler.js << 'EOF'
// GembaPay webhook handler — NEW
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.4.5
EOF

cat > backend/src/services/gembapay/paymentVerifier.js << 'EOF'
// GembaPay payment verification — NEW
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.4.5
EOF

# Utils
cat > backend/src/utils/hmac.js << 'EOF'
// HMAC generation and verification for rotating QR codes — NEW
// See docs/nft-ticket-platform-v2-plan-en.md Section 3.4.2
EOF

cat > backend/src/utils/claimCodes.js << 'EOF'
// Secure claim code generation (cryptographically random) — NEW
EOF

cat > backend/src/utils/deviceFingerprint.js << 'EOF'
// Device fingerprinting for ticket binding — NEW
EOF

# Migration
cat > backend/database/migrations/001_initial_schema.sql << 'EOF'
-- GembaTicket v2 — Initial database schema
-- See docs/nft-ticket-platform-v2-plan-en.md Section 4.1
EOF

# ============================================
# FRONTEND
# ============================================
cat > frontend/package.json << 'EOF'
{
  "name": "gembaticket-frontend",
  "version": "2.0.0",
  "description": "GembaTicket React frontend",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {},
  "devDependencies": {}
}
EOF

# Pages
for page in HomePage EventsPage EventDetailPage LiveTicketPage ClaimNFTPage MyTicketsPage NFTViewerPage; do
cat > frontend/src/pages/${page}.jsx << EOF
// ${page}
// See docs/nft-ticket-platform-v2-plan-en.md Section 5
export default function ${page}() { return null; }
EOF
done

for page in OrganizerDashboard CreateEventPage EventStatsPage ScannerSetupPage; do
cat > frontend/src/pages/organizer/${page}.jsx << EOF
// ${page}
// See docs/nft-ticket-platform-v2-plan-en.md Section 5
export default function ${page}() { return null; }
EOF
done

# Components - tickets
for comp in TicketCard RotatingQR TransferModal TicketStatusBadge; do
cat > frontend/src/components/tickets/${comp}.jsx << EOF
// ${comp}
// See docs/nft-ticket-platform-v2-plan-en.md Section 5.2
export default function ${comp}() { return null; }
EOF
done

# Components - nft
for comp in NFTViewer AnimatedQR GlowEffect ClaimButton; do
cat > frontend/src/components/nft/${comp}.jsx << EOF
// ${comp}
// See docs/nft-ticket-platform-v2-plan-en.md Section 5.2
export default function ${comp}() { return null; }
EOF
done

# Components - payment
cat > frontend/src/components/payment/GembaPayWidget.jsx << 'EOF'
// GembaPay payment widget integration
// See docs/nft-ticket-platform-v2-plan-en.md Section 5.1
export default function GembaPayWidget() { return null; }
EOF

# Components - scanner
for comp in ScannerApp ScanResult LiveFeed; do
cat > frontend/src/components/scanner/${comp}.jsx << EOF
// ${comp}
// See docs/nft-ticket-platform-v2-plan-en.md Section 5.2
export default function ${comp}() { return null; }
EOF
done

# Components - common
for comp in Header Footer WalletConnect; do
cat > frontend/src/components/common/${comp}.jsx << EOF
// ${comp}
export default function ${comp}() { return null; }
EOF
done

# Hooks
cat > frontend/src/hooks/useRotatingQR.js << 'EOF'
// 30-second QR rotation hook — NEW
EOF

cat > frontend/src/hooks/useWebSocket.js << 'EOF'
// WebSocket hook for real-time updates — NEW
EOF

cat > frontend/src/hooks/useGembaPay.js << 'EOF'
// GembaPay SDK integration hook — NEW
EOF

# Services
cat > frontend/src/services/api.js << 'EOF'
// Backend API client
EOF

cat > frontend/src/services/web3.js << 'EOF'
// Optional Web3 service — only for NFT claiming
EOF

# ============================================
# SCANNER PWA
# ============================================
cat > scanner/package.json << 'EOF'
{
  "name": "gembaticket-scanner",
  "version": "2.0.0",
  "description": "GembaTicket Scanner PWA",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {},
  "devDependencies": {}
}
EOF

cat > scanner/src/index.js << 'EOF'
// Scanner PWA entry point
// See docs/nft-ticket-platform-v2-plan-en.md Section 5.2
EOF

echo ""
echo "GembaTicket v2 structure created:"
echo "  $(find . -not -path './.git/*' -type d | wc -l) directories"
echo "  $(find . -not -path './.git/*' -type f | wc -l) files"
echo ""
echo "Next: git add -A && git commit -m 'scaffold: project structure with all stubs'"
