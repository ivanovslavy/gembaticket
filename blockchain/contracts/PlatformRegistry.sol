// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PlatformRegistry v2 — Event factory and admin (payment-agnostic)
/// @notice All payments handled by GembaPay off-chain.
///         Deploys event clones and manages platform settings.
///         Platform signer calls createEvent() after GembaPay confirms payment.
/// @dev Only event contracts are proxied (EIP-1167 clones).
///      PlatformRegistry is a regular deployed contract.
///      No ClaimContract — tickets are claimed directly via signature-based minting.
contract PlatformRegistry is ReentrancyGuard {

    // =========================================================================
    // ERRORS
    // =========================================================================

    error NotAdmin();
    error NotMultisig();
    error NotSigner();
    error InvalidTemplate();
    error InvalidAddress();
    error WithdrawFailed();
    error FundingFailed();
    error EventCreationFailed();
    error InvalidEventType();
    error Paused();

    // =========================================================================
    // EVENTS
    // =========================================================================

    event EventCreated(
        address indexed eventAddress,
        address indexed organizer,
        uint256 eventType,
        string eventName,
        bytes32 paymentHash
    );
    event TemplateUpdated(uint256 indexed eventType, address oldTemplate, address newTemplate);
    event PlatformSignerUpdated(address newSigner);
    event MintSignerUpdated(address newMintSigner);
    event FundsReceived(address indexed from, uint256 amount);
    event FundsWithdrawn(address indexed to, uint256 amount);
    event SignerFunded(uint256 amount);
    event PlatformPaused(bool paused);
    event AdminUpdated(address newAdmin);
    event MultisigUpdated(address newMultisig);

    // =========================================================================
    // STATE
    // =========================================================================

    address public admin;           // Deployer — can update settings
    address public multisig;        // Treasury withdrawals
    address public platformSigner;  // Pays gas for deploy + setup operations
    address public mintSigner;      // Off-chain claim signatures — 0 gas, 0 balance

    // Template contracts for cloning
    address public erc721Template;
    address public erc1155Template;

    bool public isPaused;

    // Registry of all deployed events
    address[] public allEvents;
    mapping(address => bool)    public isEvent;
    mapping(address => address) public eventOrganizer;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /// @param _admin           Admin address
    /// @param _multisig        Multisig address
    /// @param _platformSigner  Platform signer (deploy + setup gas)
    /// @param _mintSigner      Mint signer (off-chain claim signatures)
    /// @param _erc721Template  EventContract721 template
    /// @param _erc1155Template EventContract1155 template
    constructor(
        address _admin,
        address _multisig,
        address _platformSigner,
        address _mintSigner,
        address _erc721Template,
        address _erc1155Template
    ) {
        if (_admin == address(0))          revert InvalidAddress();
        if (_multisig == address(0))       revert InvalidAddress();
        if (_platformSigner == address(0)) revert InvalidAddress();
        if (_mintSigner == address(0))     revert InvalidAddress();

        admin          = _admin;
        multisig       = _multisig;
        platformSigner = _platformSigner;
        mintSigner     = _mintSigner;

        if (_erc721Template == address(0))  revert InvalidTemplate();
        if (_erc1155Template == address(0)) revert InvalidTemplate();
        erc721Template  = _erc721Template;
        erc1155Template = _erc1155Template;
    }

    // =========================================================================
    // EVENT CREATION
    // =========================================================================

    /// @notice Create a new event. Called by platform signer after GembaPay payment.
    /// @param _eventType 0 = ERC721, 1 = ERC1155
    /// @param _eventName Event name
    /// @param _baseURI   IPFS metadata base URI
    /// @param _maxSupply Maximum total tickets
    /// @param _organizer Organizer address (becomes contract owner)
    /// @param _paymentHash GembaPay payment hash (on-chain proof)
    function createEvent(
        uint256 _eventType,
        string calldata _eventName,
        string calldata _baseURI,
        uint256 _maxSupply,
        address _organizer,
        bytes32 _paymentHash
    ) external onlySigner nonReentrant returns (address eventAddress) {
        if (isPaused) revert Paused();
        if (_organizer == address(0)) revert InvalidAddress();

        eventAddress = _deployEvent(
            _eventType,
            _eventName,
            _baseURI,
            _maxSupply,
            _organizer
        );

        emit EventCreated(eventAddress, _organizer, _eventType, _eventName, _paymentHash);
    }

    // =========================================================================
    // INTERNAL DEPLOY
    // =========================================================================

    /// @dev The ONE place the CREATE2 salt is derived. `_deployEvent` and `predictEventAddress`
    ///      both call it, so the prediction cannot drift from the deployment again.
    function _eventSalt(address _organizer, uint256 _index) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(_organizer, _index));
    }

    function _deployEvent(
        uint256 _eventType,
        string calldata _eventName,
        string calldata _baseURI,
        uint256 _maxSupply,
        address _organizer
    ) internal returns (address eventAddress) {
        // CREATE2 salt. `allEvents.length` is already unique per deployment — it is incremented
        // for every event ever created — so nothing is gained by mixing in `block.timestamp`, and
        // mixing it in is what made `predictEventAddress` lie: the view runs in one block and the
        // creation in another, so the two salts differed and the predicted address was wrong.
        // (2026-10-31, finding "the one thing worth fixing" in docs/STATIC-ANALYSIS-2026-10-30.md)
        bytes32 salt = _eventSalt(_organizer, allEvents.length);

        // Clone template
        if (_eventType == 0) {
            if (erc721Template == address(0)) revert InvalidTemplate();
            eventAddress = Clones.cloneDeterministic(erc721Template, salt);
        } else if (_eventType == 1) {
            if (erc1155Template == address(0)) revert InvalidTemplate();
            eventAddress = Clones.cloneDeterministic(erc1155Template, salt);
        } else {
            revert InvalidEventType();
        }

        // Register before external call (CEI pattern)
        allEvents.push(eventAddress);
        isEvent[eventAddress] = true;
        eventOrganizer[eventAddress] = _organizer;

        // Initialize clone:
        // initialize(string _eventName, string _uri, uint256 _maxSupply,
        //            address _owner, address _platform, address _mintSigner)
        (bool success,) = eventAddress.call(
            abi.encodeWithSignature(
                "initialize(string,string,uint256,address,address,address)",
                _eventName,
                _baseURI,
                _maxSupply,
                _organizer,       // owner = organizer
                platformSigner,   // platform = setup signer
                mintSigner        // mintSigner = claim signer
            )
        );
        if (!success) revert EventCreationFailed();
    }

    // =========================================================================
    // TREASURY
    // =========================================================================

    receive() external payable {
        emit FundsReceived(msg.sender, msg.value);
    }

    function withdraw(address _to, uint256 _amount) external onlyMultisig nonReentrant {
        if (_to == address(0)) revert InvalidAddress();
        (bool sent,) = _to.call{value: _amount}("");
        if (!sent) revert WithdrawFailed();
        emit FundsWithdrawn(_to, _amount);
    }

    function fundSigner(uint256 _amount) external onlyMultisig nonReentrant {
        (bool sent,) = platformSigner.call{value: _amount}("");
        if (!sent) revert FundingFailed();
        emit SignerFunded(_amount);
    }

    // =========================================================================
    // ADMIN
    // =========================================================================

    function setTemplate(uint256 _eventType, address _newTemplate) external onlyAdmin {
        if (_newTemplate == address(0)) revert InvalidTemplate();
        if (_eventType == 0) {
            address old = erc721Template;
            erc721Template = _newTemplate;
            emit TemplateUpdated(0, old, _newTemplate);
        } else if (_eventType == 1) {
            address old = erc1155Template;
            erc1155Template = _newTemplate;
            emit TemplateUpdated(1, old, _newTemplate);
        } else {
            revert InvalidEventType();
        }
    }

    function setPlatformSigner(address _newSigner) external onlyAdmin {
        if (_newSigner == address(0)) revert InvalidAddress();
        platformSigner = _newSigner;
        emit PlatformSignerUpdated(_newSigner);
    }

    function setMintSigner(address _newMintSigner) external onlyAdmin {
        if (_newMintSigner == address(0)) revert InvalidAddress();
        mintSigner = _newMintSigner;
        emit MintSignerUpdated(_newMintSigner);
    }

    function setMultisig(address _newMultisig) external onlyMultisig {
        if (_newMultisig == address(0)) revert InvalidAddress();
        multisig = _newMultisig;
        emit MultisigUpdated(_newMultisig);
    }

    function setAdmin(address _newAdmin) external onlyAdmin {
        if (_newAdmin == address(0)) revert InvalidAddress();
        admin = _newAdmin;
        emit AdminUpdated(_newAdmin);
    }

    function togglePause() external onlyAdmin {
        isPaused = !isPaused;
        emit PlatformPaused(isPaused);
    }

    // =========================================================================
    // VIEW FUNCTIONS
    // =========================================================================

    function totalEvents() external view returns (uint256) {
        return allEvents.length;
    }

    function getEvents(uint256 _offset, uint256 _limit)
        external view
        returns (address[] memory events)
    {
        uint256 end = _offset + _limit;
        if (end > allEvents.length) end = allEvents.length;
        uint256 length = end - _offset;

        events = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            events[i] = allEvents[_offset + i];
        }
    }

    /// @notice The address the NEXT event created for `_organizer` will get.
    /// @dev Exact, not indicative: the salt is `(organizer, index)` and the index is the one this
    ///      view reads, so the answer holds until somebody else creates an event first (which moves
    ///      the index). It no longer depends on `block.timestamp`, which used to make the answer
    ///      wrong in every block but the one the event happened to be created in.
    function predictEventAddress(
        uint256 _eventType,
        address _organizer
    ) external view returns (address) {
        if (_eventType != 0 && _eventType != 1) revert InvalidEventType();
        address template = _eventType == 0 ? erc721Template : erc1155Template;
        if (template == address(0)) revert InvalidTemplate();
        return Clones.predictDeterministicAddress(template, _eventSalt(_organizer, allEvents.length));
    }

    function contractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // =========================================================================
    // MODIFIERS
    // =========================================================================

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyMultisig() {
        if (msg.sender != multisig) revert NotMultisig();
        _;
    }

    modifier onlySigner() {
        if (msg.sender != platformSigner) revert NotSigner();
        _;
    }
}
