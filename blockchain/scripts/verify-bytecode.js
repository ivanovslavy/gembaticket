// blockchain/scripts/verify-bytecode.js (G2, 2026-07-19)
//
// Compares keccak256 of the ON-CHAIN runtime bytecode of every live contract in
// deployed/gemba-latest.json against the LOCAL compiled artifacts (deployedBytecode).
// An exact keccak match proves the deployed code is byte-identical to this source
// tree + compiler settings (the solc metadata hash pins the exact sources).
//
// Run from blockchain/:  node scripts/verify-bytecode.js
// Exit 0 = every contract matched an artifact; 1 = at least one didn't.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.RPC || "https://rpc2.gembascan.io";
const deployed = JSON.parse(fs.readFileSync(path.join(__dirname, "../deployed/gemba-latest.json"), "utf8"));

// Which artifact(s) each deployed name may correspond to — both the plain and the V3
// sources are tried, so this script also ANSWERS which source generation is live.
const CANDIDATES = {
  PlatformRegistry: ["PlatformRegistry.sol/PlatformRegistry.json"],
  EventContract721: ["EventContract721.sol/EventContract721.json", "EventContract721V3.sol/EventContract721V3.json"],
  EventContract1155: ["EventContract1155.sol/EventContract1155.json", "EventContract1155V3.sol/EventContract1155V3.json"],
};

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  let fails = 0;
  for (const [name, entry] of Object.entries(deployed.contracts)) {
    const addr = entry.address;
    const code = await provider.getCode(addr);
    const onchainHash = ethers.keccak256(code);
    console.log(`${name} ${addr}`);
    console.log(`  on-chain: ${(code.length - 2) / 2} bytes, keccak ${onchainHash}`);
    let matched = null;
    const tried = [];
    for (const rel of CANDIDATES[name] || []) {
      const f = path.join(__dirname, "../artifacts/contracts", rel);
      if (!fs.existsSync(f)) { tried.push(`${rel} (no artifact)`); continue; }
      const art = JSON.parse(fs.readFileSync(f, "utf8"));
      const localHash = ethers.keccak256(art.deployedBytecode);
      tried.push(`${rel} keccak ${localHash.slice(0, 20)}…`);
      if (localHash === onchainHash) { matched = rel; break; }
    }
    if (matched) console.log(`  MATCH: ${matched}`);
    else { fails++; console.log(`  NO EXACT MATCH — tried: ${tried.join(" | ")}`); }
  }
  console.log(fails ? `\n${fails} contract(s) did NOT match — investigate before trusting the tree` : "\nAll deployed contracts are byte-identical to the local artifacts.");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("verify-bytecode error:", e.message); process.exit(1); });
