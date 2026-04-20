# GembaTicket — smart contracts & audit artifacts

Audit-grade Solidity layer for **GembaTicket v3**. Non-custodial event ticketing with optional ERC-721 / ERC-1155 NFT collectibles, deployed as EIP-1167 minimal-proxy clones via a `PlatformRegistry` factory.

**Company:** GEMBA EOOD (EIK: 208656371), Varna, Bulgaria
**Network:** Ethereum Sepolia (testnet); production target TBD
**Solidity:** 0.8.28
**Framework:** Hardhat
**Libraries:** OpenZeppelin 5.4 (UUPS upgradeable, EIP-1167 clones, EIP-712)

This directory contains the **public** artifacts of the smart-contract layer:

- `contracts/` — Solidity source (MIT-licensed): `PlatformRegistry.sol`, `EventContract721.sol`, `EventContract1155.sol`, plus `interfaces/`.
- `docs/audit_solidity.md` — formal audit report (Slither, Mythril, functional assertions).
- `docs/nft-ticket-platform-v2-plan*.md` — design documents kept for historical reference.
- `reports/` — raw Slither JSON outputs.
- `slither-report.txt` and `*.config.json` — analyzer outputs and configs.
- `deployed/` — Sepolia deployment addresses (public on-chain record).
- `scripts/` — deployment and verification scripts.
- `hardhat.config.js`, `package.json` — project scaffolding.

Tests (`test/`) and internal Hardhat scripts remain private. A clean-room reviewer can reproduce every audit result from `contracts/` + `hardhat.config.js` + `package.json`.

---

## Four-role security model

Each event contract enforces strict role separation:

| Role | Holder | Permissions |
|---|---|---|
| **Owner** | Organizer wallet (or an initial platform wallet the organizer later claims) | `transferOwnership`, `cancelEvent`, `endEvent`, `setPlatform`, `setMintSigner`, `setOperator`, `renounceOperator`, plus everything Operator can do |
| **Operator** | Platform signer by default; `null` once organizer calls `renounceOperator` | `toggleSale`, `increaseSupply`, `toggleTicketType`, `increaseTypeSupply`, `addTicketType`, `setTokenURI`, `setTypeURI`, `updateBaseURI`, `setURI` |
| **Platform** | Platform signer, one-time | `setupEvent` during deploy. Locked after setup. |
| **MintSigner** | Platform signer, EIP-712 off-chain signer | Signs claim messages validated by `claim(…)`; zero ETH balance |

The Owner ↔ Operator check is implemented as `modifier onlyOwnerOrOperator` on the relevant functions in `EventContract721.sol` and `EventContract1155.sol`.

See [`../docs/CHAIN_ACTIONS.md`](../docs/CHAIN_ACTIONS.md) for the full pipeline that sits on top of the `Operator` role.

---

## Deploy architecture

```
         ┌──────────────────────────┐
         │    PlatformRegistry      │
         │    (UUPS, singleton)     │
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

## Lazy mint + EIP-712 claim

Tickets are **not** minted on sale. Instead:

1. Buyer purchases (fiat via GembaPay, or free issuance by organizer). A `Ticket` row is written to Prisma with `status=PAID`.
2. When the buyer clicks *Claim NFT* in the storefront, the API signs an EIP-712 message binding `(tokenId, buyerAddress, eventContract)` with `MINT_SIGNER_KEY`.
3. The buyer's wallet submits `claim(tokenId, signature, ...)`; the contract verifies via `ecrecover`, mints directly to the buyer's address. The buyer pays gas.

Economics:
- Platform pays: 1 deploy per event (via the clone).
- Organizer pays (off-chain via GembaPay): gas + €5 for each paid chain action.
- Buyer pays: only the claim gas, if they opt-in to collect the NFT.

---

## Audit summary

Full report: [`docs/audit_solidity.md`](./docs/audit_solidity.md).

| Tool | Critical | High | Medium |
|---|---|---|---|
| Slither | 0 | 0 | 0 |
| Mythril | 0 | 0 | 0 |
| Functional assertions | — | — | 220 passed |

Assertions cover:
- Role separation (Owner / Operator / Platform / MintSigner).
- Setup phase lock-in (`setupEvent` cannot be re-run).
- EIP-712 claim signature validation incl. replay + cross-contract rejection.
- Supply, sale, and ticket-type state transitions under `onlyOwnerOrOperator`.
- Free `setOperator` / `renounceOperator` paths.
- Refund flow via `cancelEvent` / `endEvent`.

---

## Deployed addresses

See `deployed/sepolia-latest.json` for the most recent Sepolia deployment addresses (public on-chain record). Historical deployments are preserved in the same folder with ISO-timestamped filenames.

---

## Hardhat project scaffolding

If you want to reproduce the deployment pipeline against your own Solidity source tree:

```bash
npm ci
cp .env.example .env            # fill SEPOLIA_RPC_URL, PRIVATE_KEY, etc.
npx hardhat compile
npx hardhat run scripts/deploy-v2.js --network sepolia
npx hardhat run scripts/test-all.js --network sepolia
```

The scripts expect a `contracts/` folder that is **not** checked into this public repo. Reach out if you need audit-team access to the source.

---

## Integration with the platform

The on-chain layer is one of four tiers in the full system. See the parent [`README.md`](../README.md) and [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the bird's-eye view, and [`docs/CHAIN_ACTIONS.md`](../docs/CHAIN_ACTIONS.md) for the paid action pipeline that drives every post-deploy state change.

---

## License

Proprietary. Copyright 2024-2026 GEMBA EOOD. All rights reserved. Audit artifacts (reports, configs, this README, the docs in this folder) are published for transparency; all other intellectual property is reserved.
