# GembaTicket — static analysis of the live contract generation

**Date:** 2026-10-30 · **Network:** GembaChain testnet (chainId 821207) · **Tools:** Slither 0.11.3,
Aderyn (Cyfrin), solc 0.8.28 · **Scope:** the three contracts that are actually deployed and cloned
today — `PlatformRegistry`, `EventContract721V3`, `EventContract1155V3` (plus their interfaces).

This is an internal static analysis by the development team, not an independent audit.

## 0. The analysis was run on the code that is live — proven, not assumed

A static analysis of a source file says nothing unless that file is what the chain runs. The
compiled artefact of each contract was compared with `eth_getCode` at its deployed address:

| contract | address | artefact | on chain | identical |
|---|---|---|---|---|
| `PlatformRegistry` | `0x32977E6391e7C25BF0Ddc2a5f4c9A311e5bA1d02` | 5 222 B | 5 222 B | **byte-for-byte ✅** |
| `EventContract721V3` | `0x3Ba630bF309249354F25a22c2f0A3EC6b34183D8` | 12 614 B | 12 614 B | **byte-for-byte ✅** |
| `EventContract1155V3` | `0x1a7722d1292cd5eB67A05fC8B51DFDe821055cDa` | 15 518 B | 15 518 B | **byte-for-byte ✅** |

The G1 hardening is on the chain: the EIP-2 low-s constant
`0x7fff…5d576e7357a4501ddfe92f46681b20a0` is present in both deployed templates (and, correctly,
absent from the registry, which verifies no signatures). The earlier note that "G1 exists only as
source" is out of date — it was true on 03.10 and was fixed by the 21.10 redeploy.

## 1. What the tools found

Slither: **no High and no Medium** finding in our own code (98 results touch our files: 10 Low, the
rest informational naming/pragma noise inherited from OpenZeppelin). Aderyn: **1 High, 10 Low**.

Every finding below is classified as **real**, **false** or **accepted**, with the reason. Nothing
was changed in any contract: a contract change means a redeploy, and that needs the owner.

| # | tool | finding | verdict |
|---|---|---|---|
| 1 | Aderyn H-1 | Weak randomness — `keccak256(organizer, index, block.timestamp)` as the clone salt | **false** as a security issue · **but it exposes a real functional bug, see §2** |
| 2 | Slither | `incorrect-modifier`: `onlyOwnerOrPlatformOnce` "does not always execute `_;` or revert" | **false** |
| 3 | Slither + Aderyn L-9 | `missing-zero-check` on `setOperator` / `setRelayer` | **accepted — by design** |
| 4 | Aderyn L-2 | `ecrecover` signature malleability | **false — already handled** |
| 5 | Aderyn L-10 | unchecked return value of `_requireOwned(tokenId)` | **false** |
| 6 | Slither | `shadowing-local`: a return variable named `name` shadows `name()` | **real, cosmetic** |
| 7 | Slither | `timestamp`: "uses timestamp for comparisons" in `getEvents` | **false** |
| 8 | Slither | `assembly` in `_recoverSigner` | **accepted — intentional** |
| 9 | Slither | `low-level-calls` in `_deployEvent`, `withdraw`, `fundSigner` | **accepted — return values are checked** |
| 10 | Aderyn L-1 | centralisation risk (owner-only setters) | **accepted — that is the model** |
| 11 | Aderyn L-5/L-6/L-7/L-8, Slither naming/pragma | style: modifier used once, `nonReentrant` not first, `revert` inside a loop, state change without an event, `_name` parameters, mixed pragmas | **accepted — style** |

### Why each verdict

**1 · Weak randomness (false as security).** The hash is a CREATE2 salt for `Clones.cloneDeterministic`,
not a random number anybody wins anything from. The clone address is derived from the registry's own
address, so no third party can occupy it, and the address is *meant* to be predictable —
`predictEventAddress()` exists for that. Predictability costs nothing here.

