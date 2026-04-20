const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH");

  // --- Config ---
  const ADMIN = deployer.address;
  const MULTISIG = deployer.address; // Same initially, change later
  const PLATFORM_SIGNER = process.env.PLATFORM_SIGNER_ADDRESS || deployer.address;
  const MINT_SIGNER = process.env.MINT_SIGNER_ADDRESS || deployer.address;

  console.log("\n--- Config ---");
  console.log("Admin:          ", ADMIN);
  console.log("Multisig:       ", MULTISIG);
  console.log("Platform Signer:", PLATFORM_SIGNER);
  console.log("Mint Signer:    ", MINT_SIGNER);

  // --- Deploy templates ---
  console.log("\n--- Deploying Templates ---");

  const EC721 = await hre.ethers.getContractFactory("EventContract721");
  const template721 = await EC721.deploy();
  await template721.waitForDeployment();
  console.log("EventContract721 template:", await template721.getAddress());

  const EC1155 = await hre.ethers.getContractFactory("EventContract1155");
  const template1155 = await EC1155.deploy();
  await template1155.waitForDeployment();
  console.log("EventContract1155 template:", await template1155.getAddress());

  // --- Deploy PlatformRegistry ---
  console.log("\n--- Deploying PlatformRegistry ---");

  const Registry = await hre.ethers.getContractFactory("PlatformRegistry");
  const registry = await Registry.deploy(
    ADMIN,
    MULTISIG,
    PLATFORM_SIGNER,
    MINT_SIGNER,
    await template721.getAddress(),
    await template1155.getAddress()
  );
  await registry.waitForDeployment();
  console.log("PlatformRegistry:         ", await registry.getAddress());

  // --- Summary ---
  console.log("\n========================================");
  console.log("  GembaTicket v2 — Deployment Complete");
  console.log("========================================");
  console.log("EventContract721 template:", await template721.getAddress());
  console.log("EventContract1155 template:", await template1155.getAddress());
  console.log("PlatformRegistry:         ", await registry.getAddress());
  console.log("========================================");
  console.log("\nVerify on Etherscan:");
  console.log(`npx hardhat verify --network sepolia ${await template721.getAddress()}`);
  console.log(`npx hardhat verify --network sepolia ${await template1155.getAddress()}`);
  console.log(`npx hardhat verify --network sepolia ${await registry.getAddress()} ${ADMIN} ${MULTISIG} ${PLATFORM_SIGNER} ${MINT_SIGNER} ${await template721.getAddress()} ${await template1155.getAddress()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
