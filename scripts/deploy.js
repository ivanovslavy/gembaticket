// scripts/deploy.js
// ============================================
// GembaTicket v2 — Full Deployment Script
// ============================================
// NON-CUSTODIAL. Signature-based claiming. No ClaimContract.
// Three roles: Admin, PlatformSigner (gas), MintSigner (off-chain signatures).
// All payments handled by GembaPay. Contracts are payment-agnostic.
//
// Deploys: EventContract721, EventContract1155, PlatformRegistry
// Outputs: deployed/<network>-<timestamp>.json
//
// Usage:
//   npx hardhat run scripts/deploy.js --network sepolia
//   npx hardhat run scripts/deploy.js --network polygon
//   npx hardhat run scripts/deploy.js --network localhost

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  console.log("============================================");
  console.log("GembaTicket v2 — Deployment");
  console.log("============================================");
  console.log(`Network:  ${network} (chainId: ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ETH/MATIC`);
  console.log("============================================\n");

  // =========================================================================
  // CONFIGURATION
  // =========================================================================

  const config = {
    admin: process.env.ADMIN_ADDRESS || deployer.address,
    multisig: process.env.MULTISIG_ADDRESS || deployer.address,
    platformSigner: process.env.PLATFORM_SIGNER_ADDRESS || deployer.address,
    mintSigner: process.env.MINT_SIGNER_ADDRESS || deployer.address,
  };

  console.log("Configuration:");
  console.log(`  Admin:            ${config.admin}`);
  console.log(`  Multisig:         ${config.multisig}`);
  console.log(`  Platform Signer:  ${config.platformSigner} (deploy + setup gas)`);
  console.log(`  Mint Signer:      ${config.mintSigner} (off-chain claim signatures, 0 gas)`);
  console.log(`  Payments:         ALL via GembaPay (contracts are payment-agnostic)`);
  console.log(`  Architecture:     Signature-based claiming (no ClaimContract)`);
  console.log("");

  // =========================================================================
  // STEP 1: Deploy EventContract721 template
  // =========================================================================

  console.log("[1/3] Deploying EventContract721 template...");
  const EventContract721 = await hre.ethers.getContractFactory("EventContract721");
  const event721Template = await EventContract721.deploy();
  await event721Template.waitForDeployment();
  const event721Addr = await event721Template.getAddress();
  console.log(`  ✔ EventContract721 template: ${event721Addr}`);
  console.log(`    tx: ${event721Template.deploymentTransaction().hash}`);

  // =========================================================================
  // STEP 2: Deploy EventContract1155 template
  // =========================================================================

  console.log("\n[2/3] Deploying EventContract1155 template...");
  const EventContract1155 = await hre.ethers.getContractFactory("EventContract1155");
  const event1155Template = await EventContract1155.deploy();
  await event1155Template.waitForDeployment();
  const event1155Addr = await event1155Template.getAddress();
  console.log(`  ✔ EventContract1155 template: ${event1155Addr}`);
  console.log(`    tx: ${event1155Template.deploymentTransaction().hash}`);

  // =========================================================================
  // STEP 3: Deploy PlatformRegistry
  // =========================================================================

  console.log("\n[3/3] Deploying PlatformRegistry...");
  const PlatformRegistry = await hre.ethers.getContractFactory("PlatformRegistry");
  const registry = await PlatformRegistry.deploy(
    config.admin,
    config.multisig,
    config.platformSigner,
    config.mintSigner,
    event721Addr,
    event1155Addr
  );
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(`  ✔ PlatformRegistry: ${registryAddr}`);
  console.log(`    tx: ${registry.deploymentTransaction().hash}`);

  // =========================================================================
  // VERIFICATION
  // =========================================================================

  console.log("\n============================================");
  console.log("Verifying deployment...");
  console.log("============================================");

  const reg721 = await registry.erc721Template();
  const reg1155 = await registry.erc1155Template();
  const regSigner = await registry.platformSigner();
  const regMintSigner = await registry.mintSigner();

  console.log(`  Registry.erc721Template()  = ${reg721} ${reg721 === event721Addr ? "✔" : "✗"}`);
  console.log(`  Registry.erc1155Template() = ${reg1155} ${reg1155 === event1155Addr ? "✔" : "✗"}`);
  console.log(`  Registry.platformSigner()  = ${regSigner} ${regSigner === config.platformSigner ? "✔" : "✗"}`);
  console.log(`  Registry.mintSigner()      = ${regMintSigner} ${regMintSigner === config.mintSigner ? "✔" : "✗"}`);

  // =========================================================================
  // SAVE DEPLOYMENT OUTPUT
  // =========================================================================

  const deployedDir = path.join(__dirname, "..", "deployed");
  if (!fs.existsSync(deployedDir)) {
    fs.mkdirSync(deployedDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${network}-${timestamp}.json`;

  const deployment = {
    version: "2.0",
    network: network,
    chainId: Number(chainId),
    timestamp: new Date().toISOString(),
    deployer: deployer.address,

    contracts: {
      EventContract721: {
        address: event721Addr,
        type: "template (EIP-1167)",
        tx: event721Template.deploymentTransaction().hash,
      },
      EventContract1155: {
        address: event1155Addr,
        type: "template (EIP-1167)",
        tx: event1155Template.deploymentTransaction().hash,
      },
      PlatformRegistry: {
        address: registryAddr,
        type: "singleton",
        tx: registry.deploymentTransaction().hash,
      },
    },

    configuration: {
      admin: config.admin,
      multisig: config.multisig,
      platformSigner: config.platformSigner,
      mintSigner: config.mintSigner,
      payments: "All payments via GembaPay (contracts are payment-agnostic)",
      architecture: "Signature-based claiming — no ClaimContract",
    },
  };

  const filepath = path.join(deployedDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(deployment, null, 2));
  console.log(`\n✔ Deployment saved: ${filepath}`);

  const latestPath = path.join(deployedDir, `${network}-latest.json`);
  fs.writeFileSync(latestPath, JSON.stringify(deployment, null, 2));
  console.log(`✔ Latest saved:     ${latestPath}`);

  // =========================================================================
  // SUMMARY
  // =========================================================================

  console.log("\n============================================");
  console.log("DEPLOYMENT COMPLETE — GembaTicket v2");
  console.log("============================================");
  console.log(`  EventContract721 (template):  ${event721Addr}`);
  console.log(`  EventContract1155 (template): ${event1155Addr}`);
  console.log(`  PlatformRegistry (singleton): ${registryAddr}`);
  console.log("============================================");
  console.log("");
  console.log("NEXT STEPS:");
  console.log("  1. Verify contracts on block explorer:");
  console.log(`     npx hardhat verify --network ${network} ${event721Addr}`);
  console.log(`     npx hardhat verify --network ${network} ${event1155Addr}`);
  console.log(`     npx hardhat verify --network ${network} ${registryAddr} \\`);
  console.log(`       "${config.admin}" "${config.multisig}" "${config.platformSigner}" \\`);
  console.log(`       "${config.mintSigner}" "${event721Addr}" "${event1155Addr}"`);
  console.log("  2. Fund platform signer wallet with ETH/MATIC for gas");
  console.log("  3. Mint signer needs NO funds (off-chain signatures only)");
  console.log("  4. Update backend .env with:");
  console.log(`     REGISTRY_ADDRESS=${registryAddr}`);
  console.log(`     PLATFORM_SIGNER_KEY=<private key>`);
  console.log(`     MINT_SIGNER_KEY=<private key>`);
  console.log("  5. Run tests:");
  console.log(`     npx hardhat run scripts/test-all.js --network ${network}`);
  console.log("");

  return deployment;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n✗ Deployment FAILED:");
    console.error(error);
    process.exit(1);
  });
