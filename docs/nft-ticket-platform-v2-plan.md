# NFT Ticket Platform v2 — Пълен план за разработка

**Проект:** Non-custodial билетна платформа с NFT бонус
**Компания:** GEMBA EOOD
**Дата:** 08.02.2026
**Статус:** За одобрение

---

## 1. ВИЗИЯ И ПРИНЦИПИ

### 1.1 Основна визия

Билетна платформа, която работи като Eventbrite за крайния потребител, но под капака използва blockchain и NFT технологии за сигурност, автентичност и колекционерска стойност. Потребителите НЕ трябва да знаят нищо за blockchain.

### 1.2 Ключови принципи

- **ZERO CUSTODY** — платформата не държи нито crypto, нито fiat, нито private keys, нито NFT-та от името на потребители
- **BLOCKCHAIN INVISIBLE** — потребителите (организатори и купувачи) работят с email, карти и QR кодове; blockchain е невидим слой отдолу
- **GEMBAPAY POWERED** — всички плащания (fiat и crypto) минават през GembaPay; GEMBA EOOD получава само платформена такса
- **NFT = БОНУС** — билетът работи без NFT; NFT е опционален claim за потребители, които го искат
- **МАКСИМАЛНА СИГУРНОСТ** — rotating QR, device binding, transfer lock след първо сканиране, HMAC верификация

### 1.3 Поддържани мрежи

- **Primary:** Polygon (ниски gas fees, бърза финалност)
- **Secondary:** BSC, Ethereum (организаторът избира при създаване)
- **IPFS:** Собствен node на Hetzner VPS (primary + fallback)

---

## 2. SMART CONTRACTS (Solidity 0.8.28)

### 2.1 Архитектурен преглед

```
Diamond Proxy v2 (EIP-2535)
├── FactoryFacet v2        — Създаване на събития
├── TreasuryFacet          — Платформени такси
└── AdminFacet             — Platform management

EventContract v2 (per-event, клониран)
├── ERC721 или ERC1155     — NFT билети
├── Crypto payment logic   — GembaPay protocol вграден
├── Fiat proof minting     — Backend-verified mint
├── Ticket lifecycle       — activate/lock/transfer control
└── Event management       — cancel/end/metadata

ClaimContract (singleton)
├── Lock NFT за claim      — NFT-тата чакат тук
├── Claim с код            — Потребител вземa NFT
└── Renounced ownership    — Никой няма контрол
```

### 2.2 EventContract v2 — Детайлна спецификация

```solidity
// ============================================
// STATE VARIABLES
// ============================================

address public owner;              // Организатор (може EOA или smart wallet)
address public platform;           // Platform backend address (за fiat mint)
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

// ERC721 вариант:
uint256 public maxSupply;
uint256 public price;              // В native token (ETH/BNB/MATIC)

// ERC1155 вариант:
struct TicketType {
    string name;                   // "General", "VIP", "Backstage"
    uint256 price;
    uint256 maxSupply;
    uint256 minted;
    bool active;
}
mapping(uint256 => TicketType) public ticketTypes;

// Ticket lifecycle
mapping(uint256 => bool) public ticketActivated;       // След първо сканиране
mapping(uint256 => address) public activatedBy;         // Кой го е активирал
mapping(uint256 => bytes32) public ticketClaimHash;     // Hash за claim

// ============================================
// CRYPTO PAYMENT (GembaPay Protocol)
// ============================================

function buyTicketCrypto(uint256 ticketTypeId) external payable {
    require(saleActive, "Sale not active");
    require(!isEventCanceled, "Event canceled");
    require(!isEventEnded, "Event ended");

    uint256 ticketPrice = _getPrice(ticketTypeId);
    require(msg.value >= ticketPrice, "Insufficient payment");

    // Non-custodial split — средствата ВЕДНАГА отиват при получателите
    uint256 platformFee = (ticketPrice * platformFeeBps) / 10000;
    uint256 organizerAmount = ticketPrice - platformFee;

    // Директен transfer — контрактът НЕ задържа средства
    (bool sentOrganizer,) = owner.call{value: organizerAmount}("");
    require(sentOrganizer, "Organizer payment failed");

    (bool sentTreasury,) = treasury.call{value: platformFee}("");
    require(sentTreasury, "Treasury payment failed");

    // Refund excess
    if (msg.value > ticketPrice) {
        (bool refunded,) = msg.sender.call{value: msg.value - ticketPrice}("");
        require(refunded, "Refund failed");
    }

    // Mint NFT в ClaimContract
    uint256 tokenId = _mintToClaimContract(msg.sender, ticketTypeId);

    emit TicketPurchased(msg.sender, tokenId, ticketTypeId, ticketPrice, "crypto");
}

// ============================================
// FIAT PAYMENT (GembaPay webhook → Backend → тук)
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

    // Генерираме claim hash
    bytes32 claimHash = keccak256(abi.encodePacked(
        tokenId, _buyer, block.timestamp, blockhash(block.number - 1)
    ));
    ticketClaimHash[tokenId] = claimHash;

    // Mint NFT в ClaimContract (не директно на buyer)
    _safeMint(address(claimContract), tokenId);

    // Регистрираме в ClaimContract
    IClaimContract(claimContract).lockForClaim(claimHash, tokenId, _buyer);
}

// ============================================
// TICKET LIFECYCLE
// ============================================

// Извиква се от backend при първо сканиране
function activateTicket(uint256 _tokenId) external onlyPlatform {
    require(!ticketActivated[_tokenId], "Already activated");
    ticketActivated[_tokenId] = true;

    // Ако е claim-нат, записваме owner-а; ако не — buyer от ClaimContract
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
    // Mint (from == 0) е винаги OK
    if (from == address(0)) return;

    // След края на събитието — свободен transfer
    if (isEventEnded) return;

    // След активиране — БЛОКИРАН transfer
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
    // Fiat refunds → организаторът чрез GembaPay/Stripe
    // Crypto refunds → организаторът ръчно (не държим средства)
}

function endEvent() external onlyOwner {
    require(!isEventCanceled, "Event is canceled");
    isEventEnded = true;
    saleActive = false;
    emit EventEnded(block.timestamp);
    // Отключва NFT transfers за вторичен пазар
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

### 2.3 ClaimContract — Детайлна спецификация

```solidity
// ============================================
// CLAIM CONTRACT — Autonomous NFT Holding
// ============================================
// Owner: address(0) след deployment (renounced)
// Никой няма контрол — само код

