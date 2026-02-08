// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// EventContract1155 v2 — ERC1155 ticket contract with zone-based ticket types
//
// Extends EventContract721 logic with:
//   - Multiple ticket types (General, VIP, Backstage, All Access)
//   - Per-type pricing, supply limits, and zone levels
//   - Zone-based access control for scanner verification
//
// See docs/nft-ticket-platform-v2-plan-en.md Section 2.2
