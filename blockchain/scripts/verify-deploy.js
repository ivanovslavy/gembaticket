const hre = require("hardhat");

async function main() {
  const REG  = "0x32977E6391e7C25BF0Ddc2a5f4c9A311e5bA1d02";
  const T721 = "0x3Ba630bF309249354F25a22c2f0A3EC6b34183D8";
  const T1155= "0x1a7722d1292cd5eB67A05fC8B51DFDe821055cDa";

  const provider = hre.ethers.provider;

  for (const [name, addr] of [["Registry", REG], ["ERC721 template", T721], ["ERC1155 template", T1155]]) {
    const code = await provider.getCode(addr);
    console.log(`${name.padEnd(18)} ${addr}  code size: ${(code.length - 2) / 2} bytes`);
  }

  const registry = await hre.ethers.getContractAt("PlatformRegistry", REG);
  console.log("\nRegistry state:");
  console.log("  admin           :", await registry.admin());
  console.log("  platformSigner  :", await registry.platformSigner());
  console.log("  mintSigner      :", await registry.mintSigner());
  console.log("  erc721Template  :", await registry.erc721Template());
  console.log("  erc1155Template :", await registry.erc1155Template());
  console.log("  totalEvents     :", (await registry.totalEvents()).toString());
}

main().catch(e => { console.error(e); process.exit(1); });