struct ClaimData {
    address eventContract;     // Кой event contract
    uint256 tokenId;           // Кой token
    address buyer;             // Кой е купил (за верификация)
    bool claimed;              // Вече claim-нат ли е
    uint256 createdAt;         // Кога е създаден
}

mapping(bytes32 => ClaimData) public claims;

// Регистриране на claim (само от event contracts)
function lockForClaim(
    bytes32 _claimHash,
    uint256 _tokenId,
    address _buyer
) external {
    // Верификация: caller трябва да е регистриран event contract
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

// Потребител claim-ва NFT (трябва да знае claimCode)
function claim(
    string calldata _claimCode,
    address _destinationWallet
) external {
    bytes32 claimHash = keccak256(abi.encodePacked(_claimCode));
    ClaimData storage data = claims[claimHash];

    require(data.eventContract != address(0), "Invalid claim code");
    require(!data.claimed, "Already claimed");

    data.claimed = true;

    // Transfer NFT от ClaimContract → потребителски wallet
    IERC721(data.eventContract).transferFrom(
        address(this),
        _destinationWallet,
        data.tokenId
    );

    emit NFTClaimed(claimHash, _destinationWallet, data.tokenId);
}

// Регистриране на нов event contract (от Factory)
function registerEvent(address _eventContract) external onlyFactory {
    registeredEvents[_eventContract] = true;
}

// Transfer claim на нов buyer (преди активиране)
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

### 2.4 FactoryFacet v2

```solidity
function createEvent(
    bytes calldata _initData,
    uint256 _eventType        // 0 = ERC721, 1 = ERC1155
) external payable returns (address eventAddress) {
    // Плащане за създаване: GembaPay (fiat) или native token
    // Минимална такса покрива gas + platform fee
    require(msg.value >= createEventFee, "Insufficient fee");

    // Deploy чрез CREATE2 (deterministic address)
    bytes32 salt = keccak256(abi.encodePacked(msg.sender, block.timestamp));

    if (_eventType == 0) {
        eventAddress = Clones.cloneDeterministic(erc721Template, salt);
    } else {
        eventAddress = Clones.cloneDeterministic(erc1155Template, salt);
    }

    // Initialize
    IEventContract(eventAddress).initialize(_initData, msg.sender, platform, treasury, claimContract);

    // Register в ClaimContract
    IClaimContract(claimContract).registerEvent(eventAddress);

    // Fee → Treasury
    (bool sent,) = treasury.call{value: msg.value}("");
    require(sent, "Fee transfer failed");

    allEvents.push(eventAddress);
    emit EventCreated(eventAddress, msg.sender, _eventType);
}

// За fiat плащане на създаване (backend вика след GembaPay потвърждение)
function createEventWithFiatProof(
    bytes calldata _initData,
    uint256 _eventType,
    address _organizer,
    bytes32 _paymentHash
) external onlyPlatform returns (address) {
    // Същата логика, но без msg.value
    // Gas се покрива от platform treasury
}
```

### 2.5 PlatformTreasury

```solidity
// Събира платформени такси
// Multisig управление (3-of-3 или 2-of-3)
// emergencyWithdraw с timelock
// Покрива gas за fiat операции (createEvent, mint)

receive() external payable {
    emit FundsReceived(msg.sender, msg.value);
}

function withdraw(address _to, uint256 _amount) external onlyMultisig {
    (bool sent,) = _to.call{value: _amount}("");
    require(sent, "Withdraw failed");
}
```

### 2.6 Контракти — Обобщение

| Контракт | LOC (est.) | Роля |
|----------|-----------|------|
| EventContract721 v2 | ~350 | ERC721 + payments + lifecycle |
| EventContract1155 v2 | ~400 | ERC1155 + ticket types + payments + lifecycle |
| ClaimContract | ~150 | Autonomous NFT holding + claim |
| FactoryFacet v2 | ~200 | Event deployment + registration |
| TreasuryFacet | ~100 | Fee collection + multisig withdraw |
| AdminFacet | ~80 | Platform settings |
| **Общо** | **~1280** | **vs. сегашните ~4150 LOC** |

Намаление от ~4150 → ~1280 LOC (69% по-малко код, по-малко attack surface).

### 2.7 Какво НЕ включваме (vs. v1)

- ❌ Validator/Oracle contracts — GembaPay замества
- ❌ QRModule on-chain — off-chain сканиране (по-бързо, безплатно)
- ❌ AdminModule as separate contract — вграден в EventContract
- ❌ MintModule as separate contract — вграден в EventContract
- ❌ ViewModule — frontend чете директно от контракта
- ❌ balanceThreshold — не се натрупва баланс в контракта
- ❌ Minter wallet management — няма custodial wallets

---

## 3. BACKEND (Node.js + Express)

### 3.1 Архитектурен преглед

```
src/
├── app.js                          — Express setup, CORS, CSP
├── middleware/
│   ├── auth.js                     — JWT auth (ЗАПАЗЕН)
│   ├── security.js                 — Rate limiting, logging (ЗАПАЗЕН)
│   ├── validation.js               — Input validation (ЗАПАЗЕН)
│   └── hmac.js                     — НОВ: HMAC верификация за QR
├── routes/
│   ├── auth.js                     — Login/register (ЗАПАЗЕН)
│   ├── events.js                   — Event CRUD (МОДИФИЦИРАН)
│   ├── tickets.js                  — Ticket management (МОДИФИЦИРАН)
│   ├── scanner.js                  — Scan verification (ПРЕНАПИСАН)
│   ├── claims.js                   — НОВ: NFT claim endpoints
│   ├── webhooks.js                 — НОВ: GembaPay webhooks
│   └── organizer.js                — НОВ: Organizer management
├── services/
│   ├── auth/
│   │   ├── userAuth.js             — User auth (ЗАПАЗЕН)
│   │   └── googleAuth.js           — Google OAuth (ЗАПАЗЕН)
│   ├── blockchain.js               — Contract interactions (ПРЕНАПИСАН)
│   ├── ipfs.js                     — IPFS client (ЗАПАЗЕН, доработен)
│   ├── ticketGenerator.js          — Ticket images (МОДИФИЦИРАН за 3-page)
│   ├── notificationService.js      — Email (ЗАПАЗЕН)
│   ├── queue.js                    — Bull queues (ЗАПАЗЕН)
│   ├── redis.js                    — Redis cache (ЗАПАЗЕН)
│   ├── database.js                 — DB pool (ЗАПАЗЕН, нова schema)
│   ├── scannerService.js           — НОВ: Scan logic + HMAC + device binding
│   ├── claimService.js             — НОВ: Claim code management
│   ├── transferService.js          — НОВ: Ticket transfer logic
│   ├── metadataService.js          — НОВ: Dynamic NFT metadata
│   └── gembapay/
│       ├── webhookHandler.js       — НОВ: Process GembaPay webhooks
│       └── paymentVerifier.js      — НОВ: Verify payment proofs
└── utils/
    ├── hmac.js                     — НОВ: HMAC generation/verification
    ├── claimCodes.js               — НОВ: Secure claim code generation
    └── deviceFingerprint.js        — НОВ: Device binding logic
```

### 3.2 Код за запазване от v1

| Файл | Редове | Промени |
|------|--------|---------|
| middleware/auth.js | 439 | Без промени |
| middleware/security.js | 313 | Без промени |
| services/auth/userAuth.js | 424 | Махаме wallet generation полетата |
| services/ipfs.js | 304 | Добавяме 3-page upload logic |
| services/ticketGenerator.js | 277 | Модифицираме за 3-page дизайн |
| services/notificationService.js | 402 | Добавяме claim code в email-ите |
| services/queue.js | 331 | Добавяме нови queue types |
| services/database.js | 468 | Нова schema migration |
| **Общо запазен** | **~2958** | |

### 3.3 Код за МАХАНЕ от v1

| Файл | Причина |
|------|---------|
| services/auth/custodialWallet.js | CUSTODY — генерира PK |
| services/eventWalletManager.js | CUSTODY — minter wallets |
| services/ticketMinter.js | Зависи от custodial wallets |
| services/payments/stripe.js | Заменен от GembaPay |
| services/payments/paypal.js | Заменен от GembaPay |
| services/payments/paymentProcessor.js | Заменен от GembaPay |
| routes/factory.js | Нова factory логика |
| routes/blockchain.js | Пренаписан |
| routes/payments.js | Заменен от GembaPay webhooks |
| utils/encryption.js | Няма PK за криптиране |
| utils/keyDerivation.js | Няма PK за derivation |

### 3.4 Нови services — Детайлна спецификация

#### 3.4.1 scannerService.js — Сканиране с rotating QR

```javascript
class ScannerService {

  // Генерира rotating QR данни (на всеки 30 сек)
  generateRotatingQR(serialNumber) {
    const timestamp = Math.floor(Date.now() / 30000) * 30000; // 30-sec window
    const hmacSecret = this.getTicketHmacSecret(serialNumber);
    const signature = crypto
      .createHmac('sha256', hmacSecret)
      .update(`${serialNumber}:${timestamp}`)
      .digest('hex')
      .substring(0, 16);

    return {
      sn: serialNumber,
      ts: timestamp,
      sig: signature
    };
  }

  // Верифицира QR от скенер
  async verifyScan(qrData, scannerInfo) {
    const { sn, ts, sig } = qrData;

    // 1. Timestamp проверка (последните 60 сек)
    const now = Date.now();
    if (Math.abs(now - ts) > 60000) {
      return { valid: false, reason: 'QR code expired' };
    }

    // 2. HMAC верификация
    const hmacSecret = await this.getTicketHmacSecret(sn);
    const expectedSig = crypto
      .createHmac('sha256', hmacSecret)
      .update(`${sn}:${ts}`)
      .digest('hex')
      .substring(0, 16);

    if (sig !== expectedSig) {
      return { valid: false, reason: 'Invalid QR signature' };
    }

    // 3. Ticket lookup
    const ticket = await db.query(
      'SELECT * FROM tickets WHERE serial_number = $1', [sn]
    );
    if (!ticket) return { valid: false, reason: 'Ticket not found' };

    // 4. Scanner оторизация за този event
    const scanner = await db.query(
      'SELECT * FROM scanners WHERE id = $1 AND event_id = $2 AND is_active = true',
      [scannerInfo.scannerId, ticket.event_id]
    );
    if (!scanner) return { valid: false, reason: 'Scanner not authorized' };

    // 5. Ticket type проверка за зона
    if (scannerInfo.zoneTokenType !== undefined) {
      if (ticket.ticket_type_id < scannerInfo.zoneTokenType) {
        return { valid: false, reason: 'Insufficient access level' };
      }
    }

    // 6. First scan → ACTIVATE + LOCK
    if (!ticket.is_activated) {
      await this.activateTicket(ticket);
      return { valid: true, action: 'ENTRY', firstScan: true };
    }

    // 7. Вече активиран → проверка дали е същият потребител
    if (ticket.locked_to_user !== scannerInfo.currentUserId) {
      return { valid: false, reason: 'Ticket activated by another user' };
    }

    // 8. Entry/Exit toggle
    const lastScan = await db.query(
      'SELECT scan_type FROM scan_logs WHERE ticket_id = $1 ORDER BY scan_time DESC LIMIT 1',
      [ticket.id]
    );
    const nextAction = (!lastScan || lastScan.scan_type === 'exit') ? 'ENTRY' : 'EXIT';

    return { valid: true, action: nextAction, firstScan: false };
  }

  // Активиране на билет (първо сканиране)
  async activateTicket(ticket) {
    await db.query(`
      UPDATE tickets SET
        is_activated = true,
        locked_to_user = $1,
        locked_to_device = $2,
        activated_at = NOW()
      WHERE id = $3
    `, [ticket.owner_user_id, currentDeviceHash, ticket.id]);

    // On-chain activation (ако има NFT)
    if (ticket.token_id) {
      await blockchain.activateTicket(ticket.event_contract, ticket.token_id);
    }

    // Update NFT metadata — цвят става ЗЕЛЕН
    await metadataService.updateTicketVisualState(ticket.id, 'INSIDE', 'green');
  }
}
```

#### 3.4.2 transferService.js — Прехвърляне на билети

```javascript
class TransferService {

  async transferTicket(serialNumber, fromUserId, recipientEmail) {
    const ticket = await db.query(
      'SELECT * FROM tickets WHERE serial_number = $1 AND owner_user_id = $2',
      [serialNumber, fromUserId]
    );

    // БЛОКИРАЙ ако е вече активиран
    if (ticket.is_activated) {
      throw new Error('Ticket is activated and cannot be transferred');
    }

    // Намери или създай recipient user
    let recipient = await db.query(
      'SELECT * FROM users WHERE email = $1', [recipientEmail]
    );
    if (!recipient) {
      recipient = await userAuth.createPendingUser(recipientEmail);
    }

    // Регенерирай security tokens
    const newAuthToken = secureRandom.generate(32);
    const newHmacSecret = secureRandom.generate(32);

    await db.query(`
      UPDATE tickets SET
        owner_user_id = $1,
        auth_token = $2,
        hmac_secret = $3,
        device_hash = NULL,
        transferred_at = NOW()
      WHERE id = $4
    `, [recipient.id, newAuthToken, newHmacSecret, ticket.id]);

    // Log transfer
    await db.query(`
      INSERT INTO transfer_log (ticket_id, from_user_id, to_user_id, transferred_at)
      VALUES ($1, $2, $3, NOW())
    `, [ticket.id, fromUserId, recipient.id]);

    // On-chain transfer ако е claim-нат NFT
    if (ticket.claimed_by) {
      await blockchain.transferClaimOwnership(ticket.claim_hash, recipient.wallet_address);
    }

    // Изпрати emails
    await notifications.sendTicketReceivedEmail(recipient, ticket);
    await notifications.sendTicketTransferredEmail(fromUserId, recipientEmail, ticket);

    return { success: true };
  }
}
```

#### 3.4.3 metadataService.js — Динамична NFT metadata

```javascript
class MetadataService {

  // Генерира 3-page NFT metadata
  async generateEventMetadata(eventId, tokenId) {
    const event = await db.query('SELECT * FROM events WHERE id = $1', [eventId]);
    const ticket = await db.query(
      'SELECT * FROM tickets WHERE event_id = $1 AND token_id = $2',
      [eventId, tokenId]
    );

    // Page 1: Poster (качен от организатора)
    const posterCID = event.poster_ipfs_cid;

    // Page 2: Event Info (генериран)
    const infoImage = await ticketGenerator.generateInfoPage(event, ticket);
    const infoCID = await ipfs.addBuffer(infoImage);

    // Page 3: QR Code (динамичен — animated HTML)
    const qrViewerHTML = this.generateQRViewerHTML(ticket.serial_number, event);
    const qrCID = await ipfs.addBuffer(Buffer.from(qrViewerHTML));

    // Определяме визуалното състояние
    const visualState = await this.getVisualState(ticket);

    const metadata = {
      name: `${event.event_name} — ${ticket.ticket_type_name} #${tokenId}`,
      description: `${event.event_name} | ${event.event_date} | ${event.location}`,
      image: `ipfs://${posterCID}`,
      animation_url: `ipfs://${qrCID}`,   // Animated HTML viewer
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

    // Upload metadata JSON на IPFS
    const metadataCID = await ipfs.addJSON(metadata);
    return metadataCID;
  }

  // Динамичен API endpoint за metadata (fallback ако IPFS е бавен)
  // GET /api/v1/metadata/:eventAddress/:tokenId.json
  async serveMetadata(eventAddress, tokenId) {
    // Проверява cache, после DB, после IPFS
    // Връща актуална metadata с текущо визуално състояние
  }

  // Визуални състояния за "светещите" NFT
  async getVisualState(ticket) {
    if (!ticket.is_activated) {
      return { status: "Ready", color: "#FFFFFF", glow: "none", animation: "none" };
    }

    const lastScan = await db.query(
      'SELECT * FROM scan_logs WHERE ticket_id = $1 ORDER BY scan_time DESC LIMIT 1',
      [ticket.id]
    );

    const event = await db.query('SELECT * FROM events WHERE id = $1', [ticket.event_id]);

    if (event.is_event_ended) {
      return {
        status: "Event Attended ✓",
        color: "#1a1a1a",
        glow: "rainbow",
        animation: "hologram",
        badge: "Collector's Edition"
      };
    }

    if (lastScan?.scan_type === 'exit') {
      return { status: "OUTSIDE", color: "#3B82F6", glow: "blue-pulse", animation: "breathe" };
    }

    // Вътре — зависи от зоната
    const zone = lastScan?.zone || 'general';
    const zoneColors = {
      general:   { status: "INSIDE", color: "#22C55E", glow: "green-pulse" },
      vip:       { status: "VIP ZONE", color: "#F59E0B", glow: "gold-pulse" },
      backstage: { status: "BACKSTAGE", color: "#EF4444", glow: "red-pulse" },
      allaccess: { status: "ALL ACCESS", color: "#8B5CF6", glow: "rainbow-pulse" }
    };

    return { ...zoneColors[zone], animation: "pulse" };
  }
}
```

#### 3.4.4 GembaPay Webhook Handler

```javascript
// routes/webhooks.js
router.post('/gembapay', webhookSignatureVerify, async (req, res) => {
  const { event, data } = req.body;

  switch (event) {
    case 'payment.completed':
      // Fiat или crypto плащане потвърдено
      const { paymentId, eventId, ticketTypeId, buyerEmail, amount } = data;

      // 1. Създай ticket в DB
      const ticket = await ticketService.createTicket(eventId, ticketTypeId, buyerEmail);

      // 2. Mint NFT в ClaimContract чрез backend wallet
      const paymentHash = ethers.keccak256(ethers.toUtf8Bytes(paymentId));
      const tx = await blockchain.mintWithFiatProof(
        ticket.event_contract,
        ticket.owner_address || claimContract.address,
        ticketTypeId,
        paymentHash
      );

      // 3. Upload metadata на IPFS
      const metadataCID = await metadataService.generateEventMetadata(eventId, ticket.token_id);

      // 4. Генерирай claim код
      const claimCode = await claimService.generateClaimCode(ticket);

      // 5. Изпрати email с QR линк + claim код
      await notifications.sendTicketPurchasedEmail(buyerEmail, ticket, claimCode);

      break;

    case 'payment.failed':
      // Логвай failed payment
      break;

    case 'payment.refunded':
      // Организаторът е направил refund
      // Update ticket status, notify buyer
      break;

    case 'merchant.event_creation_paid':
      // Организатор е платил за създаване на събитие
      // Deploy EventContract
      break;
  }

  res.json({ received: true });
});
```

### 3.5 API Endpoints — Пълен списък

```
AUTH (ЗАПАЗЕНИ):
  POST   /api/v1/auth/register        — Email + password registration
  POST   /api/v1/auth/login           — Login → JWT
  POST   /api/v1/auth/google          — Google OAuth
  POST   /api/v1/auth/verify-email    — Email verification
  POST   /api/v1/auth/refresh         — Refresh JWT

