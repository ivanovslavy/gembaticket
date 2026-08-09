# NFT Ticket Platform v2 — Complete Development Plan

**Project:** Non-custodial ticketing platform with NFT bonus
**Company:** GEMBA EOOD
**Date:** 08.02.2026
**Status:** Pending approval

---

## 1. VISION AND PRINCIPLES

### 1.1 Core Vision

A ticketing platform that works like Eventbrite for the end user, but under the hood leverages blockchain and NFT technologies for security, authenticity, and collectible value. Users DO NOT need to know anything about blockchain.

### 1.2 Key Principles

- **ZERO CUSTODY** — the platform holds no funds, no private keys, and no NFTs on behalf of users
- **BLOCKCHAIN INVISIBLE** — users (organizers and buyers) work with email, cards, and QR codes; blockchain is an invisible layer underneath
- **GEMBAPAY POWERED** — all payments go through GembaPay; GEMBA EOOD receives only the platform fee
- **NFT = BONUS** — the ticket works without NFT; NFT is an optional claim for users who want it
- **MAXIMUM SECURITY** — rotating QR, device binding, transfer lock after first scan, HMAC verification
- **PLATFORM COVERS GAS** — all blockchain transaction costs (minting, activation) are paid by the platform from PlatformTreasury, funded by the 5% platform fee; no user ever pays or sees gas fees

### 1.3 Supported Networks

- **Primary:** Polygon (low gas fees, fast finality)
- **Secondary:** BSC, Ethereum (organizer chooses at creation)
- **IPFS:** Own node on Hetzner VPS (primary + fallback)

### 1.4 Gas Cost Model

```
WHO PAYS FOR MINTING?

The platform (GEMBA EOOD) covers ALL gas costs.

How it works:
  → Backend has a "platform signer" wallet funded from PlatformTreasury
  → This wallet calls mintWithFiatProof() for fiat purchases
  → For crypto purchases, buyTicketCrypto() is called by user but
    the internal _mint() cost is covered by the incoming msg.value
  → activateTicket() on first scan — platform signer pays gas

Cost analysis (Polygon):
  Mint: ~$0.01-0.05 per ticket
  Activation: ~$0.005 per scan
  1000 tickets = ~$15-55 total gas

  Revenue from 5% platform fee:
  1000 tickets × $20 avg × 5% = $1,000 platform revenue
  Gas cost: $15-55 = ~2-5% of platform revenue

  Result: Gas is negligible and fully absorbed into platform fee.
  Nobody pays separately. Nobody sees gas fees. Nobody knows.

For event creation:
  → Deploy EventContract: ~$0.50-2.00 on Polygon
  → Covered by event creation fee ($5-10) paid by organizer via GembaPay
  → Organizer sees: "Event creation fee: $5" — not "gas fee"
```

---

## 2. SMART CONTRACTS (Solidity 0.8.28)

### 2.1 Architecture Overview

```
PlatformRegistry.sol (singleton, regular contract)
├── createEvent()          — Clone via EIP-1167 minimal proxy
├── Treasury functions     — Receive fees, withdraw, fund signer
├── Admin functions        — Set templates, fees, pause
└── setTemplate()          — Upgrade logic for future events

EventContract v2 (per-event, EIP-1167 clone)
├── ERC721 or ERC1155      — NFT tickets
├── Crypto payment logic   — GembaPay protocol embedded
├── Fiat proof minting     — Backend-verified mint
├── Ticket lifecycle       — activate/lock/transfer control
└── Event management       — cancel/end/metadata

ClaimContract (singleton, regular contract)
├── Lock NFT for claim     — NFTs wait here
├── Claim with code        — User takes NFT
└── Renounced ownership    — Nobody has control
```

### 2.2 EventContract v2 — Detailed Specification

```solidity
// ============================================
// STATE VARIABLES
// ============================================

address public owner;              // Organizer (can be EOA or smart wallet)
address public platform;           // Platform backend address (for fiat mint + activation)
address public treasury;           // PlatformTreasury address
address public claimContract;      // ClaimContract address

string public eventName;
string public eventLocation;
string public eventDate;
string public eventTime;
string public eventDescription;
string public baseTokenURI;        // IPFS base URI

bool public isEventCanceled;
bool public isEventEnded;
bool public saleActive;

uint256 public platformFeeBps;     // 500 = 5%
uint256 public totalMinted;

// ERC721 variant:
uint256 public maxSupply;
uint256 public price;              // In native token (ETH/BNB/MATIC)

// ERC1155 variant:
struct TicketType {
    string name;                   // "General", "VIP", "Backstage"
    uint256 price;
    uint256 maxSupply;
    uint256 minted;
    bool active;
}
mapping(uint256 => TicketType) public ticketTypes;

// Ticket lifecycle
mapping(uint256 => bool) public ticketActivated;       // After first scan
mapping(uint256 => address) public activatedBy;         // Who activated it
mapping(uint256 => bytes32) public ticketClaimHash;     // Hash for claim

// ============================================
// CRYPTO PAYMENT (GembaPay Protocol)
// ============================================

function buyTicketCrypto(uint256 ticketTypeId) external payable {
    require(saleActive, "Sale not active");
    require(!isEventCanceled, "Event canceled");
    require(!isEventEnded, "Event ended");

    uint256 ticketPrice = _getPrice(ticketTypeId);
    require(msg.value >= ticketPrice, "Insufficient payment");

    // Non-custodial split — funds IMMEDIATELY go to recipients
    uint256 platformFee = (ticketPrice * platformFeeBps) / 10000;
    uint256 organizerAmount = ticketPrice - platformFee;

    // Direct transfer — contract does NOT hold funds
    (bool sentOrganizer,) = owner.call{value: organizerAmount}("");
    require(sentOrganizer, "Organizer payment failed");

    (bool sentTreasury,) = treasury.call{value: platformFee}("");
    require(sentTreasury, "Treasury payment failed");

    // Refund excess
    if (msg.value > ticketPrice) {
        (bool refunded,) = msg.sender.call{value: msg.value - ticketPrice}("");
        require(refunded, "Refund failed");
    }

    // Mint NFT to ClaimContract
    uint256 tokenId = _mintToClaimContract(msg.sender, ticketTypeId);

    emit TicketPurchased(msg.sender, tokenId, ticketTypeId, ticketPrice, "crypto");
}

// ============================================
// FIAT PAYMENT (GembaPay webhook → Backend → here)
// Gas paid by platform signer wallet
// ============================================

function mintWithFiatProof(
    address _buyer,
    uint256 _ticketTypeId,
    bytes32 _paymentHash        // GembaPay payment ID hash
) external onlyPlatform {
    require(saleActive, "Sale not active");
    require(!isEventCanceled, "Event canceled");

    uint256 tokenId = _mintToClaimContract(_buyer, _ticketTypeId);

    emit TicketPurchased(_buyer, tokenId, _ticketTypeId, 0, "fiat");
    emit FiatPaymentRecorded(_paymentHash, tokenId);
}

// ============================================
// MINT TO CLAIM CONTRACT (internal)
// ============================================

function _mintToClaimContract(
    address _buyer,
    uint256 _ticketTypeId
) internal returns (uint256 tokenId) {
    _validateSupply(_ticketTypeId);

    tokenId = ++totalMinted;

    // Generate claim hash
    bytes32 claimHash = keccak256(abi.encodePacked(
        tokenId, _buyer, block.timestamp, blockhash(block.number - 1)
    ));
    ticketClaimHash[tokenId] = claimHash;

    // Mint NFT to ClaimContract (not directly to buyer)
    _safeMint(address(claimContract), tokenId);

    // Register in ClaimContract
    IClaimContract(claimContract).lockForClaim(claimHash, tokenId, _buyer);
}

// ============================================
// TICKET LIFECYCLE
// ============================================

// Called by platform backend on first scan
// Gas paid by platform signer wallet
function activateTicket(uint256 _tokenId) external onlyPlatform {
    require(!ticketActivated[_tokenId], "Already activated");
    ticketActivated[_tokenId] = true;

    address ticketHolder = _getEffectiveOwner(_tokenId);
    activatedBy[_tokenId] = ticketHolder;

    emit TicketActivated(_tokenId, ticketHolder);
}

// Transfer control hook
function _beforeTokenTransfer(
    address from,
    address to,
    uint256 tokenId
) internal override {
    // Mint (from == 0) is always OK
    if (from == address(0)) return;

    // After event ends — free transfer (collectible value)
    if (isEventEnded) return;

    // After activation — transfer BLOCKED
    require(!ticketActivated[tokenId], "Ticket activated - transfer locked");
}

// ============================================
// EVENT MANAGEMENT
// ============================================

function cancelEvent() external onlyOwner {
    require(!isEventEnded, "Event already ended");
    isEventCanceled = true;
    saleActive = false;
    emit EventCanceled(block.timestamp);
    // Fiat refunds → organizer via GembaPay/Stripe (their responsibility)
    // Crypto refunds → organizer manually (we don't hold funds)
}

function endEvent() external onlyOwner {
    require(!isEventCanceled, "Event is canceled");
    isEventEnded = true;
    saleActive = false;
    emit EventEnded(block.timestamp);
    // Unlocks NFT transfers for secondary market
}

function setEventDetails(...) external onlyOwner { ... }
function toggleSale() external onlyOwner { ... }
function setBaseURI(string calldata _uri) external onlyOwner { ... }

// ============================================
// MODIFIERS
// ============================================

modifier onlyOwner() {
    require(msg.sender == owner, "Not owner");
    _;
}

modifier onlyPlatform() {
    require(msg.sender == platform, "Not platform");
    _;
}
```

