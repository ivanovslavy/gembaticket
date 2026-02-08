require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    polygon_amoy: {
      url: process.env.POLYGON_RPC_URL || "",
      accounts: process.env.PLATFORM_SIGNER_KEY ? [process.env.PLATFORM_SIGNER_KEY] : [],
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL || "",
      accounts: process.env.PLATFORM_SIGNER_KEY ? [process.env.PLATFORM_SIGNER_KEY] : [],
    },
  },
  gasReporter: { enabled: true, currency: "USD" },
};
