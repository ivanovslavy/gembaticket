// scripts/deploy.js
// ============================================
// GembaTicket v2 — Full Deployment Script
// ============================================
// All payments handled by GembaPay. Contracts are payment-agnostic.
//
// Deploys: EventContract721, EventContract1155, ClaimContract, PlatformRegistry
// Outputs: deployed/<network>-<timestamp>.json
//
// Usage:
//   npx hardhat run scripts/deploy.js --network sepolia
//   npx hardhat run scripts/deploy.js --network polygon_amoy
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
  // For testnet: deployer = admin = multisig = signer (same address)
  // For mainnet: these MUST be different addresses

  const config = {
    admin: process.env.ADMIN_ADDRESS || deployer.address,
    multisig: process.env.MULTISIG_ADDRESS || deployer.address,
    platformSigner: process.env.PLATFORM_SIGNER_ADDRESS || deployer.address,
  };

  console.log("Configuration:");
  console.log(`  Admin:           ${config.admin}`);
  console.log(`  Multisig:        ${config.multisig}`);
  console.log(`  Platform Signer: ${config.platformSigner}`);
  console.log(`  Payments:        ALL via GembaPay (contracts are payment-agnostic)`);
  console.log("");

  // =========================================================================
  // STEP 1: Deploy EventContract721 template
  // =========================================================================

  console.log("[1/5] Deploying EventContract721 template...");
  const EventContract721 = await hre.ethers.getContractFactory("EventContract721");
  const event721Template = await EventContract721.deploy();
  await event721Template.waitForDeployment();
  const event721Addr = await event721Template.getAddress();
  console.log(`  ✓ EventContract721 template: ${event721Addr}`);
  console.log(`    tx: ${event721Template.deploymentTransaction().hash}`);

  // =========================================================================
  // STEP 2: Deploy EventContract1155 template
  // =========================================================================

  console.log("\n[2/5] Deploying EventContract1155 template...");
  const EventContract1155 = await hre.ethers.getContractFactory("EventContract1155");
  const event1155Template = await EventContract1155.deploy();
  await event1155Template.waitForDeployment();
  const event1155Addr = await event1155Template.getAddress();
  console.log(`  ✓ EventContract1155 template: ${event1155Addr}`);
  console.log(`    tx: ${event1155Template.deploymentTransaction().hash}`);

  // =========================================================================
  // STEP 3: Deploy ClaimContract
  // =========================================================================

  console.log("\n[3/5] Deploying ClaimContract...");
  const ClaimContract = await hre.ethers.getContractFactory("ClaimContract");
  const claimContract = await ClaimContract.deploy();
  await claimContract.waitForDeployment();
  const claimAddr = await claimContract.getAddress();
  console.log(`  ✓ ClaimContract: ${claimAddr}`);
  console.log(`    tx: ${claimContract.deploymentTransaction().hash}`);

  // =========================================================================
  // STEP 4: Deploy PlatformRegistry
  // =========================================================================

  console.log("\n[4/5] Deploying PlatformRegistry...");
  const PlatformRegistry = await hre.ethers.getContractFactory("PlatformRegistry");
  const registry = await PlatformRegistry.deploy(
    config.admin,
    config.multisig,
    config.platformSigner,
    claimAddr,
    event721Addr,
    event1155Addr
  );
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(`  ✓ PlatformRegistry: ${registryAddr}`);
  console.log(`    tx: ${registry.deploymentTransaction().hash}`);

  // =========================================================================
  // STEP 5: Configure ClaimContract → set factory to PlatformRegistry
  // =========================================================================

  console.log("\n[5/5] Configuring ClaimContract...");
  const setFactoryTx = await claimContract.setFactory(registryAddr);
  await setFactoryTx.wait();
  console.log(`  ✓ ClaimContract.setFactory(${registryAddr})`);
  console.log(`    tx: ${setFactoryTx.hash}`);

  // =========================================================================
  // VERIFICATION
  // =========================================================================

  console.log("\n============================================");
  console.log("Verifying deployment...");
  console.log("============================================");

  const factoryAddr = await claimContract.factory();
  console.log(`  ClaimContract.factory()   = ${factoryAddr} ${factoryAddr === registryAddr ? "✓" : "✗ MISMATCH"}`);

  const regClaim = await registry.claimContract();
  const reg721 = await registry.erc721Template();
  const reg1155 = await registry.erc1155Template();
  const regSigner = await registry.platformSigner();

  console.log(`  Registry.claimContract()  = ${regClaim} ${regClaim === claimAddr ? "✓" : "✗"}`);
  console.log(`  Registry.erc721Template() = ${reg721} ${reg721 === event721Addr ? "✓" : "✗"}`);
  console.log(`  Registry.erc1155Template()= ${reg1155} ${reg1155 === event1155Addr ? "✓" : "✗"}`);
  console.log(`  Registry.platformSigner() = ${regSigner} ${regSigner === config.platformSigner ? "✓" : "✗"}`);

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
      ClaimContract: {
        address: claimAddr,
        type: "singleton",
        tx: claimContract.deploymentTransaction().hash,
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
      payments: "All payments via GembaPay (contracts are payment-agnostic)",
    },

    postDeployment: {
      claimContractFactory: registryAddr,
    },
  };

  const filepath = path.join(deployedDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(deployment, null, 2));
  console.log(`\n✓ Deployment saved: ${filepath}`);

  const latestPath = path.join(deployedDir, `${network}-latest.json`);
  fs.writeFileSync(latestPath, JSON.stringify(deployment, null, 2));
  console.log(`✓ Latest saved:     ${latestPath}`);

  // =========================================================================
  // SUMMARY
  // =========================================================================

  console.log("\n============================================");
  console.log("DEPLOYMENT COMPLETE");
  console.log("============================================");
  console.log(`  EventContract721 (template): ${event721Addr}`);
  console.log(`  EventContract1155 (template): ${event1155Addr}`);
  console.log(`  ClaimContract (singleton):    ${claimAddr}`);
  console.log(`  PlatformRegistry (singleton): ${registryAddr}`);
  console.log("============================================");
  console.log("");
  console.log("NEXT STEPS:");
  console.log("  1. Verify contracts on block explorer:");
  console.log(`     npx hardhat verify --network ${network} ${event721Addr}`);
  console.log(`     npx hardhat verify --network ${network} ${event1155Addr}`);
  console.log(`     npx hardhat verify --network ${network} ${claimAddr}`);
  console.log(`     npx hardhat verify --network ${network} ${registryAddr} \\`);
  console.log(`       "${config.admin}" "${config.multisig}" "${config.platformSigner}" \\`);
  console.log(`       "${claimAddr}" "${event721Addr}" "${event1155Addr}"`);
  console.log("  2. Fund platform signer wallet with ETH/MATIC for gas");
  console.log("  3. Update .env with contract addresses from deployed/ JSON");
  console.log("  4. Configure GembaPay webhooks to point to backend");
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
