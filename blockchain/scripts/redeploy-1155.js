const hre=require("hardhat");
(async()=>{
  const REGISTRY="0x32977E6391e7C25BF0Ddc2a5f4c9A311e5bA1d02";
  const EC=await hre.ethers.getContractFactory("EventContract1155");
  const t=await EC.deploy(); await t.waitForDeployment();
  const addr=await t.getAddress();
  console.log("NEW EventContract1155 template:", addr);
  const reg=await hre.ethers.getContractAt("PlatformRegistry", REGISTRY);
  const tx=await reg.setTemplate(1, addr); await tx.wait();
  console.log("registry.setTemplate(1, ...) tx:", tx.hash);
  console.log("registry erc1155Template now:", await reg.erc1155Template());
})().catch(e=>{console.error(e.message||e);process.exit(1)});
