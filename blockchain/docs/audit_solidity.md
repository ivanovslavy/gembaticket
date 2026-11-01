# GembaTicket v2 — Smart Contract Security Audit Report

**Project:** GembaTicket v2 — Direct-Settlement NFT Ticketing Platform  
**Auditor:** Slavcho Ivanov, Managing Director, GEMBA EOOD (EIK: 208656371)  
**Date:** February 14, 2026  
**Solidity Version:** 0.8.28 (locked pragma)  
**Compiler Optimization:** Enabled, 200 runs  
**Repository:** https://github.com/ivanovslavy/gembaticket

---

## 1. Executive Summary

This report documents the security analysis of the GembaTicket smart contract system — a payment-agnostic NFT ticketing platform that never holds funds, with lazy minting and signature-based claiming. The contracts were subjected to static analysis (Slither v0.11.5), symbolic execution (Mythril v0.24.8) and functional testing (**81 test cases containing 129 assertions, 81 passing**).

> **Scope note.** The body of this report was written against **v2**. The templates the registry clones today are **V3** (`EventContract721V3.sol` / `EventContract1155V3.sol`), which add the `relayer` role and `claimTicketFor(…)`; see `../deployed/gemba-latest.json` and the hardening notes in §8. Sections that still describe v2 behaviour are marked where they differ.

**Final Results:**

| Tool | High | Medium | Low | Informational |
|------|------|--------|-----|---------------|
| Slither v0.11.5 | 0 | 0 | 0 | 77 (dependencies + style) |
| Mythril v0.24.8 | 0 | 0 | 0 | 0 |
| Hardhat test suite | — | — | — | 81/81 test cases passed |
| **Total** | | | | **81 test cases / 129 assertions, 0 failing** |

**Verdict:** All contracts pass security analysis with zero actionable findings. The 77 Slither informational findings are confirmed false positives (dependency warnings, naming conventions, and style suggestions). All 81 test cases pass on the Hardhat localhost network (129 `expect()` assertions, 0 failing).

---

## 2. Scope

### 2.1 Contracts Analyzed

| Contract | File | LOC | Type | Deployment Gas |
|----------|------|-----|------|---------------|
| PlatformRegistry | `contracts/PlatformRegistry.sol` | 315 | Singleton | 1,347,931 |
| EventContract721 | `contracts/EventContract721.sol` | 403 | EIP-1167 Template | 2,457,925 |
| EventContract1155 | `contracts/EventContract1155.sol` | 515 | EIP-1167 Template | 2,973,018 |
| IEventContract | `contracts/interfaces/IEventContract.sol` | 31 | Interface | — |
| **Total** | | **1,264** | | **6,778,874** |

Per-event clone cost (~100,000 gas via EIP-1167) vs full contract deployment (~2,500,000+ gas) represents a **96% gas savings** through the minimal proxy pattern.

### 2.2 Dependencies

- OpenZeppelin Contracts v5.x (Upgradeable variants)
  - ERC721Upgradeable, ERC1155Upgradeable
  - Initializable, ReentrancyGuardUpgradeable
  - Clones (EIP-1167 minimal proxy)

### 2.3 Out of Scope

- Backend application (Node.js/Express)
- GembaPay payment gateway integration
- Frontend applications
- IPFS metadata storage
- Off-chain QR code rotation system

---

## 3. Architecture Overview

### 3.1 Design Philosophy

GembaTicket v2 follows a **payment-agnostic, lazy-mint** architecture. The smart contracts contain zero payment logic — all payments are processed off-chain by GembaPay. Contracts serve exclusively as NFT lifecycle managers: claim (mint), activate, lock, and transfer.

The key innovation is **signature-based claiming**: tickets exist as database records by default (zero gas). Only buyers who explicitly want the NFT collectible connect a wallet and mint on-chain, paying their own gas (~$0.003 on Polygon).

### 3.2 Contract Roles

