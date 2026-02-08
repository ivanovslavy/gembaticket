// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IEventContract {
    function initialize(bytes calldata _initData, address _owner, address _platform, address _treasury, address _claimContract) external;
    function activateTicket(uint256 _tokenId) external;
    function cancelEvent() external;
    function endEvent() external;
}