### 2.3 ClaimContract — Detailed Specification

```solidity
// ============================================
// CLAIM CONTRACT — Autonomous NFT Holding
// ============================================
// Owner: address(0) after deployment (renounced)
// Nobody has control — only code

struct ClaimData {
    address eventContract;     // Which event contract
    uint256 tokenId;           // Which token
    address buyer;             // Who bought it (for verification)
    bool claimed;              // Already claimed?
    uint256 createdAt;         // When created
}

mapping(bytes32 => ClaimData) public claims;

// Register a claim (only from event contracts)
function lockForClaim(
    bytes32 _claimHash,
    uint256 _tokenId,
    address _buyer
) external {
    require(registeredEvents[msg.sender], "Not registered event");
    require(claims[_claimHash].eventContract == address(0), "Claim exists");

    claims[_claimHash] = ClaimData({
        eventContract: msg.sender,
        tokenId: _tokenId,
        buyer: _buyer,
        claimed: false,
        createdAt: block.timestamp
    });

    emit ClaimLocked(_claimHash, msg.sender, _tokenId, _buyer);
}

// User claims NFT (must know claimCode)
function claim(
    string calldata _claimCode,
    address _destinationWallet
) external {
    bytes32 claimHash = keccak256(abi.encodePacked(_claimCode));
    ClaimData storage data = claims[claimHash];

    require(data.eventContract != address(0), "Invalid claim code");
    require(!data.claimed, "Already claimed");

    data.claimed = true;

    IERC721(data.eventContract).transferFrom(
        address(this),
        _destinationWallet,
        data.tokenId
    );

    emit NFTClaimed(claimHash, _destinationWallet, data.tokenId);
}

// Register new event contract (from Factory)
function registerEvent(address _eventContract) external onlyFactory {
    registeredEvents[_eventContract] = true;
}

// Transfer claim to new buyer (before activation)
function transferClaim(
    bytes32 _claimHash,
    address _newBuyer
) external {
    ClaimData storage data = claims[_claimHash];
    require(data.buyer == msg.sender || msg.sender == data.eventContract,
            "Not authorized");
    require(!data.claimed, "Already claimed");

    data.buyer = _newBuyer;
    emit ClaimTransferred(_claimHash, msg.sender, _newBuyer);
}
```

### 2.4 PlatformRegistry (replaces Diamond Proxy)

Instead of a Diamond Proxy (EIP-2535) with separate facets, the platform uses a single
PlatformRegistry contract that combines factory, treasury, and admin functions. Event
contracts are deployed as EIP-1167 minimal proxy clones — 45 bytes of immutable bytecode
that delegate to a template. This is simpler, cheaper, and more secure than Diamond.

Template upgradeability: deploy a new EventContract template, call setTemplate() on
PlatformRegistry, and all NEW events use the new logic. Old events remain on the old
template (immutable, safe). This gives us upgrade capability without proxy risk.

```solidity
// Key functions (see PlatformRegistry.sol for full implementation):

// FACTORY — Clone event contracts via EIP-1167
function createEvent(
    uint256 _eventType,       // 0 = ERC721, 1 = ERC1155
    string calldata _eventName,
    string calldata _baseURI,
    uint256 _maxSupply,
    uint256 _priceInNative
) external payable returns (address eventAddress);

// FACTORY — Fiat payment (platform signer calls after GembaPay webhook)
function createEventWithFiatProof(
    uint256 _eventType,
    string calldata _eventName,
    string calldata _baseURI,
    uint256 _maxSupply,
    uint256 _priceInNative,
    address _organizer,
    bytes32 _paymentHash
) external onlySigner returns (address eventAddress);

// TREASURY — Receives platform fees from event contracts
receive() external payable;
function withdraw(address _to, uint256 _amount) external onlyMultisig;
function fundSigner(uint256 _amount) external onlyMultisig;

// ADMIN — Settings management
function setTemplate(uint256 _eventType, address _newTemplate) external onlyAdmin;
function setCreateEventFee(uint256 _newFee) external onlyAdmin;
function setPlatformFeeBps(uint256 _newFeeBps) external onlyAdmin;
function setPlatformSigner(address _newSigner) external onlyAdmin;
function togglePause() external onlyAdmin;
```

### 2.5 Contracts — Summary

