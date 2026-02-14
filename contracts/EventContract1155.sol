// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @title EventContract1155 v2 — ERC1155 ticket contract with signature-based claiming
/// @notice NON-CUSTODIAL. Does NOT handle payments. All payments processed by GembaPay off-chain.
///         Clients mint their own NFTs by providing a platform-signed message.
///         Platform never pays gas for minting — only for initial setup.
/// @dev Cloned per-event via EIP-1167. Each token ID is a unique ticket (balance = 1).
///      Three roles: Owner (organizer), Platform (one-time setup), MintSigner (off-chain signatures).
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
    error NotOwnerOrPlatform();
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
    error InvalidSignature();
    error AlreadyClaimed();
    error SetupAlreadyComplete();
    error AlreadyExecuted();

    // =========================================================================
    // EVENTS
    // =========================================================================

    event TicketClaimed(
        address indexed claimer,
        uint256 indexed tokenId,
        uint256 ticketTypeId,
        bytes32 claimHash
    );
    event TicketActivated(uint256 indexed tokenId, address indexed holder);
    event TicketTypeCreated(
        uint256 indexed typeId,
        string name,
        uint256 maxSupply,
        uint256 zoneLevel
    );
    event TicketTypeSupplyIncreased(
        uint256 indexed typeId,
        uint256 addedSupply,
        uint256 newMaxSupply
    );
    event EventCanceledEvent(uint256 timestamp);
    event EventEndedEvent(uint256 timestamp);
    event SaleToggled(bool active);
    event PlatformUpdated(address newPlatform);
    event MintSignerUpdated(address newMintSigner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SetupCompleted(uint256 timestamp);

    // =========================================================================
    // STRUCTS
    // =========================================================================

    struct TicketType {
        string name;       // "General", "VIP", "Backstage"
        uint256 maxSupply; // Max tickets of this type
        uint256 minted;    // Tickets minted of this type
        uint256 zoneLevel; // 0=General, 1=VIP, 2=Backstage, 3=AllAccess
        bool active;       // Can be purchased
    }

    // =========================================================================
    // STATE
    // =========================================================================

    // --- Roles ---
    address public owner;       // Organizer — full control after setup
    address public platform;    // Backend signer — setup operations (one-time each)
    address public mintSigner;  // Claim signer — off-chain only, 0 gas, 0 balance

    // --- Event metadata ---
    string  public eventName;
    uint256 public totalMinted;
    uint256 public maxSupply;   // Global cap across all types

    // --- Status ---
    bool public saleActive;
    bool public isEventCanceled;
    bool public isEventEnded;

    // --- Setup lock ---
    bool public setupComplete;

    // --- Platform one-time actions (post-setup) ---
    mapping(bytes4 => bool) private _platformActionUsed;

    // --- Ticket types ---
    mapping(uint256 => TicketType) public ticketTypes;
    uint256 public ticketTypeCount;

    // --- Per-ticket data ---
    mapping(uint256 => uint256)  public ticketType;       // tokenId => typeId
    mapping(uint256 => bool)     public ticketActivated;
    mapping(uint256 => address)  public activatedBy;

    // --- Claim tracking ---
    mapping(bytes32 => bool)     public usedClaims;

    // --- Custom URIs per ticket type ---
    mapping(uint256 => string)   private _typeURIs;

    // =========================================================================
    // INITIALIZER
    // =========================================================================

    /// @param _eventName  Human-readable event name
    /// @param _uri        Base URI for metadata
    /// @param _maxSupply  Global maximum tickets across all types
    /// @param _owner      Organizer address
    /// @param _platform   Platform signer (setup + emergency)
    /// @param _mintSigner Mint signer (off-chain claim signatures only)
    function initialize(
        string calldata _eventName,
        string calldata _uri,
        uint256 _maxSupply,
        address _owner,
        address _platform,
        address _mintSigner
    ) external initializer {
        __ERC1155_init(_uri);
        __ReentrancyGuard_init();

        if (_owner == address(0))      revert InvalidAddress();
        if (_platform == address(0))   revert InvalidAddress();
        if (_mintSigner == address(0)) revert InvalidAddress();

        eventName   = _eventName;
        maxSupply   = _maxSupply;
        owner       = _owner;
        platform    = _platform;
        mintSigner  = _mintSigner;
        saleActive  = false;
        setupComplete = false;
    }

    // =========================================================================
    // SETUP PHASE — Platform only, before completeSetup()
    // =========================================================================

    /// @notice Create a ticket type. Platform only, before setup is locked.
    function createTicketType(
        uint256 _typeId,
        string calldata _name,
        uint256 _typeMaxSupply,
        uint256 _zoneLevel
    ) external onlyPlatformSetup {
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

    /// @notice Enable sales during setup.
    function enableSale() external onlyPlatformSetup {
        if (isEventCanceled) revert EventCanceled();
        saleActive = true;
        emit SaleToggled(true);
    }

    /// @notice Set base URI during setup.
    function setBaseURI(string calldata _newURI) external onlyPlatformSetup {
        _setURI(_newURI);
    }

    /// @notice Lock setup permanently. Platform loses setup access.
    function completeSetup() external onlyPlatformSetup {
        setupComplete = true;
        emit SetupCompleted(block.timestamp);
    }

    // =========================================================================
    // CLAIM — Client mints their own NFT with mintSigner signature
    // =========================================================================

    /// @notice Claim (mint) a ticket. Client pays gas. Platform pays nothing.
    /// @dev Signature = mintSigner signs keccak256(contract, typeId, claimHash, wallet)
    /// @param _typeId     Ticket type to mint
    /// @param _claimHash  Unique claim identifier (keccak256 of ticket UUID)
    /// @param _signature  MintSigner's ECDSA signature
    function claimTicket(
        uint256 _typeId,
        bytes32 _claimHash,
        bytes memory _signature
    ) external nonReentrant {
        if (isEventCanceled)          revert EventCanceled();
        if (!saleActive)              revert SaleNotActive();
        if (usedClaims[_claimHash])   revert AlreadyClaimed();

        TicketType storage tt = ticketTypes[_typeId];
        if (tt.maxSupply == 0 || !tt.active) revert InvalidTicketType();
        if (tt.minted >= tt.maxSupply)       revert TypeMaxSupplyReached();
        if (totalMinted >= maxSupply)        revert MaxSupplyReached();

        // Verify mintSigner signed (contract, typeId, claimHash, msg.sender)
        bytes32 messageHash = keccak256(abi.encodePacked(
            address(this), _typeId, _claimHash, msg.sender
        ));
        bytes32 ethSigned = _toEthSignedMessageHash(messageHash);

        if (_recoverSigner(ethSigned, _signature) != mintSigner) {
            revert InvalidSignature();
        }

        // State changes
        usedClaims[_claimHash] = true;
        uint256 tokenId = ++totalMinted;
        tt.minted++;
        ticketType[tokenId] = _typeId;

        // Mint to claimer's wallet
        _mint(msg.sender, tokenId, 1, "");

        emit TicketClaimed(msg.sender, tokenId, _typeId, _claimHash);
    }

    // =========================================================================
    // TICKET LIFECYCLE — Platform (scanner)
    // =========================================================================

    /// @notice Activate a ticket on first venue scan. Locks transfers.
    function activateTicket(uint256 _tokenId) external onlyPlatform {
        if (ticketActivated[_tokenId]) revert AlreadyActivated();

        ticketActivated[_tokenId] = true;
        // Note: for ERC1155 with unique IDs, holder tracking via events
        activatedBy[_tokenId] = msg.sender;

        emit TicketActivated(_tokenId, msg.sender);
    }

    /// @dev Transfer restrictions: activated tickets locked until event ends.
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
    // OWNER FUNCTIONS — Organizer, unlimited access
    // =========================================================================

    /// @notice Toggle ticket sales on/off.
    function toggleSale() external onlyOwner {
        if (isEventCanceled) revert EventCanceled();
        if (isEventEnded)    revert EventEnded();
        saleActive = !saleActive;
        emit SaleToggled(saleActive);
    }

    /// @notice Toggle a ticket type active/inactive.
    function toggleTicketType(uint256 _typeId) external onlyOwner {
        if (ticketTypes[_typeId].maxSupply == 0) revert InvalidTicketType();
        ticketTypes[_typeId].active = !ticketTypes[_typeId].active;
    }

    /// @notice Increase supply for a ticket type (wave releases).
    /// @dev Only increases — never decreases. Protects already sold tickets.
    function increaseTypeSupply(uint256 _typeId, uint256 _additional) external onlyOwner {
        if (ticketTypes[_typeId].maxSupply == 0) revert InvalidTicketType();

        ticketTypes[_typeId].maxSupply += _additional;
        maxSupply += _additional;

        emit TicketTypeSupplyIncreased(_typeId, _additional, ticketTypes[_typeId].maxSupply);
    }

    /// @notice Add new ticket types after setup.
    function addTicketType(
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
        maxSupply += _typeMaxSupply;

        emit TicketTypeCreated(_typeId, _name, _typeMaxSupply, _zoneLevel);
    }

    /// @notice Set custom URI for a specific ticket type.
    function setTypeURI(uint256 _typeId, string calldata _typeUri) external onlyOwner {
        _typeURIs[_typeId] = _typeUri;
        emit URI(_typeUri, _typeId);
    }

    /// @notice Update base URI (fallback for types without custom URI).
    function setURI(string calldata _newURI) external onlyOwner {
        _setURI(_newURI);
    }

    // =========================================================================
    // EVENT LIFECYCLE — Owner (unlimited) or Platform (one-time emergency)
    // =========================================================================

    /// @notice Cancel the event. Refunds handled off-chain via GembaPay.
    function cancelEvent() external onlyOwnerOrPlatformOnce {
        if (isEventEnded) revert EventAlreadyEnded();
        isEventCanceled = true;
        saleActive = false;
        emit EventCanceledEvent(block.timestamp);
    }

    /// @notice End the event. Unlocks NFT transfers for secondary market.
    function endEvent() external onlyOwnerOrPlatformOnce {
        if (isEventCanceled) revert EventCanceled();
        isEventEnded = true;
        saleActive = false;
        emit EventEndedEvent(block.timestamp);
    }

    // =========================================================================
    // KEY ROTATION — Owner only
    // =========================================================================

    function setPlatform(address _new) external onlyOwner {
        if (_new == address(0)) revert InvalidAddress();
        platform = _new;
        emit PlatformUpdated(_new);
    }

    /// @dev Changing mintSigner invalidates all pending unused signatures.
    function setMintSigner(address _new) external onlyOwner {
        if (_new == address(0)) revert InvalidAddress();
        mintSigner = _new;
        emit MintSignerUpdated(_new);
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        if (_newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, _newOwner);
        owner = _newOwner;
    }

    // =========================================================================
    // VIEW FUNCTIONS
    // =========================================================================

    /// @notice URI with custom per-type override support.
    function uri(uint256 _id) public view override returns (string memory) {
        // If token has been minted, check its type for custom URI
        if (_id > 0 && _id <= totalMinted) {
            uint256 tId = ticketType[_id];
            if (bytes(_typeURIs[tId]).length > 0) return _typeURIs[tId];
        }
        // Also allow direct type ID lookups for marketplace compatibility
        if (bytes(_typeURIs[_id]).length > 0) return _typeURIs[_id];
        return super.uri(_id);
    }

    function getTicketInfo(uint256 _tokenId)
        external view
        returns (
            bool activated,
            address activator,
            uint256 typeId,
            uint256 zoneLevel,
            bool exists
        )
    {
        activated = ticketActivated[_tokenId];
        activator = activatedBy[_tokenId];
        typeId    = ticketType[_tokenId];
        zoneLevel = ticketTypes[typeId].zoneLevel;
        exists    = _tokenId > 0 && _tokenId <= totalMinted;
    }

    function getTicketTypeInfo(uint256 _typeId)
        external view
        returns (
            string memory name,
            uint256 typeMaxSupply,
            uint256 minted,
            uint256 zoneLevel,
            bool active
        )
    {
        TicketType storage tt = ticketTypes[_typeId];
        name          = tt.name;
        typeMaxSupply = tt.maxSupply;
        minted        = tt.minted;
        zoneLevel     = tt.zoneLevel;
        active        = tt.active;
    }

    function getEventInfo()
        external view
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
        name     = eventName;
        supply   = maxSupply;
        minted   = totalMinted;
        types    = ticketTypeCount;
        sale     = saleActive;
        canceled = isEventCanceled;
        ended    = isEventEnded;
    }

    // =========================================================================
    // INTERNAL — Signature helpers
    // =========================================================================

    function _toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    function _recoverSigner(bytes32 _hash, bytes memory _sig) internal pure returns (address) {
        if (_sig.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(_sig, 32))
            s := mload(add(_sig, 64))
            v := byte(0, mload(add(_sig, 96)))
        }

        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);

        return ecrecover(_hash, v, r, s);
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

    /// @dev Platform only, setup phase only.
    modifier onlyPlatformSetup() {
        if (msg.sender != platform)  revert NotPlatform();
        if (setupComplete)           revert SetupAlreadyComplete();
        _;
    }

    /// @dev Owner unlimited OR platform one-time per function selector.
    modifier onlyOwnerOrPlatformOnce() {
        if (msg.sender == owner) {
            _;
        } else if (msg.sender == platform) {
            if (_platformActionUsed[msg.sig]) revert AlreadyExecuted();
            _platformActionUsed[msg.sig] = true;
            _;
        } else {
            revert NotOwnerOrPlatform();
        }
    }
}