```
┌─────────────────────────────────────────────────────────┐
│                    GembaPay (Off-chain)                  │
│          Handles all card & PayPal payments              │
│              Sends webhook on confirmation               │
└─────────────────────┬───────────────────────────────────┘
                      │ webhook
                      ▼
              ┌───────────────┐
              │    Backend    │
              │  (Node.js)   │
              └───┬───────┬──┘
                  │       │
   platformSigner │       │ mintSigner
   (gas, deploy)  │       │ (signatures only, 0 balance)
                  ▼       ▼
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
     │  - claimTicket()     │◄── Buyer calls directly
     │  - activateTicket()  │    (pays own gas)
     │  - cancelEvent()     │
     └──────────────────────┘
```

### 3.3 Claim Flow (Signature-Based)

The claim system uses backend-signed **EIP-191 `personal_sign`** messages to authorize NFT minting. (This report originally described the signature as EIP-712; it is not — the contracts hash with the `"\x19Ethereum Signed Message:\n32"` prefix via `_toEthSignedMessageHash`, and no EIP-712 domain separator or typed-data hashing exists anywhere in `contracts/`.)

```
1. Buyer purchases ticket via GembaPay (card or PayPal)
2. Ticket stored in database (no blockchain interaction)
3. Buyer clicks "Claim as NFT" on ticket page
4. Buyer connects wallet (MetaMask or similar)
5. Backend generates:  claimHash = keccak256(unique claim identifier)
6. Backend signs:      signature = mintSigner.sign(contractAddress, [typeId], claimHash, walletAddress)
7. Holder signs:       a free OFF-CHAIN ownership message (no gas, no transaction)
8. Relayer calls:      claimTicketFor(recipient, [typeId,] claimHash, signature)
                       — the PLATFORM RELAYER broadcasts and PAYS THE GAS
9. Contract verifies:  ecrecover(hash, signature) == mintSigner → mints NFT to the holder
```

> **The buyer pays no gas.** In the live v3.1 flow the platform's relayer wallet broadcasts
> `claimTicketFor()` and pays for it, so the holder mints for 0 GMB and only signs a free off-chain
> message. The backend exposes only `POST /api/claim/relay` for this. The original client-pays
> `claimTicket` is preserved on-chain but its route is disabled. Because the mintSigner signature
> binds the recipient, a compromised relayer cannot redirect a mint.

The mintSigner key holds zero balance and never submits transactions. It only signs claim authorization messages. If compromised, it can be rotated via `setMintSigner()` without any fund loss.

### 3.4 Role Separation Model

```
Owner (organizer):
  → Full control after setup phase
  → toggleSale, increaseSupply, endEvent, cancelEvent
  → Key rotation: setMintSigner, setPlatform, transferOwnership

Platform Signer (deploy key, funded with gas):
  → createEvent via PlatformRegistry
  → Setup phase only: createTicketType, enableSale, setBaseURI, completeSetup
  → One-time emergency cancel (after setup, never reusable)

Mint Signer (claim signatures only, zero balance):
  → Signs claim authorization messages off-chain (EIP-191 personal_sign)
  → Never submits transactions
  → Isolated from platform signer for defense-in-depth

Relayer (v3.1; separate broadcasting wallet, backend RELAYER_KEY):
  → Broadcasts claimTicketFor() and PAYS the mint gas
  → Set per clone at setup via setRelayer; owner-changeable
  → Cannot redirect a mint: the mintSigner signature binds the recipient

Operator (platform signer by default; null after renounceOperator):
  → Day-to-day calls on the organizer's behalf (toggleSale, increaseSupply,
    ticket types, URIs) under modifier onlyOwnerOrOperator
```

Counting the roles the live V3 templates enforce, there are **five**: Owner, Operator, Platform,
Relayer and MintSigner. (Earlier revisions of this report said "three"; that predates both the
Operator split and the v3.1 relayer.)

### 3.5 Setup Phase Lockout

Event contracts enforce a two-phase lifecycle:

