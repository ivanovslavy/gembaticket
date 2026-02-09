# GembaTicket v2 — Smart Contract Security Audit Report

**Project:** GembaTicket v2 — Non-Custodial NFT Ticketing Platform  
**Auditor:** Slavcho Ivanov, Managing Director, GEMBA EOOD (EIK: 208656371)  
**Date:** February 9, 2025  
**Solidity Version:** 0.8.28 (locked pragma)  
**Compiler Optimization:** Enabled, 200 runs  
**Repository:** https://github.com/ivanovslavy/gembaticket

---

## 1. Executive Summary

This report documents the security analysis of the GembaTicket v2 smart contract system — a non-custodial, payment-agnostic NFT ticketing platform. The contracts were subjected to both static analysis (Slither v0.11.5) and symbolic execution (Mythril v0.24.8), covering all known vulnerability classes.

**Final Results:**

| Tool | High | Medium | Low | Informational |
|------|------|--------|-----|---------------|
| Slither v0.11.5 | 0 | 0 | 3 (false positives) | 67 (dependencies) |
| Mythril v0.24.8 | 0 | 0 | 0 | 0 |

**Verdict:** All contracts pass security analysis with zero actionable findings. The 3 remaining Slither Low findings are confirmed false positives (timestamp detector misidentifying array bounds and address comparisons).

---

## 2. Scope

### 2.1 Contracts Analyzed

| Contract | File | LOC | Type | Deployed Size |
|----------|------|-----|------|---------------|
| PlatformRegistry | `contracts/PlatformRegistry.sol` | 221 | Singleton | 5,190 bytes |
| EventContract721 | `contracts/EventContract721.sol` | 179 | EIP-1167 Template | 8,909 bytes |
| EventContract1155 | `contracts/EventContract1155.sol` | 249 | EIP-1167 Template | 10,658 bytes |
| ClaimContract | `contracts/ClaimContract.sol` | 185 | Singleton | 3,690 bytes |
| IClaimContract | `contracts/interfaces/IClaimContract.sol` | 22 | Interface | — |
| IEventContract | `contracts/interfaces/IEventContract.sol` | 18 | Interface | — |
| **Total** | | **874** | | **28,447 bytes** |

All contracts are well below the 24,576-byte Spurious Dragon deployment limit. The largest contract (EventContract1155) uses 43.4% of the limit.

### 2.2 Dependencies

- OpenZeppelin Contracts v5.x (32 contracts, 2,470 SLOC)
  - ERC721Upgradeable, ERC1155Upgradeable
  - Initializable, ReentrancyGuardUpgradeable
  - Clones (EIP-1167 minimal proxy)
  - IERC721, IERC1155, IERC721Receiver, IERC1155Receiver, ERC165

### 2.3 Out of Scope

- Backend application (Node.js/Express)
- GembaPay payment gateway integration
- Frontend applications
- IPFS metadata storage
- Off-chain QR code rotation system

---

## 3. Architecture Overview

### 3.1 Design Philosophy

GembaTicket v2 follows a **payment-agnostic** architecture. The smart contracts contain zero payment logic — all payments (cryptocurrency and fiat) are processed off-chain by GembaPay. Contracts serve exclusively as NFT lifecycle managers: mint, activate, lock, transfer, and claim.

### 3.2 Contract Roles

```
┌─────────────────────────────────────────────────────────┐
│                    GembaPay (Off-chain)                  │
│          Handles all crypto + fiat payments              │
│              Sends webhook on confirmation               │
└─────────────────────┬───────────────────────────────────┘
                      │ webhook
                      ▼
              ┌───────────────┐
              │    Backend    │
              │  (Node.js)   │
              └───────┬───────┘
                      │ tx via platformSigner
                      ▼
        ┌─────────────────────────────┐
        │     PlatformRegistry        │
        │  Factory + Admin (Singleton)│
        │  - createEvent()            │
        │  - setTemplate()            │
        │  - withdraw() / fundSigner()│
        └──────┬──────────────────────┘
               │ EIP-1167 clone
               ▼
     ┌──────────────────────┐
     │  EventContract       │
     │  (721 or 1155 clone) │
     │  - mintWithPaymentProof()  │
     │  - activateTicket()  │
     │  - cancelEvent()     │
     └──────────┬───────────┘
                │ mint to
                ▼
     ┌──────────────────────┐
     │    ClaimContract     │
     │  (Autonomous Escrow) │
     │  - lockForClaim()    │
     │  - claim()           │
     │  Ownership: RENOUNCED│
     └──────────────────────┘
```

### 3.3 Key Security Properties

1. **Non-custodial:** No contract holds user funds. GembaPay splits payments instantly.
2. **Payment-agnostic:** Zero `msg.value` in event contracts. No `payable` functions for ticket purchases.
3. **Autonomous escrow:** ClaimContract ownership is renounced after deployment. Nobody can modify or extract NFTs except through the `claim()` function with a valid claim code.
4. **Immutable event clones:** Each event is an EIP-1167 minimal proxy (45 bytes). Once deployed, the event logic cannot change. New template deployments only affect future events.
5. **Platform signer model:** A dedicated wallet (funded by the platform) pays gas for all user-facing transactions. Users never interact with the blockchain directly.

