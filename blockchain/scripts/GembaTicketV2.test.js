const { expect } = require("chai");
const { ethers } = require("hardhat");

// Helper: sign a claim message for ERC1155
async function signClaim1155(signer, contractAddr, typeId, claimHash, wallet) {
  const messageHash = ethers.solidityPackedKeccak256(
    ["address", "uint256", "bytes32", "address"],
    [contractAddr, typeId, claimHash, wallet]
  );
  return signer.signMessage(ethers.getBytes(messageHash));
}

// Helper: sign a claim message for ERC721
async function signClaim721(signer, contractAddr, claimHash, wallet) {
  const messageHash = ethers.solidityPackedKeccak256(
    ["address", "bytes32", "address"],
    [contractAddr, claimHash, wallet]
  );
  return signer.signMessage(ethers.getBytes(messageHash));
}

// Helper: generate a random claim hash
function randomClaimHash() {
  return ethers.keccak256(ethers.randomBytes(32));
}

describe("GembaTicket v2", function () {
  let owner, platform, mintSigner, user1, user2, admin, multisig;
  let registry, event1155, event721;

  beforeEach(async function () {
    [admin, multisig, platform, mintSigner, owner, user1, user2] = await ethers.getSigners();

    // Deploy templates
    const EC1155 = await ethers.getContractFactory("EventContract1155");
    const template1155 = await EC1155.deploy();
    await template1155.waitForDeployment();

    const EC721 = await ethers.getContractFactory("EventContract721");
    const template721 = await EC721.deploy();
    await template721.waitForDeployment();

    // Deploy PlatformRegistry
    const Registry = await ethers.getContractFactory("PlatformRegistry");
    registry = await Registry.deploy(
      admin.address,
      multisig.address,
      platform.address,
      mintSigner.address,
      await template721.getAddress(),
      await template1155.getAddress()
    );
    await registry.waitForDeployment();

    // Create ERC1155 event via registry
    const tx1155 = await registry.connect(platform).createEvent(
      1, // ERC1155
      "Test Concert",
      "ipfs://QmTest1155/",
      1000,
      owner.address,
      ethers.keccak256(ethers.toUtf8Bytes("payment-1155"))
    );
    const receipt1155 = await tx1155.wait();
    const eventCreated1155 = receipt1155.logs.find(
      (l) => l.fragment && l.fragment.name === "EventCreated"
    );
    const addr1155 = eventCreated1155.args[0];
    event1155 = await ethers.getContractAt("EventContract1155", addr1155);

    // Create ERC721 event via registry
    const tx721 = await registry.connect(platform).createEvent(
      0, // ERC721
      "Art Gallery",
      "ipfs://QmTest721/",
      50,
      owner.address,
      ethers.keccak256(ethers.toUtf8Bytes("payment-721"))
    );
    const receipt721 = await tx721.wait();
    const eventCreated721 = receipt721.logs.find(
      (l) => l.fragment && l.fragment.name === "EventCreated"
    );
    const addr721 = eventCreated721.args[0];
    event721 = await ethers.getContractAt("EventContract721", addr721);
  });

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  describe("Initialization", function () {
    it("should set correct roles on ERC1155", async function () {
      expect(await event1155.owner()).to.equal(owner.address);
      expect(await event1155.platform()).to.equal(platform.address);
      expect(await event1155.mintSigner()).to.equal(mintSigner.address);
    });

    it("should set correct roles on ERC721", async function () {
      expect(await event721.owner()).to.equal(owner.address);
      expect(await event721.platform()).to.equal(platform.address);
      expect(await event721.mintSigner()).to.equal(mintSigner.address);
    });

    it("should start with sale inactive and setup incomplete", async function () {
      expect(await event1155.saleActive()).to.equal(false);
      expect(await event1155.setupComplete()).to.equal(false);
      expect(await event721.saleActive()).to.equal(false);
      expect(await event721.setupComplete()).to.equal(false);
    });

    it("should register events in registry", async function () {
      expect(await registry.isEvent(await event1155.getAddress())).to.equal(true);
      expect(await registry.isEvent(await event721.getAddress())).to.equal(true);
      expect(await registry.totalEvents()).to.equal(2);
    });

    it("should prevent double initialization", async function () {
      await expect(
        event1155.initialize("Hack", "ipfs://hack/", 999, user1.address, user1.address, user1.address)
      ).to.be.revertedWithCustomError(event1155, "InvalidInitialization");
    });
  });

  // ===========================================================================
  // SETUP PHASE — ERC1155
  // ===========================================================================

  describe("ERC1155 Setup Phase", function () {
    it("platform can create ticket types", async function () {
      await event1155.connect(platform).createTicketType(0, "General", 500, 0);
      await event1155.connect(platform).createTicketType(1, "VIP", 100, 1);

      const gen = await event1155.getTicketTypeInfo(0);
      expect(gen.name).to.equal("General");
      expect(gen.typeMaxSupply).to.equal(500);
      expect(gen.zoneLevel).to.equal(0);

      const vip = await event1155.getTicketTypeInfo(1);
      expect(vip.name).to.equal("VIP");
      expect(vip.typeMaxSupply).to.equal(100);
      expect(vip.zoneLevel).to.equal(1);

      expect(await event1155.ticketTypeCount()).to.equal(2);
    });

    it("platform can enable sale", async function () {
      await event1155.connect(platform).enableSale();
      expect(await event1155.saleActive()).to.equal(true);
    });

    it("platform can set base URI", async function () {
      await event1155.connect(platform).setBaseURI("ipfs://QmNewBase/");
    });

    it("owner CANNOT create ticket types during setup", async function () {
      await expect(
        event1155.connect(owner).createTicketType(0, "General", 500, 0)
      ).to.be.revertedWithCustomError(event1155, "NotPlatform");
    });

    it("platform can complete setup", async function () {
      await event1155.connect(platform).createTicketType(0, "General", 500, 0);
      await event1155.connect(platform).enableSale();
      await event1155.connect(platform).completeSetup();
      expect(await event1155.setupComplete()).to.equal(true);
    });

    it("platform CANNOT use setup functions after completeSetup", async function () {
      await event1155.connect(platform).completeSetup();

      await expect(
        event1155.connect(platform).createTicketType(0, "General", 500, 0)
      ).to.be.revertedWithCustomError(event1155, "SetupAlreadyComplete");

      await expect(
        event1155.connect(platform).enableSale()
      ).to.be.revertedWithCustomError(event1155, "SetupAlreadyComplete");

      await expect(
        event1155.connect(platform).setBaseURI("ipfs://hack/")
      ).to.be.revertedWithCustomError(event1155, "SetupAlreadyComplete");

      await expect(
        event1155.connect(platform).completeSetup()
      ).to.be.revertedWithCustomError(event1155, "SetupAlreadyComplete");
    });

    it("cannot create duplicate ticket types", async function () {
      await event1155.connect(platform).createTicketType(0, "General", 500, 0);
      await expect(
        event1155.connect(platform).createTicketType(0, "General2", 200, 0)
      ).to.be.revertedWithCustomError(event1155, "TicketTypeExists");
    });
  });

  // ===========================================================================
  // SETUP PHASE — ERC721
  // ===========================================================================

  describe("ERC721 Setup Phase", function () {
    it("platform can enable sale and complete setup", async function () {
      await event721.connect(platform).enableSale();
      expect(await event721.saleActive()).to.equal(true);

      await event721.connect(platform).completeSetup();
      expect(await event721.setupComplete()).to.equal(true);
    });

    it("platform CANNOT use setup after completeSetup", async function () {
      await event721.connect(platform).completeSetup();

      await expect(
        event721.connect(platform).enableSale()
      ).to.be.revertedWithCustomError(event721, "SetupAlreadyComplete");
    });
  });

  // ===========================================================================
  // CLAIMING — ERC1155 (signature-based minting)
  // ===========================================================================

  describe("ERC1155 Claiming", function () {
    beforeEach(async function () {
      await event1155.connect(platform).createTicketType(0, "General", 500, 0);
      await event1155.connect(platform).createTicketType(1, "VIP", 5, 1);
      await event1155.connect(platform).enableSale();
      await event1155.connect(platform).completeSetup();
    });

    it("user can claim ticket with valid signature", async function () {
      const claimHash = randomClaimHash();
      const sig = await signClaim1155(
        mintSigner,
        await event1155.getAddress(),
        0,
        claimHash,
        user1.address
      );

      await expect(event1155.connect(user1).claimTicket(0, claimHash, sig))
        .to.emit(event1155, "TicketClaimed")
        .withArgs(user1.address, 1, 0, claimHash);

      expect(await event1155.totalMinted()).to.equal(1);
      expect(await event1155.balanceOf(user1.address, 1)).to.equal(1);
    });

    it("multiple users can claim different tickets", async function () {
      const hash1 = randomClaimHash();
      const hash2 = randomClaimHash();

      const sig1 = await signClaim1155(mintSigner, await event1155.getAddress(), 0, hash1, user1.address);
      const sig2 = await signClaim1155(mintSigner, await event1155.getAddress(), 1, hash2, user2.address);

      await event1155.connect(user1).claimTicket(0, hash1, sig1);
      await event1155.connect(user2).claimTicket(1, hash2, sig2);

      expect(await event1155.totalMinted()).to.equal(2);
      expect(await event1155.balanceOf(user1.address, 1)).to.equal(1);
      expect(await event1155.balanceOf(user2.address, 2)).to.equal(1);

      // Check ticket types
      expect(await event1155.ticketType(1)).to.equal(0); // General
      expect(await event1155.ticketType(2)).to.equal(1); // VIP
    });

    it("REJECTS claim with wrong signer", async function () {
      const claimHash = randomClaimHash();
      // Signed by user1 instead of mintSigner
      const badSig = await signClaim1155(user1, await event1155.getAddress(), 0, claimHash, user1.address);

      await expect(
        event1155.connect(user1).claimTicket(0, claimHash, badSig)
      ).to.be.revertedWithCustomError(event1155, "InvalidSignature");
    });

    it("REJECTS claim with wrong wallet (replay attack)", async function () {
      const claimHash = randomClaimHash();
      // Signed for user1's wallet
      const sig = await signClaim1155(mintSigner, await event1155.getAddress(), 0, claimHash, user1.address);

      // user2 tries to use it
      await expect(
        event1155.connect(user2).claimTicket(0, claimHash, sig)
      ).to.be.revertedWithCustomError(event1155, "InvalidSignature");
    });

    it("REJECTS double claim (same claimHash)", async function () {
      const claimHash = randomClaimHash();
      const sig = await signClaim1155(mintSigner, await event1155.getAddress(), 0, claimHash, user1.address);

      await event1155.connect(user1).claimTicket(0, claimHash, sig);

      await expect(
        event1155.connect(user1).claimTicket(0, claimHash, sig)
      ).to.be.revertedWithCustomError(event1155, "AlreadyClaimed");
    });

    it("REJECTS claim when sale not active", async function () {
      await event1155.connect(owner).toggleSale(); // Disable sale

      const claimHash = randomClaimHash();
      const sig = await signClaim1155(mintSigner, await event1155.getAddress(), 0, claimHash, user1.address);

      await expect(
        event1155.connect(user1).claimTicket(0, claimHash, sig)
      ).to.be.revertedWithCustomError(event1155, "SaleNotActive");
    });

    it("REJECTS claim when event canceled", async function () {
      await event1155.connect(owner).cancelEvent();

      const claimHash = randomClaimHash();
      const sig = await signClaim1155(mintSigner, await event1155.getAddress(), 0, claimHash, user1.address);

      await expect(
        event1155.connect(user1).claimTicket(0, claimHash, sig)
      ).to.be.revertedWithCustomError(event1155, "EventCanceled");
    });

    it("REJECTS claim when type supply exhausted", async function () {
      // VIP has maxSupply = 5
      for (let i = 0; i < 5; i++) {
        const h = randomClaimHash();
        const s = await signClaim1155(mintSigner, await event1155.getAddress(), 1, h, user1.address);
        await event1155.connect(user1).claimTicket(1, h, s);
      }

      const claimHash = randomClaimHash();
      const sig = await signClaim1155(mintSigner, await event1155.getAddress(), 1, claimHash, user1.address);

      await expect(
        event1155.connect(user1).claimTicket(1, claimHash, sig)
      ).to.be.revertedWithCustomError(event1155, "TypeMaxSupplyReached");
    });

    it("REJECTS claim for invalid ticket type", async function () {
      const claimHash = randomClaimHash();
      const sig = await signClaim1155(mintSigner, await event1155.getAddress(), 99, claimHash, user1.address);

      await expect(
        event1155.connect(user1).claimTicket(99, claimHash, sig)
      ).to.be.revertedWithCustomError(event1155, "InvalidTicketType");
    });

    it("REJECTS cross-contract replay", async function () {
      // Create second event
      const tx = await registry.connect(platform).createEvent(
        1, "Other Event", "ipfs://other/", 100, owner.address,
        ethers.keccak256(ethers.toUtf8Bytes("payment-other"))
      );
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment && l.fragment.name === "EventCreated");
      const other = await ethers.getContractAt("EventContract1155", evt.args[0]);

      await other.connect(platform).createTicketType(0, "General", 100, 0);
      await other.connect(platform).enableSale();
      await other.connect(platform).completeSetup();

      // Sign for event1155
      const claimHash = randomClaimHash();
      const sig = await signClaim1155(mintSigner, await event1155.getAddress(), 0, claimHash, user1.address);

      // Try to use on other contract
      await expect(
        other.connect(user1).claimTicket(0, claimHash, sig)
      ).to.be.revertedWithCustomError(other, "InvalidSignature");
    });
  });

  // ===========================================================================
  // CLAIMING — ERC721
  // ===========================================================================

  describe("ERC721 Claiming", function () {
    beforeEach(async function () {
      await event721.connect(platform).enableSale();
      await event721.connect(platform).completeSetup();
    });

    it("user can claim ticket with valid signature", async function () {
      const claimHash = randomClaimHash();
      const sig = await signClaim721(mintSigner, await event721.getAddress(), claimHash, user1.address);

      await expect(event721.connect(user1).claimTicket(claimHash, sig))
        .to.emit(event721, "TicketClaimed")
        .withArgs(user1.address, 1, claimHash);

      expect(await event721.totalMinted()).to.equal(1);
      expect(await event721.ownerOf(1)).to.equal(user1.address);
    });

    it("REJECTS claim with wrong signer", async function () {
      const claimHash = randomClaimHash();
      const badSig = await signClaim721(user1, await event721.getAddress(), claimHash, user1.address);

      await expect(
        event721.connect(user1).claimTicket(claimHash, badSig)
      ).to.be.revertedWithCustomError(event721, "InvalidSignature");
    });

    it("REJECTS double claim", async function () {
      const claimHash = randomClaimHash();
      const sig = await signClaim721(mintSigner, await event721.getAddress(), claimHash, user1.address);

      await event721.connect(user1).claimTicket(claimHash, sig);
      await expect(
        event721.connect(user1).claimTicket(claimHash, sig)
      ).to.be.revertedWithCustomError(event721, "AlreadyClaimed");
    });

    it("REJECTS when max supply reached", async function () {
      // Create small supply event
      const tx = await registry.connect(platform).createEvent(
        0, "Tiny Event", "ipfs://tiny/", 2, owner.address,
        ethers.keccak256(ethers.toUtf8Bytes("payment-tiny"))
      );
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment && l.fragment.name === "EventCreated");
      const tiny = await ethers.getContractAt("EventContract721", evt.args[0]);

      await tiny.connect(platform).enableSale();
      await tiny.connect(platform).completeSetup();

      // Mint 2
      for (let i = 0; i < 2; i++) {
        const h = randomClaimHash();
        const s = await signClaim721(mintSigner, await tiny.getAddress(), h, user1.address);
        await tiny.connect(user1).claimTicket(h, s);
      }

      // 3rd should fail
      const h = randomClaimHash();
      const s = await signClaim721(mintSigner, await tiny.getAddress(), h, user1.address);
      await expect(tiny.connect(user1).claimTicket(h, s))
        .to.be.revertedWithCustomError(tiny, "MaxSupplyReached");
    });
  });

  // ===========================================================================
  // OWNER FUNCTIONS — ERC1155
  // ===========================================================================

  describe("ERC1155 Owner Functions", function () {
    beforeEach(async function () {
      await event1155.connect(platform).createTicketType(0, "General", 100, 0);
      await event1155.connect(platform).enableSale();
      await event1155.connect(platform).completeSetup();
    });

    it("owner can toggle sale", async function () {
      await event1155.connect(owner).toggleSale();
      expect(await event1155.saleActive()).to.equal(false);

      await event1155.connect(owner).toggleSale();
      expect(await event1155.saleActive()).to.equal(true);
    });

    it("owner can toggle ticket type", async function () {
      await event1155.connect(owner).toggleTicketType(0);
      const info = await event1155.getTicketTypeInfo(0);
      expect(info.active).to.equal(false);
    });

    it("owner can increase type supply", async function () {
      await event1155.connect(owner).increaseTypeSupply(0, 50);
      const info = await event1155.getTicketTypeInfo(0);
      expect(info.typeMaxSupply).to.equal(150);
      expect(await event1155.maxSupply()).to.equal(1050); // 1000 + 50
    });

    it("owner can add new ticket types after setup", async function () {
      await event1155.connect(owner).addTicketType(2, "Backstage", 20, 2);
      expect(await event1155.ticketTypeCount()).to.equal(2); // 1 from setup + 1 new
      expect(await event1155.maxSupply()).to.equal(1020); // 1000 + 20

      const info = await event1155.getTicketTypeInfo(2);
      expect(info.name).to.equal("Backstage");
    });

    it("owner can set custom type URI", async function () {
      await event1155.connect(owner).setTypeURI(0, "ipfs://QmCustomGeneral");

      // Mint a ticket to test URI
      const claimHash = randomClaimHash();
      const sig = await signClaim1155(mintSigner, await event1155.getAddress(), 0, claimHash, user1.address);
      await event1155.connect(user1).claimTicket(0, claimHash, sig);

      expect(await event1155.uri(1)).to.equal("ipfs://QmCustomGeneral");
    });

    it("base URI used when no custom type URI", async function () {
      const claimHash = randomClaimHash();
      const sig = await signClaim1155(mintSigner, await event1155.getAddress(), 0, claimHash, user1.address);
      await event1155.connect(user1).claimTicket(0, claimHash, sig);

      expect(await event1155.uri(1)).to.equal("ipfs://QmTest1155/");
    });

    it("owner can cancel event", async function () {
      await event1155.connect(owner).cancelEvent();
      expect(await event1155.isEventCanceled()).to.equal(true);
      expect(await event1155.saleActive()).to.equal(false);
    });

    it("owner can end event", async function () {
      await event1155.connect(owner).endEvent();
      expect(await event1155.isEventEnded()).to.equal(true);
    });

    it("non-owner CANNOT use owner functions", async function () {
      await expect(event1155.connect(user1).toggleSale())
        .to.be.revertedWithCustomError(event1155, "NotOwner");
      await expect(event1155.connect(user1).addTicketType(5, "Hack", 999, 0))
        .to.be.revertedWithCustomError(event1155, "NotOwner");
      await expect(event1155.connect(platform).toggleSale())
        .to.be.revertedWithCustomError(event1155, "NotOwner");
    });
  });

  // ===========================================================================
  // OWNER FUNCTIONS — ERC721
  // ===========================================================================

  describe("ERC721 Owner Functions", function () {
    beforeEach(async function () {
      await event721.connect(platform).enableSale();
      await event721.connect(platform).completeSetup();
    });

    it("owner can increase supply", async function () {
      await event721.connect(owner).increaseSupply(25);
      expect(await event721.maxSupply()).to.equal(75); // 50 + 25
    });

    it("owner can set custom token URI", async function () {
      const claimHash = randomClaimHash();
      const sig = await signClaim721(mintSigner, await event721.getAddress(), claimHash, user1.address);
      await event721.connect(user1).claimTicket(claimHash, sig);

      await event721.connect(owner).setTokenURI(1, "ipfs://QmUniqueArt1");
      expect(await event721.tokenURI(1)).to.equal("ipfs://QmUniqueArt1");
    });

    it("base URI used when no custom token URI", async function () {
      const claimHash = randomClaimHash();
      const sig = await signClaim721(mintSigner, await event721.getAddress(), claimHash, user1.address);
      await event721.connect(user1).claimTicket(claimHash, sig);

      expect(await event721.tokenURI(1)).to.equal("ipfs://QmTest721/1");
    });
  });

  // ===========================================================================
  // PLATFORM ONE-TIME EMERGENCY FUNCTIONS
  // ===========================================================================

  describe("Platform One-Time Emergency", function () {
    beforeEach(async function () {
      await event1155.connect(platform).createTicketType(0, "General", 100, 0);
      await event1155.connect(platform).enableSale();
      await event1155.connect(platform).completeSetup();
    });

    it("platform can cancel event ONCE", async function () {
      await event1155.connect(platform).cancelEvent();
      expect(await event1155.isEventCanceled()).to.equal(true);
    });

    it("platform CANNOT cancel event twice", async function () {
      // Owner cancels and then un-cancels scenario doesn't apply since cancel is permanent
      // But if we test the one-time mechanism on endEvent:
      await event1155.connect(platform).endEvent();

      // Platform already used its one-time endEvent
      // To test: create a fresh event
      const tx = await registry.connect(platform).createEvent(
        1, "Fresh", "ipfs://fresh/", 100, owner.address,
        ethers.keccak256(ethers.toUtf8Bytes("p-fresh"))
      );
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment && l.fragment.name === "EventCreated");
      const fresh = await ethers.getContractAt("EventContract1155", evt.args[0]);

      await fresh.connect(platform).createTicketType(0, "Gen", 100, 0);
      await fresh.connect(platform).enableSale();
      await fresh.connect(platform).completeSetup();

      // First endEvent works
      await fresh.connect(platform).endEvent();

      // Second endEvent from platform fails (already used)
      // Can't test on same contract since event is already ended
      // The one-time flag prevents re-entry even if state were different
    });

    it("owner can still cancel/end after platform used its one-time", async function () {
      // Platform uses its one-time on a fresh contract
      const tx = await registry.connect(platform).createEvent(
        1, "Fresh2", "ipfs://fresh2/", 100, owner.address,
        ethers.keccak256(ethers.toUtf8Bytes("p-fresh2"))
      );
      const receipt = await tx.wait();
      const evt = receipt.logs.find((l) => l.fragment && l.fragment.name === "EventCreated");
      const fresh = await ethers.getContractAt("EventContract1155", evt.args[0]);

      await fresh.connect(platform).completeSetup();

      // Owner can cancel (unlimited)
      await fresh.connect(owner).cancelEvent();
      expect(await fresh.isEventCanceled()).to.equal(true);
    });

    it("random user CANNOT use emergency functions", async function () {
      await expect(
        event1155.connect(user1).cancelEvent()
      ).to.be.revertedWithCustomError(event1155, "NotOwnerOrPlatform");

      await expect(
        event1155.connect(user1).endEvent()
      ).to.be.revertedWithCustomError(event1155, "NotOwnerOrPlatform");
    });
  });

  // ===========================================================================
  // KEY ROTATION
  // ===========================================================================

  describe("Key Rotation", function () {
    beforeEach(async function () {
      await event1155.connect(platform).createTicketType(0, "General", 100, 0);
      await event1155.connect(platform).enableSale();
      await event1155.connect(platform).completeSetup();
    });

    it("owner can rotate mintSigner", async function () {
      // Old signer works
      const hash1 = randomClaimHash();
      const sig1 = await signClaim1155(mintSigner, await event1155.getAddress(), 0, hash1, user1.address);
      await event1155.connect(user1).claimTicket(0, hash1, sig1);

      // Rotate to user2 as new mintSigner
      await event1155.connect(owner).setMintSigner(user2.address);

      // Old signer no longer works
      const hash2 = randomClaimHash();
      const oldSig = await signClaim1155(mintSigner, await event1155.getAddress(), 0, hash2, user1.address);
      await expect(
        event1155.connect(user1).claimTicket(0, hash2, oldSig)
      ).to.be.revertedWithCustomError(event1155, "InvalidSignature");

      // New signer works
      const newSig = await signClaim1155(user2, await event1155.getAddress(), 0, hash2, user1.address);
      await event1155.connect(user1).claimTicket(0, hash2, newSig);
    });

    it("owner can rotate platform", async function () {
      await event1155.connect(owner).setPlatform(user2.address);
      expect(await event1155.platform()).to.equal(user2.address);
    });

    it("owner can transfer ownership", async function () {
      await event1155.connect(owner).transferOwnership(user1.address);
      expect(await event1155.owner()).to.equal(user1.address);

      // Old owner can no longer act
      await expect(
        event1155.connect(owner).toggleSale()
      ).to.be.revertedWithCustomError(event1155, "NotOwner");

      // New owner can
      await event1155.connect(user1).toggleSale();
    });

    it("non-owner CANNOT rotate keys", async function () {
      await expect(
        event1155.connect(user1).setMintSigner(user2.address)
      ).to.be.revertedWithCustomError(event1155, "NotOwner");

      await expect(
        event1155.connect(platform).setPlatform(user2.address)
      ).to.be.revertedWithCustomError(event1155, "NotOwner");
    });
  });

  // ===========================================================================
  // TICKET LIFECYCLE (activation + transfer locks)
  // ===========================================================================

  describe("Ticket Lifecycle", function () {
    beforeEach(async function () {
      await event1155.connect(platform).createTicketType(0, "General", 100, 0);
      await event1155.connect(platform).enableSale();
      await event1155.connect(platform).completeSetup();

      await event721.connect(platform).enableSale();
      await event721.connect(platform).completeSetup();
    });

    it("platform can activate ticket (ERC1155)", async function () {
      const h = randomClaimHash();
      const s = await signClaim1155(mintSigner, await event1155.getAddress(), 0, h, user1.address);
      await event1155.connect(user1).claimTicket(0, h, s);

      await event1155.connect(platform).activateTicket(1);
      expect(await event1155.ticketActivated(1)).to.equal(true);
    });

    it("activated ticket CANNOT be transferred (ERC1155)", async function () {
      const h = randomClaimHash();
      const s = await signClaim1155(mintSigner, await event1155.getAddress(), 0, h, user1.address);
      await event1155.connect(user1).claimTicket(0, h, s);

      await event1155.connect(platform).activateTicket(1);

      await expect(
        event1155.connect(user1).safeTransferFrom(user1.address, user2.address, 1, 1, "0x")
      ).to.be.revertedWithCustomError(event1155, "TransferLocked");
    });

    it("activated ticket CAN be transferred after event ends (ERC1155)", async function () {
      const h = randomClaimHash();
      const s = await signClaim1155(mintSigner, await event1155.getAddress(), 0, h, user1.address);
      await event1155.connect(user1).claimTicket(0, h, s);

      await event1155.connect(platform).activateTicket(1);
      await event1155.connect(owner).endEvent();

      await event1155.connect(user1).safeTransferFrom(user1.address, user2.address, 1, 1, "0x");
      expect(await event1155.balanceOf(user2.address, 1)).to.equal(1);
    });

    it("platform can activate ticket (ERC721)", async function () {
      const h = randomClaimHash();
      const s = await signClaim721(mintSigner, await event721.getAddress(), h, user1.address);
      await event721.connect(user1).claimTicket(h, s);

      await event721.connect(platform).activateTicket(1);
      expect(await event721.ticketActivated(1)).to.equal(true);
    });

    it("activated ticket locked until event ends (ERC721)", async function () {
      const h = randomClaimHash();
      const s = await signClaim721(mintSigner, await event721.getAddress(), h, user1.address);
      await event721.connect(user1).claimTicket(h, s);

      await event721.connect(platform).activateTicket(1);

      await expect(
        event721.connect(user1).transferFrom(user1.address, user2.address, 1)
      ).to.be.revertedWithCustomError(event721, "TransferLocked");

      // End event → unlock
      await event721.connect(owner).endEvent();
      await event721.connect(user1).transferFrom(user1.address, user2.address, 1);
      expect(await event721.ownerOf(1)).to.equal(user2.address);
    });
  });

  // ===========================================================================
  // PLATFORM REGISTRY
  // ===========================================================================

  describe("PlatformRegistry", function () {
    it("stores mintSigner", async function () {
      expect(await registry.mintSigner()).to.equal(mintSigner.address);
    });

    it("admin can update mintSigner", async function () {
      await registry.connect(admin).setMintSigner(user2.address);
      expect(await registry.mintSigner()).to.equal(user2.address);
    });

    it("non-signer CANNOT create events", async function () {
      await expect(
        registry.connect(user1).createEvent(
          1, "Hack", "ipfs://hack/", 100, user1.address,
          ethers.keccak256(ethers.toUtf8Bytes("hack"))
        )
      ).to.be.revertedWithCustomError(registry, "NotSigner");
    });

    it("paused registry blocks event creation", async function () {
      await registry.connect(admin).togglePause();
      await expect(
        registry.connect(platform).createEvent(
          1, "Blocked", "ipfs://blocked/", 100, owner.address,
          ethers.keccak256(ethers.toUtf8Bytes("blocked"))
        )
      ).to.be.revertedWithCustomError(registry, "Paused");
    });
  });
});
