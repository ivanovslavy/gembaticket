// scripts/test-erc721-lifecycle.js
// ============================================
// GembaTicket v2 — ERC721 Full Lifecycle Test
// ============================================
// Reads deployed/<network>-latest.json for contract addresses.
// Tests: create event → setup phase → signature-based claim →
//        activate → transfer lock → end event → unlock → custom URI
//
// Usage:
//   npx hardhat run scripts/test-erc721-lifecycle.js --network sepolia
//   npx hardhat run scripts/test-erc721-lifecycle.js --network localhost

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

// Sign claim for ERC721: keccak256(contract, claimHash, wallet)
async function signClaim721(signer, contractAddr, claimHash, wallet) {
  const messageHash = ethers.solidityPackedKeccak256(
    ["address", "bytes32", "address"],
    [contractAddr, claimHash, wallet]
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
  console.log("GembaTicket v2 — ERC721 Lifecycle Test");
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

  // Use MINT_SIGNER_KEY from .env if available, otherwise fall back to platformSigner
  const mintSigner = process.env.MINT_SIGNER_KEY
    ? new ethers.Wallet(process.env.MINT_SIGNER_KEY, ethers.provider)
    : platformSigner;

  console.log("\nAccounts:");
  console.log(`  platformSigner: ${platformSigner.address}`);
  console.log(`  mintSigner:     ${mintSigner.address}`);
  console.log(`  organizer:      ${organizer.address}`);
  console.log(`  buyer1:         ${buyer1.address}`);
  console.log(`  buyer2:         ${buyer2.address}`);
  console.log(`  randomUser:     ${randomUser.address}\n`);

  const registryAddr = deployment.contracts.PlatformRegistry.address;
  const registry = await ethers.getContractAt("PlatformRegistry", registryAddr);
  console.log(`PlatformRegistry: ${registryAddr}`);

  const ph = ethers.keccak256(ethers.toUtf8Bytes("test-pay-721-" + Date.now()));

  // =========================================================================
  // TEST 1: Create ERC721 Event
  // =========================================================================

  console.log("\n--- TEST 1: Create ERC721 Event ---");

  const tx1 = await registry.connect(platformSigner).createEvent(
    0, "Rock Concert 2026", "ipfs://QmRockConcert/", 100, organizer.address, ph
  );
  const receipt1 = await tx1.wait();
  const eventAddr = receipt1.logs.find(l => l.fragment && l.fragment.name === "EventCreated").args[0];
  const event721 = await ethers.getContractAt("EventContract721", eventAddr);
  console.log(`  Event deployed at: ${eventAddr}`);

  const info = await event721.getEventInfo();
  assert(info.name === "Rock Concert 2026", "Event name matches");
  assert(info.supply === 100n, "Max supply is 100");
  assert(info.minted === 0n, "0 minted");
  assert(info.sale === false, "Sale starts inactive");
  assert(await event721.owner() === organizer.address, "Owner is organizer");
  assert(await event721.platform() === platformSigner.address, "Platform is signer");
  assert(await event721.mintSigner() === mintSigner.address, "MintSigner set");
  assert(await event721.setupComplete() === false, "Setup not complete");
  assert(await registry.isEvent(eventAddr), "Registry tracks event");

  // =========================================================================
  // TEST 2: Setup Phase (platform only, locked after completeSetup)
  // =========================================================================

  console.log("\n--- TEST 2: Setup Phase ---");

  await expectRevert(
    event721.connect(randomUser).enableSale(),
    "Random user cannot enableSale"
  );

  await event721.connect(platformSigner).enableSale();
  assert((await event721.getEventInfo()).sale === true, "Sale enabled by platform");

  await event721.connect(platformSigner).setBaseURI("ipfs://QmRockConcertV2/");
  await event721.connect(platformSigner).completeSetup();
  assert(await event721.setupComplete() === true, "Setup complete");

  await expectRevert(event721.connect(platformSigner).enableSale(), "Platform locked: enableSale");
  await expectRevert(event721.connect(platformSigner).setBaseURI("x"), "Platform locked: setBaseURI");
  await expectRevert(event721.connect(platformSigner).completeSetup(), "Platform locked: completeSetup");

  // =========================================================================
  // TEST 3: Claim Ticket (signature-based, buyer pays gas, no escrow)
  // =========================================================================

  console.log("\n--- TEST 3: Claim Ticket ---");

  const h1 = randomClaimHash();
  const sig1 = await signClaim721(mintSigner, eventAddr, h1, buyer1.address);

  // Wrong signer
  const badSig = await signClaim721(randomUser, eventAddr, h1, buyer1.address);
  await expectRevert(
    event721.connect(buyer1).claimTicket(h1, badSig),
    "Wrong signer rejected"
  );

  // Valid claim
  await event721.connect(buyer1).claimTicket(h1, sig1);
  assert((await event721.getEventInfo()).minted === 1n, "1 ticket minted");
  assert(await event721.ownerOf(1) === buyer1.address, "NFT owned directly by buyer1 (no escrow)");

  // Double claim
  await expectRevert(
    event721.connect(buyer1).claimTicket(h1, sig1),
    "Double claim rejected"
  );

  // Replay: sig for buyer1 used by buyer2
  const h2 = randomClaimHash();
  const sig2for1 = await signClaim721(mintSigner, eventAddr, h2, buyer1.address);
  await expectRevert(
    event721.connect(buyer2).claimTicket(h2, sig2for1),
    "Replay attack: wrong wallet rejected"
  );

  // Buyer2 proper claim
  const h3 = randomClaimHash();
  const sig3 = await signClaim721(mintSigner, eventAddr, h3, buyer2.address);
  await event721.connect(buyer2).claimTicket(h3, sig3);
  assert(await event721.ownerOf(2) === buyer2.address, "Buyer2 owns token 2");
  assert((await event721.getEventInfo()).minted === 2n, "2 tickets minted");

  // =========================================================================
  // TEST 4: Custom Token URI (boutique events)
  // =========================================================================

  console.log("\n--- TEST 4: Custom Token URI ---");

  assert(await event721.tokenURI(1) === "ipfs://QmRockConcertV2/1", "Base URI works");

  await event721.connect(organizer).setTokenURI(1, "ipfs://QmUniqueArt1");
  assert(await event721.tokenURI(1) === "ipfs://QmUniqueArt1", "Custom token URI set");
  assert(await event721.tokenURI(2) === "ipfs://QmRockConcertV2/2", "Token 2 still uses base URI");

  // =========================================================================
  // TEST 5: Activate Ticket (First Scan)
  // =========================================================================

  console.log("\n--- TEST 5: Activate Ticket ---");

  await expectRevert(event721.connect(randomUser).activateTicket(1), "Random user cannot activate");

  await event721.connect(platformSigner).activateTicket(1);
  const tInfo = await event721.getTicketInfo(1);
  assert(tInfo.activated === true, "Ticket 1 activated");
  assert(tInfo.holder === buyer1.address, "Activated by buyer1");

  await expectRevert(event721.connect(platformSigner).activateTicket(1), "Cannot activate twice");

  // =========================================================================
  // TEST 6: Transfer Lock After Activation
  // =========================================================================

  console.log("\n--- TEST 6: Transfer Lock ---");

  await expectRevert(
    event721.connect(buyer1).transferFrom(buyer1.address, buyer2.address, 1),
    "Activated ticket transfer blocked"
  );

  // Non-activated CAN transfer
  await event721.connect(buyer2).transferFrom(buyer2.address, buyer1.address, 2);
  assert(await event721.ownerOf(2) === buyer1.address, "Non-activated ticket transfers OK");

  // =========================================================================
  // TEST 7: Owner Functions
  // =========================================================================

  console.log("\n--- TEST 7: Owner Functions ---");

  await event721.connect(organizer).toggleSale();
  assert((await event721.getEventInfo()).sale === false, "Sale toggled off");
  await event721.connect(organizer).toggleSale();
  assert((await event721.getEventInfo()).sale === true, "Sale toggled on");

  await event721.connect(organizer).increaseSupply(50);
  assert((await event721.getEventInfo()).supply === 150n, "Supply increased to 150");

  await event721.connect(organizer).updateBaseURI("ipfs://QmUpdated/");

  await expectRevert(event721.connect(randomUser).toggleSale(), "Random user cannot toggleSale");
  await expectRevert(event721.connect(randomUser).increaseSupply(999), "Random user cannot increaseSupply");

  // =========================================================================
  // TEST 8: End Event → Unlock Transfers
  // =========================================================================

  console.log("\n--- TEST 8: End Event ---");

  await event721.connect(organizer).endEvent();
  const finalInfo = await event721.getEventInfo();
  assert(finalInfo.ended === true, "Event ended");
  assert(finalInfo.sale === false, "Sale off after end");

  // Activated ticket can now transfer (collectible)
  await event721.connect(buyer1).transferFrom(buyer1.address, buyer2.address, 1);
  assert(await event721.ownerOf(1) === buyer2.address, "Activated ticket transfers after event end");

  // Cannot claim after event ended
  const h4 = randomClaimHash();
  const sig4 = await signClaim721(mintSigner, eventAddr, h4, buyer1.address);
  await expectRevert(
    event721.connect(buyer1).claimTicket(h4, sig4),
    "Cannot claim after event ended"
  );

  // =========================================================================
  // TEST 9: Max Supply
  // =========================================================================

  console.log("\n--- TEST 9: Max Supply ---");

  const tx9 = await registry.connect(platformSigner).createEvent(
    0, "Tiny Event", "ipfs://tiny/", 2, organizer.address,
    ethers.keccak256(ethers.toUtf8Bytes("pay-tiny-" + Date.now()))
  );
  const r9 = await tx9.wait();
  const tinyAddr = r9.logs.find(l => l.fragment && l.fragment.name === "EventCreated").args[0];
  const tinyEvent = await ethers.getContractAt("EventContract721", tinyAddr);

  await tinyEvent.connect(platformSigner).enableSale();
  await tinyEvent.connect(platformSigner).completeSetup();

  for (let i = 0; i < 2; i++) {
    const h = randomClaimHash();
    const s = await signClaim721(mintSigner, tinyAddr, h, buyer1.address);
    await tinyEvent.connect(buyer1).claimTicket(h, s);
  }

  const hOver = randomClaimHash();
  const sOver = await signClaim721(mintSigner, tinyAddr, hOver, buyer1.address);
  await expectRevert(tinyEvent.connect(buyer1).claimTicket(hOver, sOver), "Max supply reached");

  // =========================================================================
  // TEST 10: Cancel Event
  // =========================================================================

  console.log("\n--- TEST 10: Cancel Event ---");

  const tx10 = await registry.connect(platformSigner).createEvent(
    0, "Cancel Test", "ipfs://cancel/", 50, organizer.address,
    ethers.keccak256(ethers.toUtf8Bytes("pay-cancel-" + Date.now()))
  );
  const r10 = await tx10.wait();
  const cancelAddr = r10.logs.find(l => l.fragment && l.fragment.name === "EventCreated").args[0];
  const cancelEvent = await ethers.getContractAt("EventContract721", cancelAddr);

  await cancelEvent.connect(platformSigner).enableSale();
  await cancelEvent.connect(platformSigner).completeSetup();
  await cancelEvent.connect(organizer).cancelEvent();

  assert((await cancelEvent.getEventInfo()).canceled === true, "Event canceled");
  assert((await cancelEvent.getEventInfo()).sale === false, "Sale off after cancel");

  const ch = randomClaimHash();
  const cs = await signClaim721(mintSigner, cancelAddr, ch, buyer1.address);
  await expectRevert(cancelEvent.connect(buyer1).claimTicket(ch, cs), "Cannot claim on canceled event");
  await expectRevert(cancelEvent.connect(organizer).endEvent(), "Cannot end canceled event");

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
