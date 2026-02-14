// scripts/test-erc1155-lifecycle.js
// ============================================
// GembaTicket v2 — ERC1155 Zone-Based Ticket Test
// ============================================
// Reads deployed/<network>-latest.json for contract addresses.
// Tests: create event → setup ticket types (zones) → signature-based claim →
//        zone access levels → activate → transfer lock → wave releases → custom URI
//
// Usage:
//   npx hardhat run scripts/test-erc1155-lifecycle.js --network sepolia
//   npx hardhat run scripts/test-erc1155-lifecycle.js --network localhost

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

const GREEN = "\x1b[32m✔\x1b[0m";
const RED = "\x1b[31m✗\x1b[0m";
let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { console.log(`  ${GREEN} ${name}`); passed++; }
  else { console.log(`  ${RED} ${name}`); failed++; }
}

async function expectRevert(promise, name) {
  try { await promise; console.log(`  ${RED} ${name} (no revert)`); failed++; }
  catch { console.log(`  ${GREEN} ${name} (reverted)`); passed++; }
}

// Sign claim for ERC1155: keccak256(contract, typeId, claimHash, wallet)
async function signClaim1155(signer, contractAddr, typeId, claimHash, wallet) {
  const messageHash = ethers.solidityPackedKeccak256(
    ["address", "uint256", "bytes32", "address"],
    [contractAddr, typeId, claimHash, wallet]
  );
  return signer.signMessage(ethers.getBytes(messageHash));
}

function randomClaimHash() {
  return ethers.keccak256(ethers.randomBytes(32));
}

