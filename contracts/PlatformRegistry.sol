// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IClaimContract.sol";

/// @title PlatformRegistry — Event factory and admin (payment-agnostic)
/// @notice All payments (event creation fees, ticket sales) handled by GembaPay off-chain.
///         This contract only deploys event clones and manages platform settings.
///         Platform signer calls createEvent() after GembaPay confirms payment.
/// @dev Only 2 contracts are proxied (event clones via EIP-1167).
///      PlatformRegistry and ClaimContract are regular contracts.
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
    event ClaimContractUpdated(address newClaimContract);
    event FundsReceived(address indexed from, uint256 amount);
    event FundsWithdrawn(address indexed to, uint256 amount);
    event SignerFunded(uint256 amount);
    event PlatformPaused(bool paused);
    event AdminUpdated(address newAdmin);
    event MultisigUpdated(address newMultisig);

    // =========================================================================
    // STATE
    // =========================================================================

    // Admin (deployer, can update settings)
    address public admin;

    // Multisig for treasury withdrawals (can be same as admin initially)
    address public multisig;

    // Platform signer wallet (pays gas for mints, activations, event creation)
    address public platformSigner;

    // ClaimContract reference
    address public claimContract;

    // Template contracts for cloning
    address public erc721Template;
    address public erc1155Template;

    // State
    bool public isPaused;

    // Registry of all deployed events
    address[] public allEvents;
    mapping(address => bool) public isEvent;
    mapping(address => address) public eventOrganizer;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /// @param _admin Admin address (can update settings)
    /// @param _multisig Multisig address (can withdraw funds)
    /// @param _platformSigner Platform signer address (pays gas)
    /// @param _claimContract ClaimContract address
    /// @param _erc721Template EventContract721 template address
    /// @param _erc1155Template EventContract1155 template address
    constructor(
        address _admin,
        address _multisig,
        address _platformSigner,
        address _claimContract,
        address _erc721Template,
        address _erc1155Template
    ) {
        if (_admin == address(0)) revert InvalidAddress();
        if (_multisig == address(0)) revert InvalidAddress();
        if (_platformSigner == address(0)) revert InvalidAddress();
        if (_claimContract == address(0)) revert InvalidAddress();

        admin = _admin;
        multisig = _multisig;
        platformSigner = _platformSigner;
        claimContract = _claimContract;

        if (_erc721Template == address(0)) revert InvalidTemplate();
        if (_erc1155Template == address(0)) revert InvalidTemplate();
        erc721Template = _erc721Template;
        erc1155Template = _erc1155Template;
    }

    // =========================================================================
    // EVENT CREATION — Platform signer calls after GembaPay payment confirmation
    // =========================================================================

    /// @notice Create a new event. Called by platform signer after GembaPay
    ///         confirms the creation fee payment (crypto or fiat).
    /// @param _eventType 0 = ERC721, 1 = ERC1155
    /// @param _eventName Event name
    /// @param _baseURI IPFS metadata base URI
    /// @param _maxSupply Maximum total tickets
    /// @param _organizer Organizer address (receives revenue via GembaPay)
    /// @param _paymentHash GembaPay payment ID hash (on-chain proof of payment)
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

    function _deployEvent(
        uint256 _eventType,
        string calldata _eventName,
        string calldata _baseURI,
        uint256 _maxSupply,
        address _organizer
    ) internal returns (address eventAddress) {
        // Deterministic salt for predictable addresses
        bytes32 salt = keccak256(abi.encodePacked(
            _organizer,
            allEvents.length,
            block.timestamp
        ));

        // Step 1: Clone template (CREATE2 — not an external call)
        if (_eventType == 0) {
            if (erc721Template == address(0)) revert InvalidTemplate();
            eventAddress = Clones.cloneDeterministic(erc721Template, salt);
        } else if (_eventType == 1) {
            if (erc1155Template == address(0)) revert InvalidTemplate();
            eventAddress = Clones.cloneDeterministic(erc1155Template, salt);
        } else {
            revert InvalidEventType();
        }

        // Step 2: State writes BEFORE any external calls (CEI pattern)
        allEvents.push(eventAddress);
        isEvent[eventAddress] = true;
        eventOrganizer[eventAddress] = _organizer;

        // Step 3: Initialize clone (external call)
        (bool success,) = eventAddress.call(
            abi.encodeWithSignature(
                "initialize(string,string,uint256,address,address,address)",
                _eventName,
                _baseURI,
                _maxSupply,
                _organizer,
                platformSigner,
                claimContract
            )
        );
        if (!success) revert EventCreationFailed();

        // Step 4: Register in ClaimContract (external call last)
        IClaimContract(claimContract).registerEvent(eventAddress);
    }

    // =========================================================================
    // TREASURY — For gas funding operations
    // =========================================================================

    /// @notice Receive funds (for gas wallet funding).
    receive() external payable {
        emit FundsReceived(msg.sender, msg.value);
    }

    /// @notice Withdraw funds from contract. Multisig only.
    function withdraw(address _to, uint256 _amount) external onlyMultisig nonReentrant {
        if (_to == address(0)) revert InvalidAddress();

        (bool sent,) = _to.call{value: _amount}("");
        if (!sent) revert WithdrawFailed();

        emit FundsWithdrawn(_to, _amount);
    }

    /// @notice Fund the platform signer wallet for gas payments.
    function fundSigner(uint256 _amount) external onlyMultisig nonReentrant {
        (bool sent,) = platformSigner.call{value: _amount}("");
        if (!sent) revert FundingFailed();

        emit SignerFunded(_amount);
    }

    // =========================================================================
    // ADMIN — Settings management
    // =========================================================================

    /// @notice Update ERC721 or ERC1155 template address.
    ///         New events use new template. Old events unaffected (immutable).
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

    function setClaimContract(address _newClaimContract) external onlyAdmin {
        if (_newClaimContract == address(0)) revert InvalidAddress();
        claimContract = _newClaimContract;
        emit ClaimContractUpdated(_newClaimContract);
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
        external
        view
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

    function predictEventAddress(
        uint256 _eventType,
        address _organizer
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(
            _organizer,
            allEvents.length,
            block.timestamp
        ));
        address template = _eventType == 0 ? erc721Template : erc1155Template;
        return Clones.predictDeterministicAddress(template, salt);
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
