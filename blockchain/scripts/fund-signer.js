const hre=require("hardhat");
(async()=>{const [d]=await hre.ethers.getSigners();
const to="0x3418196aBeC513A95dF013751bcE036C7b27fa5a";
const before=await hre.ethers.provider.getBalance(to);
const tx=await d.sendTransaction({to,value:hre.ethers.parseEther("5")});await tx.wait();
console.log("sent 5 GMB to mint signer; tx",tx.hash);
console.log("0x3418 balance:",hre.ethers.formatEther(await hre.ethers.provider.getBalance(to)),"GMB");
console.log("deployer left:",hre.ethers.formatEther(await hre.ethers.provider.getBalance(d.address)),"GMB");})();