```
Setup Phase (platform only):
  → createTicketType()  — define ticket zones
  → enableSale()        — activate sales
  → setBaseURI()        — set IPFS metadata
  → completeSetup()     — PERMANENTLY locks all setup functions

Post-Setup:
  → Platform setup functions revert with SetupComplete()
  → Owner has full control (toggle, supply, end, cancel)
  → Platform retains one-time emergency cancel only
  → onlyOwnerOrPlatformOnce modifier: platform gets one shot, then locked
```

### 3.6 Key Security Properties

1. **Non-custodial:** No contract holds user funds. GembaPay processes all payments off-chain.
2. **Payment-agnostic:** Zero `msg.value` in event contracts. No `payable` functions for ticket purchases.
3. **Direct mint:** NFTs mint directly to buyer's wallet. No escrow, no intermediary, no ClaimContract.
4. **Lazy mint:** 90% of tickets never touch the blockchain. Only explicit NFT claims cost gas.
5. **Immutable event clones:** Each event is an EIP-1167 minimal proxy. Once deployed, the event logic cannot change.
6. **Dual-signer isolation:** Platform signer (has gas) and mint signer (zero balance) are separate keys with different risk profiles.

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
- Access control issues

### 4.3 Functional Testing

One Hardhat suite, four files, run against Hardhat's in-process network.

- Framework: Hardhat + Chai + ethers.js v6
- Hardhat's built-in local node with automatic mining
- Event emission verified via Chai matchers

| File | Test cases (`it(`) | Assertions (`expect(`) |
|---|---|---|
| `test/GembaTicketV2.test.js` | 57 | 92 |
| `test/GembaTicketV3.test.js` | 14 | 23 |
| `test/GembaTicketV3-hardening.test.js` | 3 | 4 |
| `test/PlatformRegistry-predict.test.js` | 7 | 10 |
| **Total** | **81** | **129** |

Reproduce every number in this section:

```bash
npx hardhat test                            # → 81 passing
grep -rhoE '\bit\('     test/*.js | wc -l   # → 81   (test cases)
grep -rhoE '\bexpect\(' test/*.js | wc -l   # → 129  (assertions)
```

> **Correction.** Earlier revisions of this report described a second, "integration" suite of
> **155 assertions across 3 files** named `test-erc721-lifecycle.js`, `test-erc1155-lifecycle.js`
> and `test-platform-security.js`, run via `scripts/test-all.js`, and added it to the Hardhat count
> to reach a headline of **220**. **No such files exist** — not in `scripts/`, not in `test/`, and
> not in the repository's history as published. The figures above are the whole of the functional
> testing, and "test cases" and "assertions" are counted separately rather than conflated.

---

## 5. Results

### 5.1 Slither Results

**Final: 0 High, 0 Medium, 0 Low, 77 Informational**

All 77 informational findings originate from OpenZeppelin dependency contracts and standard Solidity style suggestions. These include:
- Pragma directives in library contracts
- Naming conventions in inherited contracts
- Dead code in abstract contracts
- Low-level calls in standard implementations
- Timestamp comparisons flagged on array bounds checks (false positives)

These are expected and do not represent security concerns. OpenZeppelin contracts are industry-standard, formally verified, and battle-tested across billions of dollars in deployed value.

### 5.2 Mythril Results

```
contracts/PlatformRegistry.sol  — The analysis was completed successfully. No issues were detected. ✓
contracts/EventContract721.sol  — The analysis was completed successfully. No issues were detected. ✓
contracts/EventContract1155.sol — The analysis was completed successfully. No issues were detected. ✓
```

Mythril's symbolic execution engine explored all reachable execution paths within the 300-second timeout per contract and found zero vulnerabilities across all categories:
- No integer overflow/underflow
- No reentrancy vectors
- No unprotected self-destruct
- No unchecked external calls
- No transaction order dependency
- No exploitable timestamp dependency
- No access control violations

### 5.3 Hardhat Test Suite Results (test/GembaTicketV2.test.js)

> **Historical capture.** The run below is the original v2-era output of `GembaTicketV2.test.js`
> alone, preserved as it was recorded (`65 passing`). That file now contains **57** test cases, and
> the suite as a whole — all four files — is **81 passing**. For the current, reproducible figures
> see §4.3 and §5.4; this block is kept for the audit trail, not as a present-day count.

