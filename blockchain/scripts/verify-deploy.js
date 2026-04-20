const hre = require("hardhat");

async function main() {
  const REG  = "0xDdF1793B1A8632D4d94aAAc5f83bE058cb39c522";
  const T721 = "0x2481644e460A77B072c28f209055A3e86764192F";
  const T1155= "0xEFd2000dBC5b5C897823eEFCcAA99d5DC2Ce7DBA";

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
