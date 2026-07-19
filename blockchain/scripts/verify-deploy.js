const hre = require("hardhat");

async function main() {
  const REG  = "0x32977E6391e7C25BF0Ddc2a5f4c9A311e5bA1d02";
  const T721 = "0x95e75771B4e066A7edAD62d8d7CbDD50307c814e";
  const T1155= "0x0b9749eE7DfCE7e1e825C8Fc7C363496ED7F75a0";

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