| Contract | LOC (actual) | Role |
|----------|-------------|------|
| EventContract721 v2 | 209 | ERC721 template + payments + lifecycle (cloned) |
| EventContract1155 v2 | 281 | ERC1155 template + ticket types + zones (cloned) |
| ClaimContract | 181 | Autonomous NFT holding + claim (singleton) |
| PlatformRegistry | 263 | Factory + Treasury + Admin (singleton) |
| Interfaces | 44 | IEventContract + IClaimContract |
| **Total** | **978** | **vs. current ~4150 LOC (76% reduction)** |

Architecture: NO Diamond Proxy. PlatformRegistry is a regular contract. Only the
EventContract clones are proxied (EIP-1167 minimal proxy — 45 bytes, immutable).
ClaimContract is a regular contract with renounced ownership.

### 2.7 What We DO NOT Include (vs. v1)

- ❌ Validator/Oracle contracts — GembaPay replaces them
- ❌ QRModule on-chain — off-chain scanning (faster, free)
- ❌ AdminModule as separate contract — embedded in PlatformRegistry
- ❌ MintModule as separate contract — embedded in EventContract
- ❌ ViewModule — frontend reads directly from contract
- ❌ balanceThreshold — no balance accumulates in contract
- ❌ Minter wallet management — no custodial wallets
- ❌ Diamond Proxy (EIP-2535) — replaced by PlatformRegistry + EIP-1167 clones

---

## 3. BACKEND (Node.js + Express)

### 3.1 Architecture Overview

```
src/
├── app.js                          — Express setup, CORS, CSP
├── middleware/
│   ├── auth.js                     — JWT auth (KEPT)
│   ├── security.js                 — Rate limiting, logging (KEPT)
│   ├── validation.js               — Input validation (KEPT)
│   └── hmac.js                     — NEW: HMAC verification for QR
├── routes/
│   ├── auth.js                     — Login/register (KEPT)
│   ├── events.js                   — Event CRUD (MODIFIED)
│   ├── tickets.js                  — Ticket management (MODIFIED)
│   ├── scanner.js                  — Scan verification (REWRITTEN)
│   ├── claims.js                   — NEW: NFT claim endpoints
│   ├── webhooks.js                 — NEW: GembaPay webhooks
│   └── organizer.js                — NEW: Organizer management
├── services/
│   ├── auth/
│   │   ├── userAuth.js             — User auth (KEPT)
│   │   └── googleAuth.js           — Google OAuth (KEPT)
│   ├── blockchain.js               — Contract interactions (REWRITTEN)
│   ├── ipfs.js                     — IPFS client (KEPT, extended)
│   ├── ticketGenerator.js          — Ticket images (MODIFIED for 3-page)
│   ├── notificationService.js      — Email (KEPT)
│   ├── queue.js                    — Bull queues (KEPT)
│   ├── redis.js                    — Redis cache (KEPT)
│   ├── database.js                 — DB pool (KEPT, new schema)
│   ├── platformSigner.js           — NEW: Platform wallet for gas payments
│   ├── scannerService.js           — NEW: Scan logic + HMAC + device binding
│   ├── claimService.js             — NEW: Claim code management
│   ├── transferService.js          — NEW: Ticket transfer logic
│   ├── metadataService.js          — NEW: Dynamic NFT metadata
│   └── gembapay/
│       ├── webhookHandler.js       — NEW: Process GembaPay webhooks
│       └── paymentVerifier.js      — NEW: Verify payment proofs
└── utils/
    ├── hmac.js                     — NEW: HMAC generation/verification
    ├── claimCodes.js               — NEW: Secure claim code generation
    └── deviceFingerprint.js        — NEW: Device binding logic
```

### 3.2 Code Retained from v1

| File | Lines | Changes |
|------|-------|---------|
| middleware/auth.js | 439 | No changes |
| middleware/security.js | 313 | No changes |
| services/auth/userAuth.js | 424 | Remove wallet generation fields |
| services/ipfs.js | 304 | Add 3-page upload logic |
| services/ticketGenerator.js | 277 | Modify for 3-page design |
| services/notificationService.js | 402 | Add claim code to emails |
| services/queue.js | 331 | Add new queue types |
| services/database.js | 468 | New schema migration |
| **Total retained** | **~2958** | |

### 3.3 Code to REMOVE from v1

| File | Reason |
|------|--------|
| services/auth/custodialWallet.js | CUSTODY — generates PK |
| services/eventWalletManager.js | CUSTODY — minter wallets |
| services/ticketMinter.js | Depends on custodial wallets |
| services/payments/stripe.js | Replaced by GembaPay |
| services/payments/paypal.js | Replaced by GembaPay |
| services/payments/paymentProcessor.js | Replaced by GembaPay |
| routes/factory.js | New factory logic |
| routes/blockchain.js | Rewritten |
| routes/payments.js | Replaced by GembaPay webhooks |
| utils/encryption.js | No PK to encrypt |
| utils/keyDerivation.js | No PK derivation needed |

### 3.4 New Services — Detailed Specification

#### 3.4.1 platformSigner.js — Gas Payment Wallet

```javascript
class PlatformSigner {
  constructor() {
    // Wallet funded from PlatformTreasury
    // Used ONLY for signing platform transactions (mint, activate)
    // NOT custodial — holds only gas funds, never user assets
    this.wallet = new ethers.Wallet(process.env.PLATFORM_SIGNER_KEY, provider);
  }

  // Monitor balance and alert if low
  async checkBalance() {
    const balance = await provider.getBalance(this.wallet.address);
    const threshold = ethers.parseEther('0.5'); // ~10,000 mints on Polygon

    if (balance < threshold) {
      await notifications.alertPlatformAdmin(
        `Platform signer low balance: ${ethers.formatEther(balance)} MATIC`
      );
    }
    return balance;
  }

  // Estimate gas before transaction
  async estimateAndExecute(contract, method, args) {
    const gasEstimate = await contract[method].estimateGas(...args);
    const gasPrice = await provider.getFeeData();
    const cost = gasEstimate * gasPrice.gasPrice;

    console.log(`Gas cost: ${ethers.formatEther(cost)} MATIC for ${method}`);

    return contract[method](...args);
  }
}
```

#### 3.4.2 scannerService.js — Scanning with Rotating QR

