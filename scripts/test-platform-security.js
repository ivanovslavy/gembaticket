// scripts/test-platform-security.js
// ============================================
// GembaTicket v2 — Platform Admin & Security Tests
// ============================================
// npx hardhat run scripts/test-platform-security.js --network localhost
//
// Tests: access control, admin functions, pause, template upgrade,
//        ClaimContract autonomy, reentrancy guards, edge cases

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
  console.log("GembaTicket v2 — Platform & Security Tests");
  console.log("============================================\n");

  const [admin, multisig, signer, organizer, attacker] = await ethers.getSigners();

  // Deploy with separate roles
  console.log("--- Deploying with separate roles ---");
  console.log(`  admin:    ${admin.address}`);
  console.log(`  multisig: ${multisig.address}`);
  console.log(`  signer:   ${signer.address}`);
  console.log(`  attacker: ${attacker.address}\n`);

  const t721 = await (await ethers.getContractFactory("EventContract721")).deploy();
  const t1155 = await (await ethers.getContractFactory("EventContract1155")).deploy();
  const claimC = await (await ethers.getContractFactory("ClaimContract")).deploy();
  const reg = await (await ethers.getContractFactory("PlatformRegistry")).deploy(
    admin.address, multisig.address, signer.address,
    await claimC.getAddress(), await t721.getAddress(), await t1155.getAddress()
  );
  await claimC.setFactory(await reg.getAddress());

  const ph = ethers.keccak256(ethers.toUtf8Bytes("pay"));

  // =========================================================================
  // TEST 1: Access Control — PlatformRegistry
  // =========================================================================

  console.log("--- TEST 1: PlatformRegistry Access Control ---");

  // Only signer can createEvent
  await expectRevert(
    reg.connect(attacker).createEvent(0, "Hack", "ipfs://", 10, attacker.address, ph),
    "Attacker cannot createEvent"
  );
  await expectRevert(
    reg.connect(admin).createEvent(0, "Hack", "ipfs://", 10, admin.address, ph),
    "Admin cannot createEvent (only signer)"
  );

  // Only admin can set settings
  await expectRevert(
    reg.connect(attacker).setPlatformSigner(attacker.address),
    "Attacker cannot setPlatformSigner"
  );
  await expectRevert(
    reg.connect(attacker).setTemplate(0, attacker.address),
    "Attacker cannot setTemplate"
  );
  await expectRevert(
    reg.connect(attacker).togglePause(),
    "Attacker cannot togglePause"
  );
  await expectRevert(
    reg.connect(attacker).setAdmin(attacker.address),
    "Attacker cannot setAdmin"
  );

  // Only multisig can withdraw/fund
  await expectRevert(
    reg.connect(attacker).withdraw(attacker.address, 1),
    "Attacker cannot withdraw"
  );
  await expectRevert(
    reg.connect(attacker).fundSigner(1),
    "Attacker cannot fundSigner"
  );
  await expectRevert(
    reg.connect(attacker).setMultisig(attacker.address),
    "Attacker cannot setMultisig"
  );

  // Correct roles work
  const tx1 = await reg.connect(signer).createEvent(
    0, "Legit Event", "ipfs://legit/", 100, organizer.address, ph
  );
  const r1 = await tx1.wait();
  assert(r1.status === 1, "Signer creates event successfully");

  // =========================================================================
  // TEST 2: Pause System
  // =========================================================================

  console.log("\n--- TEST 2: Pause System ---");

  await reg.connect(admin).togglePause();
  assert(await reg.isPaused() === true, "Platform paused");

  await expectRevert(
    reg.connect(signer).createEvent(0, "Blocked", "ipfs://", 10, organizer.address, ph),
    "Cannot createEvent when paused"
  );

  await reg.connect(admin).togglePause();
  assert(await reg.isPaused() === false, "Platform unpaused");

  // Can create after unpause
  const tx2 = await reg.connect(signer).createEvent(
    0, "After Unpause", "ipfs://", 10, organizer.address, ph
  );
  assert((await tx2.wait()).status === 1, "Create event works after unpause");

  // =========================================================================
  // TEST 3: Template Upgrade
  // =========================================================================

  console.log("\n--- TEST 3: Template Upgrade ---");

  const oldTemplate = await reg.erc721Template();

  // Deploy new template
  const newT721 = await (await ethers.getContractFactory("EventContract721")).deploy();
  const newAddr = await newT721.getAddress();

  await reg.connect(admin).setTemplate(0, newAddr);
  assert(await reg.erc721Template() === newAddr, "ERC721 template updated");

  // Old events still use old template (immutable clones)
  // New event uses new template
  const tx3 = await reg.connect(signer).createEvent(
    0, "New Template Event", "ipfs://new/", 50, organizer.address, ph
  );
  const r3 = await tx3.wait();
  assert(r3.status === 1, "Event created with new template");

  // Cannot set zero address template
  await expectRevert(
    reg.connect(admin).setTemplate(0, ethers.ZeroAddress),
    "Cannot set zero address template"
  );

  // Invalid event type
  await expectRevert(
    reg.connect(admin).setTemplate(5, newAddr),
    "Invalid event type reverts"
  );

  // =========================================================================
  // TEST 4: Treasury Operations
  // =========================================================================

  console.log("\n--- TEST 4: Treasury ---");

  // Send ETH to registry
  await admin.sendTransaction({
    to: await reg.getAddress(),
    value: ethers.parseEther("1.0"),
  });

  const balance = await reg.contractBalance();
  assert(balance === ethers.parseEther("1.0"), "Registry received 1 ETH");

  // Multisig withdraws
  const beforeBal = await ethers.provider.getBalance(organizer.address);
  await reg.connect(multisig).withdraw(organizer.address, ethers.parseEther("0.5"));
  const afterBal = await ethers.provider.getBalance(organizer.address);
  assert(afterBal - beforeBal === ethers.parseEther("0.5"), "Withdraw 0.5 ETH to organizer");

  // Fund signer
  const signerBefore = await ethers.provider.getBalance(signer.address);
  await reg.connect(multisig).fundSigner(ethers.parseEther("0.3"));
  const signerAfter = await ethers.provider.getBalance(signer.address);
  assert(signerAfter - signerBefore === ethers.parseEther("0.3"), "Funded signer 0.3 ETH");

  // Cannot withdraw to zero address
  await expectRevert(
    reg.connect(multisig).withdraw(ethers.ZeroAddress, 1),
    "Cannot withdraw to zero address"
  );

  // =========================================================================
  // TEST 5: ClaimContract Autonomy
  // =========================================================================

  console.log("\n--- TEST 5: ClaimContract Autonomy ---");

  // setFactory is one-time
  await expectRevert(
    claimC.setFactory(attacker.address),
    "setFactory already set — locked forever"
  );

  // Only registered events can lock claims
  await expectRevert(
    claimC.connect(attacker).lockForClaim(
      ethers.keccak256(ethers.toUtf8Bytes("fake")), 1, attacker.address
    ),
    "Unregistered contract cannot lockForClaim"
  );

  await expectRevert(
    claimC.connect(attacker).registerEvent(attacker.address),
    "Only factory can registerEvent"
  );

  // =========================================================================
  // TEST 6: Zero Address Validation
  // =========================================================================

  console.log("\n--- TEST 6: Zero Address Checks ---");

  await expectRevert(
    reg.connect(admin).setPlatformSigner(ethers.ZeroAddress),
    "Cannot set zero platform signer"
  );
  await expectRevert(
    reg.connect(admin).setClaimContract(ethers.ZeroAddress),
    "Cannot set zero claim contract"
  );
  await expectRevert(
    reg.connect(multisig).setMultisig(ethers.ZeroAddress),
    "Cannot set zero multisig"
  );
  await expectRevert(
    reg.connect(admin).setAdmin(ethers.ZeroAddress),
    "Cannot set zero admin"
  );

  // createEvent with zero organizer
  await expectRevert(
    reg.connect(signer).createEvent(0, "Zero", "ipfs://", 10, ethers.ZeroAddress, ph),
    "Cannot create event with zero organizer"
  );

  // =========================================================================
  // TEST 7: Event Contract Access Control
  // =========================================================================

  console.log("\n--- TEST 7: Event Contract Access ---");

  // Get an event address
  const events = await reg.getEvents(0, 1);
  const eventAddr = events[0];
  const event721 = await ethers.getContractAt("EventContract721", eventAddr);

  // Attacker cannot call onlyOwner functions
  await expectRevert(
    event721.connect(attacker).toggleSale(),
    "Attacker cannot toggleSale"
  );
  await expectRevert(
    event721.connect(attacker).cancelEvent(),
    "Attacker cannot cancelEvent"
  );
  await expectRevert(
    event721.connect(attacker).endEvent(),
    "Attacker cannot endEvent"
  );
  await expectRevert(
    event721.connect(attacker).setBaseURI("ipfs://hack/"),
    "Attacker cannot setBaseURI"
  );

  // Attacker cannot call onlyPlatform functions
  const fakeHash = ethers.keccak256(ethers.toUtf8Bytes("fake"));
  await expectRevert(
    event721.connect(attacker).mintWithPaymentProof(attacker.address, fakeHash, fakeHash),
    "Attacker cannot mintWithPaymentProof"
  );
  await expectRevert(
    event721.connect(attacker).activateTicket(1),
    "Attacker cannot activateTicket"
  );
  await expectRevert(
    event721.connect(attacker).setPlatform(attacker.address),
    "Attacker cannot setPlatform"
  );

  // =========================================================================
  // TEST 8: Admin Role Transfer
  // =========================================================================

  console.log("\n--- TEST 8: Role Transfer ---");

  const [, , , , , newAdmin] = await ethers.getSigners();

  await reg.connect(admin).setAdmin(newAdmin.address);
  assert(await reg.admin() === newAdmin.address, "Admin transferred");

  // Old admin can no longer act
  await expectRevert(
    reg.connect(admin).togglePause(),
    "Old admin cannot act"
  );

  // New admin works
  await reg.connect(newAdmin).togglePause();
  assert(await reg.isPaused() === true, "New admin can pause");
  await reg.connect(newAdmin).togglePause(); // unpause

  // =========================================================================
  // TEST 9: Registry View Functions
  // =========================================================================

  console.log("\n--- TEST 9: View Functions ---");

  const total = await reg.totalEvents();
  assert(total >= 3n, `Total events: ${total} (≥3)`);

  const page = await reg.getEvents(0, 2);
  assert(page.length === 2, "getEvents pagination: 2 results");

  const page2 = await reg.getEvents(2, 10);
  assert(page2.length === Number(total) - 2, "getEvents offset works");

  // =========================================================================
  // TEST 10: Constructor Validation
  // =========================================================================

  console.log("\n--- TEST 10: Constructor Validation ---");

  const PlatformRegistry = await ethers.getContractFactory("PlatformRegistry");

  await expectRevert(
    PlatformRegistry.deploy(
      ethers.ZeroAddress, multisig.address, signer.address,
      await claimC.getAddress(), await t721.getAddress(), await t1155.getAddress()
    ),
    "Zero admin in constructor reverts"
  );

  await expectRevert(
    PlatformRegistry.deploy(
      admin.address, multisig.address, signer.address,
      await claimC.getAddress(), ethers.ZeroAddress, await t1155.getAddress()
    ),
    "Zero ERC721 template in constructor reverts"
  );

  await expectRevert(
    PlatformRegistry.deploy(
      admin.address, multisig.address, signer.address,
      await claimC.getAddress(), await t721.getAddress(), ethers.ZeroAddress
    ),
    "Zero ERC1155 template in constructor reverts"
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
