// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IClaimContract.sol";

/// @title EventContract721 — ERC721 ticket contract with embedded payment logic
/// @notice Cloned per-event via EIP-1167. Non-custodial: funds split immediately.
///         Platform signer pays gas for fiat minting and ticket activation.
/// @dev Template contract — do NOT call initialize() on the template itself.
contract EventContract721 is
    Initializable,
    ERC721Upgradeable,
    ReentrancyGuardUpgradeable
{
    // =========================================================================
    // ERRORS
    // =========================================================================

    error NotOwner();
    error NotPlatform();
    error SaleNotActive();
    error EventCanceled();
    error EventEnded();
    error EventNotCanceled();
    error EventAlreadyEnded();
    error InsufficientPayment();
    error MaxSupplyReached();
    error TransferLocked();
    error AlreadyActivated();
    error PaymentFailed();
    error AlreadyInitialized();

    // =========================================================================
    // EVENTS
    // =========================================================================

    event TicketPurchased(
        address indexed buyer,
        uint256 indexed tokenId,
        uint256 price,
        string paymentType
    );
    event FiatPaymentRecorded(bytes32 indexed paymentHash, uint256 indexed tokenId);
    event TicketActivated(uint256 indexed tokenId, address indexed holder);
    event EventCanceledEvent(uint256 timestamp);
    event EventEndedEvent(uint256 timestamp);
    event SaleToggled(bool active);
    event BaseURIUpdated(string newURI);

    // =========================================================================
    // STATE
    // =========================================================================

    // Addresses
    address public owner;
    address public platform;
    address public treasury;
    address public claimContract;

    // Event metadata
    string public eventName;
    string private _baseTokenURI;

    // Ticket config
    uint256 public maxSupply;
    uint256 public priceInNative;
    uint256 public platformFeeBps; // 500 = 5%

    // Counters
    uint256 public totalMinted;

    // Status
    bool public saleActive;
    bool public isEventCanceled;
    bool public isEventEnded;

    // Ticket lifecycle
    mapping(uint256 => bool) public ticketActivated;
    mapping(uint256 => address) public activatedBy;
    mapping(uint256 => bytes32) public ticketClaimHash;

    // =========================================================================
    // INITIALIZER (replaces constructor for clones)
    // =========================================================================

    /// @notice Initialize the event contract. Called once by PlatformRegistry after cloning.
    /// @param _eventName Human-readable event name
    /// @param _baseURI IPFS base URI for metadata (e.g. "ipfs://Qm.../")
    /// @param _maxSupply Maximum number of tickets
    /// @param _priceInNative Ticket price in native token (wei)
    /// @param _platformFeeBps Platform fee in basis points (500 = 5%)
    /// @param _owner Organizer address (receives ticket revenue)
    /// @param _platform Platform signer address (can mint fiat tickets, activate)
    /// @param _treasury Platform treasury address (receives fees)
    /// @param _claimContract ClaimContract address (holds NFTs until claimed)
    function initialize(
        string calldata _eventName,
        string calldata _baseURI,
        uint256 _maxSupply,
        uint256 _priceInNative,
        uint256 _platformFeeBps,
        address _owner,
        address _platform,
        address _treasury,
        address _claimContract
    ) external initializer {
        __ERC721_init(_eventName, "GTKT");
        __ReentrancyGuard_init();

        eventName = _eventName;
        _baseTokenURI = _baseURI;
        maxSupply = _maxSupply;
        priceInNative = _priceInNative;
        platformFeeBps = _platformFeeBps;
        owner = _owner;
        platform = _platform;
        treasury = _treasury;
        claimContract = _claimContract;
        saleActive = false;
    }

    // =========================================================================
    // CRYPTO PAYMENT — Direct purchase with native token
    // =========================================================================

    /// @notice Buy a ticket with native token (ETH/MATIC/BNB).
    ///         Funds are split IMMEDIATELY: organizer + treasury. Non-custodial.
    function buyTicketCrypto() external payable nonReentrant {
        if (!saleActive) revert SaleNotActive();
        if (isEventCanceled) revert EventCanceled();
        if (isEventEnded) revert EventEnded();
        if (msg.value < priceInNative) revert InsufficientPayment();
        if (totalMinted >= maxSupply) revert MaxSupplyReached();

        // Calculate split
        uint256 fee = (priceInNative * platformFeeBps) / 10000;
        uint256 organizerAmount = priceInNative - fee;

        // Effects: mint before external calls
        uint256 tokenId = _mintTicket(msg.sender);

        // Interactions: send funds (Check-Effects-Interactions)
        (bool sentOrganizer,) = owner.call{value: organizerAmount}("");
        if (!sentOrganizer) revert PaymentFailed();

        (bool sentTreasury,) = treasury.call{value: fee}("");
        if (!sentTreasury) revert PaymentFailed();

        // Refund excess
        uint256 excess = msg.value - priceInNative;
        if (excess > 0) {
            (bool refunded,) = msg.sender.call{value: excess}("");
            if (!refunded) revert PaymentFailed();
        }

        emit TicketPurchased(msg.sender, tokenId, priceInNative, "crypto");
    }

    // =========================================================================
    // FIAT PAYMENT — Platform signer mints after GembaPay webhook confirmation
    // =========================================================================

    /// @notice Mint a ticket for a fiat payment. Called by platform signer.
    ///         Fiat funds already routed to organizer via GembaPay/Stripe Connect.
    /// @param _buyer Buyer address (or zero if no wallet — uses ClaimContract)
    /// @param _paymentHash Keccak256 of GembaPay payment ID (for on-chain proof)
    function mintWithFiatProof(
        address _buyer,
        bytes32 _paymentHash
    ) external onlyPlatform nonReentrant {
        if (!saleActive) revert SaleNotActive();
        if (isEventCanceled) revert EventCanceled();
        if (totalMinted >= maxSupply) revert MaxSupplyReached();

        uint256 tokenId = _mintTicket(_buyer);

        emit TicketPurchased(_buyer, tokenId, 0, "fiat");
        emit FiatPaymentRecorded(_paymentHash, tokenId);
    }

    // =========================================================================
    // INTERNAL MINT — Always mints to ClaimContract
    // =========================================================================

    /// @dev Mints NFT to ClaimContract and registers the claim.
    ///      The NFT stays in ClaimContract until the user claims it (optional).
    function _mintTicket(address _buyer) internal returns (uint256 tokenId) {
        tokenId = ++totalMinted;

        // Generate claim hash from deterministic but unpredictable data
        bytes32 claimHash = keccak256(abi.encodePacked(
            address(this),
            tokenId,
            _buyer,
            block.timestamp,
            block.prevrandao
        ));
        ticketClaimHash[tokenId] = claimHash;

        // Mint to ClaimContract
        _safeMint(claimContract, tokenId);

        // Register claim in ClaimContract
        IClaimContract(claimContract).lockForClaim(claimHash, tokenId, _buyer);
    }

    // =========================================================================
    // TICKET LIFECYCLE
    // =========================================================================

    /// @notice Activate a ticket on first scan. Locks transfers permanently.
    ///         Called by platform signer when scanner verifies first entry.
    /// @param _tokenId The token ID to activate
    function activateTicket(uint256 _tokenId) external onlyPlatform {
        if (ticketActivated[_tokenId]) revert AlreadyActivated();

        ticketActivated[_tokenId] = true;
        activatedBy[_tokenId] = _ownerOf(_tokenId);

        emit TicketActivated(_tokenId, _ownerOf(_tokenId));
    }

    /// @dev Override _update to enforce transfer restrictions.
    ///      OZ 5.x replaces _beforeTokenTransfer with _update.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);

        // Minting (from == 0) is always allowed
        if (from != address(0)) {
            // After event ends: transfers unlocked (collectible value)
            if (!isEventEnded) {
                // After activation: transfers locked
                if (ticketActivated[tokenId]) revert TransferLocked();
            }
        }

        return super._update(to, tokenId, auth);
    }

    // =========================================================================
    // EVENT MANAGEMENT (organizer only)
    // =========================================================================

    /// @notice Cancel the event. Stops sales. Refunds are organizer's responsibility.
    function cancelEvent() external onlyOwner {
        if (isEventEnded) revert EventAlreadyEnded();
        isEventCanceled = true;
        saleActive = false;
        emit EventCanceledEvent(block.timestamp);
    }

    /// @notice End the event. Unlocks NFT transfers for secondary market.
    function endEvent() external onlyOwner {
        if (isEventCanceled) revert EventCanceled();
        isEventEnded = true;
        saleActive = false;
        emit EventEndedEvent(block.timestamp);
    }

    /// @notice Toggle ticket sales on/off.
    function toggleSale() external onlyOwner {
        if (isEventCanceled) revert EventCanceled();
        if (isEventEnded) revert EventEnded();
        saleActive = !saleActive;
        emit SaleToggled(saleActive);
    }

    /// @notice Update the base token URI (IPFS).
    /// @param _newBaseURI New IPFS base URI
    function setBaseURI(string calldata _newBaseURI) external onlyOwner {
        _baseTokenURI = _newBaseURI;
        emit BaseURIUpdated(_newBaseURI);
    }

    // =========================================================================
    // PLATFORM MANAGEMENT
    // =========================================================================

    /// @notice Update the platform signer address. Called by current platform.
    /// @param _newPlatform New platform signer address
    function setPlatform(address _newPlatform) external onlyPlatform {
        platform = _newPlatform;
    }

    // =========================================================================
    // VIEW FUNCTIONS
    // =========================================================================

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    /// @notice Get ticket info for scanner verification
    function getTicketInfo(uint256 _tokenId)
        external
        view
        returns (
            bool activated,
            address holder,
            bytes32 claimHash
        )
    {
        activated = ticketActivated[_tokenId];
        holder = activatedBy[_tokenId];
        claimHash = ticketClaimHash[_tokenId];
    }

    /// @notice Get event summary
    function getEventInfo()
        external
        view
        returns (
            string memory name,
            uint256 supply,
            uint256 minted,
            uint256 price,
            bool sale,
            bool canceled,
            bool ended
        )
    {
        name = eventName;
        supply = maxSupply;
        minted = totalMinted;
        price = priceInNative;
        sale = saleActive;
        canceled = isEventCanceled;
        ended = isEventEnded;
    }

    // =========================================================================
    // MODIFIERS
    // =========================================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyPlatform() {
        if (msg.sender != platform) revert NotPlatform();
        _;
    }
}
