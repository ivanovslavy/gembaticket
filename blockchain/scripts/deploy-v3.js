// Deploy v3 templates (gasless relayed claiming) and point the existing PlatformRegistry at them.
// v3 is backward-compatible: the original client-pays claimTicket is unchanged, so switching
// templates is safe — new events get the gasless claimTicketFor path on top.
const hre = require("hardhat");

const REGISTRY = "0xAAe144b80AbE5e8f03Af181a63f4E8f9c7F91191";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer (admin/platform/relayer):", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(bal), "GMB");

  // --- Deploy v3 templates ---
  const EC721 = await hre.ethers.getContractFactory("EventContract721V3");
  const t721 = await EC721.deploy();
  await t721.waitForDeployment();
  const a721 = await t721.getAddress();
  console.log("EventContract721V3 template :", a721);

  const EC1155 = await hre.ethers.getContractFactory("EventContract1155V3");
  const t1155 = await EC1155.deploy();
  await t1155.waitForDeployment();
  const a1155 = await t1155.getAddress();
  console.log("EventContract1155V3 template:", a1155);

  // --- Point the registry at the v3 templates (admin only) ---
  const reg = await hre.ethers.getContractAt("PlatformRegistry", REGISTRY);
  const admin = await reg.admin();
  if (admin.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer is not registry admin (admin=${admin})`);
  }
  const tx0 = await reg.setTemplate(0, a721);  await tx0.wait();
  console.log("registry.setTemplate(0, 721V3)  ✓", tx0.hash);
  const tx1 = await reg.setTemplate(1, a1155); await tx1.wait();
  console.log("registry.setTemplate(1, 1155V3) ✓", tx1.hash);

  console.log("\n========================================");
  console.log("  GembaTicket v3 — templates LIVE");
  console.log("========================================");
  console.log("EventContract721V3 :", a721);
  console.log("EventContract1155V3:", a1155);
  console.log("PlatformRegistry   :", REGISTRY, "(now clones v3 for new events)");
  console.log("Relayer (default)  :", deployer.address, "(= platform broadcasting wallet)");
  console.log("\nVerify on GembaScan:");
  console.log(`npx hardhat verify --network gemba ${a721}`);
  console.log(`npx hardhat verify --network gemba ${a1155}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
