// scripts/test-erc721-lifecycle.js
// ============================================
// GembaTicket v2 — ERC721 Full Lifecycle Test
// ============================================
// npx hardhat run scripts/test-erc721-lifecycle.js --network localhost
//
// Tests: deploy → create event → toggle sale → mint with proof →
//        activate → transfer lock → end event → transfer unlock → claim NFT

const hre = require("hardhat");
const { ethers } = hre;

// Colors for terminal output
const GREEN = "\x1b[32m✓\x1b[0m";
const RED = "\x1b[31m✗\x1b[0m";
const YELLOW = "\x1b[33m⚠\x1b[0m";
let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ${GREEN} ${testName}`);
    passed++;
  } else {
    console.log(`  ${RED} ${testName}`);
    failed++;
  }
}

async function expectRevert(promise, testName) {
  try {
    await promise;
    console.log(`  ${RED} ${testName} (should have reverted)`);
    failed++;
  } catch (e) {
    console.log(`  ${GREEN} ${testName} (reverted as expected)`);
    passed++;
  }
}

async function main() {
  console.log("============================================");
  console.log("GembaTicket v2 — ERC721 Full Lifecycle Test");
  console.log("============================================\n");

  // =========================================================================
  // SETUP: Get signers and deploy fresh
  // =========================================================================

  const [deployer, organizer, buyer1, buyer2, randomUser] = await ethers.getSigners();

  console.log("Accounts:");
  console.log(`  deployer/signer: ${deployer.address}`);
  console.log(`  organizer:       ${organizer.address}`);
  console.log(`  buyer1:          ${buyer1.address}`);
  console.log(`  buyer2:          ${buyer2.address}`);
  console.log(`  randomUser:      ${randomUser.address}`);
  console.log("");

  // Deploy fresh contracts
  console.log("--- Deploying contracts ---");

  const EventContract721 = await ethers.getContractFactory("EventContract721");
  const template721 = await EventContract721.deploy();
  await template721.waitForDeployment();

  const EventContract1155 = await ethers.getContractFactory("EventContract1155");
  const template1155 = await EventContract1155.deploy();
  await template1155.waitForDeployment();

  const ClaimContract = await ethers.getContractFactory("ClaimContract");
  const claim = await ClaimContract.deploy();
  await claim.waitForDeployment();

  const PlatformRegistry = await ethers.getContractFactory("PlatformRegistry");
  const registry = await PlatformRegistry.deploy(
    deployer.address,   // admin
    deployer.address,   // multisig
    deployer.address,   // platformSigner
    await claim.getAddress(),
    await template721.getAddress(),
    await template1155.getAddress()
  );
  await registry.waitForDeployment();

  // Configure ClaimContract
  await claim.setFactory(await registry.getAddress());

  console.log(`  PlatformRegistry: ${await registry.getAddress()}`);
  console.log(`  ClaimContract:    ${await claim.getAddress()}`);
  console.log("");

  // =========================================================================
  // TEST 1: Create ERC721 Event
  // =========================================================================

  console.log("--- TEST 1: Create ERC721 Event ---");

  const paymentHash = ethers.keccak256(ethers.toUtf8Bytes("gembapay-payment-001"));

  const tx1 = await registry.createEvent(
    0, // ERC721
    "Rock Concert 2026",
    "ipfs://QmRockConcert/",
    100, // maxSupply
    organizer.address,
    paymentHash
  );
  const receipt1 = await tx1.wait();

  // Get event address from EventCreated log
  const eventCreatedLog = receipt1.logs.find(
    log => log.fragment && log.fragment.name === "EventCreated"
  );
  const eventAddress = eventCreatedLog.args[0];
  console.log(`  Event deployed at: ${eventAddress}`);

  const event721 = await ethers.getContractAt("EventContract721", eventAddress);

  const eventInfo = await event721.getEventInfo();
  assert(eventInfo.name === "Rock Concert 2026", "Event name matches");
  assert(eventInfo.supply === 100n, "Max supply is 100");
  assert(eventInfo.minted === 0n, "0 tickets minted");
  assert(eventInfo.sale === false, "Sale starts inactive");
  assert(eventInfo.canceled === false, "Not canceled");
  assert(eventInfo.ended === false, "Not ended");

  assert(await event721.owner() === organizer.address, "Owner is organizer");
  assert(await event721.platform() === deployer.address, "Platform is deployer");

  const totalEvents = await registry.totalEvents();
  assert(totalEvents === 1n, "Registry tracks 1 event");
  assert(await registry.isEvent(eventAddress), "Registry recognizes event");

  // =========================================================================
  // TEST 2: Toggle Sale
  // =========================================================================

  console.log("\n--- TEST 2: Toggle Sale ---");

  // Random user cannot toggle
  await expectRevert(
    event721.connect(randomUser).toggleSale(),
    "Random user cannot toggle sale"
  );

  // Organizer toggles sale on
  await event721.connect(organizer).toggleSale();
  assert((await event721.getEventInfo()).sale === true, "Sale is now active");

  // =========================================================================
  // TEST 3: Mint Ticket with Payment Proof (ERC721)
  // =========================================================================

  console.log("\n--- TEST 3: Mint Ticket ---");

  // Generate claim code (backend would do this)
  const claimCode1 = "CLAIM-ROCK-001-" + Date.now();
  const claimHash1 = ethers.keccak256(ethers.toUtf8Bytes(claimCode1));
  const paymentHash1 = ethers.keccak256(ethers.toUtf8Bytes("gembapay-tx-001"));

  // Random user cannot mint
  await expectRevert(
    event721.connect(randomUser).mintWithPaymentProof(buyer1.address, paymentHash1, claimHash1),
    "Random user cannot mint"
  );

  // Platform signer mints
  const mintTx = await event721.mintWithPaymentProof(buyer1.address, paymentHash1, claimHash1);
  await mintTx.wait();

  const info = await event721.getEventInfo();
  assert(info.minted === 1n, "1 ticket minted");

  // NFT is in ClaimContract, not buyer
  const claimAddr = await claim.getAddress();
  const ownerOfToken = await event721.ownerOf(1);
  assert(ownerOfToken === claimAddr, "NFT held by ClaimContract");

  // Claim hash stored
  const storedHash = await event721.ticketClaimHash(1);
  assert(storedHash === claimHash1, "Claim hash stored on-chain");

  // Mint second ticket for buyer2
  const claimCode2 = "CLAIM-ROCK-002-" + Date.now();
  const claimHash2 = ethers.keccak256(ethers.toUtf8Bytes(claimCode2));
  const paymentHash2 = ethers.keccak256(ethers.toUtf8Bytes("gembapay-tx-002"));
  await event721.mintWithPaymentProof(buyer2.address, paymentHash2, claimHash2);
  assert((await event721.getEventInfo()).minted === 2n, "2 tickets minted");

  // =========================================================================
  // TEST 4: Claim NFT (User claims ticket to their wallet)
  // =========================================================================

  console.log("\n--- TEST 4: Claim NFT ---");

  // Wrong claim code
  await expectRevert(
    claim.claim("WRONG-CODE", buyer1.address),
    "Wrong claim code reverts"
  );

  // Correct claim
  await claim.claim(claimCode1, buyer1.address);
  assert(await event721.ownerOf(1) === buyer1.address, "Buyer1 owns token 1 after claim");

  // Cannot claim twice
  await expectRevert(
    claim.claim(claimCode1, buyer1.address),
    "Cannot claim same code twice"
  );

  // Buyer2 claims
  await claim.claim(claimCode2, buyer2.address);
  assert(await event721.ownerOf(2) === buyer2.address, "Buyer2 owns token 2 after claim");

  // =========================================================================
  // TEST 5: Transfer Claim (before claiming)
  // =========================================================================

  console.log("\n--- TEST 5: Transfer Claim ---");

  // Mint a 3rd ticket
  const claimCode3 = "CLAIM-ROCK-003-" + Date.now();
  const claimHash3 = ethers.keccak256(ethers.toUtf8Bytes(claimCode3));
  await event721.mintWithPaymentProof(buyer1.address, paymentHash1, claimHash3);

  // buyer1 transfers claim to buyer2 (ticket resale before event)
  await claim.connect(buyer1).transferClaim(claimHash3, buyer2.address);

  // Now buyer2 can claim it
  await claim.claim(claimCode3, buyer2.address);
  assert(await event721.ownerOf(3) === buyer2.address, "Buyer2 owns transferred ticket");

  // =========================================================================
  // TEST 6: Activate Ticket (First Scan)
  // =========================================================================

  console.log("\n--- TEST 6: Activate Ticket ---");

  // Random user cannot activate
  await expectRevert(
    event721.connect(randomUser).activateTicket(1),
    "Random user cannot activate"
  );

  // Platform activates (scanner verified entry)
  await event721.activateTicket(1);
  const ticketInfo = await event721.getTicketInfo(1);
  assert(ticketInfo.activated === true, "Ticket 1 is activated");
  assert(ticketInfo.holder === buyer1.address, "Activated by buyer1");

  // Cannot activate twice
  await expectRevert(
    event721.activateTicket(1),
    "Cannot activate same ticket twice"
  );

  // =========================================================================
  // TEST 7: Transfer Lock After Activation
  // =========================================================================

  console.log("\n--- TEST 7: Transfer Lock ---");

  // Activated ticket cannot be transferred
  await expectRevert(
    event721.connect(buyer1).transferFrom(buyer1.address, buyer2.address, 1),
    "Activated ticket transfer blocked"
  );

  // Non-activated ticket CAN be transferred
  await event721.connect(buyer2).transferFrom(buyer2.address, buyer1.address, 2);
  assert(await event721.ownerOf(2) === buyer1.address, "Non-activated ticket transfers OK");

  // =========================================================================
  // TEST 8: End Event → Unlock Transfers
  // =========================================================================

  console.log("\n--- TEST 8: End Event ---");

  // Random user cannot end
  await expectRevert(
    event721.connect(randomUser).endEvent(),
    "Random user cannot end event"
  );

  // Organizer ends
  await event721.connect(organizer).endEvent();
  const finalInfo = await event721.getEventInfo();
  assert(finalInfo.ended === true, "Event is ended");
  assert(finalInfo.sale === false, "Sale turned off");

  // NOW activated ticket can transfer (collectible)
  await event721.connect(buyer1).transferFrom(buyer1.address, buyer2.address, 1);
  assert(await event721.ownerOf(1) === buyer2.address, "Activated ticket transfers after event end");

  // Cannot mint after event ends (sale is off)
  const claimCode4 = "CLAIM-ROCK-004-" + Date.now();
  const claimHash4 = ethers.keccak256(ethers.toUtf8Bytes(claimCode4));
  await expectRevert(
    event721.mintWithPaymentProof(buyer1.address, paymentHash1, claimHash4),
    "Cannot mint after event ended"
  );

  // =========================================================================
  // TEST 9: Max Supply Check
  // =========================================================================

  console.log("\n--- TEST 9: Max Supply ---");

  // Create small event (max 2 tickets)
  const tx9 = await registry.createEvent(
    0, "Small Event", "ipfs://small/", 2, organizer.address,
    ethers.keccak256(ethers.toUtf8Bytes("pay-small"))
  );
  const r9 = await tx9.wait();
  const smallAddr = r9.logs.find(l => l.fragment && l.fragment.name === "EventCreated").args[0];
  const smallEvent = await ethers.getContractAt("EventContract721", smallAddr);

  await smallEvent.connect(organizer).toggleSale();

  const cc1 = ethers.keccak256(ethers.toUtf8Bytes("s1"));
  const cc2 = ethers.keccak256(ethers.toUtf8Bytes("s2"));
  const cc3 = ethers.keccak256(ethers.toUtf8Bytes("s3"));
  const ph = ethers.keccak256(ethers.toUtf8Bytes("px"));

  await smallEvent.mintWithPaymentProof(buyer1.address, ph, cc1);
  await smallEvent.mintWithPaymentProof(buyer2.address, ph, cc2);

  // Third mint should fail
  await expectRevert(
    smallEvent.mintWithPaymentProof(buyer1.address, ph, cc3),
    "Max supply reached — mint reverts"
  );

  // =========================================================================
  // TEST 10: Cancel Event
  // =========================================================================

  console.log("\n--- TEST 10: Cancel Event ---");

  const tx10 = await registry.createEvent(
    0, "Cancel Test", "ipfs://cancel/", 50, organizer.address,
    ethers.keccak256(ethers.toUtf8Bytes("pay-cancel"))
  );
  const r10 = await tx10.wait();
  const cancelAddr = r10.logs.find(l => l.fragment && l.fragment.name === "EventCreated").args[0];
  const cancelEvent = await ethers.getContractAt("EventContract721", cancelAddr);

  await cancelEvent.connect(organizer).toggleSale();
  await cancelEvent.connect(organizer).cancelEvent();

  const cancelInfo = await cancelEvent.getEventInfo();
  assert(cancelInfo.canceled === true, "Event is canceled");
  assert(cancelInfo.sale === false, "Sale off after cancel");

  // Cannot mint on canceled event
  const ccx = ethers.keccak256(ethers.toUtf8Bytes("cx"));
  await expectRevert(
    cancelEvent.mintWithPaymentProof(buyer1.address, ph, ccx),
    "Cannot mint on canceled event"
  );

  // Cannot end a canceled event
  await expectRevert(
    cancelEvent.connect(organizer).endEvent(),
    "Cannot end a canceled event"
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