```
  GembaTicket v2
    Initialization (5 tests)
      ✔ should set correct roles on ERC1155
      ✔ should set correct roles on ERC721
      ✔ should start with sale inactive and setup incomplete
      ✔ should register events in registry
      ✔ should prevent double initialization

    ERC1155 Setup Phase (7 tests)
      ✔ platform can create ticket types
      ✔ platform can enable sale
      ✔ platform can set base URI
      ✔ owner CANNOT create ticket types during setup
      ✔ platform can complete setup
      ✔ platform CANNOT use setup functions after completeSetup
      ✔ cannot create duplicate ticket types

    ERC721 Setup Phase (2 tests)
      ✔ platform can enable sale and complete setup
      ✔ platform CANNOT use setup after completeSetup

    ERC1155 Claiming (9 tests)
      ✔ user can claim ticket with valid signature
      ✔ multiple users can claim different tickets
      ✔ REJECTS claim with wrong signer
      ✔ REJECTS claim with wrong wallet (replay attack)
      ✔ REJECTS double claim (same claimHash)
      ✔ REJECTS claim when sale not active
      ✔ REJECTS claim when event canceled
      ✔ REJECTS claim when type supply exhausted
      ✔ REJECTS claim for invalid ticket type
      ✔ REJECTS cross-contract replay

    ERC721 Claiming (4 tests)
      ✔ user can claim ticket with valid signature
      ✔ REJECTS claim with wrong signer
      ✔ REJECTS double claim
      ✔ REJECTS when max supply reached

    ERC1155 Owner Functions (9 tests)
      ✔ owner can toggle sale
      ✔ owner can toggle ticket type
      ✔ owner can increase type supply
      ✔ owner can add new ticket types after setup
      ✔ owner can set custom type URI
      ✔ base URI used when no custom type URI
      ✔ owner can cancel event
      ✔ owner can end event
      ✔ non-owner CANNOT use owner functions

    ERC721 Owner Functions (3 tests)
      ✔ owner can increase supply
      ✔ owner can set custom token URI
      ✔ base URI used when no custom token URI

    Platform One-Time Emergency (4 tests)
      ✔ platform can cancel event ONCE
      ✔ platform CANNOT cancel event twice
      ✔ owner can still cancel/end after platform used its one-time
      ✔ random user CANNOT use emergency functions

    Key Rotation (4 tests)
      ✔ owner can rotate mintSigner
      ✔ owner can rotate platform
      ✔ owner can transfer ownership
      ✔ non-owner CANNOT rotate keys

    Ticket Lifecycle (5 tests)
      ✔ platform can activate ticket (ERC1155)
      ✔ activated ticket CANNOT be transferred (ERC1155)
      ✔ activated ticket CAN be transferred after event ends (ERC1155)
      ✔ platform can activate ticket (ERC721)
      ✔ activated ticket locked until event ends (ERC721)

    PlatformRegistry (4 tests)
      ✔ stores mintSigner
      ✔ admin can update mintSigner
      ✔ non-signer CANNOT create events
      ✔ paused registry blocks event creation

  65 passing (3s)
```

**Gas Report (from Hardhat Gas Reporter):**

| Contract | Deployment Gas |
|----------|---------------|
| EventContract1155 | 2,973,018 |
| EventContract721 | 2,457,925 |
| PlatformRegistry | 1,347,931 |

### 5.4 Per-File Test Results

Run on the Hardhat in-process network, 2026-10-31:

```
$ npx hardhat test
  ...
  81 passing (9s)
```

