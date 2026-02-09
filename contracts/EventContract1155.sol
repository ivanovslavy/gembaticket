// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IClaimContract.sol";

/// @title EventContract1155 — ERC1155 ticket contract with zone-based types (payment-agnostic)
/// @notice Does NOT handle payments. All payments processed by GembaPay off-chain.
///         Each token ID is a unique ticket. ticketType maps each token to its tier.
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
    error MaxSupplyReached();
    error TypeMaxSupplyReached();
    error TransferLocked();
    error AlreadyActivated();
    error InvalidTicketType();
    error TicketTypeExists();
    error InvalidAddress();

    // =========================================================================
    // EVENTS
    // =========================================================================

    event TicketMinted(
        address indexed buyer,
        uint256 indexed tokenId,
        uint256 ticketTypeId,
        bytes32 paymentHash
    );
    event TicketActivated(uint256 indexed tokenId, address indexed holder);
    event TicketTypeCreated(
        uint256 indexed typeId,
        string name,
        uint256 maxSupply,
        uint256 zoneLevel
    );
    event EventCanceledEvent(uint256 timestamp);
    event EventEndedEvent(uint256 timestamp);
    event SaleToggled(bool active);
    event PlatformUpdated(address newPlatform);

    // =========================================================================
    // STRUCTS
    // =========================================================================

    struct TicketType {
        string name;       // "General", "VIP", "Backstage", "All Access"
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
    address public claimContract;

    string public eventName;
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
    uint256 private _claimNonce;

    // =========================================================================
    // INITIALIZER
    // =========================================================================

    /// @notice Initialize the event contract. Called once by PlatformRegistry.
    /// @param _eventName Human-readable event name
    /// @param _uri Base URI for metadata
    /// @param _maxSupply Global maximum tickets across all types
    /// @param _owner Organizer address
    /// @param _platform Platform signer address
    /// @param _claimContract ClaimContract address
    function initialize(
        string calldata _eventName,
        string calldata _uri,
        uint256 _maxSupply,
        address _owner,
        address _platform,
        address _claimContract
    ) external initializer {
        __ERC1155_init(_uri);
        __ReentrancyGuard_init();

        if (_owner == address(0)) revert InvalidAddress();
        if (_platform == address(0)) revert InvalidAddress();
        if (_claimContract == address(0)) revert InvalidAddress();

        eventName = _eventName;
        maxSupply = _maxSupply;
        owner = _owner;
        platform = _platform;
        claimContract = _claimContract;
        saleActive = false;
    }

    // =========================================================================
    // TICKET TYPE MANAGEMENT (organizer)
    // =========================================================================

    /// @notice Create a ticket type (zone/tier).
    /// @param _typeId Unique type identifier (0=General, 1=VIP, etc.)
    /// @param _name Display name
    /// @param _typeMaxSupply Maximum tickets of this type
    /// @param _zoneLevel Zone access level (higher = more access)
    function createTicketType(
        uint256 _typeId,
        string calldata _name,
        uint256 _typeMaxSupply,
        uint256 _zoneLevel
    ) external onlyOwner {
        if (ticketTypes[_typeId].maxSupply != 0) revert TicketTypeExists();

        ticketTypes[_typeId] = TicketType({
            name: _name,
            maxSupply: _typeMaxSupply,
            minted: 0,
            zoneLevel: _zoneLevel,
            active: true
        });
        ticketTypeCount++;

        emit TicketTypeCreated(_typeId, _name, _typeMaxSupply, _zoneLevel);
    }

    /// @notice Toggle a ticket type active/inactive
    function toggleTicketType(uint256 _typeId) external onlyOwner {
        if (ticketTypes[_typeId].maxSupply == 0) revert InvalidTicketType();
        ticketTypes[_typeId].active = !ticketTypes[_typeId].active;
    }

    // =========================================================================
    // MINT — Platform signer mints after GembaPay payment confirmation
    // =========================================================================

    /// @notice Mint a ticket after payment confirmed by GembaPay webhook.
    /// @param _buyer Buyer address
    /// @param _typeId Ticket type
    /// @param _paymentHash GembaPay payment ID hash
    function mintWithPaymentProof(
        address _buyer,
        uint256 _typeId,
        bytes32 _paymentHash
    ) external onlyPlatform nonReentrant {
        if (!saleActive) revert SaleNotActive();
        if (isEventCanceled) revert EventCanceled();
        if (_buyer == address(0)) revert InvalidAddress();

        TicketType storage tt = ticketTypes[_typeId];
        if (tt.maxSupply == 0 || !tt.active) revert InvalidTicketType();
        if (tt.minted >= tt.maxSupply) revert TypeMaxSupplyReached();
        if (totalMinted >= maxSupply) revert MaxSupplyReached();

        uint256 tokenId = _mintTicket(_buyer, _typeId);

        emit TicketMinted(_buyer, tokenId, _typeId, _paymentHash);
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
            block.prevrandao,
            ++_claimNonce
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

    /// @notice Cancel the event. Refunds handled off-chain via GembaPay.
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
        if (_newPlatform == address(0)) revert InvalidAddress();
        platform = _newPlatform;
        emit PlatformUpdated(_newPlatform);
    }

    // =========================================================================
    // VIEW FUNCTIONS
    // =========================================================================

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

    function getTicketTypeInfo(uint256 _typeId)
        external
        view
        returns (
            string memory name,
            uint256 typeMaxSupply,
            uint256 minted,
            uint256 zoneLevel,
            bool active
        )
    {
        TicketType storage tt = ticketTypes[_typeId];
        name = tt.name;
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

    function _getHolder(uint256 _tokenId) internal view returns (address) {
        if (balanceOf(claimContract, _tokenId) == 1) return claimContract;
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
