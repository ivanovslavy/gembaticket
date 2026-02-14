// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @title EventContract721 v2 — ERC721 ticket contract with signature-based claiming
/// @notice NON-CUSTODIAL. Does NOT handle payments. All payments processed by GembaPay off-chain.
///         Clients mint their own NFTs by providing a platform-signed message.
///         Ideal for boutique events with unique per-ticket NFT artwork.
/// @dev Cloned per-event via EIP-1167. Each token is a unique ticket.
///      Three roles: Owner (organizer), Platform (one-time setup), MintSigner (off-chain signatures).
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
    error NotOwnerOrPlatform();
    error SaleNotActive();
    error EventCanceled();
    error EventEnded();
    error EventAlreadyEnded();
    error MaxSupplyReached();
    error TransferLocked();
    error AlreadyActivated();
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
        bytes32 claimHash
    );
    event TicketActivated(uint256 indexed tokenId, address indexed holder);
    event EventCanceledEvent(uint256 timestamp);
    event EventEndedEvent(uint256 timestamp);
    event SaleToggled(bool active);
    event BaseURIUpdated(string newURI);
    event PlatformUpdated(address newPlatform);
    event MintSignerUpdated(address newMintSigner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SupplyIncreased(uint256 addedSupply, uint256 newMaxSupply);
    event SetupCompleted(uint256 timestamp);

    // =========================================================================
    // STATE
    // =========================================================================

    // --- Roles ---
    address public owner;       // Organizer — full control after setup
    address public platform;    // Backend signer — setup + emergency (one-time each)
    address public mintSigner;  // Claim signer — off-chain only, 0 gas, 0 balance

    // --- Event metadata ---
    string  public eventName;
    string  private _baseTokenURI;
    uint256 public maxSupply;
    uint256 public totalMinted;

    // --- Status ---
    bool public saleActive;
    bool public isEventCanceled;
    bool public isEventEnded;

    // --- Setup lock ---
    bool public setupComplete;

    // --- Platform one-time actions (post-setup) ---
    mapping(bytes4 => bool) private _platformActionUsed;

    // --- Per-ticket data ---
    mapping(uint256 => bool)    public ticketActivated;
    mapping(uint256 => address) public activatedBy;

    // --- Claim tracking ---
    mapping(bytes32 => bool)    public usedClaims;

    // --- Custom per-token URI (boutique events: unique artwork per ticket) ---
    mapping(uint256 => string)  private _tokenURIs;

    // =========================================================================
    // INITIALIZER
    // =========================================================================

    /// @param _eventName  Human-readable event name
    /// @param _uri        Base URI for metadata
    /// @param _maxSupply  Maximum number of tickets
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
        __ERC721_init(_eventName, "GTKT");
        __ReentrancyGuard_init();

        if (_owner == address(0))      revert InvalidAddress();
        if (_platform == address(0))   revert InvalidAddress();
        if (_mintSigner == address(0)) revert InvalidAddress();

        eventName     = _eventName;
        _baseTokenURI = _uri;
        maxSupply     = _maxSupply;
        owner         = _owner;
        platform      = _platform;
        mintSigner    = _mintSigner;
        saleActive    = false;
        setupComplete = false;
    }

    // =========================================================================
    // SETUP PHASE — Platform only, before completeSetup()
    // =========================================================================

    /// @notice Enable sales during setup.
    function enableSale() external onlyPlatformSetup {
        if (isEventCanceled) revert EventCanceled();
        saleActive = true;
        emit SaleToggled(true);
    }

    /// @notice Set base URI during setup.
    function setBaseURI(string calldata _newBaseURI) external onlyPlatformSetup {
        _baseTokenURI = _newBaseURI;
        emit BaseURIUpdated(_newBaseURI);
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
    /// @dev Signature = mintSigner signs keccak256(contract, claimHash, wallet)
    /// @param _claimHash  Unique claim identifier (keccak256 of ticket UUID)
    /// @param _signature  MintSigner's ECDSA signature
    function claimTicket(
        bytes32 _claimHash,
        bytes memory _signature
    ) external nonReentrant {
        if (isEventCanceled)          revert EventCanceled();
        if (!saleActive)              revert SaleNotActive();
        if (totalMinted >= maxSupply) revert MaxSupplyReached();
        if (usedClaims[_claimHash]) revert AlreadyClaimed();

        // Verify mintSigner signed (contract, claimHash, msg.sender)
        bytes32 messageHash = keccak256(abi.encodePacked(
            address(this), _claimHash, msg.sender
        ));
        bytes32 ethSigned = _toEthSignedMessageHash(messageHash);

        if (_recoverSigner(ethSigned, _signature) != mintSigner) {
            revert InvalidSignature();
        }

        // State changes
        usedClaims[_claimHash] = true;
        uint256 tokenId = ++totalMinted;

        // Mint to claimer's wallet
        _safeMint(msg.sender, tokenId);

        emit TicketClaimed(msg.sender, tokenId, _claimHash);
    }

    // =========================================================================
    // TICKET LIFECYCLE — Platform (scanner)
    // =========================================================================

    /// @notice Activate a ticket on first venue scan. Locks transfers.
    function activateTicket(uint256 _tokenId) external onlyPlatform {
        if (ticketActivated[_tokenId]) revert AlreadyActivated();

        ticketActivated[_tokenId] = true;
        activatedBy[_tokenId] = _ownerOf(_tokenId);

        emit TicketActivated(_tokenId, _ownerOf(_tokenId));
    }

    /// @dev Transfer restrictions: activated tickets locked until event ends.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);

        if (from != address(0)) {
            if (!isEventEnded && ticketActivated[tokenId]) {
                revert TransferLocked();
            }
        }

        return super._update(to, tokenId, auth);
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

    /// @notice Increase max supply (wave releases).
    function increaseSupply(uint256 _additional) external onlyOwner {
        maxSupply += _additional;
        emit SupplyIncreased(_additional, maxSupply);
    }

    /// @notice Set custom URI for a specific token (boutique unique NFTs).
    function setTokenURI(uint256 _tokenId, string calldata _uri) external onlyOwner {
        _tokenURIs[_tokenId] = _uri;
    }

    /// @notice Update base URI (fallback for tokens without custom URI).
    function updateBaseURI(string calldata _newBaseURI) external onlyOwner {
        _baseTokenURI = _newBaseURI;
        emit BaseURIUpdated(_newBaseURI);
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

    /// @notice Token URI with per-token custom override support.
    function tokenURI(uint256 _tokenId) public view override returns (string memory) {
        _requireOwned(_tokenId);

        // Custom per-token URI takes priority (boutique events)
        if (bytes(_tokenURIs[_tokenId]).length > 0) {
            return _tokenURIs[_tokenId];
        }

        return super.tokenURI(_tokenId);
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function getTicketInfo(uint256 _tokenId)
        external view
        returns (
            bool activated,
            address holder,
            bool exists
        )
    {
        activated = ticketActivated[_tokenId];
        holder    = activatedBy[_tokenId];
        exists    = _tokenId > 0 && _tokenId <= totalMinted;
    }

    function getEventInfo()
        external view
        returns (
            string memory name,
            uint256 supply,
            uint256 minted,
            bool sale,
            bool canceled,
            bool ended
        )
    {
        name     = eventName;
        supply   = maxSupply;
        minted   = totalMinted;
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

    modifier onlyPlatformSetup() {
        if (msg.sender != platform) revert NotPlatform();
        if (setupComplete)          revert SetupAlreadyComplete();
        _;
    }

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