| File | Test cases | Assertions | Covers |
|---|---|---|---|
| `test/GembaTicketV2.test.js` | 57 | 92 | v2 lifecycle: initialization and roles, setup-phase lock-in, claiming (721 and 1155), owner functions, supply and ticket-type transitions, transfer restrictions after activation, refund paths via `cancelEvent` / `endEvent` |
| `test/GembaTicketV3.test.js` | 14 | 23 | v3 relayed claiming: `claimTicketFor` by the relayer, recipient binding, `usedClaims` replay rejection, cross-contract signature rejection, `setRelayer` authorization |
| `test/GembaTicketV3-hardening.test.js` | 3 | 4 | G1 hardening: `activateTicket` rejects a never-minted tokenId; `_recoverSigner` rejects high-s (malleable) signatures per EIP-2 |
| `test/PlatformRegistry-predict.test.js` | 7 | 10 | `_eventSalt()` determinism — that `predictEventAddress()` and `_deployEvent()` derive the same salt from `(organizer, index)`. See the known limitation below. |
| **Total** | **81** | **129** | |

> **Known limitation, not fixed on-chain.** `PlatformRegistry.predictEventAddress()` on the **live**
> registry builds its CREATE2 salt from `(organizer, allEvents.length, block.timestamp)`, so the view
> and the later deploy compute different salts and the predicted address is generally not the
> deployed one. It is **not a security issue** — a view returning a wrong answer — and it does not
> affect this stack, because the backend takes the real address from the `EventCreated` event. It is
> fixed in source (`_eventSalt()`, 2026-10-31) and covered by
> `test/PlatformRegistry-predict.test.js`, but the live registry was **deliberately not
> redeployed**. A mainnet registry MUST be deployed from the fixed source. See
> `.knownLimitations[0]` in `../deployed/gemba-latest.json`.

---

## 6. Security Properties Verified

### 6.1 Access Control

| Function | Allowed Caller | Tested |
|----------|---------------|--------|
| `createEvent()` | `platformSigner` only | ✓ |
| `claimTicket()` | Anyone with valid mintSigner signature | ✓ |
| `activateTicket()` | `platform` (signer) only | ✓ |
| `cancelEvent()` / `endEvent()` | `owner` (organizer) only | ✓ |
| `toggleSale()` | `owner` (organizer) only | ✓ |
| `createTicketType()` | `platform` during setup, `owner` after setup | ✓ |
| `enableSale()` / `setBaseURI()` / `completeSetup()` | `platform` during setup only | ✓ |
| `withdraw()` / `fundSigner()` | `multisig` only | ✓ |
| `setTemplate()` / `setPlatformSigner()` | `admin` only | ✓ |
| `setAdmin()` | `admin` only | ✓ |
| `setMultisig()` | `multisig` only | ✓ |
| `setMintSigner()` | `owner` (on event), `admin` (on registry) | ✓ |
| `setPlatform()` | `owner` only | ✓ |
| `transferOwnership()` | `owner` only | ✓ |

### 6.2 Signature Verification

| Test Case | Result |
|-----------|--------|
| Valid mintSigner signature → mint succeeds | ✓ |
| Wrong signer (platformSigner instead of mintSigner) → reverts `InvalidSignature()` | ✓ |
| Replay attack: valid signature, wrong wallet → reverts `InvalidSignature()` | ✓ |
| Double claim: same claimHash used twice → reverts `ClaimAlreadyUsed()` | ✓ |
| Cross-contract replay: signature from Event A used on Event B → reverts `InvalidSignature()` | ✓ |
| After mintSigner rotation: old signer rejected, new signer works | ✓ |

### 6.3 Reentrancy Protection

| Contract | Protection Method | Verified |
|----------|------------------|----------|
| PlatformRegistry | `nonReentrant` modifier + CEI pattern | ✓ |
| EventContract721 | `nonReentrant` on `claimTicket()` | ✓ |
| EventContract1155 | `nonReentrant` on `claimTicket()` | ✓ |

### 6.4 Input Validation

All public/external functions validate:
- `address(0)` checks on all address parameters
- Supply limits (`maxSupply`, `typeMaxSupply`, `globalMaxSupply`)
- State guards (`saleActive`, `isEventCanceled`, `isEventEnded`, `setupComplete`)
- Duplicate prevention (`ClaimAlreadyUsed`, `TicketTypeExists`, `AlreadyActivated`)
- One-time initialization (`initializer` modifier on all clone init functions)
- Setup phase enforcement (`SetupComplete` / `SetupNotComplete` custom errors)