```javascript
class ScannerService {

  // Generate rotating QR data (every 30 seconds)
  generateRotatingQR(serialNumber) {
    const timestamp = Math.floor(Date.now() / 30000) * 30000; // 30-sec window
    const hmacSecret = this.getTicketHmacSecret(serialNumber);
    const signature = crypto
      .createHmac('sha256', hmacSecret)
      .update(`${serialNumber}:${timestamp}`)
      .digest('hex')
      .substring(0, 16);

    return { sn: serialNumber, ts: timestamp, sig: signature };
  }

  // Verify QR from scanner
  async verifyScan(qrData, scannerInfo) {
    const { sn, ts, sig } = qrData;

    // 1. Timestamp check (last 60 seconds)
    if (Math.abs(Date.now() - ts) > 60000)
      return { valid: false, reason: 'QR code expired' };

    // 2. HMAC verification
    const hmacSecret = await this.getTicketHmacSecret(sn);
    const expectedSig = crypto
      .createHmac('sha256', hmacSecret)
      .update(`${sn}:${ts}`)
      .digest('hex')
      .substring(0, 16);
    if (sig !== expectedSig)
      return { valid: false, reason: 'Invalid QR signature' };

    // 3. Ticket lookup
    const ticket = await db.query(
      'SELECT * FROM tickets WHERE serial_number = $1', [sn]
    );
    if (!ticket) return { valid: false, reason: 'Ticket not found' };

    // 4. Scanner authorization for this event
    const scanner = await db.query(
      'SELECT * FROM scanners WHERE id = $1 AND event_id = $2 AND is_active = true',
      [scannerInfo.scannerId, ticket.event_id]
    );
    if (!scanner) return { valid: false, reason: 'Scanner not authorized' };

    // 5. Zone access check
    if (scannerInfo.zoneTokenType !== undefined) {
      if (ticket.ticket_type_id < scannerInfo.zoneTokenType)
        return { valid: false, reason: 'Insufficient access level' };
    }

    // 6. First scan → ACTIVATE + LOCK
    if (!ticket.is_activated) {
      await this.activateTicket(ticket);
      return { valid: true, action: 'ENTRY', firstScan: true };
    }

    // 7. Already activated → verify same user
    if (ticket.locked_to_user !== scannerInfo.currentUserId)
      return { valid: false, reason: 'Ticket activated by another user' };

    // 8. Entry/Exit toggle
    const lastScan = await db.query(
      'SELECT scan_type FROM scan_logs WHERE ticket_id = $1 ORDER BY scan_time DESC LIMIT 1',
      [ticket.id]
    );
    const nextAction = (!lastScan || lastScan.scan_type === 'exit') ? 'ENTRY' : 'EXIT';

    return { valid: true, action: nextAction, firstScan: false };
  }

  // Activate ticket (first scan) — gas paid by platform
  async activateTicket(ticket) {
    await db.query(`
      UPDATE tickets SET
        is_activated = true, locked_to_user = $1,
        locked_to_device = $2, activated_at = NOW()
      WHERE id = $3
    `, [ticket.owner_user_id, currentDeviceHash, ticket.id]);

    // On-chain activation — gas paid by platform signer
    if (ticket.token_id) {
      await platformSigner.estimateAndExecute(
        eventContract, 'activateTicket', [ticket.token_id]
      );
    }

    // Update NFT visual state — color changes to GREEN
    await metadataService.updateTicketVisualState(ticket.id, 'INSIDE', 'green');
  }
}
```

#### 3.4.3 transferService.js — Ticket Transfers

```javascript
class TransferService {

  async transferTicket(serialNumber, fromUserId, recipientEmail) {
    const ticket = await db.query(
      'SELECT * FROM tickets WHERE serial_number = $1 AND owner_user_id = $2',
      [serialNumber, fromUserId]
    );

    // BLOCK if already activated
    if (ticket.is_activated)
      throw new Error('Ticket is activated and cannot be transferred');

    // Find or create recipient user
    let recipient = await db.query(
      'SELECT * FROM users WHERE email = $1', [recipientEmail]
    );
    if (!recipient)
      recipient = await userAuth.createPendingUser(recipientEmail);

    // Regenerate security tokens — old link dies immediately
    const newAuthToken = secureRandom.generate(32);
    const newHmacSecret = secureRandom.generate(32);

    await db.query(`
      UPDATE tickets SET
        owner_user_id = $1, auth_token = $2,
        hmac_secret = $3, device_hash = NULL, transferred_at = NOW()
      WHERE id = $4
    `, [recipient.id, newAuthToken, newHmacSecret, ticket.id]);

    // Log transfer
    await db.query(`
      INSERT INTO transfer_log (ticket_id, from_user_id, to_user_id, transferred_at)
      VALUES ($1, $2, $3, NOW())
    `, [ticket.id, fromUserId, recipient.id]);

    // On-chain transfer if NFT is claimed
    if (ticket.claimed_by)
      await blockchain.transferClaimOwnership(ticket.claim_hash, recipient.wallet_address);

    // Send emails
    await notifications.sendTicketReceivedEmail(recipient, ticket);
    await notifications.sendTicketTransferredEmail(fromUserId, recipientEmail, ticket);

    return { success: true };
  }
}
```

#### 3.4.4 metadataService.js — Dynamic NFT Metadata

