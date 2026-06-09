# Migration: Hetzner move + Ethereum Sepolia → GembaBlockchain testnet (2026-06-08)

GembaTicket was moved off the Raspberry Pi onto the Hetzner server and switched
from Ethereum Sepolia to **GembaBlockchain testnet** (the project's own L1).

## Infrastructure (Hetzner move)
- Stack relocated: PostgreSQL DB (`gembaticket`), Redis, 8 systemd services
  (api, listener, chain-worker, scanner, web, dashboard, admin, scanner-pwa),
  Apache vhosts + Let's Encrypt for all 7 subdomains, daily DB backup cron.
- IPFS is now the shared self-hosted Kubo node (gateway `ipfs.gembaticket.com`).

## Network switch (Sepolia → GembaBlockchain)
- Chain: **GembaBlockchain testnet, chainId 821207** (was Sepolia 11155111).
- RPC: `https://testnet.gembascan.io/rpc` (+ rpc1/rpc2 fallback). Explorer: GembaScan.
- The event listener is single-chain (driven by `CHAIN_ID`); other networks'
  configs remain in code but are inactive. Legacy Sepolia data is **retained**
  as historical records; new events live on GembaBlockchain.

## Contracts (GembaBlockchain testnet, verified on GembaScan)
| Contract | Address |
|---|---|
| PlatformRegistry | `0xAAe144b80AbE5e8f03Af181a63f4E8f9c7F91191` |
| EventContract721 (template) | `0x95e75771B4e066A7edAD62d8d7CbDD50307c814e` |
| EventContract1155 (template) | `0x0b9749eE7DfCE7e1e825C8Fc7C363496ED7F75a0` |

Signers: platform/gas `0x8eB8Bf106EbC9834a2586D04F73866C7436Ce298`, mint signer
`0x3418196aBeC513A95dF013751bcE036C7b27fa5a`. Full record:
[`blockchain/deployed/gemba-latest.json`](../blockchain/deployed/gemba-latest.json).