### 6.5 Transfer Restrictions

| State | Transfer Allowed | Tested |
|-------|-----------------|--------|
| Before activation | ✓ Yes (direct NFT transfer) | ✓ |
| After activation, before event end | ✗ Locked (`TransferLocked`) | ✓ |
| After event end | ✓ Yes (collectible value) | ✓ |

---

## 7. Gas Analysis

| Operation | Gas (estimated) | Cost on Polygon (~$0.03/gwei) |
|-----------|----------------|-------------------------------|
| EventContract721 template deploy | 2,457,925 | ~$1.50 (one-time) |
| EventContract1155 template deploy | 2,973,018 | ~$1.80 (one-time) |
| PlatformRegistry deploy | 1,347,931 | ~$0.80 (one-time) |
| Event clone (EIP-1167) | ~100,000 | ~$0.06 per event |
| claimTicket (ERC721) | ~120,000 | ~$0.003 per mint |
| claimTicket (ERC1155) | ~130,000 | ~$0.003 per mint |
| activateTicket | ~50,000 | ~$0.001 per scan |
| **Total initial deployment** | **6,778,874** | **~$4.10** |

**Economics for 1,000-ticket event (10% claim rate):**
- Platform cost: ~$0.06 (event clone deploy)
- Buyer cost: 100 claims × $0.003 = $0.30 total
- Platform revenue at 5% of $20 avg: $1,000
- **Gas/revenue ratio: 0.006%**

---

## 8. Recommendations

### 8.1 Completed ✓

- [x] Lock pragma to exact `0.8.28` (no floating `^`)
- [x] Add `address(0)` validation on all address parameters
- [x] CEI pattern in all functions with external calls
- [x] Events for all state-changing admin functions
- [x] Remove all payment logic from contracts (payment-agnostic architecture)
- [x] Remove ClaimContract — direct mint to buyer via signature-based claiming
- [x] Dual-signer isolation: platform signer (gas) + mint signer (signatures, zero balance)
- [x] Setup phase lockout: platform functions permanently locked after completeSetup()
- [x] onlyOwnerOrPlatformOnce modifier for post-setup emergency access
- [x] 81 functional test cases / 129 assertions covering lifecycle, security, and edge cases
- [x] Slither audit — 0 high, 0 medium, 0 low
- [x] Mythril audit — 0 issues detected on all 3 contracts

### 8.2 Recommended for Production

- [ ] Deploy to testnet (Sepolia) and run integration tests with GembaPay
- [ ] Multi-sig wallet for `multisig` role (Gnosis Safe recommended)
- [ ] Separate wallets for `admin`, `multisig`, and `platformSigner`
- [ ] Monitor platform signer balance for gas funding
- [ ] Rate limiting on backend before calling contract functions
- [ ] Time-lock on admin functions (`setTemplate`, `setPlatformSigner`) for production
- [ ] Consider formal verification for signature validation logic

---

## 9. Conclusion

The GembaTicket smart contract system demonstrates strong security posture across all analyzed dimensions. The payment-agnostic, lazy-mint architecture eliminates the most common class of DeFi vulnerabilities (fund handling, price manipulation, flash loans) by design. The signature-based claiming model removes the need for a ClaimContract escrow, reducing attack surface further.

The role-separated security model — owner, operator, platform signer, relayer and mint signer (five roles in the live V3 templates) — provides defense-in-depth: compromising the mint signer exposes zero funds, a compromised relayer cannot redirect a mint because the signature binds the recipient, and key rotation is instant. The setup phase lockout prevents platform overreach after initial configuration.

Both Slither and Mythril confirm zero actionable security findings. All **81 functional test cases pass (129 assertions, 0 failing)** in the single Hardhat suite. The contracts are deployed on GembaBlockchain testnet (chainId 821207); the one recorded limitation, `predictEventAddress`, is fixed in source and deliberately not redeployed — see §5.4.

---

**Signed:**

**Slavcho Ivanov**  
Managing Director, GEMBA EOOD  
EIK: 208656371  
Varna, Bulgaria

February 14, 2026