```javascript
class MetadataService {

  // Generate 3-page NFT metadata
  async generateEventMetadata(eventId, tokenId) {
    const event = await db.query('SELECT * FROM events WHERE id = $1', [eventId]);
    const ticket = await db.query(
      'SELECT * FROM tickets WHERE event_id = $1 AND token_id = $2',
      [eventId, tokenId]
    );

    // Page 1: Poster (uploaded by organizer)
    const posterCID = event.poster_ipfs_cid;

    // Page 2: Event Info (generated)
    const infoImage = await ticketGenerator.generateInfoPage(event, ticket);
    const infoCID = await ipfs.addBuffer(infoImage);

    // Page 3: QR Code (dynamic — animated HTML)
    const qrViewerHTML = this.generateQRViewerHTML(ticket.serial_number, event);
    const qrCID = await ipfs.addBuffer(Buffer.from(qrViewerHTML));

    const visualState = await this.getVisualState(ticket);

    const metadata = {
      name: `${event.event_name} — ${ticket.ticket_type_name} #${tokenId}`,
      description: `${event.event_name} | ${event.event_date} | ${event.location}`,
      image: `ipfs://${posterCID}`,
      animation_url: `ipfs://${qrCID}`,
      external_url: `https://tickets.gembapay.com/ticket/${ticket.serial_number}`,
      attributes: [
        { trait_type: "Event", value: event.event_name },
        { trait_type: "Date", value: event.event_date },
        { trait_type: "Location", value: event.location },
        { trait_type: "Ticket Type", value: ticket.ticket_type_name },
        { trait_type: "Zone Access", value: ticket.zone_name },
        { trait_type: "Status", value: visualState.status },
        { trait_type: "Serial", value: ticket.serial_number }
      ],
      properties: {
        pages: [
          { name: "Event Poster", image: `ipfs://${posterCID}` },
          { name: "Ticket Info", image: `ipfs://${infoCID}` },
          { name: "Entry QR", animation_url: `ipfs://${qrCID}` }
        ],
        visual_state: visualState
      }
    };

    const metadataCID = await ipfs.addJSON(metadata);
    return metadataCID;
  }

  // Visual states for "glowing" NFTs
  async getVisualState(ticket) {
    if (!ticket.is_activated)
      return { status: "Ready", color: "#FFFFFF", glow: "none", animation: "none" };

    const lastScan = await db.query(
      'SELECT * FROM scan_logs WHERE ticket_id = $1 ORDER BY scan_time DESC LIMIT 1',
      [ticket.id]
    );
    const event = await db.query('SELECT * FROM events WHERE id = $1', [ticket.event_id]);

    if (event.is_event_ended) {
      return {
        status: "Event Attended ✓", color: "#1a1a1a",
        glow: "rainbow", animation: "hologram", badge: "Collector's Edition"
      };
    }

    if (lastScan?.scan_type === 'exit')
      return { status: "OUTSIDE", color: "#3B82F6", glow: "blue-pulse", animation: "breathe" };

    const zone = lastScan?.zone || 'general';
    const zoneColors = {
      general:   { status: "INSIDE",     color: "#22C55E", glow: "green-pulse" },
      vip:       { status: "VIP ZONE",   color: "#F59E0B", glow: "gold-pulse" },
      backstage: { status: "BACKSTAGE",  color: "#EF4444", glow: "red-pulse" },
      allaccess: { status: "ALL ACCESS", color: "#8B5CF6", glow: "rainbow-pulse" }
    };

    return { ...zoneColors[zone], animation: "pulse" };
  }
}
```

#### 3.4.5 GembaPay Webhook Handler

```javascript
// routes/webhooks.js
router.post('/gembapay', webhookSignatureVerify, async (req, res) => {
  const { event, data } = req.body;

  switch (event) {
    case 'payment.completed':
      const { paymentId, eventId, ticketTypeId, buyerEmail, amount } = data;

      // 1. Create ticket in DB
      const ticket = await ticketService.createTicket(eventId, ticketTypeId, buyerEmail);

      // 2. Mint NFT via platform signer (gas from platform)
      const paymentHash = ethers.keccak256(ethers.toUtf8Bytes(paymentId));
      await platformSigner.estimateAndExecute(
        eventContract, 'mintWithFiatProof',
        [ticket.buyer_address || claimContract.address, ticketTypeId, paymentHash]
      );

      // 3. Upload metadata to IPFS
      await metadataService.generateEventMetadata(eventId, ticket.token_id);

      // 4. Generate claim code
      const claimCode = await claimService.generateClaimCode(ticket);

      // 5. Send email with QR link + claim code
      await notifications.sendTicketPurchasedEmail(buyerEmail, ticket, claimCode);
      break;

    case 'payment.refunded':
      // Organizer issued refund — update ticket status, notify buyer
      break;

    case 'merchant.event_creation_paid':
      // Deploy EventContract via platform signer (gas from platform)
      break;
  }

  res.json({ received: true });
});
```

### 3.5 API Endpoints — Complete List

```
AUTH (KEPT):
  POST   /api/v1/auth/register        — Email + password registration
  POST   /api/v1/auth/login           — Login → JWT
  POST   /api/v1/auth/google          — Google OAuth
  POST   /api/v1/auth/verify-email    — Email verification
  POST   /api/v1/auth/refresh         — Refresh JWT

EVENTS (MODIFIED):
  POST   /api/v1/events               — Create event (triggers deploy via platform signer)
  GET    /api/v1/events               — List events (public)
  GET    /api/v1/events/:id           — Event details
  PUT    /api/v1/events/:id           — Update event (organizer only)
  POST   /api/v1/events/:id/cancel    — Cancel event
  POST   /api/v1/events/:id/end       — End event
  GET    /api/v1/events/:id/stats     — Statistics (organizer only)

TICKETS (MODIFIED):
  GET    /api/v1/tickets/my           — My tickets
  GET    /api/v1/tickets/:serial      — Ticket details
  GET    /api/v1/tickets/:serial/qr   — Live rotating QR data
  POST   /api/v1/tickets/:serial/transfer — Transfer ticket
  GET    /api/v1/tickets/:serial/live — Live ticket page data

SCANNER (REWRITTEN):
  POST   /api/v1/scanner/scan         — Scan QR
  POST   /api/v1/scanner/register     — Register scanner for event
  GET    /api/v1/scanner/:id/stats    — Scanner statistics
  WS     /api/v1/scanner/event/:eventId/live — Live scan feed (WebSocket)

CLAIMS (NEW):
  POST   /api/v1/claims/claim         — Claim NFT with code
  GET    /api/v1/claims/:serial/status — Claim status

METADATA (NEW):
  GET    /api/v1/metadata/:address/:tokenId.json — NFT metadata (dynamic)
  GET    /api/v1/metadata/:address/:tokenId/visual — Visual state API

WEBHOOKS (NEW):
  POST   /api/v1/webhooks/gembapay    — GembaPay payment events

ORGANIZER (NEW):
  POST   /api/v1/organizer/register   — Register as organizer
  GET    /api/v1/organizer/events     — My events
  POST   /api/v1/organizer/upload-poster — Upload poster image
```

---

## 4. DATABASE (PostgreSQL)

### 4.1 New Schema

```sql
-- ============================================
-- KEPT TABLES (with modifications)
-- ============================================

-- USERS — remove custodial wallet fields
CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) UNIQUE NOT NULL,
    email_verified  BOOLEAN DEFAULT false,
    password_hash   VARCHAR(255),
    google_id       VARCHAR(255),
    -- REMOVED: encrypted_private_key, encryption_salt, wallet_created_at
    wallet_address  VARCHAR(42),          -- OPTIONAL: if they claim NFT
    role            VARCHAR(20) DEFAULT 'user',  -- 'user', 'organizer', 'admin'
    failed_login_attempts INT DEFAULT 0,
    locked_until    TIMESTAMP,
    last_login      TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- MODIFIED TABLES
-- ============================================

-- EVENTS — new structure
CREATE TABLE events (
    id                  SERIAL PRIMARY KEY,
    organizer_user_id   INT REFERENCES users(id),

    -- Event info
    event_name          VARCHAR(255) NOT NULL,
    description         TEXT,
    location            VARCHAR(500),
    venue_address       TEXT,
    event_date          DATE,
    event_time          TIME,

    -- Blockchain
    contract_address    VARCHAR(42),
    contract_type       VARCHAR(10),       -- 'ERC721' or 'ERC1155'
    chain_id            INT,
    deployment_tx       VARCHAR(66),

    -- IPFS
    poster_ipfs_cid     VARCHAR(100),
    metadata_base_cid   VARCHAR(100),

    -- GembaPay
    gembapay_merchant_id VARCHAR(100),

    -- Status
    is_active           BOOLEAN DEFAULT true,
    is_canceled         BOOLEAN DEFAULT false,
    is_ended            BOOLEAN DEFAULT false,
    sale_active         BOOLEAN DEFAULT false,

    -- Stats
    max_capacity        INT CHECK (max_capacity > 0),
    tickets_sold        INT DEFAULT 0,
    tickets_scanned     INT DEFAULT 0,

    -- REMOVED: scanner_address, scanner_name, minter_address, encrypted_minter_key

    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW()
);

