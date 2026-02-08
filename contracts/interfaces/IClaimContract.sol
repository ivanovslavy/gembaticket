// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IClaimContract {
    function lockForClaim(
        bytes32 _claimHash,
        uint256 _tokenId,
        address _buyer
    ) external;

    function lockForClaimERC1155(
        bytes32 _claimHash,
        uint256 _tokenId,
        address _buyer
    ) external;

    function registerEvent(address _eventContract) external;

    function transferClaim(
        bytes32 _claimHash,
        address _newBuyer
    ) external;

    function getClaimStatus(bytes32 _claimHash)
        external
        view
        returns (
            bool exists,
            bool claimed,
            address buyer,
            address eventContract,
            uint256 tokenId
        );
}