EVENTS (МОДИФИЦИРАНИ):
  POST   /api/v1/events               — Създай event (trigger deploy)
  GET    /api/v1/events               — Списък events (публичен)
  GET    /api/v1/events/:id           — Event детайли
  PUT    /api/v1/events/:id           — Update event (organizer only)
  POST   /api/v1/events/:id/cancel    — Отмени event
  POST   /api/v1/events/:id/end       — Приключи event
  GET    /api/v1/events/:id/stats     — Статистики (organizer only)

TICKETS (МОДИФИЦИРАНИ):
  GET    /api/v1/tickets/my           — Моите билети
  GET    /api/v1/tickets/:serial      — Ticket детайли
  GET    /api/v1/tickets/:serial/qr   — Live rotating QR данни
  POST   /api/v1/tickets/:serial/transfer — Прехвърли билет
  GET    /api/v1/tickets/:serial/live — Live ticket page данни

SCANNER (ПРЕНАПИСАН):
  POST   /api/v1/scanner/scan         — Сканирай QR
  POST   /api/v1/scanner/register     — Регистрирай скенер за event
  GET    /api/v1/scanner/:id/stats    — Scanner статистики
  GET    /api/v1/scanner/event/:eventId/live — Live scan feed (WebSocket)

CLAIMS (НОВ):
  POST   /api/v1/claims/claim         — Claim NFT с код
  GET    /api/v1/claims/:serial/status — Claim status

