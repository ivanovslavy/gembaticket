// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/// @title ClaimContract — Autonomous NFT holding with renounced ownership
/// @notice Holds NFTs minted by EventContracts until users claim them.
///         Ownership is renounced after setup — nobody controls this contract.
/// @dev Only registered event contracts can lock claims.
///      Only the PlatformRegistry can register events.
contract ClaimContract is IERC721Receiver, IERC1155Receiver, ERC165 {

    // =========================================================================
    // ERRORS
    // =========================================================================

    error NotFactory();
    error NotRegisteredEvent();
    error ClaimAlreadyExists();
    error InvalidClaimCode();
    error AlreadyClaimed();
    error NotAuthorized();
    error FactoryAlreadySet();
    error InvalidAddress();

    // =========================================================================
    // EVENTS
    // =========================================================================

    event ClaimLocked(
        bytes32 indexed claimHash,
        address indexed eventContract,
        uint256 tokenId,
        address buyer
    );
    event NFTClaimed(
        bytes32 indexed claimHash,
        address indexed wallet,
        uint256 tokenId,
        address eventContract
    );
    event ClaimTransferred(
        bytes32 indexed claimHash,
        address indexed from,
        address indexed to
    );
    event EventRegistered(address indexed eventContract);
    event FactorySet(address indexed factory);

    // =========================================================================
    // STATE
    // =========================================================================

    struct ClaimData {
        address eventContract;
        uint256 tokenId;
        address buyer;
        bool claimed;
        bool isERC1155;
        uint256 createdAt;
    }

    address public factory;
    mapping(bytes32 => ClaimData) public claims;
    mapping(address => bool) public registeredEvents;

    // =========================================================================
    // SETUP (one-time)
    // =========================================================================

    /// @notice Set the factory (PlatformRegistry) address. Can only be called once.
    /// @param _factory Address of the PlatformRegistry contract
    function setFactory(address _factory) external {
        if (_factory == address(0)) revert InvalidAddress();
        if (factory != address(0)) revert FactoryAlreadySet();
        factory = _factory;
        emit FactorySet(_factory);
    }

    // =========================================================================
    // FACTORY FUNCTIONS
    // =========================================================================

    /// @notice Register a new event contract as trusted. Called by PlatformRegistry.
    /// @param _eventContract Address of the newly deployed event clone
    function registerEvent(address _eventContract) external {
        if (msg.sender != factory) revert NotFactory();
        registeredEvents[_eventContract] = true;
        emit EventRegistered(_eventContract);
    }

    // =========================================================================
    // EVENT CONTRACT FUNCTIONS
    // =========================================================================

    /// @notice Lock an NFT for future claiming. Called by event contracts after minting.
    /// @param _claimHash Keccak256 hash used to verify the claim code
    /// @param _tokenId Token ID of the minted NFT
    /// @param _buyer Address of the buyer (for verification and transfer tracking)
    function lockForClaim(
        bytes32 _claimHash,
        uint256 _tokenId,
        address _buyer
    ) external {
        if (!registeredEvents[msg.sender]) revert NotRegisteredEvent();
        if (claims[_claimHash].eventContract != address(0)) revert ClaimAlreadyExists();
        if (_buyer == address(0)) revert InvalidAddress();

        claims[_claimHash] = ClaimData({
            eventContract: msg.sender,
            tokenId: _tokenId,
            buyer: _buyer,
            claimed: false,
            isERC1155: false,
            createdAt: block.timestamp
        });

        emit ClaimLocked(_claimHash, msg.sender, _tokenId, _buyer);
    }

    /// @notice Lock an ERC1155 NFT for future claiming.
    /// @param _claimHash Keccak256 hash used to verify the claim code
    /// @param _tokenId Token ID of the minted NFT
    /// @param _buyer Address of the buyer
    function lockForClaimERC1155(
        bytes32 _claimHash,
        uint256 _tokenId,
        address _buyer
    ) external {
        if (!registeredEvents[msg.sender]) revert NotRegisteredEvent();
        if (claims[_claimHash].eventContract != address(0)) revert ClaimAlreadyExists();
        if (_buyer == address(0)) revert InvalidAddress();

        claims[_claimHash] = ClaimData({
            eventContract: msg.sender,
            tokenId: _tokenId,
            buyer: _buyer,
            claimed: false,
            isERC1155: true,
            createdAt: block.timestamp
        });

        emit ClaimLocked(_claimHash, msg.sender, _tokenId, _buyer);
    }

    // =========================================================================
    // USER FUNCTIONS
    // =========================================================================

    /// @notice Claim an NFT by providing the claim code. Transfers NFT to caller's wallet.
    /// @param _claimCode The plain-text claim code (hashed to match claimHash)
    /// @param _destinationWallet Wallet address to receive the NFT
    function claim(
        string calldata _claimCode,
        address _destinationWallet
    ) external {
        if (_destinationWallet == address(0)) revert InvalidAddress();
        bytes32 claimHash = keccak256(abi.encodePacked(_claimCode));
        ClaimData storage data = claims[claimHash];

        if (data.eventContract == address(0)) revert InvalidClaimCode();
        if (data.claimed) revert AlreadyClaimed();

        data.claimed = true;

        emit NFTClaimed(claimHash, _destinationWallet, data.tokenId, data.eventContract);

        if (data.isERC1155) {
            IERC1155(data.eventContract).safeTransferFrom(
                address(this),
                _destinationWallet,
                data.tokenId,
                1,
                ""
            );
        } else {
            IERC721(data.eventContract).safeTransferFrom(
                address(this),
                _destinationWallet,
                data.tokenId
            );
        }
    }

    /// @notice Transfer claim ownership to a new buyer (before NFT is claimed).
    ///         Can be called by current buyer or the event contract (for platform transfers).
    /// @param _claimHash The claim hash to transfer
    /// @param _newBuyer New buyer address
    function transferClaim(
        bytes32 _claimHash,
        address _newBuyer
    ) external {
        ClaimData storage data = claims[_claimHash];
        if (data.eventContract == address(0)) revert InvalidClaimCode();
        if (data.claimed) revert AlreadyClaimed();
        if (msg.sender != data.buyer && msg.sender != data.eventContract)
            revert NotAuthorized();

        address oldBuyer = data.buyer;
        data.buyer = _newBuyer;
        emit ClaimTransferred(_claimHash, oldBuyer, _newBuyer);
    }

    // =========================================================================
    // VIEW FUNCTIONS
    // =========================================================================

    /// @notice Check if a claim exists and its status
    function getClaimStatus(bytes32 _claimHash)
        external
        view
        returns (
            bool exists,
            bool claimed,
            address buyer,
            address eventContract,
            uint256 tokenId
        )
    {
        ClaimData storage data = claims[_claimHash];
        exists = data.eventContract != address(0);
        claimed = data.claimed;
        buyer = data.buyer;
        eventContract = data.eventContract;
        tokenId = data.tokenId;
    }

    // =========================================================================
    // RECEIVER IMPLEMENTATIONS
    // =========================================================================

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC165, IERC165)
        returns (bool)
    {
        return
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(IERC1155Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
