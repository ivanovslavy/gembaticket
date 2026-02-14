// scripts/test-platform-security.js
// ============================================
// GembaTicket v2 — Platform Admin & Security Tests
// ============================================
// Reads deployed/<network>-latest.json for contract addresses.
// Tests: access control, admin functions, pause, template upgrade,
//        treasury, key rotation, zero address validation, setup lockout
//
// Usage:
//   npx hardhat run scripts/test-platform-security.js --network sepolia
//   npx hardhat run scripts/test-platform-security.js --network localhost

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
  console.log("GembaTicket v2 — Platform & Security Tests");
  console.log("============================================\n");

  const network = hre.network.name;
  const deployment = loadDeployment(network);
  console.log(`Network: ${network} (deployed: ${deployment.timestamp})`);

  const signers = await ethers.getSigners();
  const admin = signers[0];       // = deployer = platformSigner on localhost
  const multisig = signers[0];
  const platformSigner = signers[0];
  const mintSigner = process.env.MINT_SIGNER_KEY
    ? new ethers.Wallet(process.env.MINT_SIGNER_KEY, ethers.provider)
    : signers[0];
  const organizer = signers[1] || signers[0];
  const attacker = signers[4] || signers[1] || signers[0];
  const newAdmin = signers[5] || signers[2] || signers[0];

  console.log("\nAccounts:");
  console.log(`  admin/signer: ${admin.address}`);
  console.log(`  mintSigner:   ${mintSigner.address}`);
  console.log(`  organizer:    ${organizer.address}`);
  console.log(`  attacker:     ${attacker.address}`);
  console.log(`  newAdmin:     ${newAdmin.address}\n`);

  const registryAddr = deployment.contracts.PlatformRegistry.address;
  const registry = await ethers.getContractAt("PlatformRegistry", registryAddr);
  console.log(`PlatformRegistry: ${registryAddr}`);

  const ph = ethers.keccak256(ethers.toUtf8Bytes("sec-test-" + Date.now()));

  // =========================================================================
  // TEST 1: PlatformRegistry Access Control
  // =========================================================================

  console.log("\n--- TEST 1: PlatformRegistry Access Control ---");

  if (attacker.address !== platformSigner.address) {
    await expectRevert(
      registry.connect(attacker).createEvent(0, "Hack", "ipfs://", 10, attacker.address, ph),
      "Attacker cannot createEvent"
    );
  }

  if (attacker.address !== admin.address) {
    await expectRevert(registry.connect(attacker).setPlatformSigner(attacker.address), "Attacker cannot setPlatformSigner");
    await expectRevert(registry.connect(attacker).setMintSigner(attacker.address), "Attacker cannot setMintSigner");
    await expectRevert(registry.connect(attacker).setTemplate(0, attacker.address), "Attacker cannot setTemplate");
    await expectRevert(registry.connect(attacker).togglePause(), "Attacker cannot togglePause");
    await expectRevert(registry.connect(attacker).setAdmin(attacker.address), "Attacker cannot setAdmin");
  }

  if (attacker.address !== multisig.address) {
    await expectRevert(registry.connect(attacker).withdraw(attacker.address, 1), "Attacker cannot withdraw");
    await expectRevert(registry.connect(attacker).fundSigner(1), "Attacker cannot fundSigner");
    await expectRevert(registry.connect(attacker).setMultisig(attacker.address), "Attacker cannot setMultisig");
  }

  const tx1 = await registry.connect(platformSigner).createEvent(
    0, "Legit Event", "ipfs://legit/", 100, organizer.address, ph
  );
  assert((await tx1.wait()).status === 1, "Signer creates event successfully");

  // =========================================================================
  // TEST 2: Pause System
  // =========================================================================

  console.log("\n--- TEST 2: Pause System ---");

  await registry.connect(admin).togglePause();
  assert(await registry.isPaused() === true, "Platform paused");

  await expectRevert(
    registry.connect(platformSigner).createEvent(0, "Blocked", "ipfs://", 10, organizer.address, ph),
    "Cannot createEvent when paused"
  );

  await registry.connect(admin).togglePause();
  assert(await registry.isPaused() === false, "Platform unpaused");

  const tx2 = await registry.connect(platformSigner).createEvent(
    0, "After Unpause", "ipfs://", 10, organizer.address, ph
  );
  assert((await tx2.wait()).status === 1, "Create event after unpause");

  // =========================================================================
  // TEST 3: Template Upgrade
  // =========================================================================

  console.log("\n--- TEST 3: Template Upgrade ---");

  const newT721 = await (await ethers.getContractFactory("EventContract721")).deploy();
  const newAddr = await newT721.getAddress();

  await registry.connect(admin).setTemplate(0, newAddr);
  assert(await registry.erc721Template() === newAddr, "ERC721 template updated");

  const tx3 = await registry.connect(platformSigner).createEvent(
    0, "New Template Event", "ipfs://new/", 50, organizer.address, ph
  );
  assert((await tx3.wait()).status === 1, "Event with new template");

  await expectRevert(registry.connect(admin).setTemplate(0, ethers.ZeroAddress), "Cannot set zero template");
  await expectRevert(registry.connect(admin).setTemplate(5, newAddr), "Invalid event type");

  // Restore original
  await registry.connect(admin).setTemplate(0, deployment.contracts.EventContract721.address);

  // =========================================================================
  // TEST 4: Treasury Operations
  // =========================================================================

  console.log("\n--- TEST 4: Treasury ---");

  await admin.sendTransaction({ to: registryAddr, value: ethers.parseEther("1.0") });
  const balance = await registry.contractBalance();
  assert(balance >= ethers.parseEther("1.0"), "Registry received ETH");

  const beforeBal = await ethers.provider.getBalance(organizer.address);
  await registry.connect(multisig).withdraw(organizer.address, ethers.parseEther("0.5"));
  const afterBal = await ethers.provider.getBalance(organizer.address);
  assert(afterBal - beforeBal === ethers.parseEther("0.5"), "Withdraw 0.5 ETH");

  // Fund signer
  const signerBefore = await ethers.provider.getBalance(platformSigner.address);
  await registry.connect(multisig).fundSigner(ethers.parseEther("0.3"));
  const signerAfter = await ethers.provider.getBalance(platformSigner.address);
  // Note: on localhost admin=multisig=signer, so gas costs make exact comparison hard
  assert(signerAfter >= signerBefore, "Fund signer executed");

  await expectRevert(registry.connect(multisig).withdraw(ethers.ZeroAddress, 1), "Cannot withdraw to zero");

  // =========================================================================
  // TEST 5: Zero Address Validation
  // =========================================================================

  console.log("\n--- TEST 5: Zero Address Checks ---");

  await expectRevert(registry.connect(admin).setPlatformSigner(ethers.ZeroAddress), "Cannot set zero platform signer");
  await expectRevert(registry.connect(admin).setMintSigner(ethers.ZeroAddress), "Cannot set zero mint signer");
  await expectRevert(registry.connect(multisig).setMultisig(ethers.ZeroAddress), "Cannot set zero multisig");
  await expectRevert(registry.connect(admin).setAdmin(ethers.ZeroAddress), "Cannot set zero admin");
  await expectRevert(
    registry.connect(platformSigner).createEvent(0, "Zero", "ipfs://", 10, ethers.ZeroAddress, ph),
    "Cannot create event with zero organizer"
  );

  // =========================================================================
  // TEST 6: Event Contract Access Control
  // =========================================================================

  console.log("\n--- TEST 6: Event Contract Access ---");

  const events = await registry.getEvents(0, 1);
  const event721 = await ethers.getContractAt("EventContract721", events[0]);

  if (attacker.address !== organizer.address) {
    await expectRevert(event721.connect(attacker).toggleSale(), "Attacker cannot toggleSale");
    await expectRevert(event721.connect(attacker).updateBaseURI("ipfs://hack/"), "Attacker cannot updateBaseURI");
    await expectRevert(event721.connect(attacker).increaseSupply(9999), "Attacker cannot increaseSupply");
    await expectRevert(event721.connect(attacker).transferOwnership(attacker.address), "Attacker cannot transferOwnership");
    await expectRevert(event721.connect(attacker).setMintSigner(attacker.address), "Attacker cannot setMintSigner");
    await expectRevert(event721.connect(attacker).setPlatform(attacker.address), "Attacker cannot setPlatform");
  }

  if (attacker.address !== platformSigner.address) {
    await expectRevert(event721.connect(attacker).activateTicket(1), "Attacker cannot activateTicket");
  }

  // =========================================================================
  // TEST 7: Key Rotation on Event Contract
  // =========================================================================

  console.log("\n--- TEST 7: Key Rotation ---");

  const txK = await registry.connect(platformSigner).createEvent(
    1, "Key Rotation Test", "ipfs://keys/", 100, organizer.address,
    ethers.keccak256(ethers.toUtf8Bytes("pay-keys-" + Date.now()))
  );
  const rK = await txK.wait();
  const kAddr = rK.logs.find(l => l.fragment && l.fragment.name === "EventCreated").args[0];
  const keyEvent = await ethers.getContractAt("EventContract1155", kAddr);

  await keyEvent.connect(platformSigner).createTicketType(0, "General", 100, 0);
  await keyEvent.connect(platformSigner).enableSale();
  await keyEvent.connect(platformSigner).completeSetup();

  // Claim with original mintSigner
  const h1 = randomClaimHash();
  const s1 = await signClaim1155(mintSigner, kAddr, 0, h1, organizer.address);
  await keyEvent.connect(organizer).claimTicket(0, h1, s1);
  assert((await keyEvent.getEventInfo()).minted === 1n, "Claim with original mintSigner");

  // Rotate mintSigner
  await keyEvent.connect(organizer).setMintSigner(newAdmin.address);
  assert(await keyEvent.mintSigner() === newAdmin.address, "MintSigner rotated");

  // Old signer fails
  const h2 = randomClaimHash();
  const oldSig = await signClaim1155(mintSigner, kAddr, 0, h2, organizer.address);
  await expectRevert(keyEvent.connect(organizer).claimTicket(0, h2, oldSig), "Old mintSigner rejected");

  // New signer works
  const newSig = await signClaim1155(newAdmin, kAddr, 0, h2, organizer.address);
  await keyEvent.connect(organizer).claimTicket(0, h2, newSig);
  assert((await keyEvent.getEventInfo()).minted === 2n, "New mintSigner works");

  // Rotate platform
  await keyEvent.connect(organizer).setPlatform(newAdmin.address);
  assert(await keyEvent.platform() === newAdmin.address, "Platform rotated");

  // Non-owner cannot rotate
  if (attacker.address !== organizer.address) {
    await expectRevert(keyEvent.connect(attacker).setMintSigner(attacker.address), "Non-owner cannot rotate mintSigner");
    await expectRevert(keyEvent.connect(attacker).setPlatform(attacker.address), "Non-owner cannot rotate platform");
  }

  // =========================================================================
  // TEST 8: Setup Phase Security
  // =========================================================================

  console.log("\n--- TEST 8: Setup Phase Security ---");

  const txS = await registry.connect(platformSigner).createEvent(
    1, "Setup Security", "ipfs://setup/", 100, organizer.address,
    ethers.keccak256(ethers.toUtf8Bytes("pay-setup-" + Date.now()))
  );
  const rS = await txS.wait();
  const sAddr = rS.logs.find(l => l.fragment && l.fragment.name === "EventCreated").args[0];
  const setupEvent = await ethers.getContractAt("EventContract1155", sAddr);

  // Owner cannot use platform setup functions
  if (organizer.address !== platformSigner.address) {
    await expectRevert(setupEvent.connect(organizer).createTicketType(0, "X", 100, 0), "Owner cannot createTicketType");
    await expectRevert(setupEvent.connect(organizer).enableSale(), "Owner cannot enableSale");
    await expectRevert(setupEvent.connect(organizer).completeSetup(), "Owner cannot completeSetup");
  }

  // Platform does setup
  await setupEvent.connect(platformSigner).createTicketType(0, "General", 100, 0);
  await setupEvent.connect(platformSigner).enableSale();
  await setupEvent.connect(platformSigner).completeSetup();

  // Platform locked after setup
  await expectRevert(
    setupEvent.connect(platformSigner).createTicketType(1, "Late", 50, 1),
    "Platform locked after setup"
  );

  // Owner can still add types
  await setupEvent.connect(organizer).addTicketType(1, "VIP Added", 50, 1);
  assert((await setupEvent.getEventInfo()).types === 2n, "Owner added type after setup");

  // =========================================================================
  // TEST 9: Admin Role Transfer
  // =========================================================================

  console.log("\n--- TEST 9: Admin Role Transfer ---");

  if (newAdmin.address !== admin.address) {
    await registry.connect(admin).setAdmin(newAdmin.address);
    assert(await registry.admin() === newAdmin.address, "Admin transferred");

    await expectRevert(registry.connect(admin).togglePause(), "Old admin cannot act");

    await registry.connect(newAdmin).togglePause();
    assert(await registry.isPaused() === true, "New admin can pause");
    await registry.connect(newAdmin).togglePause();

    // Restore
    await registry.connect(newAdmin).setAdmin(admin.address);
  } else {
    console.log("  ⚠ Skipped: not enough unique signers");
  }

  // =========================================================================
  // TEST 10: Constructor Validation & View Functions
  // =========================================================================

  console.log("\n--- TEST 10: Constructor Validation & Views ---");

  const PlatformRegistry = await ethers.getContractFactory("PlatformRegistry");

  await expectRevert(
    PlatformRegistry.deploy(ethers.ZeroAddress, admin.address, admin.address, admin.address,
      deployment.contracts.EventContract721.address, deployment.contracts.EventContract1155.address),
    "Zero admin in constructor reverts"
  );
  await expectRevert(
    PlatformRegistry.deploy(admin.address, admin.address, admin.address, admin.address,
      ethers.ZeroAddress, deployment.contracts.EventContract1155.address),
    "Zero ERC721 template in constructor reverts"
  );
  await expectRevert(
    PlatformRegistry.deploy(admin.address, admin.address, admin.address, admin.address,
      deployment.contracts.EventContract721.address, ethers.ZeroAddress),
    "Zero ERC1155 template in constructor reverts"
  );
  await expectRevert(
    PlatformRegistry.deploy(admin.address, admin.address, admin.address, ethers.ZeroAddress,
      deployment.contracts.EventContract721.address, deployment.contracts.EventContract1155.address),
    "Zero mintSigner in constructor reverts"
  );

  const total = await registry.totalEvents();
  assert(total >= 3n, `Total events: ${total} (≥3)`);

  const page = await registry.getEvents(0, 2);
  assert(page.length === 2, "getEvents pagination: 2 results");

  assert(await registry.mintSigner() !== ethers.ZeroAddress, "MintSigner set");
  assert(await registry.platformSigner() !== ethers.ZeroAddress, "PlatformSigner set");

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
