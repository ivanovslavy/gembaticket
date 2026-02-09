// scripts/test-all.js
// ============================================
// GembaTicket v2 — Run All Tests
// ============================================
// npx hardhat run scripts/test-all.js --network localhost

const { execSync } = require("child_process");

const tests = [
  "scripts/test-erc721-lifecycle.js",
  "scripts/test-erc1155-lifecycle.js",
  "scripts/test-platform-security.js",
];

let allPassed = true;

console.log("╔════════════════════════════════════════════╗");
console.log("║   GembaTicket v2 — Full Test Suite         ║");
console.log("╚════════════════════════════════════════════╝\n");

for (const test of tests) {
  console.log(`\n▶ Running: ${test}\n`);
  try {
    execSync(`npx hardhat run ${test} --network localhost`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    console.log(`\n✓ ${test} — PASSED\n`);
  } catch (e) {
    console.log(`\n✗ ${test} — FAILED\n`);
    allPassed = false;
  }
}

console.log("\n╔════════════════════════════════════════════╗");
if (allPassed) {
  console.log("║   ALL TESTS PASSED ✓                       ║");
} else {
  console.log("║   SOME TESTS FAILED ✗                      ║");
}
console.log("╚════════════════════════════════════════════╝\n");

if (!allPassed) process.exit(1);