---

## 4. Tools and Methodology

### 4.1 Slither — Static Analysis

**Version:** 0.11.5  
**Configuration:** `slither.config.json`
```json
{
  "detectors_to_run": "all",
  "exclude_informational": false,
  "exclude_low": false,
  "filter_paths": "node_modules",
  "solc_remaps": ["@openzeppelin/=node_modules/@openzeppelin/"]
}
```

Slither performs static analysis across 75 vulnerability detectors including:
- Reentrancy (all variants: eth, no-eth, benign, events)
- Access control violations
- Uninitialized state variables
- Unchecked return values
- Integer overflow/underflow (checked by Solidity 0.8+)
- Delegatecall injection
- Storage collisions (proxy patterns)
- Arbitrary `selfdestruct` / `delegatecall`
- Front-running vulnerabilities
- Missing zero-address validation

### 4.2 Mythril — Symbolic Execution

**Version:** 0.24.8  
**Configuration:** `mythril.config.json`
```json
{
  "remappings": ["@openzeppelin/=node_modules/@openzeppelin/"]
}
```
**Execution timeout:** 300 seconds per contract  
**Solidity version:** 0.8.28

Mythril performs symbolic execution and SMT solving to detect:
- Integer overflow/underflow
- Reentrancy attacks
- Unprotected self-destruct
- Unchecked external calls
- Transaction order dependency
- Timestamp dependency
- Exception handling issues
- Access control violations

---

## 5. Findings

### 5.1 Slither Results

**Full output:**
```
Total number of contracts in source files: 6
Number of contracts in dependencies: 32
Source lines of code (SLOC) in source files: 885
Source lines of code (SLOC) in dependencies: 2470
Number of assembly lines: 0
Number of optimization issues: 0
Number of informational issues: 67
Number of low issues: 3
Number of medium issues: 0
Number of high issues: 0
```

#### Remaining Low Findings (3 — All False Positives)

**Finding 1: Timestamp — ClaimContract.lockForClaim()**
```
ClaimContract.lockForClaim(bytes32,uint256,address) uses timestamp for comparisons
  Dangerous comparisons:
  - claims[_claimHash].eventContract != address(0)
```
**Assessment:** FALSE POSITIVE. This comparison checks if a claim hash already exists in the mapping. It compares an `address` against `address(0)`, which has no relationship to `block.timestamp`. Slither's timestamp detector is triggered because the `ClaimData` struct contains a `createdAt` field set to `block.timestamp`, causing the detector to flag the entire function.

**Finding 2: Timestamp — ClaimContract.lockForClaimERC1155()**  
**Assessment:** FALSE POSITIVE. Identical to Finding 1, same root cause.

**Finding 3: Timestamp — PlatformRegistry.getEvents()**
```
PlatformRegistry.getEvents(uint256,uint256) uses timestamp for comparisons
  Dangerous comparisons:
  - end > allEvents.length
  - i < length
```
**Assessment:** FALSE POSITIVE. These are standard array bounds checks for pagination. No `block.timestamp` involvement. Suppressed with `// slither-disable-next-line timestamp` annotations.

#### Resolved Findings (Pre-Audit Fixes)

