// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Interface for EventContract721 and EventContract1155 common functions
interface IEventContract {
    function activateTicket(uint256 _tokenId) external;
    function cancelEvent() external;
    function endEvent() external;
    function toggleSale() external;
    function totalMinted() external view returns (uint256);
    function isEventCanceled() external view returns (bool);
    function isEventEnded() external view returns (bool);
    function owner() external view returns (address);
    function platform() external view returns (address);
}
