// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// EventContract721 v2 — ERC721 ticket contract with embedded payment logic
//
// Responsibilities:
//   - Crypto payments with on-chain split (95% organizer, 5% treasury)
//   - Fiat proof minting (called by platform signer after GembaPay webhook)
//   - Ticket lifecycle: activate on first scan, lock transfers
//   - Event management: cancel, end, toggle sale
//   - Mint to ClaimContract (non-custodial NFT holding)
//
// See docs/nft-ticket-platform-v2-plan-en.md Section 2.2
