// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IClaimContract {
    function lockForClaim(bytes32 _claimHash, uint256 _tokenId, address _buyer) external;
    function registerEvent(address _eventContract) external;
    function transferClaim(bytes32 _claimHash, address _newBuyer) external;
}