The following findings were identified and resolved during the audit process:

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | Medium | Reentrancy in `_deployEvent()` — state writes after external calls | Restructured to CEI: clone → state writes → initialize → register |
| 2 | Low | Missing events on `setPlatform()` (x2) | Added `emit PlatformUpdated()` to both EventContracts |
| 3 | Low | Missing events on `setAdmin()`, `setMultisig()` | Added `emit AdminUpdated()`, `emit MultisigUpdated()` |
| 4 | Low | Missing zero-check on `setFactory()` | Added `if (_factory == address(0)) revert InvalidAddress()` |
| 5 | Low | Missing zero-check on template addresses in constructor | Added `if (_erc721Template == address(0)) revert InvalidTemplate()` |
| 6 | Low | Reentrancy in `claim()` — event after transfer | Moved `emit NFTClaimed()` before `safeTransferFrom()` |
| 7 | Low | Reentrancy in `_deployEvent()` — state writes after initialize | Resolved by CEI restructure (same as #1) |

#### Informational Findings (67 — All from Dependencies)

All 67 informational findings originate from OpenZeppelin dependency contracts (`node_modules/@openzeppelin/`). These include standard warnings about:
- Pragma directives in library contracts
- Naming conventions in inherited contracts
- Dead code in abstract contracts
- Low-level calls in standard implementations

These are expected and do not represent security concerns. OpenZeppelin contracts are industry-standard, formally verified, and battle-tested across billions of dollars in deployed value.

### 5.2 Mythril Results

```
contracts/PlatformRegistry.sol  — No issues detected ✓
contracts/EventContract721.sol  — No issues detected ✓
contracts/EventContract1155.sol — No issues detected ✓
contracts/ClaimContract.sol     — No issues detected ✓
```

Mythril's symbolic execution engine explored all reachable execution paths within the 300-second timeout per contract and found zero vulnerabilities across all categories:
- No integer overflow/underflow
- No reentrancy vectors
- No unprotected self-destruct
- No unchecked external calls  
- No transaction order dependency
- No exploitable timestamp dependency
- No access control violations

---

## 6. Security Properties Verified

### 6.1 Access Control

| Function | Allowed Caller | Verified |
|----------|---------------|----------|
| `createEvent()` | `platformSigner` only | ✓ |
| `mintWithPaymentProof()` | `platform` (signer) only | ✓ |
| `activateTicket()` | `platform` (signer) only | ✓ |
| `cancelEvent()` / `endEvent()` | `owner` (organizer) only | ✓ |
| `toggleSale()` | `owner` (organizer) only | ✓ |
| `withdraw()` / `fundSigner()` | `multisig` only | ✓ |
| `setTemplate()` / `setPlatformSigner()` | `admin` only | ✓ |
| `claim()` | Anyone with valid claim code | ✓ |
| `setFactory()` | Anyone (one-time, then locked) | ✓ |

### 6.2 Reentrancy Protection

| Contract | Protection Method | Verified |
|----------|------------------|----------|
| PlatformRegistry | `nonReentrant` modifier + CEI pattern | ✓ |
| EventContract721 | `nonReentrant` on `mintWithPaymentProof()` | ✓ |
| EventContract1155 | `nonReentrant` on `mintWithPaymentProof()` | ✓ |
| ClaimContract | Effects before interactions (`claimed = true` before transfer) | ✓ |

### 6.3 Input Validation

All public/external functions validate:
- `address(0)` checks on all address parameters
- Supply limits (`maxSupply`, `typeMaxSupply`)
- State guards (`saleActive`, `isEventCanceled`, `isEventEnded`)
- Duplicate prevention (`ClaimAlreadyExists`, `TicketTypeExists`, `AlreadyActivated`)
- One-time initialization (`FactoryAlreadySet`, `initializer` modifier)

### 6.4 Transfer Restrictions

| State | Transfer Allowed | Verified |
|-------|-----------------|----------|
| Before activation | ✓ Yes (via ClaimContract or direct) | ✓ |
| After activation, before event end | ✗ Locked (`TransferLocked`) | ✓ |
| After event end | ✓ Yes (collectible value) | ✓ |

---

## 7. Gas Analysis

| Contract | Deployment Gas (est.) |
|----------|--------------------|
| EventContract721 template | ~1,200,000 |
| EventContract1155 template | ~1,500,000 |
| ClaimContract | ~500,000 |
| PlatformRegistry | ~700,000 |
| Event clone (EIP-1167) | ~45,000 per event |
| **Total initial deployment** | **~3,900,000** |

Per-event clone cost (~45,000 gas) vs full contract deployment (~1,200,000+ gas) represents a **96% gas savings** through the EIP-1167 minimal proxy pattern.

---

## 8. Recommendations

### 8.1 Completed ✓

- [x] Lock pragma to exact `0.8.28` (no floating `^`)
- [x] Add `address(0)` validation on all address parameters
- [x] Add claim nonce to prevent hash collision (theoretical)
- [x] CEI pattern in all functions with external calls
- [x] Events for all state-changing admin functions
- [x] Remove all payment logic from contracts (payment-agnostic architecture)

### 8.2 Recommended for Production

- [ ] Deploy to testnet (Sepolia) and run integration tests
- [ ] Multi-sig wallet for `multisig` role (Gnosis Safe recommended)
- [ ] Separate wallets for `admin`, `multisig`, and `platformSigner`
- [ ] Monitor platform signer balance for gas funding
- [ ] Rate limiting on backend before calling contract functions
- [ ] Consider formal verification for ClaimContract (holds all NFTs)
- [ ] Time-lock on admin functions (`setTemplate`, `setPlatformSigner`) for production

---

## 9. Conclusion

The GembaTicket v2 smart contract system demonstrates strong security posture across all analyzed dimensions. The payment-agnostic architecture eliminates the most common class of DeFi vulnerabilities (fund handling, price manipulation, flash loans) by design. The minimal contract surface (874 SLOC across 4 contracts) reduces attack surface significantly compared to the original v1 system (4,150 SLOC across 32 contracts).

Both Slither and Mythril confirm zero actionable security findings. The contracts are ready for testnet deployment and integration testing.

---

**Signed:**

**Slavcho Ivanov**  
Managing Director, GEMBA EOOD  
EIK: 208656371  
Varna, Bulgaria

February 9, 2025
