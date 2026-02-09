// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IClaimContract.sol";

/// @title EventContract721 — ERC721 ticket contract (payment-agnostic)
/// @notice Cloned per-event via EIP-1167. Does NOT handle payments.
///         All payments (crypto + fiat) are processed by GembaPay off-chain.
///         Platform signer mints tickets after GembaPay webhook confirmation.
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
    error EventAlreadyEnded();
    error MaxSupplyReached();
    error TransferLocked();
    error AlreadyActivated();
    error InvalidAddress();

    // =========================================================================
    // EVENTS
    // =========================================================================

    event TicketMinted(
        address indexed buyer,
        uint256 indexed tokenId,
        bytes32 paymentHash
    );
    event TicketActivated(uint256 indexed tokenId, address indexed holder);
    event EventCanceledEvent(uint256 timestamp);
    event EventEndedEvent(uint256 timestamp);
    event SaleToggled(bool active);
    event BaseURIUpdated(string newURI);
    event PlatformUpdated(address newPlatform);

    // =========================================================================
    // STATE
    // =========================================================================

    // Addresses
    address public owner;       // Organizer
    address public platform;    // Platform signer (pays gas, mints tickets)
    address public claimContract;

    // Event metadata
    string public eventName;
    string private _baseTokenURI;

    // Ticket config
    uint256 public maxSupply;

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
    uint256 private _claimNonce;

    // =========================================================================
    // INITIALIZER (replaces constructor for clones)
    // =========================================================================

    /// @notice Initialize the event contract. Called once by PlatformRegistry.
    /// @param _eventName Human-readable event name
    /// @param _uri IPFS base URI for metadata
    /// @param _maxSupply Maximum number of tickets
    /// @param _owner Organizer address
    /// @param _platform Platform signer address (mints tickets, activates)
    /// @param _claimContract ClaimContract address (holds NFTs until claimed)
    function initialize(
        string calldata _eventName,
        string calldata _uri,
        uint256 _maxSupply,
        address _owner,
        address _platform,
        address _claimContract
    ) external initializer {
        __ERC721_init(_eventName, "GTKT");
        __ReentrancyGuard_init();

        if (_owner == address(0)) revert InvalidAddress();
        if (_platform == address(0)) revert InvalidAddress();
        if (_claimContract == address(0)) revert InvalidAddress();

        eventName = _eventName;
        _baseTokenURI = _uri;
        maxSupply = _maxSupply;
        owner = _owner;
        platform = _platform;
        claimContract = _claimContract;
        saleActive = false;
    }

    // =========================================================================
    // MINT — Platform signer mints after GembaPay payment confirmation
    // =========================================================================

    /// @notice Mint a ticket after payment confirmed by GembaPay webhook.
    ///         Works for both crypto and fiat — GembaPay handles all payments.
    /// @param _buyer Buyer address (for claim tracking)
    /// @param _paymentHash Keccak256 of GembaPay payment ID (on-chain proof)
    function mintWithPaymentProof(
        address _buyer,
        bytes32 _paymentHash
    ) external onlyPlatform nonReentrant {
        if (!saleActive) revert SaleNotActive();
        if (isEventCanceled) revert EventCanceled();
        if (totalMinted >= maxSupply) revert MaxSupplyReached();
        if (_buyer == address(0)) revert InvalidAddress();

        uint256 tokenId = _mintTicket(_buyer);

        emit TicketMinted(_buyer, tokenId, _paymentHash);
    }

    // =========================================================================
    // INTERNAL MINT — Always mints to ClaimContract
    // =========================================================================

    function _mintTicket(address _buyer) internal returns (uint256 tokenId) {
        tokenId = ++totalMinted;

        bytes32 claimHash = keccak256(abi.encodePacked(
            address(this),
            tokenId,
            _buyer,
            block.timestamp,
            block.prevrandao,
            ++_claimNonce
        ));
        ticketClaimHash[tokenId] = claimHash;

        _safeMint(claimContract, tokenId);

        IClaimContract(claimContract).lockForClaim(claimHash, tokenId, _buyer);
    }

    // =========================================================================
    // TICKET LIFECYCLE
    // =========================================================================

    /// @notice Activate a ticket on first scan. Locks transfers permanently.
    function activateTicket(uint256 _tokenId) external onlyPlatform {
        if (ticketActivated[_tokenId]) revert AlreadyActivated();

        ticketActivated[_tokenId] = true;
        activatedBy[_tokenId] = _ownerOf(_tokenId);

        emit TicketActivated(_tokenId, _ownerOf(_tokenId));
    }

    /// @dev Override _update to enforce transfer restrictions.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);

        if (from != address(0)) {
            if (!isEventEnded) {
                if (ticketActivated[tokenId]) revert TransferLocked();
            }
        }

        return super._update(to, tokenId, auth);
    }

    // =========================================================================
    // EVENT MANAGEMENT (organizer only)
    // =========================================================================

    /// @notice Cancel the event. Refunds handled off-chain via GembaPay.
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
    function setBaseURI(string calldata _newBaseURI) external onlyOwner {
        _baseTokenURI = _newBaseURI;
        emit BaseURIUpdated(_newBaseURI);
    }

    // =========================================================================
    // PLATFORM MANAGEMENT
    // =========================================================================

    function setPlatform(address _newPlatform) external onlyPlatform {
        if (_newPlatform == address(0)) revert InvalidAddress();
        platform = _newPlatform;
        emit PlatformUpdated(_newPlatform);
    }

    // =========================================================================
    // VIEW FUNCTIONS
    // =========================================================================

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

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

    function getEventInfo()
        external
        view
        returns (
            string memory name,
            uint256 supply,
            uint256 minted,
            bool sale,
            bool canceled,
            bool ended
        )
    {
        name = eventName;
        supply = maxSupply;
        minted = totalMinted;
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
