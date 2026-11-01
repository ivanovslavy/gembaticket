# GembaTicket — smart contracts & audit artifacts

Audit-grade Solidity layer for **GembaTicket v3**. Direct-settlement event ticketing with optional ERC-721 / ERC-1155 NFT collectibles, deployed as EIP-1167 minimal-proxy clones via a `PlatformRegistry` factory.

**Company:** GEMBA EOOD (EIK: 208656371), Varna, Bulgaria
**Network:** **GembaBlockchain** testnet, chainId **821207** (RPC `https://rpc1.gembascan.io`, explorer `https://testnet.gembascan.io`) — migrated off Ethereum Sepolia on 2026-06-08, see [`../docs/migration-gembablockchain.md`](../docs/migration-gembablockchain.md)
**Solidity:** 0.8.28
**Framework:** Hardhat
**Libraries:** OpenZeppelin 5.4 (EIP-1167 clones). Signatures are **EIP-191 `personal_sign`**, not EIP-712.

> **Not upgradeable.** There is no proxy-upgrade mechanism anywhere in this tree: `grep -rn "UUPS" contracts/` returns nothing, `PlatformRegistry` is a plain `contract PlatformRegistry is ReentrancyGuard`, and the event contracts are cloned, not proxied-for-upgrade. EIP-1167 clones share a template's code; they do not make it replaceable. A fix ships as a **new template** plus `setTemplate()`, which is why `deployed/gemba-latest.json` carries a `previousTemplates` block.

This directory contains the **public** artifacts of the smart-contract layer:

- `contracts/` — Solidity source (MIT-licensed), all of it tracked: `PlatformRegistry.sol`, `EventContract721.sol`, `EventContract1155.sol`, `EventContract721V3.sol`, `EventContract1155V3.sol` (the **V3 pair is what is live**) and `interfaces/IEventContract.sol`.
- `docs/audit_solidity.md` — formal audit report (Slither, Mythril, functional tests).
- `docs/nft-ticket-platform-v2-plan*.md` — design documents kept for historical reference.
- `reports/` — raw analyzer output: Slither JSON, the Aderyn report and the bytecode check of 2026-10-30.
- `slither-report.txt` — consolidated Slither run output.
- `deployed/` — deployment addresses (public on-chain record), current record `deployed/gemba-latest.json`.
- `scripts/` — all 8 deployment and verification scripts.
- `hardhat.config.js`, `package.json` — project scaffolding.

Only the tests (`test/`) are private. A clean-room reviewer can reproduce every audit result from `contracts/` + `hardhat.config.js` + `package.json`.

---

## Five-role security model

Each event contract enforces strict role separation:

| Role | Holder | Permissions |
|---|---|---|
| **Owner** | The platform's **offline cold key** by default — every contract is deployed owned by it. An organizer who wants the contract itself can ask in the dashboard and ownership is transferred to their linked wallet. | `transferOwnership`, `cancelEvent`, `endEvent`, `setPlatform`, `setMintSigner`, `setOperator`, `setRelayer`, `renounceOperator`, plus everything Operator can do |
| **Operator** | Platform signer by default; `null` once the owner calls `renounceOperator` | `toggleSale`, `increaseSupply`, `toggleTicketType`, `increaseTypeSupply`, `addTicketType`, `setTokenURI`, `setTypeURI`, `updateBaseURI`, `setURI` |
| **Platform** | Platform signer, one-time | `setupEvent` during deploy. Locked after setup. |
| **Relayer** | A separate broadcasting wallet (backend `RELAYER_KEY`), re-pointed per clone at setup via `setRelayer`; owner-changeable. Added in **v3.1**. | Broadcasts `claimTicketFor(…)` and **pays the mint gas** |
| **MintSigner** | Platform signer's sibling key, EIP-191 off-chain signer; zero balance | Signs the claim authorization validated by **`claimTicketFor(…)`**; never submits a transaction |

The Owner ↔ Operator check is implemented as `modifier onlyOwnerOrOperator` on the relevant functions in `EventContract721V3.sol` and `EventContract1155V3.sol`.

Note that `PlatformRegistry` itself is **not** `Ownable` — it uses an `admin` address behind `modifier onlyAdmin`, so `registry.owner()` reverts and `registry.admin()` is the accessor.

See [`../docs/CHAIN_ACTIONS.md`](../docs/CHAIN_ACTIONS.md) for the full pipeline that sits on top of the `Operator` role.

---

## Deploy architecture

```
         ┌──────────────────────────┐
         │    PlatformRegistry      │
         │  (singleton, not a proxy)│
         │                          │
         │  createEvent(kind,...)   │
         │   → EIP-1167 clone       │
         └─────────┬────────────────┘
                   │
    ┌──────────────┼────────────────┐
    ▼              ▼                ▼
┌────────────┐ ┌─────────────┐ ┌────────────┐
│ Clone of   │ │ Clone of    │ │ Clone of   │
│ ERC721Tpl  │ │ ERC1155Tpl  │ │ ERC1155Tpl │
│ (event A)  │ │ (event B)   │ │ (event C)  │
└────────────┘ └─────────────┘ └────────────┘
```

Gas cost per event deploy is ~100–180k (clone only) vs. millions if each event were a fresh contract.

---

## Lazy mint + EIP-191 relayed claim

Tickets are **not** minted on sale. Instead:

