// scripts/test-erc1155-lifecycle.js
// ============================================
// GembaTicket v2 — ERC1155 Zone-Based Ticket Test
// ============================================
// npx hardhat run scripts/test-erc1155-lifecycle.js --network localhost
//
// Tests: create event → ticket types (General/VIP/Backstage) →
//        mint per zone → zone access levels → activate → claim

const hre = require("hardhat");
const { ethers } = hre;

const GREEN = "\x1b[32m✓\x1b[0m";
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

async function main() {
  console.log("============================================");
  console.log("GembaTicket v2 — ERC1155 Lifecycle Test");
  console.log("============================================\n");

  const [deployer, organizer, buyer1, buyer2, randomUser] = await ethers.getSigners();

  // Deploy fresh
  console.log("--- Deploying contracts ---");
  const t721 = await (await ethers.getContractFactory("EventContract721")).deploy();
  const t1155 = await (await ethers.getContractFactory("EventContract1155")).deploy();
  const claimC = await (await ethers.getContractFactory("ClaimContract")).deploy();
  const reg = await (await ethers.getContractFactory("PlatformRegistry")).deploy(
    deployer.address, deployer.address, deployer.address,
    await claimC.getAddress(), await t721.getAddress(), await t1155.getAddress()
  );
  await claimC.setFactory(await reg.getAddress());
  console.log("  All contracts deployed\n");

  const ph = ethers.keccak256(ethers.toUtf8Bytes("pay-001"));

  // =========================================================================
  // TEST 1: Create ERC1155 Event
  // =========================================================================

  console.log("--- TEST 1: Create ERC1155 Event ---");

  const tx = await reg.createEvent(
    1, // ERC1155
    "Festival 2026",
    "ipfs://QmFestival/",
    500, // global max supply
    organizer.address,
    ph
  );
  const receipt = await tx.wait();
  const eventAddr = receipt.logs.find(l => l.fragment && l.fragment.name === "EventCreated").args[0];
  const event1155 = await ethers.getContractAt("EventContract1155", eventAddr);

  console.log(`  Event deployed at: ${eventAddr}`);

  const info = await event1155.getEventInfo();
  assert(info.name === "Festival 2026", "Event name matches");
  assert(info.supply === 500n, "Global max supply 500");
  assert(info.types === 0n, "0 ticket types initially");

  // =========================================================================
  // TEST 2: Create Ticket Types (Zones)
  // =========================================================================

  console.log("\n--- TEST 2: Create Ticket Types ---");

  // Random user cannot create types
  await expectRevert(
    event1155.connect(randomUser).createTicketType(0, "General", 300, 0),
    "Random user cannot create ticket type"
  );

  // Organizer creates zones
  await event1155.connect(organizer).createTicketType(0, "General Admission", 300, 0);
  await event1155.connect(organizer).createTicketType(1, "VIP", 150, 1);
  await event1155.connect(organizer).createTicketType(2, "Backstage", 40, 2);
  await event1155.connect(organizer).createTicketType(3, "All Access", 10, 3);

  const genInfo = await event1155.getTicketTypeInfo(0);
  assert(genInfo.name === "General Admission", "General type name");
  assert(genInfo.typeMaxSupply === 300n, "General max 300");
  assert(genInfo.zoneLevel === 0n, "General zone = 0");
  assert(genInfo.active === true, "General is active");

  const vipInfo = await event1155.getTicketTypeInfo(1);
  assert(vipInfo.name === "VIP", "VIP type name");
  assert(vipInfo.zoneLevel === 1n, "VIP zone = 1");

  const allInfo = await event1155.getTicketTypeInfo(3);
  assert(allInfo.maxSupply === 10n || allInfo.typeMaxSupply === 10n, "All Access max 10");
  assert(allInfo.zoneLevel === 3n, "All Access zone = 3");

  // Cannot create duplicate type ID
  await expectRevert(
    event1155.connect(organizer).createTicketType(0, "Dup", 100, 0),
    "Duplicate type ID reverts"
  );

  assert((await event1155.getEventInfo()).types === 4n, "4 ticket types created");

  // =========================================================================
  // TEST 3: Toggle Sale & Mint
  // =========================================================================

  console.log("\n--- TEST 3: Mint Tickets per Zone ---");

  await event1155.connect(organizer).toggleSale();

  // Mint General for buyer1
  const cc1 = "FEST-GEN-001";
  const ch1 = ethers.keccak256(ethers.toUtf8Bytes(cc1));
  await event1155.mintWithPaymentProof(buyer1.address, 0, ph, ch1);

  // Mint VIP for buyer2
  const cc2 = "FEST-VIP-001";
  const ch2 = ethers.keccak256(ethers.toUtf8Bytes(cc2));
  await event1155.mintWithPaymentProof(buyer2.address, 1, ph, ch2);

  // Mint Backstage for buyer1
  const cc3 = "FEST-BACK-001";
  const ch3 = ethers.keccak256(ethers.toUtf8Bytes(cc3));
  await event1155.mintWithPaymentProof(buyer1.address, 2, ph, ch3);

  // Mint All Access for buyer2
  const cc4 = "FEST-AA-001";
  const ch4 = ethers.keccak256(ethers.toUtf8Bytes(cc4));
  await event1155.mintWithPaymentProof(buyer2.address, 3, ph, ch4);

  assert((await event1155.getEventInfo()).minted === 4n, "4 tickets minted total");

  // Check ticket type mapping
  assert(await event1155.ticketType(1) === 0n, "Token 1 is General");
  assert(await event1155.ticketType(2) === 1n, "Token 2 is VIP");
  assert(await event1155.ticketType(3) === 2n, "Token 3 is Backstage");
  assert(await event1155.ticketType(4) === 3n, "Token 4 is All Access");

  // Check zone levels via getTicketInfo
  const t2Info = await event1155.getTicketInfo(2);
  assert(t2Info.zoneLevel === 1n, "Token 2 zone level = 1 (VIP)");

  const t4Info = await event1155.getTicketInfo(4);
  assert(t4Info.zoneLevel === 3n, "Token 4 zone level = 3 (All Access)");

  // Invalid ticket type
  await expectRevert(
    event1155.mintWithPaymentProof(buyer1.address, 99, ph, ethers.keccak256(ethers.toUtf8Bytes("x"))),
    "Invalid ticket type reverts"
  );

  // =========================================================================
  // TEST 4: Claim ERC1155 Tickets
  // =========================================================================

  console.log("\n--- TEST 4: Claim ERC1155 Tickets ---");

  const claimAddr = await claimC.getAddress();

  // All tokens are in ClaimContract
  assert(await event1155.balanceOf(claimAddr, 1) === 1n, "Token 1 held by ClaimContract");
  assert(await event1155.balanceOf(claimAddr, 2) === 1n, "Token 2 held by ClaimContract");

  // Claim General ticket
  await claimC.claim(cc1, buyer1.address);
  assert(await event1155.balanceOf(buyer1.address, 1) === 1n, "Buyer1 claimed General ticket");
  assert(await event1155.balanceOf(claimAddr, 1) === 0n, "ClaimContract no longer holds token 1");

  // Claim VIP ticket
  await claimC.claim(cc2, buyer2.address);
  assert(await event1155.balanceOf(buyer2.address, 2) === 1n, "Buyer2 claimed VIP ticket");

  // =========================================================================
  // TEST 5: Activate & Transfer Lock
  // =========================================================================

  console.log("\n--- TEST 5: Activate & Transfer Lock ---");

  // Activate buyer1's General ticket
  await event1155.activateTicket(1);
  const activated = await event1155.getTicketInfo(1);
  assert(activated.activated === true, "Token 1 activated");

  // Activated ticket cannot be transferred
  await expectRevert(
    event1155.connect(buyer1).safeTransferFrom(buyer1.address, buyer2.address, 1, 1, "0x"),
    "Activated ticket transfer blocked"
  );

  // Non-activated ticket CAN transfer
  await event1155.connect(buyer2).safeTransferFrom(buyer2.address, buyer1.address, 2, 1, "0x");
  assert(await event1155.balanceOf(buyer1.address, 2) === 1n, "Non-activated VIP transferred OK");

  // =========================================================================
  // TEST 6: Toggle Ticket Type
  // =========================================================================

  console.log("\n--- TEST 6: Toggle Ticket Type ---");

  await event1155.connect(organizer).toggleTicketType(1); // Disable VIP
  const vipOff = await event1155.getTicketTypeInfo(1);
  assert(vipOff.active === false, "VIP type deactivated");

  // Cannot mint deactivated type
  await expectRevert(
    event1155.mintWithPaymentProof(buyer1.address, 1, ph, ethers.keccak256(ethers.toUtf8Bytes("vip-blocked"))),
    "Cannot mint deactivated ticket type"
  );

  // Re-enable
  await event1155.connect(organizer).toggleTicketType(1);
  assert((await event1155.getTicketTypeInfo(1)).active === true, "VIP type reactivated");

  // =========================================================================
  // TEST 7: Type Max Supply
  // =========================================================================

  console.log("\n--- TEST 7: Type Max Supply ---");

  // Create type with max 2
  await event1155.connect(organizer).createTicketType(10, "Limited", 2, 0);

  const lc1 = ethers.keccak256(ethers.toUtf8Bytes("lim1"));
  const lc2 = ethers.keccak256(ethers.toUtf8Bytes("lim2"));
  const lc3 = ethers.keccak256(ethers.toUtf8Bytes("lim3"));

  await event1155.mintWithPaymentProof(buyer1.address, 10, ph, lc1);
  await event1155.mintWithPaymentProof(buyer2.address, 10, ph, lc2);

  await expectRevert(
    event1155.mintWithPaymentProof(buyer1.address, 10, ph, lc3),
    "Type max supply reached"
  );

  const limInfo = await event1155.getTicketTypeInfo(10);
  assert(limInfo.minted === 2n, "Limited type: 2 minted");

  // =========================================================================
  // TEST 8: End Event → Unlock
  // =========================================================================

  console.log("\n--- TEST 8: End Event ---");

  await event1155.connect(organizer).endEvent();
  assert((await event1155.getEventInfo()).ended === true, "Event ended");

  // Activated ticket can now transfer (collectible)
  await event1155.connect(buyer1).safeTransferFrom(buyer1.address, buyer2.address, 1, 1, "0x");
  assert(await event1155.balanceOf(buyer2.address, 1) === 1n, "Activated ticket transfers after event end");

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