-- TICKET TYPES (NEW — for ERC1155 zones)
CREATE TABLE ticket_types (
    id              SERIAL PRIMARY KEY,
    event_id        INT REFERENCES events(id),
    token_type_id   INT NOT NULL,          -- On-chain token type ID
    name            VARCHAR(100) NOT NULL,  -- "General", "VIP", "Backstage"
    price_usd       NUMERIC(10,2),
    price_crypto    VARCHAR(50),           -- "0.01" ETH/BNB
    max_supply      INT NOT NULL,
    minted          INT DEFAULT 0,
    zone_level      INT DEFAULT 0,         -- 0=General, 1=VIP, 2=Backstage, 3=AllAccess
    color_code      VARCHAR(7),            -- "#22C55E" for visualization
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- TICKETS — rewritten
CREATE TABLE tickets (
    id                  SERIAL PRIMARY KEY,
    event_id            INT REFERENCES events(id),
    ticket_type_id      INT REFERENCES ticket_types(id),
    token_id            INT,
    serial_number       VARCHAR(100) UNIQUE NOT NULL,

    -- Ownership
    owner_user_id       INT REFERENCES users(id),
    original_buyer_id   INT REFERENCES users(id),

    -- Security tokens (rotating QR)
    auth_token          VARCHAR(64) NOT NULL,
    hmac_secret         VARCHAR(64) NOT NULL,

    -- Device binding
    device_hash         VARCHAR(64),

    -- Lifecycle
    is_activated        BOOLEAN DEFAULT false,
    locked_to_user      INT REFERENCES users(id),
    locked_to_device    VARCHAR(64),
    activated_at        TIMESTAMP,

    -- NFT Claim
    claim_hash          VARCHAR(66),
    claim_code          VARCHAR(64),
    is_claimed          BOOLEAN DEFAULT false,
    claimed_by          VARCHAR(42),
    claimed_at          TIMESTAMP,

    -- Visual state (for "glowing" NFTs)
    visual_status       VARCHAR(20) DEFAULT 'ready',
    visual_color        VARCHAR(7) DEFAULT '#FFFFFF',
    visual_zone         VARCHAR(20) DEFAULT 'general',

    -- Payment
    payment_provider    VARCHAR(20),
    payment_id          VARCHAR(255),
    payment_amount      NUMERIC(10,2),
    payment_currency    VARCHAR(10),

    -- IPFS
    metadata_ipfs_cid   VARCHAR(100),

    -- REMOVED: qr_code (base64 in DB), encrypted_private_key, mint_tx

    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- NEW TABLES
-- ============================================

-- TRANSFER LOG
CREATE TABLE transfer_log (
    id              SERIAL PRIMARY KEY,
    ticket_id       INT REFERENCES tickets(id),
    from_user_id    INT REFERENCES users(id),
    to_user_id      INT REFERENCES users(id),
    transfer_type   VARCHAR(20),           -- 'platform', 'onchain'
    tx_hash         VARCHAR(66),
    transferred_at  TIMESTAMP DEFAULT NOW()
);

-- SCAN LOGS (improved)
CREATE TABLE scan_logs (
    id              SERIAL PRIMARY KEY,
    ticket_id       INT REFERENCES tickets(id),
    scanner_id      INT REFERENCES scanners(id),
    scan_type       VARCHAR(10) NOT NULL,  -- 'entry', 'exit'
    scan_result     VARCHAR(20) NOT NULL,  -- 'success', 'denied', 'error'
    deny_reason     VARCHAR(100),
    zone            VARCHAR(20),
    device_hash     VARCHAR(64),
    scan_time       TIMESTAMP DEFAULT NOW()
);

-- SCANNERS (improved)
CREATE TABLE scanners (
    id                  SERIAL PRIMARY KEY,
    event_id            INT REFERENCES events(id),
    name                VARCHAR(255) NOT NULL,
    location            VARCHAR(255),
    operator_user_id    INT REFERENCES users(id),
    zone_token_type     INT,
    is_active           BOOLEAN DEFAULT true,
    scanner_secret      VARCHAR(64),
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW()
);

-- ORGANIZER PROFILES (NEW)
CREATE TABLE organizer_profiles (
    id                  SERIAL PRIMARY KEY,
    user_id             INT UNIQUE REFERENCES users(id),
    company_name        VARCHAR(255),
    gembapay_merchant_id VARCHAR(100),
    stripe_account_id   VARCHAR(100),
    is_verified         BOOLEAN DEFAULT false,
    reputation_score    INT DEFAULT 100,
    events_created      INT DEFAULT 0,
    events_canceled     INT DEFAULT 0,
    total_tickets_sold  INT DEFAULT 0,
    created_at          TIMESTAMP DEFAULT NOW()
);

-- REFUND TRACKING (NEW)
CREATE TABLE refund_tracking (
    id              SERIAL PRIMARY KEY,
    event_id        INT REFERENCES events(id),
    ticket_id       INT REFERENCES tickets(id),
    payment_id      VARCHAR(255),
    refund_amount   NUMERIC(10,2),
    refund_currency VARCHAR(10),
    payment_type    VARCHAR(20),            -- 'fiat' or 'crypto'
    refund_status   VARCHAR(20) DEFAULT 'pending',
    refund_deadline TIMESTAMP,
    refunded_at     TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_tickets_serial ON tickets(serial_number);
CREATE INDEX idx_tickets_owner ON tickets(owner_user_id);
CREATE INDEX idx_tickets_event ON tickets(event_id);
CREATE INDEX idx_tickets_auth_token ON tickets(auth_token);
CREATE INDEX idx_tickets_claim_hash ON tickets(claim_hash);
CREATE INDEX idx_tickets_activated ON tickets(is_activated) WHERE is_activated = true;
CREATE INDEX idx_scan_logs_ticket ON scan_logs(ticket_id);
CREATE INDEX idx_scan_logs_time ON scan_logs(scan_time DESC);
CREATE INDEX idx_transfer_log_ticket ON transfer_log(ticket_id);
CREATE INDEX idx_events_organizer ON events(organizer_user_id);
CREATE INDEX idx_events_active ON events(is_active) WHERE is_active = true;
CREATE INDEX idx_refund_tracking_status ON refund_tracking(refund_status)
    WHERE refund_status = 'pending';
```

---

## 5. FRONTEND (React)

### 5.1 Structure

```
src/
├── pages/
│   ├── HomePage.jsx               — Landing page
│   ├── EventsPage.jsx             — Browse events
│   ├── EventDetailPage.jsx        — Single event + buy widget
│   ├── LiveTicketPage.jsx         — NEW: Live rotating QR (auth required)
│   ├── ClaimNFTPage.jsx           — NEW: Claim NFT with code + MetaMask
│   ├── MyTicketsPage.jsx          — My tickets (list)
│   ├── NFTViewerPage.jsx          — NEW: 3-page NFT viewer
│   └── organizer/
│       ├── OrganizerDashboard.jsx — Manage events
│       ├── CreateEventPage.jsx    — Create event form
│       ├── EventStatsPage.jsx     — Real-time scan stats
│       └── ScannerSetupPage.jsx   — Configure scanners
├── components/
│   ├── tickets/
│   │   ├── TicketCard.jsx         — Ticket preview card
│   │   ├── RotatingQR.jsx         — NEW: QR with 30-sec rotation
│   │   ├── TransferModal.jsx      — NEW: Transfer ticket
│   │   └── TicketStatusBadge.jsx  — Visual status indicator
│   ├── nft/
│   │   ├── NFTViewer.jsx          — NEW: 3-page swipe viewer
│   │   ├── AnimatedQR.jsx         — NEW: Canvas/WebGL animated QR
│   │   ├── GlowEffect.jsx        — NEW: Color glow effects
│   │   └── ClaimButton.jsx        — NEW: Claim NFT button + flow
│   ├── payment/
│   │   └── GembaPayWidget.jsx     — NEW: GembaPay payment integration
│   ├── scanner/
│   │   ├── ScannerApp.jsx         — NEW: PWA Scanner (camera + verify)
│   │   ├── ScanResult.jsx         — NEW: Green/red screen + sound
│   │   └── LiveFeed.jsx           — NEW: Real-time scan dashboard
│   └── common/
│       ├── Header.jsx
│       ├── Footer.jsx
│       └── WalletConnect.jsx      — Optional MetaMask connect
├── hooks/
│   ├── useRotatingQR.js           — NEW: 30-sec QR rotation hook
│   ├── useWebSocket.js            — NEW: Real-time updates
│   └── useGembaPay.js             — NEW: GembaPay SDK hook
└── services/
    ├── api.js                     — Backend API client
    └── web3.js                    — Optional Web3 (only for claim)
```

### 5.2 Key Components

#### NFTViewer.jsx — 3-page swipe viewer

```
Page 1: EVENT POSTER (1000x1000)
  → Uploaded by organizer
  → Clean minimalist design
  → Shown in OpenSea/MetaMask as main image

Page 2: TICKET INFO
  → Event name, date, time, location
  → Ticket type and zone
  → Serial number
  → Generated by the system

Page 3: ANIMATED QR
  → QR code that GLOWS and PULSES
  → Color depends on status:
    ⬜ WHITE  = Ready (not scanned)
    🟢 GREEN  = Inside (after entry scan)
    🔵 BLUE   = Outside (after exit scan)
    🟡 GOLD   = VIP Zone
    🔴 RED    = Backstage
    🌈 RAINBOW = Event ended (collector's edition)
  → Real-time status updates via API polling
```

#### ScannerApp.jsx — PWA Scanner

```
Standalone PWA (Progressive Web App):
  → Installs on scanner operator's phone
  → Camera access for QR reading
  → Works fullscreen like native app
  → Audio feedback: beep for success, buzz for denied

Flow:
  1. Operator logs in (email + password)
  2. Selects event + zone to scan
  3. Camera activates
  4. Reads QR → POST /api/v1/scanner/scan
  5. Result:
     ✅ Green screen + "ENTER" + beep sound
     ❌ Red screen + reason + buzz sound
  6. Auto-reset for next scan (2 sec)

Offline mode:
  → Cache ticket serial numbers on startup
  → No internet: verify against cache
  → On reconnection: sync pending scans
```

---

## 6. INFRASTRUCTURE

### 6.1 Hetzner VPS Setup

```
VPS 1 (Primary — Falkenstein):
  ├── Node.js Backend (PM2)
  ├── PostgreSQL 16
  ├── Redis 7
  ├── IPFS Node (Kubo)
  ├── Nginx (reverse proxy)
  └── Certbot (SSL)

VPS 2 (Fallback — Helsinki):
  ├── Node.js Backend (PM2) — hot standby
  ├── PostgreSQL 16 — streaming replication
  ├── Redis 7 — replica
  ├── IPFS Node (Kubo) — pin mirror
  └── Nginx

Cloudflare:
  ├── DNS
  ├── Load Balancer (failover)
  ├── DDoS protection
  └── SSL termination

Domains:
  tickets.gembapay.com       — Frontend
  api.tickets.gembapay.com   — Backend API
  ipfs.gembapay.com          — IPFS Gateway
  scanner.gembapay.com       — Scanner PWA
```

### 6.2 IPFS Setup

```bash
# On each VPS:
ipfs init
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080

# Peer the two nodes:
ipfs swarm connect /ip4/<VPS2_IP>/tcp/4001/p2p/<VPS2_PEER_ID>

# Auto-pin between nodes:
# Every upload → pin on primary → replicate to secondary
```

---

## 7. GEMBAPAY INTEGRATION

### 7.1 Organizer Onboarding

```
1. Organizer registers on ticket platform
2. Clicks "Become an Organizer"
3. Redirect to GembaPay merchant onboarding:
   → Stripe Connect onboarding (for cards)
   → Select the payment methods to accept
   → KYC (if required by Stripe)
4. Webhook: merchant.onboarded → platform records merchant_id
5. Organizer can now create events
```

### 7.2 Payment Flow

```
TICKET PURCHASE:
  1. Buyer → EventDetailPage → selects ticket → [Buy]
  2. GembaPay Widget opens:
     → Card (Visa/MC) → Stripe Connect → directly to organizer
     → Crypto (ETH/BNB/MATIC/USDT) → GembaPay Protocol → directly to organizer
  3. GembaPay automatic split: 95% → organizer, 5% → GEMBA EOOD
  4. Webhook → backend → mint NFT (gas from platform) → email ticket

EVENT CREATION:
  1. Organizer → CreateEventPage → fills form
  2. GembaPay Widget: platform fee ($5-10)
  3. Webhook → backend → deploy EventContract (gas from platform) → IPFS upload
  4. Organizer sees: "Event created successfully!"
```

### 7.3 Refund Policy

```
FIAT REFUNDS:
  → Money is in organizer's Stripe account
  → Platform CANNOT initiate refunds
  → Organizer must refund from their Stripe/GembaPay dashboard
  → Platform tracks via refund_tracking table
  → If overdue: warning → reputation score decrease → ban

CRYPTO REFUNDS:
  → Money was sent directly to organizer's wallet
  → Contract holds ZERO funds
  → Organizer must manually send back
  → Platform provides buyer addresses to organizer
  → Same tracking and reputation system

PLATFORM RESPONSIBILITY:
  → Monitor canceled events
  → Track refund status per ticket
  → Notify buyers of refund deadlines
  → Enforce reputation scoring
  → Ban repeat offenders
```

---

## 8. TICKET LIFECYCLE

### 8.1 Transfer and Lock Logic

```
PHASE 1: FREE TICKET (before first scan)

  Ivan buys ticket → can transfer freely
  Ivan → "Transfer Ticket" → enters Petar's email
  Backend:
    → auth_token regenerated for Petar
    → device binding reset
    → HMAC secret changed
    → Petar receives email with new live QR link
    → Ivan's link stops working IMMEDIATELY

  Petar → can transfer to Maria (if desired)
  Same process. No restrictions.

PHASE 2: LOCKED TICKET (after first scan)

  Petar goes to event → scanner reads QR
  Backend:
    → first_scan = true
    → locked_to_user = Petar's user ID
    → locked_to_device = Petar's device fingerprint
    → TRANSFER BLOCKED from this moment

  Petar sends link to Maria → Maria opens →
    "This ticket has been activated by another user"

  Petar tries "Transfer Ticket" →
    "Ticket is activated and cannot be transferred"

PHASE 3: AFTER EVENT

  NFT transfer → UNLOCKED (collectible value)
  Plain ticket → expired, no longer relevant
```

### 8.2 Security Matrix

```
                    Plain QR          NFT Ticket
                    ─────────         ──────────
Before scan:
  Transfer          ✅ Off-chain       ✅ On-chain transfer
  Mechanism         Email transfer     transferFrom()
  What happens      New auth+HMAC      New owner on-chain
                    Old link dies      Backend syncs

First scan:
  Lock              ✅ DB lock          ✅ activateTicket()
  Mechanism         is_activated=true   ticketActivated=true
                    locked_to_user      activatedBy[tokenId]

After scan:
  Transfer          ❌ BLOCKED          ❌ REVERT on-chain
  Forward QR        ❌ Device+HMAC      ❌ Owner check
  Second person     ❌ "Activated"      ❌ "Transfer locked"

Entry/Exit:
  Re-entry          ✅ Toggle            ✅ Toggle
  Verification      locked_to_user      activatedBy match

After event:
  Transfer          ❌ Expired           ✅ Unlocked
  Value             None                 Collectible
```

---

## 9. DEVELOPMENT PHASES

### PHASE 1: Smart Contracts (2-3 weeks)

```
Week 1:
  □ EventContract721 v2 (buyTicketCrypto, mintWithFiatProof)
  □ EventContract1155 v2 (ticket types, zones)
  □ ClaimContract (lock, claim, renounce)
  □ Unit tests for each contract

Week 2:
  □ PlatformRegistry (factory + treasury + admin, EIP-1167 clones)
  □ Integration tests (full flow: create event → buy → activate → claim)
  □ Integration tests (full flow)
  □ Slither + Mythril security audit

Week 3:
  □ Testnet deploy (Polygon Amoy)
  □ Gas optimization
  □ Edge case testing
  □ Fix audit findings
```

### PHASE 2: Backend (2-3 weeks)

```
Week 4:
  □ New DB schema + migration from v1
  □ platformSigner.js (gas payment wallet + balance monitoring)
  □ scannerService.js (rotating QR, HMAC, device binding)
  □ transferService.js (ticket transfers)
  □ claimService.js (claim code generation)

Week 5:
  □ metadataService.js (3-page metadata, IPFS upload)
  □ GembaPay webhook handler
  □ Event creation flow (deploy + IPFS)
  □ Blockchain service v2 (contract interactions)

Week 6:
  □ API endpoints (all routes)
  □ WebSocket for real-time scan feed
  □ Email templates (claim code, ticket, transfer)
  □ Integration testing
```

### PHASE 3: Frontend (2-3 weeks)

```
Week 7:
  □ Event pages (browse, detail, buy)
  □ GembaPay widget integration
  □ Live Ticket Page (rotating QR)
  □ My Tickets page

Week 8:
  □ NFT Viewer (3-page swipe, animated QR, glow effects)
  □ Claim NFT page (MetaMask connect + claim flow)
  □ Transfer modal
  □ Organizer dashboard (create event, stats)

Week 9:
  □ Scanner PWA (camera, QR reading, sounds)
  □ Live scan feed dashboard
  □ Mobile responsive polish
  □ Apple/Google Wallet integration (stretch goal)
```

### PHASE 4: Infrastructure + Launch (1-2 weeks)

```
Week 10:
  □ IPFS node setup (primary + fallback)
  □ Production deploy on Polygon mainnet
  □ Cloudflare LB configuration
  □ SSL, DNS, security headers

Week 11:
  □ End-to-end testing (full flow)
  □ Load testing (concurrent scans)
  □ Security review
  □ Soft launch with test event
```

---

## 10. SECURITY CHECKLIST

```
Smart Contracts:
  □ ReentrancyGuard on all payable functions
  □ Check-Effects-Interactions pattern
  □ Access control: onlyOwner, onlyPlatform
  □ Integer overflow protection (Solidity 0.8+)
  □ Slither audit — 0 high/critical
  □ Mythril symbolic execution
  □ Manual review of payment splitting
  □ Platform signer wallet balance monitoring + alerts

Backend:
  □ JWT with expiration + refresh tokens
  □ Rate limiting on all endpoints
  □ HMAC verification for QR
  □ Input validation (express-validator)
  □ SQL injection prevention (parameterized queries)
  □ XSS prevention (CSP headers)
  □ CORS configuration
  □ Webhook signature verification (GembaPay)
  □ Device fingerprinting for ticket binding
  □ Platform signer key in env vars, never in code

Frontend:
  □ No sensitive data in localStorage
  □ CSP meta tags
  □ XSS sanitization
  □ Secure WebSocket connections
  □ Camera permissions handling (Scanner PWA)

Infrastructure:
  □ PostgreSQL encrypted connections
  □ Redis password authentication
  □ IPFS API not publicly accessible
  □ Firewall rules (only 80, 443)
  □ Automatic security updates
  □ Backup strategy (daily DB + IPFS pins)
  □ Platform signer balance auto-monitoring
```

---

## 11. SUMMARY

### What We Achieve

| Feature | v1 (current) | v2 (plan) |
|---------|-------------|-----------|
| Custody | ❌ Custodial (PK + fiat) | ✅ Zero custody |
| Blockchain knowledge | ❌ Required | ✅ Not required |
| Payments | ❌ Direct Stripe | ✅ GembaPay (direct settlement) |
| Gas costs | ❌ User/minter pays | ✅ Platform absorbs from 5% fee |
| NFT Metadata | ❌ None (broken) | ✅ IPFS + dynamic 3-page |
| Scanner | ❌ No app exists | ✅ PWA + rotating QR |
| Anti-fraud | ❌ Minimal | ✅ HMAC + device bind + activation lock |
| Ticket transfer | ❌ Not supported | ✅ Free before scan, locked after |
| Solidity LOC | ~4150 | ~978 (76% reduction) |
| Backend LOC | ~12700 | ~8000 (est.) |
| Regulation | ❌ licensing burden \| ✅ Clean direct settlement |
| Refunds | ❌ No mechanism | ✅ Tracking + reputation + ban |
| NFT Experience | ❌ Empty/broken NFTs | ✅ 3-page animated + glowing |

### Timeline

- **Total:** 10-11 weeks
- **MVP (contracts + backend + basic frontend):** 6-7 weeks
- **Full launch:** 10-11 weeks

### Risks

| Risk | Probability | Mitigation |
|------|------------|------------|
| GembaPay API changes | Low | Abstraction layer, easy swap |
| IPFS node downtime | Medium | Dual-node + Cloudflare cache |
| Gas spike on Polygon | Low | Batch minting, L2 fallback |
| Scanner offline | Medium | Offline cache + sync |
| Organizer doesn't refund | Medium | Reputation system + ban |
| Platform signer out of gas | Low | Auto-monitoring + alerts + auto-fund |
