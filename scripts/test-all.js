// scripts/test-all.js
// ============================================
// GembaTicket v2 — Run All Tests
// ============================================
// Runs deploy + all tests against deployed contracts.
// Reads --network from CLI automatically.
//
// Usage:
//   npx hardhat run scripts/test-all.js --network localhost
//   npx hardhat run scripts/test-all.js --network sepolia

const { execSync } = require("child_process");
const hre = require("hardhat");

const network = hre.network.name;

const tests = [
  { name: "ERC721 Lifecycle", script: "scripts/test-erc721-lifecycle.js" },
  { name: "ERC1155 Lifecycle", script: "scripts/test-erc1155-lifecycle.js" },
  { name: "Platform Security", script: "scripts/test-platform-security.js" },
];

let allPassed = true;
const results = [];

console.log("╔════════════════════════════════════════════════╗");
console.log("║   GembaTicket v2 — Full Test Suite             ║");
console.log(`║   Network: ${network.padEnd(36)} ║`);
console.log("╚════════════════════════════════════════════════╝\n");

for (const test of tests) {
  console.log(`\n▶ Running: ${test.name} (${test.script})\n`);
  try {
    execSync(`npx hardhat run ${test.script} --network ${network}`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    console.log(`\n✔ ${test.name} — PASSED\n`);
    results.push({ name: test.name, status: "PASSED" });
  } catch (e) {
    console.log(`\n✗ ${test.name} — FAILED\n`);
    results.push({ name: test.name, status: "FAILED" });
    allPassed = false;
  }
}

console.log("\n╔════════════════════════════════════════════════╗");
console.log("║   RESULTS                                      ║");
console.log("╠════════════════════════════════════════════════╣");
for (const r of results) {
  const icon = r.status === "PASSED" ? "✔" : "✗";
  console.log(`║   ${icon} ${r.name.padEnd(42)} ║`);
}
console.log("╠════════════════════════════════════════════════╣");
if (allPassed) {
  console.log("║   ✔ ALL TESTS PASSED                           ║");
} else {
  console.log("║   ✗ SOME TESTS FAILED                          ║");
}
console.log("╚════════════════════════════════════════════════╝\n");

if (!allPassed) process.exit(1);
