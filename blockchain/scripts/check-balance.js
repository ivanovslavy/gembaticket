const hre = require("hardhat");
async function main() {
  const [d] = await hre.ethers.getSigners();
  const bal = await hre.ethers.provider.getBalance(d.address);
  console.log("Deployer:", d.address);
  console.log("Balance:", hre.ethers.formatEther(bal), "ETH");
  const net = await hre.ethers.provider.getNetwork();
  console.log("Chain:", net.chainId.toString());
}
main().catch(e => { console.error(e); process.exit(1); });