**2 · `onlyOwnerOrPlatformOnce` (false).** Slither looks for a top-level `_;` or `revert`. Here all
three branches are covered: `owner` → `_;`; `platform` → consume-once then `_;`; anything else →
`revert NotOwnerOrPlatform()`. No silent no-op is reachable.

**3 · Missing zero-check on `setOperator` / `setRelayer` (accepted, by design).** For these two,
`address(0)` is the documented way to *revoke* the role — `renounceOperator()` does exactly that, and
the relayer comment says so. Neither is ever compared with a recovered signer: both are compared with
`msg.sender`, which can never be the zero address. The three setters where a zero WOULD be dangerous
— `setPlatform`, `setMintSigner`, `transferOwnership` — all revert with `InvalidAddress`. The line is
already drawn in the right place, and the dangerous combination (a zero `mintSigner` plus a malformed
signature that recovers to zero) is unreachable.

**4 · `ecrecover` malleability (false).** The G1 guard sits immediately above the `ecrecover`: a
signature in the upper half of the `s` range returns `address(0)`, as do a wrong length and a `v`
outside {27, 28}. The malleable half is refused before it reaches the opcode.

**5 · Unchecked return of `_requireOwned` (false).** It reverts when the token does not exist; its
return value (the owner) is deliberately unused. Checking it would be meaningless.

**6 · `shadowing-local` (real, cosmetic).** `getEventInfo()` names a return variable `name`, which
shadows the ERC-721/1155 `name()` function inside that scope. No behaviour changes — the function is
a view that never calls `name()`. Worth renaming the next time these templates are deployed; not a
reason to deploy.

**7 · `timestamp` in `getEvents` (false).** The "dangerous comparisons" Slither lists are
`end > allEvents.length` and `i < length` — array arithmetic in a paginated view. No time value takes
part in them.

**9 · Low-level calls (accepted).** All three check the result: `_deployEvent` reverts with
`EventCreationFailed()` when the clone's `initialize` fails, `withdraw` with `WithdrawFailed()`,
`fundSigner` with `FundingFailed()`. The `initialize` call is made by signature rather than through a
typed interface so a template can evolve without the registry being redeployed; the register-then-call
order follows checks-effects-interactions.

## 2. The one thing worth fixing — and it is not a security hole

`predictEventAddress(eventType, organizer)` (PlatformRegistry, line ~282) builds its salt the same way
`_deployEvent` does, **including `block.timestamp`**. The timestamp of the block in which the view is
called is almost never the timestamp of the block in which the event is later created, so the address
it returns is, in general, **not** the address that will be deployed. Nothing is lost on-chain (the
real address is emitted by `EventCreated`, which is what the backend uses), but any caller that trusts
this view — a front-end pre-filling an address, say — is told the wrong thing.

**Not fixed here.** A fix changes `PlatformRegistry`, which means a redeploy of the registry, which
means every event contract is re-pointed. That is the owner's decision; the alternative is to drop the
view (nothing in our stack calls it) or to document it as "valid only within the current block".

## 3. What was NOT analysed

`EventContract721.sol` / `EventContract1155.sol` (the pre-V3 templates) are still in the repository
and still hold the three events deployed before the regenesis, but the registry no longer clones them.
They are out of scope for the live generation and have not been re-analysed.

## 4. How to reproduce

```bash
# from the laptop (nothing is installed on the server)
pipx install solc-select && solc-select install 0.8.28 && solc-select use 0.8.28
npm i -g @cyfrin/aderyn
slither contracts/<file>.sol --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
        --exclude-dependencies --json <file>.json
aderyn . --src contracts --output aderyn.md
# then the bytecode check: compare the hardhat artefact's deployedBytecode with eth_getCode
```

Raw tool output and the bytecode comparison are kept with this report
(`slither-ours.json`, `aderyn.md`, `bytecode-check.json`).