1. Buyer purchases (fiat via GembaPay, or free issuance by organizer). A `Ticket` row is written to Prisma with `status=PAID`.
2. When the buyer clicks *Claim NFT* in the storefront, they sign a **free off-chain ownership message** in their wallet. The API then signs the claim authorization — `(contract, [typeId,] claimHash, recipient)` — with `MINT_SIGNER_KEY`, as an **EIP-191 `personal_sign`** digest (`"\x19Ethereum Signed Message:\n32"`, see `_toEthSignedMessageHash` in `EventContract721V3.sol`).
3. The **platform relayer** broadcasts `claimTicketFor(recipient, [typeId,] claimHash, signature)`; the contract verifies via `ecrecover`, rejects malleable high-s signatures, and mints directly to the buyer's address. Because the mintSigner signature binds the recipient, a compromised relayer cannot redirect a mint.

Economics:
- Platform pays: 1 deploy per event (via the clone), **and the claim gas** — the relayer sponsors it.
- **Buyer pays nothing on-chain.** The holder mints for 0 GMB and only signs a free off-chain message. The only client-pays path (`claimTicket`) is preserved on-chain but its route is disabled.
- Organizer pays: **nothing today.** Fees are **dormant** — live config is `FEES_ENABLED=false` and `backend/src/config/fees.js` gates every charge on it, so deploys and chain actions complete gas-only with no GembaPay charge. In the dormant paid mode the design is `gas + €5` per paid chain action (and €10 for a deploy); nothing was deleted, and no organizer is charged while the flag is off.

---

## Audit summary

Full report: [`docs/audit_solidity.md`](./docs/audit_solidity.md).

| Tool | Critical | High | Medium |
|---|---|---|---|
| Slither | 0 | 0 | 0 |
| Mythril | 0 | 0 | 0 |
| Functional tests | — | — | 81 passing, 0 failing |

The test suite is **81 test cases** containing **129 `expect()` assertions**, across the 4 files in the (private) `test/` folder. Reproduce:

```bash
npx hardhat test                            # → 81 passing
grep -rhoE '\bit\('     test/*.js | wc -l   # → 81   (test cases)
grep -rhoE '\bexpect\(' test/*.js | wc -l   # → 129  (assertions)
```

| File | Test cases | `expect()` |
|---|---|---|
| `GembaTicketV2.test.js` | 57 | 92 |
| `GembaTicketV3.test.js` | 14 | 23 |
| `GembaTicketV3-hardening.test.js` | 3 | 4 |
| `PlatformRegistry-predict.test.js` | 7 | 10 |
| **Total** | **81** | **129** |

Tests cover:
- Role separation (Owner / Operator / Platform / Relayer / MintSigner).
- Setup phase lock-in (`setupEvent` cannot be re-run).
- Claim signature validation incl. replay, cross-contract and high-s rejection.
- Supply, sale, and ticket-type state transitions under `onlyOwnerOrOperator`.
- Free `setOperator` / `renounceOperator` paths.
- Refund flow via `cancelEvent` / `endEvent`.
- `predictEventAddress` salt determinism (see `.knownLimitations` in `deployed/gemba-latest.json` — fixed in source, **not** on the live registry).

---

## Deployed addresses

See [`deployed/gemba-latest.json`](./deployed/gemba-latest.json) for the current deployment (public on-chain record). Historical deployments are preserved in the same folder with ISO-timestamped filenames, including the pre-migration Sepolia records.

Verified live against `https://rpc1.gembascan.io` on 2026-10-31:

| Contract | Address | Code size |
|---|---|---|
| `PlatformRegistry` | `0x32977E6391e7C25BF0Ddc2a5f4c9A311e5bA1d02` | 5 222 B |
| `EventContract721V3` (ACTIVE template) | `0x3Ba630bF309249354F25a22c2f0A3EC6b34183D8` | 12 614 B |
| `EventContract1155V3` (ACTIVE template) | `0x1a7722d1292cd5eB67A05fC8B51DFDe821055cDa` | 15 518 B |

The two template addresses are exactly what the registry returns from `erc721Template()` / `erc1155Template()`.

---

## Hardhat project scaffolding

To reproduce the deployment pipeline:

```bash
npm ci
npx hardhat compile
npx hardhat run scripts/deploy-v3.js --network gemba
npx hardhat test                # 81 passing
```

The `gemba` network is defined in `hardhat.config.js` (chainId 821207) and reads `GEMBA_RPC_URL`
(defaulting to `https://rpc1.gembascan.io`) and `PLATFORM_SIGNER_KEY` from the environment. Note that
the checked-in `.env.example` is **stale** — it is an old backend-shaped file and does not list either
of those two variables.

The `contracts/` folder **is** checked into this public repo — all 6 `.sol` files, MIT-licensed. Only `test/` is withheld.

---

## Integration with the platform

The on-chain layer is one of four tiers in the full system. See the parent [`README.md`](../README.md) and [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the bird's-eye view, and [`docs/CHAIN_ACTIONS.md`](../docs/CHAIN_ACTIONS.md) for the action pipeline that drives every post-deploy state change.

---

## License

**Smart-contract source in `contracts/` is MIT-licensed** — every `.sol` file begins `// SPDX-License-Identifier: MIT`, and that licence governs it.

The documentation and audit artifacts in this folder (reports, this README, the docs) are © 2024-2026 GEMBA EOOD, published for transparency. The application source — `backend/`, `frontend/`, `scanner/` — is **not published** and remains proprietary.