function loadDeployment(network) {
  const filePath = path.join(__dirname, "..", "deployed", `${network}-latest.json`);
  if (!fs.existsSync(filePath)) {
    console.error(`\n  ✗ No deployment found at ${filePath}`);
    console.error(`    Run first: npx hardhat run scripts/deploy.js --network ${network}\n`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function main() {
  console.log("============================================");
  console.log("GembaTicket v2 — ERC1155 Lifecycle Test");
  console.log("============================================\n");

  const network = hre.network.name;
  const deployment = loadDeployment(network);
  console.log(`Network: ${network} (deployed: ${deployment.timestamp})`);

  const signers = await ethers.getSigners();
  const platformSigner = signers[0];
  const organizer = signers[1] || signers[0];
  const buyer1 = signers[2] || signers[0];
  const buyer2 = signers[3] || signers[0];
  const randomUser = signers[4] || signers[0];
  const mintSigner = process.env.MINT_SIGNER_KEY
    ? new ethers.Wallet(process.env.MINT_SIGNER_KEY, ethers.provider)
    : platformSigner;

  console.log("\nAccounts:");
  console.log(`  platformSigner: ${platformSigner.address}`);
  console.log(`  mintSigner:     ${mintSigner.address}`);
  console.log(`  organizer:      ${organizer.address}`);
  console.log(`  buyer1:         ${buyer1.address}`);
  console.log(`  buyer2:         ${buyer2.address}\n`);

  const registryAddr = deployment.contracts.PlatformRegistry.address;
  const registry = await ethers.getContractAt("PlatformRegistry", registryAddr);
  console.log(`PlatformRegistry: ${registryAddr}`);

  const ph = ethers.keccak256(ethers.toUtf8Bytes("test-pay-1155-" + Date.now()));

  // =========================================================================
  // TEST 1: Create ERC1155 Event
  // =========================================================================

  console.log("\n--- TEST 1: Create ERC1155 Event ---");

  const tx = await registry.connect(platformSigner).createEvent(
    1, "Festival 2026", "ipfs://QmFestival/", 500, organizer.address, ph
  );
  const receipt = await tx.wait();
  const eventAddr = receipt.logs.find(l => l.fragment && l.fragment.name === "EventCreated").args[0];
  const event1155 = await ethers.getContractAt("EventContract1155", eventAddr);
  console.log(`  Event deployed at: ${eventAddr}`);

  const info = await event1155.getEventInfo();
  assert(info.name === "Festival 2026", "Event name matches");
  assert(info.supply === 500n, "Global max supply 500");
  assert(info.types === 0n, "0 ticket types initially");
  assert(await event1155.setupComplete() === false, "Setup not complete");

  // =========================================================================
  // TEST 2: Setup Phase — Create Ticket Types (Zones)
  // =========================================================================

  console.log("\n--- TEST 2: Setup — Create Ticket Types ---");

  // Only platform can create during setup
  await expectRevert(
    event1155.connect(randomUser).createTicketType(0, "Hack", 300, 0),
    "Random user cannot create ticket type"
  );
  await expectRevert(
    event1155.connect(organizer).createTicketType(0, "Hack", 300, 0),
    "Owner cannot create ticket type during setup"
  );

  // Platform creates zones
  await event1155.connect(platformSigner).createTicketType(0, "General Admission", 300, 0);
  await event1155.connect(platformSigner).createTicketType(1, "VIP", 150, 1);
  await event1155.connect(platformSigner).createTicketType(2, "Backstage", 40, 2);
  await event1155.connect(platformSigner).createTicketType(3, "All Access", 10, 3);

  const genInfo = await event1155.getTicketTypeInfo(0);
  assert(genInfo.name === "General Admission", "General type name");
  assert(genInfo.typeMaxSupply === 300n, "General max 300");
  assert(genInfo.zoneLevel === 0n, "General zone = 0");

  const vipInfo = await event1155.getTicketTypeInfo(1);
  assert(vipInfo.name === "VIP", "VIP type name");
  assert(vipInfo.zoneLevel === 1n, "VIP zone = 1");

  const aaInfo = await event1155.getTicketTypeInfo(3);
  assert(aaInfo.typeMaxSupply === 10n, "All Access max 10");
  assert(aaInfo.zoneLevel === 3n, "All Access zone = 3");

  await expectRevert(
    event1155.connect(platformSigner).createTicketType(0, "Dup", 100, 0),
    "Duplicate type ID reverts"
  );

  assert((await event1155.getEventInfo()).types === 4n, "4 ticket types created");

  // Enable sale and lock setup
  await event1155.connect(platformSigner).enableSale();
  await event1155.connect(platformSigner).completeSetup();
  assert(await event1155.setupComplete() === true, "Setup locked");

  await expectRevert(
    event1155.connect(platformSigner).createTicketType(4, "Late", 50, 0),
    "Platform locked after setup"
  );

  // =========================================================================
  // TEST 3: Claim Tickets per Zone (Signature-Based)
  // =========================================================================

  console.log("\n--- TEST 3: Claim Tickets per Zone ---");

  // General for buyer1
  const h1 = randomClaimHash();
  const s1 = await signClaim1155(mintSigner, eventAddr, 0, h1, buyer1.address);
  await event1155.connect(buyer1).claimTicket(0, h1, s1);

  // VIP for buyer2
  const h2 = randomClaimHash();
  const s2 = await signClaim1155(mintSigner, eventAddr, 1, h2, buyer2.address);
  await event1155.connect(buyer2).claimTicket(1, h2, s2);

  // Backstage for buyer1
  const h3 = randomClaimHash();
  const s3 = await signClaim1155(mintSigner, eventAddr, 2, h3, buyer1.address);
  await event1155.connect(buyer1).claimTicket(2, h3, s3);

  // All Access for buyer2
  const h4 = randomClaimHash();
  const s4 = await signClaim1155(mintSigner, eventAddr, 3, h4, buyer2.address);
  await event1155.connect(buyer2).claimTicket(3, h4, s4);

  assert((await event1155.getEventInfo()).minted === 4n, "4 tickets minted total");

  // NFTs owned directly (no escrow!)
  assert(await event1155.balanceOf(buyer1.address, 1) === 1n, "Buyer1 owns token 1 (General)");
  assert(await event1155.balanceOf(buyer2.address, 2) === 1n, "Buyer2 owns token 2 (VIP)");
  assert(await event1155.balanceOf(buyer1.address, 3) === 1n, "Buyer1 owns token 3 (Backstage)");
  assert(await event1155.balanceOf(buyer2.address, 4) === 1n, "Buyer2 owns token 4 (All Access)");

  // Check type mapping
  assert(await event1155.ticketType(1) === 0n, "Token 1 is General");
  assert(await event1155.ticketType(2) === 1n, "Token 2 is VIP");
  assert(await event1155.ticketType(3) === 2n, "Token 3 is Backstage");
  assert(await event1155.ticketType(4) === 3n, "Token 4 is All Access");

  // Zone levels via getTicketInfo
  assert((await event1155.getTicketInfo(2)).zoneLevel === 1n, "Token 2 zone = 1 (VIP)");
  assert((await event1155.getTicketInfo(4)).zoneLevel === 3n, "Token 4 zone = 3 (All Access)");

  // Invalid type
  const hBad = randomClaimHash();
  const sBad = await signClaim1155(mintSigner, eventAddr, 99, hBad, buyer1.address);
  await expectRevert(event1155.connect(buyer1).claimTicket(99, hBad, sBad), "Invalid ticket type reverts");

  // =========================================================================
  // TEST 4: Signature Security
  // =========================================================================

  console.log("\n--- TEST 4: Signature Security ---");

  // Wrong signer
  const hW = randomClaimHash();
  const sW = await signClaim1155(randomUser, eventAddr, 0, hW, buyer1.address);
  await expectRevert(event1155.connect(buyer1).claimTicket(0, hW, sW), "Wrong signer rejected");

  // Wrong wallet (replay)
  const hR = randomClaimHash();
  const sR = await signClaim1155(mintSigner, eventAddr, 0, hR, buyer1.address);
  await expectRevert(event1155.connect(buyer2).claimTicket(0, hR, sR), "Replay: wrong wallet rejected");

  // Double claim
  await expectRevert(event1155.connect(buyer1).claimTicket(0, h1, s1), "Double claim rejected");

  // =========================================================================
  // TEST 5: Activate & Transfer Lock
  // =========================================================================

  console.log("\n--- TEST 5: Activate & Transfer Lock ---");

  await event1155.connect(platformSigner).activateTicket(1);
  assert((await event1155.getTicketInfo(1)).activated === true, "Token 1 activated");

  await expectRevert(
    event1155.connect(buyer1).safeTransferFrom(buyer1.address, buyer2.address, 1, 1, "0x"),
    "Activated ticket transfer blocked"
  );

  // Non-activated CAN transfer
  await event1155.connect(buyer2).safeTransferFrom(buyer2.address, buyer1.address, 2, 1, "0x");
  assert(await event1155.balanceOf(buyer1.address, 2) === 1n, "Non-activated VIP transferred OK");

  // =========================================================================
  // TEST 6: Owner Functions — Toggle, Waves, Add Types
  // =========================================================================

  console.log("\n--- TEST 6: Owner Functions ---");

  // Toggle type
  await event1155.connect(organizer).toggleTicketType(1);
  assert((await event1155.getTicketTypeInfo(1)).active === false, "VIP deactivated");

  const hOff = randomClaimHash();
  const sOff = await signClaim1155(mintSigner, eventAddr, 1, hOff, buyer1.address);
  await expectRevert(event1155.connect(buyer1).claimTicket(1, hOff, sOff), "Cannot claim deactivated type");

  await event1155.connect(organizer).toggleTicketType(1);
  assert((await event1155.getTicketTypeInfo(1)).active === true, "VIP reactivated");

  // Wave release
  await event1155.connect(organizer).increaseTypeSupply(0, 100);
  assert((await event1155.getTicketTypeInfo(0)).typeMaxSupply === 400n, "General supply → 400");
  assert((await event1155.getEventInfo()).supply === 600n, "Global supply → 600");

  // Add new type after setup
  await event1155.connect(organizer).addTicketType(5, "Early Bird", 50, 0);
  assert((await event1155.getEventInfo()).types === 5n, "5 ticket types now");
  assert((await event1155.getEventInfo()).supply === 650n, "Global supply → 650");

  // Access control
  await expectRevert(event1155.connect(randomUser).toggleSale(), "Random cannot toggleSale");
  await expectRevert(event1155.connect(randomUser).addTicketType(9, "X", 1, 0), "Random cannot addTicketType");

  // =========================================================================
  // TEST 7: Custom Type URI
  // =========================================================================

  console.log("\n--- TEST 7: Custom Type URI ---");

  assert(await event1155.uri(1) === "ipfs://QmFestival/", "Default: base URI");

  await event1155.connect(organizer).setTypeURI(1, "ipfs://QmCustomVIP");

  // Mint new VIP to test custom URI
  const hVip = randomClaimHash();
  const sVip = await signClaim1155(mintSigner, eventAddr, 1, hVip, buyer1.address);
  await event1155.connect(buyer1).claimTicket(1, hVip, sVip);
  const newTokenId = (await event1155.getEventInfo()).minted;

  assert(await event1155.uri(newTokenId) === "ipfs://QmCustomVIP", "Custom VIP URI works");
  // Token 3 is Backstage (typeId=2), no custom URI → base URI
  // (Token 1 collides with typeId 1 in marketplace fallback, which is by design)
  assert(await event1155.uri(3) === "ipfs://QmFestival/", "Non-custom type still uses base URI");

  // =========================================================================
  // TEST 8: Type Max Supply
  // =========================================================================

  console.log("\n--- TEST 8: Type Max Supply ---");

  await event1155.connect(organizer).addTicketType(10, "Limited Edition", 2, 0);

  for (let i = 0; i < 2; i++) {
    const hl = randomClaimHash();
    const sl = await signClaim1155(mintSigner, eventAddr, 10, hl, buyer1.address);
    await event1155.connect(buyer1).claimTicket(10, hl, sl);
  }

  const hlO = randomClaimHash();
  const slO = await signClaim1155(mintSigner, eventAddr, 10, hlO, buyer1.address);
  await expectRevert(event1155.connect(buyer1).claimTicket(10, hlO, slO), "Type max supply reached");
  assert((await event1155.getTicketTypeInfo(10)).minted === 2n, "Limited: 2 minted");

  // =========================================================================
  // TEST 9: End Event → Unlock
  // =========================================================================

  console.log("\n--- TEST 9: End Event ---");

  await event1155.connect(organizer).endEvent();
  assert((await event1155.getEventInfo()).ended === true, "Event ended");

  // Activated ticket now transferable
  await event1155.connect(buyer1).safeTransferFrom(buyer1.address, buyer2.address, 1, 1, "0x");
  assert(await event1155.balanceOf(buyer2.address, 1) === 1n, "Activated ticket transfers after event end");

  // =========================================================================
  // TEST 10: Platform Emergency (One-Time)
  // =========================================================================

  console.log("\n--- TEST 10: Platform Emergency ---");

  const txE = await registry.connect(platformSigner).createEvent(
    1, "Emergency Test", "ipfs://emg/", 100, organizer.address,
    ethers.keccak256(ethers.toUtf8Bytes("pay-emg-" + Date.now()))
  );
  const rE = await txE.wait();
  const eAddr = rE.logs.find(l => l.fragment && l.fragment.name === "EventCreated").args[0];
  const emgEvent = await ethers.getContractAt("EventContract1155", eAddr);

  await emgEvent.connect(platformSigner).completeSetup();

  await emgEvent.connect(platformSigner).cancelEvent();
  assert((await emgEvent.getEventInfo()).canceled === true, "Platform emergency cancel works");

  await expectRevert(
    emgEvent.connect(randomUser).cancelEvent(),
    "Random user cannot emergency cancel"
  );

  // =========================================================================
  // RESULTS
  // =========================================================================

  console.log("\n============================================");
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("============================================");

  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
