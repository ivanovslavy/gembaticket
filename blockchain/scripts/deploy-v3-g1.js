// Deploy the G1-hardened V3 event templates (2026-10-21) and point the PlatformRegistry at them.
//   G1: activateTicket rejects a tokenId that was never minted; _recoverSigner rejects high-s
//   (malleable) signatures (EIP-2). No ABI change — the backend needs no code change.
// Only NEW events clone the new templates; existing events keep their own (immutable) code.
// The templates themselves are INITIALIZED here with the real roles (cold owner, platform role
// key, mint signer) so nobody else can initialize them — the previous templates were left
// uninitialized (owner = 0x0).
//   cd /gembaticket.com/blockchain && npx hardhat run scripts/deploy-v3-g1.js --network gemba
// Env (backend/.env is read for the role addresses): PLATFORM_SIGNER_KEY (= registry admin).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const REGISTRY = "0x32977E6391e7C25BF0Ddc2a5f4c9A311e5bA1d02";
const LOW_S = "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0";

async function main() {
  const backendEnv = require("dotenv").parse(fs.readFileSync(path.join(__dirname, "../../backend/.env")));
  const { ethers } = hre;
  const cold = ethers.getAddress(backendEnv.OWNER_COLD_ADDRESS);
  const platformRole = new ethers.Wallet(backendEnv.PLATFORM_ROLE_KEY).address;
  const mintSigner = new ethers.Wallet(backendEnv.MINT_SIGNER_KEY).address;

  const [deployer] = await ethers.getSigners();
  const reg = await ethers.getContractAt("PlatformRegistry", REGISTRY);
  const admin = await reg.admin();
  if (admin.toLowerCase() !== deployer.address.toLowerCase()) throw new Error(`deployer ${deployer.address} is not the registry admin ${admin}`);
  if ((await reg.mintSigner()).toLowerCase() !== mintSigner.toLowerCase()) throw new Error("registry mintSigner differs from backend MINT_SIGNER_KEY");
  console.log("deployer/admin:", deployer.address, "balance", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "GMB");
  console.log("roles for the template lock: owner(cold)", cold, "platform", platformRole, "mintSigner", mintSigner);

  const out = { network: hre.network.name, chainId: Number((await ethers.provider.getNetwork()).chainId), registry: REGISTRY, previous: {}, templates: {}, txs: {} };
  out.previous.erc721 = await reg.erc721Template();
  out.previous.erc1155 = await reg.erc1155Template();

  for (const [type, name] of [[0, "EventContract721V3"], [1, "EventContract1155V3"]]) {
    const art = await hre.artifacts.readArtifact(name);
    if (!art.deployedBytecode.toLowerCase().includes(LOW_S)) throw new Error(`${name}: compiled bytecode lacks the EIP-2 low-s check — not the G1 source`);
    const F = await ethers.getContractFactory(name);
    const c = await F.deploy();
    await c.waitForDeployment();
    const addr = await c.getAddress();
    const code = await ethers.provider.getCode(addr);
    if (!code.toLowerCase().includes(LOW_S)) throw new Error(`${name} at ${addr}: on-chain code lacks the low-s check`);
    console.log(`${name} deployed: ${addr} (${(code.length - 2) / 2} bytes, low-s ✓)`);

    // Lock the template: initialize it with the real roles; maxSupply 0 — it is never used as an event.
    const init = await c.initialize(`GembaTicket ${type === 0 ? "721" : "1155"} template — not an event`, "", 0, cold, platformRole, mintSigner);
    await init.wait();
    const owner = await c.owner();
    if (owner.toLowerCase() !== cold.toLowerCase()) throw new Error(`${name}: template owner is ${owner}, expected ${cold}`);
    console.log(`  template initialized (owner = cold ${cold}): ${init.hash}`);

    const set = await reg.setTemplate(type, addr);
    await set.wait();
    console.log(`  registry.setTemplate(${type}) → ${addr}: ${set.hash}`);
    out.templates[type === 0 ? "erc721" : "erc1155"] = addr;
    out.txs[`${name}.initialize`] = init.hash;
    out.txs[`setTemplate(${type})`] = set.hash;
  }
  if ((await reg.erc721Template()).toLowerCase() !== out.templates.erc721.toLowerCase() || (await reg.erc1155Template()).toLowerCase() !== out.templates.erc1155.toLowerCase()) throw new Error("registry does not point at the new templates");
  console.log("RESULT " + JSON.stringify(out));
}

// Same key as event deploys → take the backend's deploy-signer lock so an organizer's deploy and
// this one never share a nonce.
const backendEnv0 = require("dotenv").parse(fs.readFileSync(path.join(__dirname, "../../backend/.env")));
process.env.REDIS_URL = process.env.REDIS_URL || backendEnv0.REDIS_URL;
const { withBootstrapSigner } = require("../../backend/src/utils/signerLock");
withBootstrapSigner("template deploy (G1)", main)
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { try { require("../../backend/src/config/redis").quit(); } catch {} });
