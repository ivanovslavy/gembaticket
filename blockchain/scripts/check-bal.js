const hre=require("hardhat");
(async()=>{const [d]=await hre.ethers.getSigners();const b=await hre.ethers.provider.getBalance(d.address);console.log("DEPLOYER",d.address,"BAL",hre.ethers.formatEther(b),"GMB");})();