METADATA (НОВ):
  GET    /api/v1/metadata/:address/:tokenId.json — NFT metadata
  GET    /api/v1/metadata/:address/:tokenId/visual — Visual state API

WEBHOOKS (НОВ):
  POST   /api/v1/webhooks/gembapay    — GembaPay payment events

ORGANIZER (НОВ):
  POST   /api/v1/organizer/register   — Регистрирай се като организатор
  GET    /api/v1/organizer/events     — Моите събития
  POST   /api/v1/organizer/upload-poster — Upload poster image
```

---

## 4. DATABASE (PostgreSQL)

### 4.1 Нова схема

```sql
-- ============================================
-- ЗАПАЗЕНИ ТАБЛИЦИ (с модификации)
-- ============================================

-- USERS — махаме custodial wallet полета
CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) UNIQUE NOT NULL,
    email_verified  BOOLEAN DEFAULT false,
    password_hash   VARCHAR(255),
    google_id       VARCHAR(255),
    -- МАХНАТО: encrypted_private_key, encryption_salt, wallet_created_at
    wallet_address  VARCHAR(42),          -- ОПЦИОНАЛНО: ако claim-не NFT
    role            VARCHAR(20) DEFAULT 'user',  -- 'user', 'organizer', 'admin'
    failed_login_attempts INT DEFAULT 0,
    locked_until    TIMESTAMP,
    last_login      TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- МОДИФИЦИРАНИ ТАБЛИЦИ
