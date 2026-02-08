// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IClaimContract.sol";

/// @title EventContract1155 — ERC1155 ticket contract with zone-based ticket types
/// @notice Each token ID is a unique ticket. ticketType maps each token to its tier.
///         Supports multiple tiers: General (0), VIP (1), Backstage (2), All Access (3).
/// @dev Cloned per-event via EIP-1167. Uses unique token IDs (balance = 1 each).
contract EventContract1155 is
    Initializable,
    ERC1155Upgradeable,
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
    error EventAlreadyEnded();
    error InsufficientPayment();
    error MaxSupplyReached();
    error TypeMaxSupplyReached();
    error TransferLocked();
    error AlreadyActivated();
    error PaymentFailed();
    error InvalidTicketType();
    error TicketTypeExists();

    // =========================================================================
    // EVENTS
    // =========================================================================

    event TicketPurchased(
        address indexed buyer,
        uint256 indexed tokenId,
        uint256 ticketTypeId,
        uint256 price,
        string paymentType
    );
    event FiatPaymentRecorded(bytes32 indexed paymentHash, uint256 indexed tokenId);
    event TicketActivated(uint256 indexed tokenId, address indexed holder);
    event TicketTypeCreated(
        uint256 indexed typeId,
        string name,
        uint256 price,
        uint256 maxSupply,
        uint256 zoneLevel
    );
    event EventCanceledEvent(uint256 timestamp);
    event EventEndedEvent(uint256 timestamp);
    event SaleToggled(bool active);

    // =========================================================================
    // STRUCTS
    // =========================================================================

    struct TicketType {
        string name;       // "General", "VIP", "Backstage", "All Access"
        uint256 price;     // Price in native token (wei)
        uint256 maxSupply; // Max tickets of this type
        uint256 minted;    // Tickets minted of this type
        uint256 zoneLevel; // 0=General, 1=VIP, 2=Backstage, 3=AllAccess
        bool active;       // Can be purchased
    }

    // =========================================================================
    // STATE
    // =========================================================================

    address public owner;
    address public platform;
    address public treasury;
    address public claimContract;

    string public eventName;
    uint256 public platformFeeBps;
    uint256 public totalMinted;
    uint256 public maxSupply; // Global cap across all types

    bool public saleActive;
    bool public isEventCanceled;
    bool public isEventEnded;

    // Ticket types: typeId => TicketType
    mapping(uint256 => TicketType) public ticketTypes;
    uint256 public ticketTypeCount;

    // Per-ticket data: tokenId => data
    mapping(uint256 => uint256) public ticketType;     // tokenId => typeId
    mapping(uint256 => bool) public ticketActivated;
    mapping(uint256 => address) public activatedBy;
    mapping(uint256 => bytes32) public ticketClaimHash;

    // =========================================================================
    // INITIALIZER
    // =========================================================================

    /// @notice Initialize the event contract. Called once by PlatformRegistry.
    /// @param _eventName Human-readable event name
    /// @param _uri Base URI for metadata
    /// @param _maxSupply Global maximum tickets across all types
    /// @param _platformFeeBps Platform fee in basis points (500 = 5%)
    /// @param _owner Organizer address
    /// @param _platform Platform signer address
    /// @param _treasury Platform treasury address
    /// @param _claimContract ClaimContract address
    function initialize(
        string calldata _eventName,
        string calldata _uri,
        uint256 _maxSupply,
        uint256 _platformFeeBps,
        address _owner,
        address _platform,
        address _treasury,
        address _claimContract
    ) external initializer {
        __ERC1155_init(_uri);
        __ReentrancyGuard_init();

        eventName = _eventName;
        maxSupply = _maxSupply;
        platformFeeBps = _platformFeeBps;
        owner = _owner;
        platform = _platform;
        treasury = _treasury;
        claimContract = _claimContract;
        saleActive = false;
    }

    // =========================================================================
    // TICKET TYPE MANAGEMENT (organizer)
    // =========================================================================

    /// @notice Create a ticket type (zone/tier).
    /// @param _typeId Unique type identifier (0=General, 1=VIP, etc.)
    /// @param _name Display name
    /// @param _price Price in native token (wei)
    /// @param _typeMaxSupply Maximum tickets of this type
    /// @param _zoneLevel Zone access level (higher = more access)
    function createTicketType(
        uint256 _typeId,
        string calldata _name,
        uint256 _price,
        uint256 _typeMaxSupply,
        uint256 _zoneLevel
    ) external onlyOwner {
        if (ticketTypes[_typeId].maxSupply != 0) revert TicketTypeExists();

        ticketTypes[_typeId] = TicketType({
            name: _name,
            price: _price,
            maxSupply: _typeMaxSupply,
            minted: 0,
            zoneLevel: _zoneLevel,
            active: true
        });
        ticketTypeCount++;

        emit TicketTypeCreated(_typeId, _name, _price, _typeMaxSupply, _zoneLevel);
    }

    /// @notice Toggle a ticket type active/inactive
    function toggleTicketType(uint256 _typeId) external onlyOwner {
        if (ticketTypes[_typeId].maxSupply == 0) revert InvalidTicketType();
        ticketTypes[_typeId].active = !ticketTypes[_typeId].active;
    }

    // =========================================================================
    // CRYPTO PAYMENT
    // =========================================================================

    /// @notice Buy a ticket with native token. Specify which ticket type.
    /// @param _typeId Ticket type to purchase
    function buyTicketCrypto(uint256 _typeId) external payable nonReentrant {
        if (!saleActive) revert SaleNotActive();
        if (isEventCanceled) revert EventCanceled();
        if (isEventEnded) revert EventEnded();

        TicketType storage tt = ticketTypes[_typeId];
        if (tt.maxSupply == 0 || !tt.active) revert InvalidTicketType();
        if (tt.minted >= tt.maxSupply) revert TypeMaxSupplyReached();
        if (totalMinted >= maxSupply) revert MaxSupplyReached();
        if (msg.value < tt.price) revert InsufficientPayment();

        // Calculate split
        uint256 fee = (tt.price * platformFeeBps) / 10000;
        uint256 organizerAmount = tt.price - fee;

        // Effects
        uint256 tokenId = _mintTicket(msg.sender, _typeId);

        // Interactions
        (bool sentOrganizer,) = owner.call{value: organizerAmount}("");
        if (!sentOrganizer) revert PaymentFailed();

        (bool sentTreasury,) = treasury.call{value: fee}("");
        if (!sentTreasury) revert PaymentFailed();

        uint256 excess = msg.value - tt.price;
        if (excess > 0) {
            (bool refunded,) = msg.sender.call{value: excess}("");
            if (!refunded) revert PaymentFailed();
        }

        emit TicketPurchased(msg.sender, tokenId, _typeId, tt.price, "crypto");
    }

    // =========================================================================
    // FIAT PAYMENT
    // =========================================================================

    /// @notice Mint a ticket for fiat payment. Called by platform signer.
    /// @param _buyer Buyer address
    /// @param _typeId Ticket type
    /// @param _paymentHash GembaPay payment ID hash
    function mintWithFiatProof(
        address _buyer,
        uint256 _typeId,
        bytes32 _paymentHash
    ) external onlyPlatform nonReentrant {
        if (!saleActive) revert SaleNotActive();
        if (isEventCanceled) revert EventCanceled();

        TicketType storage tt = ticketTypes[_typeId];
        if (tt.maxSupply == 0) revert InvalidTicketType();
        if (tt.minted >= tt.maxSupply) revert TypeMaxSupplyReached();
        if (totalMinted >= maxSupply) revert MaxSupplyReached();

        uint256 tokenId = _mintTicket(_buyer, _typeId);

        emit TicketPurchased(_buyer, tokenId, _typeId, 0, "fiat");
        emit FiatPaymentRecorded(_paymentHash, tokenId);
    }

    // =========================================================================
    // INTERNAL MINT
    // =========================================================================

    function _mintTicket(address _buyer, uint256 _typeId) internal returns (uint256 tokenId) {
        tokenId = ++totalMinted;
        ticketTypes[_typeId].minted++;
        ticketType[tokenId] = _typeId;

        bytes32 claimHash = keccak256(abi.encodePacked(
            address(this),
            tokenId,
            _buyer,
            block.timestamp,
            block.prevrandao
        ));
        ticketClaimHash[tokenId] = claimHash;

        // Mint to ClaimContract (amount = 1, each ticket is unique)
        _mint(claimContract, tokenId, 1, "");

        // Register claim
        IClaimContract(claimContract).lockForClaimERC1155(claimHash, tokenId, _buyer);
    }

    // =========================================================================
    // TICKET LIFECYCLE
    // =========================================================================

    /// @notice Activate a ticket on first scan. Locks transfers.
    function activateTicket(uint256 _tokenId) external onlyPlatform {
        if (ticketActivated[_tokenId]) revert AlreadyActivated();

        ticketActivated[_tokenId] = true;

        // For ERC1155, find the owner (whoever has balance of this tokenId)
        // Since balance is always 1, the holder is whoever has it
        activatedBy[_tokenId] = _getHolder(_tokenId);

        emit TicketActivated(_tokenId, activatedBy[_tokenId]);
    }

    /// @dev Override _update to enforce transfer restrictions.
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        // Check each token in the batch
        if (from != address(0)) {
            for (uint256 i = 0; i < ids.length; i++) {
                if (!isEventEnded && ticketActivated[ids[i]]) {
                    revert TransferLocked();
                }
            }
        }

        super._update(from, to, ids, values);
    }

    // =========================================================================
    // EVENT MANAGEMENT
    // =========================================================================

    function cancelEvent() external onlyOwner {
        if (isEventEnded) revert EventAlreadyEnded();
        isEventCanceled = true;
        saleActive = false;
        emit EventCanceledEvent(block.timestamp);
    }

    function endEvent() external onlyOwner {
        if (isEventCanceled) revert EventCanceled();
        isEventEnded = true;
        saleActive = false;
        emit EventEndedEvent(block.timestamp);
    }

    function toggleSale() external onlyOwner {
        if (isEventCanceled) revert EventCanceled();
        if (isEventEnded) revert EventEnded();
        saleActive = !saleActive;
        emit SaleToggled(saleActive);
    }

    function setURI(string calldata _newURI) external onlyOwner {
        _setURI(_newURI);
    }

    function setPlatform(address _newPlatform) external onlyPlatform {
        platform = _newPlatform;
    }

    // =========================================================================
    // VIEW FUNCTIONS
    // =========================================================================

    /// @notice Get ticket info for scanner
    function getTicketInfo(uint256 _tokenId)
        external
        view
        returns (
            bool activated,
            address holder,
            uint256 typeId,
            uint256 zoneLevel,
            bytes32 claimHash
        )
    {
        activated = ticketActivated[_tokenId];
        holder = activatedBy[_tokenId];
        typeId = ticketType[_tokenId];
        zoneLevel = ticketTypes[typeId].zoneLevel;
        claimHash = ticketClaimHash[_tokenId];
    }

    /// @notice Get ticket type details
    function getTicketTypeInfo(uint256 _typeId)
        external
        view
        returns (
            string memory name,
            uint256 price,
            uint256 typeMaxSupply,
            uint256 minted,
            uint256 zoneLevel,
            bool active
        )
    {
        TicketType storage tt = ticketTypes[_typeId];
        name = tt.name;
        price = tt.price;
        typeMaxSupply = tt.maxSupply;
        minted = tt.minted;
        zoneLevel = tt.zoneLevel;
        active = tt.active;
    }

    function getEventInfo()
        external
        view
        returns (
            string memory name,
            uint256 supply,
            uint256 minted,
            uint256 types,
            bool sale,
            bool canceled,
            bool ended
        )
    {
        name = eventName;
        supply = maxSupply;
        minted = totalMinted;
        types = ticketTypeCount;
        sale = saleActive;
        canceled = isEventCanceled;
        ended = isEventEnded;
    }

    /// @dev Find holder of a specific tokenId (balance = 1).
    ///      ClaimContract or a user wallet.
    function _getHolder(uint256 _tokenId) internal view returns (address) {
        if (balanceOf(claimContract, _tokenId) == 1) return claimContract;
        // If not in ClaimContract, it was claimed — we track via activatedBy
        return address(0);
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
