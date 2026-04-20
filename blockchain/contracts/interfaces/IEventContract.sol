// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Common interface for EventContract721 and EventContract1155
interface IEventContract {
    // --- Setup ---
    function enableSale() external;
    function completeSetup() external;

    // --- Lifecycle ---
    function activateTicket(uint256 _tokenId) external;
    function cancelEvent() external;
    function endEvent() external;
    function toggleSale() external;

    // --- Key rotation ---
    function setPlatform(address _new) external;
    function setMintSigner(address _new) external;
    function transferOwnership(address _newOwner) external;

    // --- View ---
    function totalMinted() external view returns (uint256);
    function maxSupply() external view returns (uint256);
    function saleActive() external view returns (bool);
    function isEventCanceled() external view returns (bool);
    function isEventEnded() external view returns (bool);
    function setupComplete() external view returns (bool);
    function owner() external view returns (address);
    function platform() external view returns (address);
    function mintSigner() external view returns (address);
}