-- ============================================

-- EVENTS — нова структура
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
    contract_type       VARCHAR(10),       -- 'ERC721' или 'ERC1155'
    chain_id            INT,
    deployment_tx       VARCHAR(66),
    
    -- IPFS
    poster_ipfs_cid     VARCHAR(100),      -- НОВ: Poster image CID
    metadata_base_cid   VARCHAR(100),      -- НОВ: Base metadata folder CID
    
    -- GembaPay
    gembapay_merchant_id VARCHAR(100),     -- НОВ: Организаторов merchant ID
    
    -- Status
    is_active           BOOLEAN DEFAULT true,
    is_canceled         BOOLEAN DEFAULT false,
    is_ended            BOOLEAN DEFAULT false,
    sale_active         BOOLEAN DEFAULT false,
    
    -- Stats
    max_capacity        INT CHECK (max_capacity > 0),
    tickets_sold        INT DEFAULT 0,
    tickets_scanned     INT DEFAULT 0,
    
    -- МАХНАТО: scanner_address, scanner_name, minter_address, encrypted_minter_key
    
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW()
);

-- TICKET TYPES (НОВ — за ERC1155 зони)
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
    color_code      VARCHAR(7),            -- "#22C55E" за визуализация
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- TICKETS — пренаписан
CREATE TABLE tickets (
    id                  SERIAL PRIMARY KEY,
    event_id            INT REFERENCES events(id),
    ticket_type_id      INT REFERENCES ticket_types(id),
    token_id            INT,                -- On-chain token ID
    serial_number       VARCHAR(100) UNIQUE NOT NULL,
    
    -- Собственост
    owner_user_id       INT REFERENCES users(id),
    original_buyer_id   INT REFERENCES users(id),
    
    -- Security tokens (rotating QR)
    auth_token          VARCHAR(64) NOT NULL,     -- НОВ: за live ticket page
    hmac_secret         VARCHAR(64) NOT NULL,     -- НОВ: за HMAC QR подпис
    
    -- Device binding
    device_hash         VARCHAR(64),               -- НОВ: browser fingerprint
    
    -- Lifecycle
    is_activated        BOOLEAN DEFAULT false,     -- НОВ: след първо сканиране
    locked_to_user      INT REFERENCES users(id),  -- НОВ: заключен към кого
    locked_to_device    VARCHAR(64),               -- НОВ: заключен към устройство
    activated_at        TIMESTAMP,                 -- НОВ
    
    -- NFT Claim
    claim_hash          VARCHAR(66),               -- НОВ: hash за claim
    claim_code          VARCHAR(64),               -- НОВ: claim код (криптиран)
    is_claimed          BOOLEAN DEFAULT false,     -- НОВ
    claimed_by          VARCHAR(42),               -- НОВ: wallet address
    claimed_at          TIMESTAMP,                 -- НОВ
    
    -- Visual state (за "светещи" NFT)
    visual_status       VARCHAR(20) DEFAULT 'ready',  -- ready/inside/outside/ended
    visual_color        VARCHAR(7) DEFAULT '#FFFFFF',
    visual_zone         VARCHAR(20) DEFAULT 'general',
    
    -- Payment
    payment_provider    VARCHAR(20),               -- 'gembapay_fiat', 'gembapay_crypto'
    payment_id          VARCHAR(255),              -- GembaPay payment ID
    payment_amount      NUMERIC(10,2),
    payment_currency    VARCHAR(10),
    
    -- IPFS
    metadata_ipfs_cid   VARCHAR(100),             -- НОВ: per-ticket metadata CID
    
    -- МАХНАТО: qr_code (base64 в DB), encrypted_private_key, mint_tx
    -- mint_tx се пази в blockchain events, не в DB
    
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- НОВИ ТАБЛИЦИ
-- ============================================

-- TRANSFER LOG
CREATE TABLE transfer_log (
    id              SERIAL PRIMARY KEY,
    ticket_id       INT REFERENCES tickets(id),
    from_user_id    INT REFERENCES users(id),
    to_user_id      INT REFERENCES users(id),
    transfer_type   VARCHAR(20),           -- 'platform', 'onchain'
    tx_hash         VARCHAR(66),           -- Ако е on-chain
    transferred_at  TIMESTAMP DEFAULT NOW()
);

-- SCAN LOGS (подобрен)
CREATE TABLE scan_logs (
    id              SERIAL PRIMARY KEY,
    ticket_id       INT REFERENCES tickets(id),
    scanner_id      INT REFERENCES scanners(id),
    scan_type       VARCHAR(10) NOT NULL,  -- 'entry', 'exit'
    scan_result     VARCHAR(20) NOT NULL,  -- 'success', 'denied', 'error'
    deny_reason     VARCHAR(100),          -- Ако denied
    zone            VARCHAR(20),           -- Коя зона
    device_hash     VARCHAR(64),           -- Device който е показал QR
    scan_time       TIMESTAMP DEFAULT NOW()
);

-- SCANNERS (подобрен)
CREATE TABLE scanners (
    id                  SERIAL PRIMARY KEY,
    event_id            INT REFERENCES events(id),
    name                VARCHAR(255) NOT NULL,
    location            VARCHAR(255),
    operator_user_id    INT REFERENCES users(id),  -- НОВ: логнат потребител
    zone_token_type     INT,                        -- НОВ: за коя зона сканира
    is_active           BOOLEAN DEFAULT true,
    scanner_secret      VARCHAR(64),                -- НОВ: за scanner auth
    created_at          TIMESTAMP DEFAULT NOW(),
    updated_at          TIMESTAMP DEFAULT NOW()
);

-- ORGANIZER PROFILES (НОВ)
CREATE TABLE organizer_profiles (
    id                  SERIAL PRIMARY KEY,
    user_id             INT UNIQUE REFERENCES users(id),
    company_name        VARCHAR(255),
    gembapay_merchant_id VARCHAR(100),
    stripe_account_id   VARCHAR(100),
    is_verified         BOOLEAN DEFAULT false,
    reputation_score    INT DEFAULT 100,       -- 0-100, намалява при проблеми
    events_created      INT DEFAULT 0,
    events_canceled     INT DEFAULT 0,
    total_tickets_sold  INT DEFAULT 0,
    created_at          TIMESTAMP DEFAULT NOW()
);

-- REFUND TRACKING (НОВ)
CREATE TABLE refund_tracking (
    id              SERIAL PRIMARY KEY,
    event_id        INT REFERENCES events(id),
    ticket_id       INT REFERENCES tickets(id),
    payment_id      VARCHAR(255),           -- Original GembaPay payment ID
    refund_amount   NUMERIC(10,2),
    refund_currency VARCHAR(10),
    payment_type    VARCHAR(20),            -- 'fiat' или 'crypto'
    refund_status   VARCHAR(20) DEFAULT 'pending',  -- pending/completed/overdue
    refund_deadline TIMESTAMP,              -- Крайна дата за refund
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

### 5.1 Структура

```
src/
├── pages/
│   ├── HomePage.jsx               — Landing page
│   ├── EventsPage.jsx             — Browse events
│   ├── EventDetailPage.jsx        — Single event + buy widget
│   ├── LiveTicketPage.jsx         — 🆕 Live rotating QR (auth required)
│   ├── ClaimNFTPage.jsx           — 🆕 Claim NFT с код + MetaMask
│   ├── MyTicketsPage.jsx          — Моите билети (list)
│   ├── NFTViewerPage.jsx          — 🆕 3-page NFT viewer
│   └── organizer/
│       ├── OrganizerDashboard.jsx — Manage events
│       ├── CreateEventPage.jsx    — Create event form
│       ├── EventStatsPage.jsx     — Real-time scan stats
│       └── ScannerSetupPage.jsx   — Configure scanners
├── components/
│   ├── tickets/
│   │   ├── TicketCard.jsx         — Ticket preview card
│   │   ├── RotatingQR.jsx         — 🆕 QR с 30-сек ротация
│   │   ├── TransferModal.jsx      — 🆕 Прехвърли билет
│   │   └── TicketStatusBadge.jsx  — Visual status indicator
│   ├── nft/
│   │   ├── NFTViewer.jsx          — 🆕 3-page swipe viewer
│   │   ├── AnimatedQR.jsx         — 🆕 Canvas/WebGL animated QR
│   │   ├── GlowEffect.jsx        — 🆕 Цветови glow ефекти
│   │   └── ClaimButton.jsx        — 🆕 Claim NFT button + flow
│   ├── payment/
│   │   └── GembaPayWidget.jsx     — 🆕 GembaPay payment integration
│   ├── scanner/
│   │   ├── ScannerApp.jsx         — 🆕 PWA Scanner (camera + verify)
│   │   ├── ScanResult.jsx         — 🆕 Зелен/червен екран + звук
│   │   └── LiveFeed.jsx           — 🆕 Real-time scan dashboard
│   └── common/
│       ├── Header.jsx
│       ├── Footer.jsx
│       └── WalletConnect.jsx      — Optional MetaMask connect
├── hooks/
│   ├── useRotatingQR.js           — 🆕 30-sec QR rotation hook
│   ├── useWebSocket.js            — 🆕 Real-time updates
│   └── useGembaPay.js             — 🆕 GembaPay SDK hook
└── services/
    ├── api.js                     — Backend API client
    └── web3.js                    — Optional Web3 (само за claim)
```

### 5.2 Ключови компоненти

#### NFTViewer.jsx — 3-page swipe viewer

```
┌────────────────────────────┐
│  ← Swipe →                 │
│                             │
│  ┌───────────────────────┐ │
│  │                       │ │
│  │    [PAGE 1: POSTER]   │ │  ← Организаторът е качил
│  │    1000x1000          │ │
│  │    Чист дизайн        │ │
│  │                       │ │
│  └───────────────────────┘ │
│                             │
│      ● ○ ○    1/3          │
│                             │
│  [Claim as NFT]  [Share]   │
└────────────────────────────┘

┌────────────────────────────┐
│  ← Swipe →                 │
│                             │
│  ┌───────────────────────┐ │
│  │  Summer Festival 2025 │ │
│  │  ─────────────────    │ │
│  │  📅 15 August 2025    │ │
│  │  ⏰ 19:00             │ │  ← Генерирана от системата
│  │  📍 Sea Garden, Varna │ │
│  │  🎫 VIP Access        │ │
│  │  #EVT-2025-0042       │ │
│  │                       │ │
│  │  ─────────────────    │ │
│  │  💎 tickets.gemba.bg  │ │
│  └───────────────────────┘ │
│                             │
│      ○ ● ○    2/3          │
└────────────────────────────┘

┌────────────────────────────┐
│  ← Swipe →                 │
│                             │
│  ┌───────────────────────┐ │
│  │                       │ │
│  │   ┌───────────────┐   │ │
│  │   │ ████████████  │   │ │
│  │   │ ██ QR CODE ██ │   │ │  ← Animated, пулсира
│  │   │ ████████████  │   │ │     Цвят зависи от status
│  │   └───────────────┘   │ │
│  │                       │ │
│  │   Status: ● INSIDE    │ │
│  │   Zone: VIP           │ │
│  │   Scans: 2            │ │
│  │                       │ │
│  └───────────────────────┘ │
│                             │
│      ○ ○ ●    3/3          │
└────────────────────────────┘
```

#### ScannerApp.jsx — PWA Scanner

```
Standalone PWA (Progressive Web App):
  → Инсталира се на телефона на скенер оператора
  → Камера достъп за QR четене
  → Работи fullscreen като native app
  → Audio feedback: beep за success, buzz за denied

Flow:
  1. Оператор логва се (email + password)
  2. Избира event + зона за сканиране
  3. Камерата се активира
  4. Чете QR → POST /api/v1/scanner/scan
  5. Резултат:
     ✅ Зелен екран + "ВЛЕЗ" + beep sound
     ❌ Червен екран + причина + buzz sound
  6. Auto-reset за следващ scan (2 сек)

Offline mode:
  → Cache на ticket serial numbers при стартиране
  → При липса на internet: проверка срещу cache
  → При възстановяване: sync pending scans
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

Домейни:
  tickets.gembapay.com    — Frontend
  api.tickets.gembapay.com — Backend API
  ipfs.gembapay.com       — IPFS Gateway
  scanner.gembapay.com    — Scanner PWA
```

### 6.2 IPFS Setup

```bash
# На всеки VPS:
ipfs init
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080

# Peer двата node-а:
ipfs swarm connect /ip4/<VPS2_IP>/tcp/4001/p2p/<VPS2_PEER_ID>

# Auto-pin между node-ите:
# Всеки upload → pin на primary → replicate на secondary
```

---

## 7. GEMBAPAY ИНТЕГРАЦИЯ

### 7.1 Организатор Onboarding

```
1. Организатор се регистрира в ticket платформата
2. Натиска "Стани организатор"
3. Пренасочване към GembaPay merchant onboarding:
   → Stripe Connect onboarding (за карти)
   → Избор на crypto мрежи и монети
   → KYC (ако е нужно за Stripe)
4. Webhook: merchant.onboarded → платформата записва merchant_id
5. Организаторът може да създава събития
```

### 7.2 Payment Flow

```
TICKET PURCHASE:
  1. Buyer → EventDetailPage → избира билет → [Buy]
  2. GembaPay Widget отваря се:
     → Карта (Visa/MC) → Stripe Connect → директно на организатора
     → Crypto (ETH/BNB/MATIC/USDT) → GembaPay Protocol → директно на организатора
  3. GembaPay автоматично split: 95% → организатор, 5% → GEMBA EOOD
  4. Webhook → backend → mint NFT → email билет

EVENT CREATION:
  1. Организатор → CreateEventPage → попълва форма
  2. GembaPay Widget: платформена такса ($5-10)
  3. Webhook → backend → deploy EventContract → IPFS upload
  4. Организаторът вижда: "Събитието е създадено!"
```

---

## 8. ФАЗИ НА РАЗРАБОТКА

### ФАЗА 1: Smart Contracts (2-3 седмици)

```
Седмица 1:
  □ EventContract721 v2 (buyTicketCrypto, mintWithFiatProof)
  □ EventContract1155 v2 (ticket types, зони)
  □ ClaimContract (lock, claim, renounce)
  □ Unit tests за всеки контракт

Седмица 2:
  □ FactoryFacet v2 (Diamond proxy, event deployment)
  □ TreasuryFacet (fee collection)
  □ Integration tests (full flow)
  □ Slither + Mythril security audit

Седмица 3:
  □ Testnet deploy (Polygon Amoy)
  □ Gas optimization
  □ Edge case testing
  □ Fix audit findings
```

### ФАЗА 2: Backend (2-3 седмици)

```
Седмица 4:
  □ Нова DB schema + migration от v1
  □ scannerService.js (rotating QR, HMAC, device binding)
  □ transferService.js (ticket transfers)
  □ claimService.js (claim code generation)

Седмица 5:
  □ metadataService.js (3-page metadata, IPFS upload)
  □ GembaPay webhook handler
  □ Event creation flow (deploy + IPFS)
  □ Blockchain service v2 (contract interactions)

Седмица 6:
  □ API endpoints (всички routes)
  □ WebSocket за real-time scan feed
  □ Email templates (claim код, ticket, transfer)
  □ Integration testing
```

### ФАЗА 3: Frontend (2-3 седмици)

```
Седмица 7:
  □ Event pages (browse, detail, buy)
  □ GembaPay widget интеграция
  □ Live Ticket Page (rotating QR)
  □ My Tickets page

Седмица 8:
  □ NFT Viewer (3-page swipe, animated QR, glow effects)
  □ Claim NFT page (MetaMask connect + claim flow)
  □ Transfer modal
  □ Organizer dashboard (create event, stats)

Седмица 9:
  □ Scanner PWA (камера, QR четене, звуци)
  □ Live scan feed dashboard
  □ Mobile responsive polish
  □ Apple/Google Wallet integration (stretch goal)
```

### ФАЗА 4: Infrastructure + Launch (1-2 седмици)

```
Седмица 10:
  □ IPFS node setup (primary + fallback)
  □ Production deploy на Polygon mainnet
  □ Cloudflare LB configuration
  □ SSL, DNS, security headers

Седмица 11:
  □ End-to-end testing (full flow)
  □ Load testing (concurrent scans)
  □ Security review
  □ Soft launch с тестово събитие
```

---

## 9. SECURITY CHECKLIST

```
Smart Contracts:
  □ ReentrancyGuard на всички payable функции
  □ Check-Effects-Interactions pattern
  □ Access control: onlyOwner, onlyPlatform
  □ Integer overflow protection (Solidity 0.8+)
  □ Slither audit — 0 high/critical
  □ Mythril symbolic execution
  □ Manual review на payment splitting

Backend:
  □ JWT с expiration + refresh tokens
  □ Rate limiting на всички endpoints
  □ HMAC verification за QR
  □ Input validation (express-validator)
  □ SQL injection prevention (parameterized queries)
  □ XSS prevention (CSP headers)
  □ CORS configuration
  □ Webhook signature verification (GembaPay)
  □ Device fingerprinting за ticket binding

Frontend:
  □ No sensitive data в localStorage
  □ CSP meta tags
  □ XSS sanitization
  □ Secure WebSocket connections
  □ Camera permissions handling (Scanner PWA)

Infrastructure:
  □ PostgreSQL encrypted connections
  □ Redis password authentication
  □ IPFS API не е публично достъпен
  □ Firewall rules (только 80, 443)
  □ Automatic security updates
  □ Backup strategy (daily DB + IPFS pins)
```

---

## 10. ОБОБЩЕНИЕ

### Какво постигаме

| Характеристика | v1 (сега) | v2 (план) |
|----------------|-----------|-----------|
| Custody | ❌ Custodial (PK + fiat) | ✅ Zero custody |
| Blockchain знания | ❌ Нужни | ✅ Не са нужни |
| Плащания | ❌ Директен Stripe | ✅ GembaPay (non-custodial) |
| NFT Metadata | ❌ Няма | ✅ IPFS + dynamic |
| Scanner | ❌ Няма app | ✅ PWA + rotating QR |
| Anti-fraud | ❌ Минимален | ✅ HMAC + device bind + lock |
| Solidity LOC | ~4150 | ~1280 |
| Backend LOC | ~12700 | ~8000 (est.) |
| Регулация | ❌ CASP нужен | ✅ Чист |
| Refunds | ❌ Няма | ✅ Tracking + reputation |
| NFT Experience | ❌ Празни NFT-та | ✅ 3-page animated |

### Времева рамка

- **Общо:** 10-11 седмици
- **MVP (contracts + backend + basic frontend):** 6-7 седмици
- **Full launch:** 10-11 седмици

### Рискове

| Риск | Вероятност | Митигация |
|------|-----------|-----------|
| GembaPay API промени | Ниска | Абстракционен слой, лесна подмяна |
| IPFS node downtime | Средна | Dual-node + Cloudflare cache |
| Gas spike на Polygon | Ниска | Batch minting, L2 fallback |
| Scanner offline | Средна | Offline cache + sync |
| Организатор не връща refund | Средна | Reputation система + бан |
