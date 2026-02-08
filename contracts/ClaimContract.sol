// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// ClaimContract — Autonomous NFT holding with renounced ownership
//
// Responsibilities:
//   - Hold NFTs minted by EventContracts until users claim them
//   - Verify claim codes (keccak256 hash matching)
//   - Transfer NFTs to user wallets on claim
//   - Transfer claim ownership on ticket transfer (before activation)
//   - Register new event contracts (called by Factory)
//
// Ownership is renounced after deployment.
//
// See docs/nft-ticket-platform-v2-plan-en.md Section 2.3
