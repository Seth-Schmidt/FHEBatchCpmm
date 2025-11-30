import { expect } from "chai";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { FHEBatchCpmm, FHEConfidentialToken } from "../types";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
  dave: HardhatEthersSigner;
};

// Require at least 2 operations per batch
// Batch size should be higher in a production environment
const MIN_BATCH_SIZE = 2;

async function deployFixture() {
  const signers = await ethers.getSigners();
  
  const TokenFactory = await ethers.getContractFactory("FHEConfidentialToken");
  const token0 = (await TokenFactory.deploy("Token0", "T0")) as FHEConfidentialToken;
  const token1 = (await TokenFactory.deploy("Token1", "T1")) as FHEConfidentialToken;
  await token0.waitForDeployment();
  await token1.waitForDeployment();
  const token0Address = await token0.getAddress();
  const token1Address = await token1.getAddress();
  
  const CpmmFactory = await ethers.getContractFactory("FHEBatchCpmm");
  const cpmm = (await CpmmFactory.deploy(
    MIN_BATCH_SIZE,
    token0Address,
    token1Address
  )) as FHEBatchCpmm;
  await cpmm.waitForDeployment();
  const cpmmAddress = await cpmm.getAddress();
  
  return { 
    cpmm: cpmm, 
    cpmmAddress: cpmmAddress, 
    token0, 
    token1, 
    token0Address, 
    token1Address,
    signers: {
      deployer: signers[0],
      alice: signers[1],
      bob: signers[2],
      carol: signers[3],
      dave: signers[4],
    }
  };
}

describe("FHEBatchCpmm", function () {
  let signers: Signers;
  let cpmm: FHEBatchCpmm;
  let cpmmAddress: string;
  let token0: FHEConfidentialToken;
  let token1: FHEConfidentialToken;
  let token0Address: string;
  let token1Address: string;

  beforeEach(async function () {
    const fixture = await deployFixture();
    cpmm = fixture.cpmm;
    cpmmAddress = fixture.cpmmAddress;
    token0 = fixture.token0;
    token1 = fixture.token1;
    token0Address = fixture.token0Address;
    token1Address = fixture.token1Address;
    signers = fixture.signers;
  });

  // Helper to get and decrypt a user's confidential balance
  async function getDecryptedBalance(
    token: FHEConfidentialToken,
    tokenAddress: string,
    user: HardhatEthersSigner
  ): Promise<bigint> {
    const encryptedBalance = await token.confidentialBalanceOf(user.address);
    return fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance,
      tokenAddress,
      user
    );
  }

  // Helper to get and decrypt LP balance from the cpmm
  async function getDecryptedLPBalance(user: HardhatEthersSigner): Promise<bigint> {
    const encryptedBalance = await cpmm.confidentialBalanceOf(user.address);
    return fhevm.userDecryptEuint(
      FhevmType.euint64,
      encryptedBalance,
      cpmmAddress,
      user
    );
  }

  // Helper to mint tokens to a user and set operator
  async function setupUserWithTokens(
    user: HardhatEthersSigner,
    amount0: bigint,
    amount1: bigint
  ) {
    const encryptedMint0 = await fhevm
      .createEncryptedInput(token0Address, user.address)
      .add64(amount0)
      .encrypt();
    await token0.connect(user).mint(user.address, encryptedMint0.handles[0], encryptedMint0.inputProof);

    const encryptedMint1 = await fhevm
      .createEncryptedInput(token1Address, user.address)
      .add64(amount1)
      .encrypt();
    await token1.connect(user).mint(user.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

    const block = await ethers.provider.getBlock("latest");
    const blockTimestamp = block?.timestamp || 0;
    const expirationTimestamp = blockTimestamp + 10000;
    await token0.connect(user).setOperator(cpmmAddress, expirationTimestamp);
    await token1.connect(user).setOperator(cpmmAddress, expirationTimestamp);
  }

  // Helper to perform initial mint
  async function performInitialMint(
    user: HardhatEthersSigner,
    to: string,
    amount0: bigint,
    amount1: bigint
  ): Promise<{ reserve0Handle: string; reserve1Handle: string; totalSupplyHandle: string }> {
    const encryptedInput = await fhevm
      .createEncryptedInput(cpmmAddress, user.address)
      .add64(amount0)
      .add64(amount1)
      .encrypt();

    const tx = await cpmm.connect(user).initialMint(
      to,
      encryptedInput.handles[0],
      encryptedInput.handles[1],
      encryptedInput.inputProof
    );
    await tx.wait();


    const filter = cpmm.filters.BatchAwaitingDecryption();
    const events = await cpmm.queryFilter(filter);
    const lastEvent = events[events.length - 1];

    return {
      reserve0Handle: lastEvent.args.reserve0Handle,
      reserve1Handle: lastEvent.args.reserve1Handle,
      totalSupplyHandle: lastEvent.args.totalSupplyHandle,
    };
  }

  // Helper to finalize a batch by decrypting handles and calling finalizeBatch
  async function finalizeBatchWithDecryption(handles: {
    reserve0Handle: string;
    reserve1Handle: string;
    totalSupplyHandle: string;
  }) {
    // Use publicDecrypt to get cleartexts and proof
    const results = await fhevm.publicDecrypt([
      handles.reserve0Handle,
      handles.reserve1Handle,
      handles.totalSupplyHandle,
    ]);

    // Extract clear values
    const reserve0 = results.clearValues[handles.reserve0Handle as `0x${string}`];
    const reserve1 = results.clearValues[handles.reserve1Handle as `0x${string}`];
    const totalSupply = results.clearValues[handles.totalSupplyHandle as `0x${string}`];

    // Encode cleartexts as expected by finalizeBatch
    const cleartexts = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint64", "uint64", "uint64"],
      [reserve0, reserve1, totalSupply]
    );

    // Call finalizeBatch with the decryption proof
    await cpmm.finalizeBatch(cleartexts, results.decryptionProof);
  }

  // Helper to fully initialize the pool (setup tokens, initial mint, finalize)
  async function initializePool(
    user: HardhatEthersSigner,
    amount0: bigint,
    amount1: bigint
  ) {
    await setupUserWithTokens(user, amount0, amount1);
    const handles = await performInitialMint(user, user.address, amount0, amount1);
    await finalizeBatchWithDecryption(handles);
  }

  // Helper to enqueue a mint (requires pool to be initialized)
  // Returns the revocation key handle for later revocation
  async function enqueueMint(
    user: HardhatEthersSigner,
    to: string,
    amount0: bigint,
    amount1: bigint,
    claimedLiquidity: bigint
  ): Promise<string> {
    const encryptedInput = await fhevm
      .createEncryptedInput(cpmmAddress, user.address)
      .add64(amount0)
      .add64(amount1)
      .add64(claimedLiquidity)
      .encrypt();

    const tx = await cpmm.connect(user).enqueueMint(
      to,
      encryptedInput.handles[0],
      encryptedInput.handles[1],
      encryptedInput.handles[2],
      encryptedInput.inputProof
    );
    await tx.wait();

    const filter = cpmm.filters.OperationQueued();
    const events = await cpmm.queryFilter(filter);
    const lastEvent = events[events.length - 1];
    
    // Return the revocation key handle
    return lastEvent.args.revocationKeyHandle;
  }

  // Helper to enqueue a burn
  async function enqueueBurn(
    user: HardhatEthersSigner,
    to: string,
    liquidity: bigint,
    claimedAmount0: bigint,
    claimedAmount1: bigint
  ): Promise<string> {
    const encryptedInput = await fhevm
      .createEncryptedInput(cpmmAddress, user.address)
      .add64(liquidity)
      .add64(claimedAmount0)
      .add64(claimedAmount1)
      .encrypt();

    const tx = await cpmm.connect(user).enqueueBurn(
      to,
      encryptedInput.handles[0],
      encryptedInput.handles[1],
      encryptedInput.handles[2],
      encryptedInput.inputProof
    );
    await tx.wait();

    const filter = cpmm.filters.OperationQueued();
    const events = await cpmm.queryFilter(filter);
    const lastEvent = events[events.length - 1];

    return lastEvent.args.revocationKeyHandle;
  }

  // Helper to enqueue a swap
  async function enqueueSwap(
    user: HardhatEthersSigner,
    to: string,
    amountIn: bigint,
    claimedOut: bigint,
    tokenOut: number // 0 = token0, 1 = token1
  ): Promise<string> {
    const encryptedInput = await fhevm
      .createEncryptedInput(cpmmAddress, user.address)
      .add64(amountIn)
      .add64(claimedOut)
      .add8(tokenOut)
      .encrypt();

    const tx = await cpmm.connect(user).enqueueSwap(
      to,
      encryptedInput.handles[0],
      encryptedInput.handles[1],
      encryptedInput.handles[2],
      encryptedInput.inputProof
    );
    await tx.wait();

    const filter = cpmm.filters.OperationQueued();
    const events = await cpmm.queryFilter(filter);
    const lastEvent = events[events.length - 1];
    
    return lastEvent.args.revocationKeyHandle;
  }

  // Helper to mint tokens to user and enqueue a mint operation
  async function setupTokensAndEnqueueMint(
    user: HardhatEthersSigner,
    to: string,
    amount0: bigint,
    amount1: bigint,
    claimedLiquidity: bigint
  ): Promise<string> {
    await setupUserWithTokens(user, amount0, amount1);
    return enqueueMint(user, to, amount0, amount1, claimedLiquidity);
  }

  // Helper to mint tokens to user and enqueue a swap operation
  async function setupTokensAndEnqueueSwap(
    user: HardhatEthersSigner,
    to: string,
    amountIn: bigint,
    claimedOut: bigint,
    tokenOut: number // 0 = token0, 1 = token1
  ): Promise<string> {
    await setupUserWithTokens(user, amountIn, amountIn);
    return enqueueSwap(user, to, amountIn, claimedOut, tokenOut);
  }

  describe("Batch Threshold", function () {
    beforeEach(async function () {
      // Initialize pool first
      await initializePool(signers.deployer, 1000000n, 1000000n);
    });

    it("should revert processBatch if batch not full", async function () {
      // Only enqueue 1 operation, operation needs to be at least minBatchSize
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);

      await expect(cpmm.processBatch()).to.be.revertedWithCustomError(
        cpmm,
        "BatchNotFull"
      );
    });

    it("should allow processBatch once minBatchSize reached", async function () {
      // Enqueue 2 operations
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);

      // Should not revert
      await expect(cpmm.processBatch()).to.not.be.reverted;
    });

    it("should report isBatchReady correctly", async function () {
      expect(await cpmm.isBatchReady()).to.be.false;
      
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      expect(await cpmm.isBatchReady()).to.be.false;
      
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);
      expect(await cpmm.isBatchReady()).to.be.true;
    });

    it("should process all operations when batch exceeds minBatchSize", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 500000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 500000n);
      await setupTokensAndEnqueueMint(signers.carol, signers.carol.address, 500000n, 500000n, 500000n);

      expect(await cpmm.getCurrentBatchSize()).to.equal(3);

      await cpmm.processBatch();
      expect(await cpmm.hasMoreOperations()).to.be.true;

      await cpmm.processBatch();
      expect(await cpmm.hasMoreOperations()).to.be.true;

      await cpmm.processBatch();
      expect(await cpmm.hasMoreOperations()).to.be.false;
      expect(await cpmm.isAwaitingDecryption()).to.be.true;

      const aliceLP = await getDecryptedLPBalance(signers.alice);
      const bobLP = await getDecryptedLPBalance(signers.bob);
      const carolLP = await getDecryptedLPBalance(signers.carol);

      expect(aliceLP).to.equal(500000n);
      expect(bobLP).to.equal(500000n);
      expect(carolLP).to.equal(500000n);
    });

    it("should revert on double finalization", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 500000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 500000n);

      await cpmm.processBatch();
      await cpmm.processBatch();

      const filter = cpmm.filters.BatchAwaitingDecryption();
      const events = await cpmm.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      const handles = {
        reserve0Handle: lastEvent.args.reserve0Handle,
        reserve1Handle: lastEvent.args.reserve1Handle,
        totalSupplyHandle: lastEvent.args.totalSupplyHandle,
      };

      await finalizeBatchWithDecryption(handles);

      await expect(finalizeBatchWithDecryption(handles)).to.be.revertedWithCustomError(
        cpmm,
        "BatchNotAwaitingDecryption"
      );
    });
  });

  describe("Initial Mint (Standalone)", function () {
    it("should process initial mint with linear average approximation", async function () {
      const amount0 = 1000000n;
      const amount1 = 1000000n;

      // Setup tokens for Alice
      await setupUserWithTokens(signers.alice, amount0, amount1);

      // Get Alice's initial token balances
      const aliceToken0Before = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1Before = await getDecryptedBalance(token1, token1Address, signers.alice);

      // Perform initial mint
      const handles = await performInitialMint(signers.alice, signers.alice.address, amount0, amount1);

      // Get Alice's token balances after minting
      const aliceToken0After = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1After = await getDecryptedBalance(token1, token1Address, signers.alice);

      // Verify tokens were transferred from Alice to cpmm
      expect(aliceToken0Before - aliceToken0After).to.equal(amount0);
      expect(aliceToken1Before - aliceToken1After).to.equal(amount1);

      // (1M + 1M) / 2 - 1000 = 999000
      const expectedLiquidity = (amount0 + amount1) / 2n - 1000n;

      // Get Alice's LP balance
      const lpBalance = await getDecryptedLPBalance(signers.alice);
      expect(lpBalance).to.equal(expectedLiquidity);

      // Pool is initialized immediately, but public reserves not set until finalizeBatch
      expect(await cpmm.isInitialized()).to.be.true;

      // Finalize to set public reserves
      await finalizeBatchWithDecryption(handles);

      const publicReserve0 = await cpmm.publicReserve0();
      const publicReserve1 = await cpmm.publicReserve1();
      const publicTotalSupply = await cpmm.publicTotalSupply();

      console.log("Initial mint amounts: \n");
      console.log("amount0", amount0);
      console.log("amount1", amount1);

      console.log("Public reserves: \n");
      console.log("publicReserve0", publicReserve0);
      console.log("publicReserve1", publicReserve1);
      console.log("publicTotalSupply", publicTotalSupply);

      // verify public reserves
      expect(await cpmm.publicReserve0()).to.equal(amount0);
      expect(await cpmm.publicReserve1()).to.equal(amount1);
    });

    it("should handle unequal initial amounts", async function () {
      const amount0 = 2000000n;
      const amount1 = 500000n;

      await setupUserWithTokens(signers.alice, amount0, amount1);

      // Get Alice's initial token balances
      const aliceToken0Before = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1Before = await getDecryptedBalance(token1, token1Address, signers.alice);

      // Perform initial mint
      const handles = await performInitialMint(signers.alice, signers.alice.address, amount0, amount1);

      // Get Alice's token balances after minting
      const aliceToken0After = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1After = await getDecryptedBalance(token1, token1Address, signers.alice);

      // Verify tokens were transferred from Alice to cpmm
      expect(aliceToken0Before - aliceToken0After).to.equal(amount0);
      expect(aliceToken1Before - aliceToken1After).to.equal(amount1);

      // (2M + 500K) / 2 - 1000 = 1249000
      const expectedLiquidity = (amount0 + amount1) / 2n - 1000n;

      // Get Alice's LP balance
      const lpBalance = await getDecryptedLPBalance(signers.alice);
      expect(lpBalance).to.equal(expectedLiquidity);

      // Finalize and check public reserves
      await finalizeBatchWithDecryption(handles);
      expect(await cpmm.publicReserve0()).to.equal(amount0);
      expect(await cpmm.publicReserve1()).to.equal(amount1);
    });

    it("should revert if already initialized", async function () {
      await initializePool(signers.alice, 1000000n, 1000000n);

      // Try to call initialMint again
      await setupUserWithTokens(signers.bob, 500000n, 500000n);
      
      const encryptedInput = await fhevm
        .createEncryptedInput(cpmmAddress, signers.bob.address)
        .add64(500000n)
        .add64(500000n)
        .encrypt();

      await expect(
        cpmm.connect(signers.bob).initialMint(
          signers.bob.address,
          encryptedInput.handles[0],
          encryptedInput.handles[1],
          encryptedInput.inputProof
        )
      ).to.be.revertedWithCustomError(cpmm, "AlreadyInitialized");
    });

    it("should revert enqueueMint before initialization", async function () {
      await setupUserWithTokens(signers.alice, 500000n, 500000n);
      
      const encryptedInput = await fhevm
        .createEncryptedInput(cpmmAddress, signers.alice.address)
        .add64(500000n)
        .add64(500000n)
        .add64(250000n)
        .encrypt();

      await expect(
        cpmm.connect(signers.alice).enqueueMint(
          signers.alice.address,
          encryptedInput.handles[0],
          encryptedInput.handles[1],
          encryptedInput.handles[2],
          encryptedInput.inputProof
        )
      ).to.be.revertedWithCustomError(cpmm, "NotInitialized");
    });
  });

  describe("Proportional Mint", function () {
    beforeEach(async function () {
      // Initialize pool with 1M / 1M reserves
      await initializePool(signers.deployer, 1000000n, 1000000n);
    });

    it("should verify valid claimed liquidity via cross-multiplication", async function () {
      // Proportional: min(500K * 1M / 1M, 500K * 1M / 1M) = 500K
      // User claims slightly less to be safe
      const claimedLiquidity = 499000n;
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, claimedLiquidity);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, claimedLiquidity);

      // Process both operations
      await cpmm.processBatch();
      await cpmm.processBatch();

      // Both should get their claimed amount since it's valid
      const aliceLP = await getDecryptedLPBalance(signers.alice);
      expect(aliceLP).to.equal(claimedLiquidity);

      const bobLP = await getDecryptedLPBalance(signers.bob);
      expect(bobLP).to.equal(claimedLiquidity);
    });

    it("should return 0 liquidity for overclaimed amount", async function () {
      // User tries to claim more than they deserve
      const claimedLiquidity = 600000n;
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, claimedLiquidity);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n); // Valid claim

      // Process both
      await cpmm.processBatch(); // Alice (overclaim)
      await cpmm.processBatch(); // Bob (valid)

      // Alice should get 0 since they overclaimed
      const aliceLP = await getDecryptedLPBalance(signers.alice);
      expect(aliceLP).to.equal(0n);

      // Bob should get their claimed amount
      const bobLP = await getDecryptedLPBalance(signers.bob);
      expect(bobLP).to.equal(250000n);
    });
  });

  describe("Batch Lifecycle", function () {
    beforeEach(async function () {
      await initializePool(signers.deployer, 1000000n, 1000000n);
    });

    it("should prevent enqueueing when batch is processing", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);

      // Start processing
      await cpmm.processBatch();

      // Setup Carol's tokens
      await setupUserWithTokens(signers.carol, 100000n, 100000n);

      // Try to enqueue while processing
      await expect(
        enqueueMint(signers.carol, signers.carol.address, 100000n, 100000n, 50000n)
      ).to.be.revertedWithCustomError(cpmm, "BatchProcessing");
    });

    it("should allow revocation before processing starts", async function () {
      // Enqueue Alice (will be revoked) and Bob (valid)
      await setupUserWithTokens(signers.alice, 500000n, 500000n);
      await setupUserWithTokens(signers.bob, 250000n, 250000n);
      
      // Alic claims 5000 LP, well below the exact LP
      const aliceRevKeyHandle = await enqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 5000n);
      // Bob: 250K/250K tokens, claims 125K LP
      await enqueueMint(signers.bob, signers.bob.address, 250000n, 250000n, 125000n);

      // Decrypt Alice's revocation key
      const revocationKey = await fhevm.userDecryptEuint(
        FhevmType.euint16,
        aliceRevKeyHandle,
        cpmmAddress,
        signers.alice
      );

      // Create fresh encryption of the key for revocation
      const revokeInput = await fhevm
        .createEncryptedInput(cpmmAddress, signers.alice.address)
        .add16(Number(revocationKey))
        .encrypt();

      // Revocation should succeed
      await expect(
        cpmm.connect(signers.alice).revokeOperation(
          revokeInput.handles[0],
          revokeInput.inputProof
        )
      ).to.emit(cpmm, "RevocationAttempted");
      
      // Process both operations
      await cpmm.processBatch();
      await cpmm.processBatch();
      
      // Finalize batch
      const filter = cpmm.filters.BatchAwaitingDecryption();
      const events = await cpmm.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      
      const handles = {
        reserve0Handle: lastEvent.args.reserve0Handle,
        reserve1Handle: lastEvent.args.reserve1Handle,
        totalSupplyHandle: lastEvent.args.totalSupplyHandle,
      };
      
      await finalizeBatchWithDecryption(handles);

      // Initial pool: 1M/1M with totalSupply = 1M
      // Alice's revoked mint: 500K/500K with 5000
      // Bob's valid mint: 250K/250K with 125K LP
      // Expected new reserves: 1M + 250K = 1250000 each
      // Expected new totalSupply: 1M + 125K = 1125000
      const publicReserve0 = await cpmm.publicReserve0();
      const publicReserve1 = await cpmm.publicReserve1();
      const publicTotalSupply = await cpmm.publicTotalSupply();

      console.log("After revocation + Bob's mint:");
      console.log("  publicReserve0:", publicReserve0);
      console.log("  publicReserve1:", publicReserve1);
      console.log("  publicTotalSupply:", publicTotalSupply);

      // Verify Alice's revoked mint had no effect and only Bob's mint is reflected
      expect(publicReserve0).to.equal(1250000n);
      expect(publicReserve1).to.equal(1250000n);
      expect(publicTotalSupply).to.equal(1125000n);
    });

    it("should allow revocation during batch processing", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      const bobRevocationKey = await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);
    
      // process Alice's operation first
      await cpmm.processBatch();
      
      // Verify we're in processing state
      const meta = await cpmm.batches(await cpmm.currentBatchId());
      expect(meta.processing).to.be.true;
      
      // Bob revokes during processing before his operation is processed
      const keyValue = await fhevm.userDecryptEuint(
        FhevmType.euint16,
        bobRevocationKey,
        cpmmAddress,
        signers.bob
      );
      
      const encryptedKey = await fhevm
        .createEncryptedInput(cpmmAddress, signers.bob.address)
        .add16(keyValue)
        .encrypt();
      
      await expect(
        cpmm.connect(signers.bob).revokeOperation(encryptedKey.handles[0], encryptedKey.inputProof)
      ).to.not.be.reverted;
      
      // Process Bob's revoked operation
      await cpmm.processBatch();
      
      // Finalize batch
      const filter = cpmm.filters.BatchAwaitingDecryption();
      const events = await cpmm.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      await finalizeBatchWithDecryption({
        reserve0Handle: lastEvent.args.reserve0Handle,
        reserve1Handle: lastEvent.args.reserve1Handle,
        totalSupplyHandle: lastEvent.args.totalSupplyHandle,
      });
      
      // Alice should have LP, Bob should have 0
      const aliceLP = await getDecryptedLPBalance(signers.alice);
      const bobLP = await getDecryptedLPBalance(signers.bob);
      
      expect(aliceLP).to.be.greaterThan(0n);
      expect(bobLP).to.equal(0n);

      const bobToken0Balance = await getDecryptedBalance(token0, token0Address, signers.bob);
      const bobToken1Balance = await getDecryptedBalance(token1, token1Address, signers.bob);
      
      // Bob still has his original tokens since the revoked mint transferred 0
      expect(bobToken0Balance).to.equal(500000n);
      expect(bobToken1Balance).to.equal(500000n);
    });
    
    it("should not allow revocation of already processed operation", async function () {
      const aliceRevocationKey = await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);
    
      // Process Alice's operation
      await cpmm.processBatch();
      
      // Alice tries to revoke after her operation was already processed
      const keyValue = await fhevm.userDecryptEuint(
        FhevmType.euint16,
        aliceRevocationKey,
        cpmmAddress,
        signers.alice
      );
      
      const encryptedKey = await fhevm
        .createEncryptedInput(cpmmAddress, signers.alice.address)
        .add16(keyValue)
        .encrypt();
      
      // Revocation call succeeds but has no effect
      await cpmm.connect(signers.alice).revokeOperation(encryptedKey.handles[0], encryptedKey.inputProof);
      
      // Process Bob's operation and finalize
      await cpmm.processBatch();
      
      const filter = cpmm.filters.BatchAwaitingDecryption();
      const events = await cpmm.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      await finalizeBatchWithDecryption({
        reserve0Handle: lastEvent.args.reserve0Handle,
        reserve1Handle: lastEvent.args.reserve1Handle,
        totalSupplyHandle: lastEvent.args.totalSupplyHandle,
      });
      
      // Alice should still have LP
      const aliceLP = await getDecryptedLPBalance(signers.alice);
      expect(aliceLP).to.be.greaterThan(0n);
      
      // Alice's tokens should have been transferred
      const aliceToken0Balance = await getDecryptedBalance(token0, token0Address, signers.alice);
      expect(aliceToken0Balance).to.equal(0n);
    });

    it("should process revoked operations with zero amounts", async function () {
      await setupUserWithTokens(signers.alice, 500000n, 500000n);
      await setupUserWithTokens(signers.bob, 500000n, 500000n);

      const aliceRevKeyHandle = await enqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await enqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);

      // Get Alice's initial token balances
      const aliceToken0Before = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1Before = await getDecryptedBalance(token1, token1Address, signers.alice);

      // Decrypt Alice's revocation key and revoke
      const aliceRevKey = await fhevm.userDecryptEuint(
        FhevmType.euint16,
        aliceRevKeyHandle,
        cpmmAddress,
        signers.alice
      );

      const revokeInput = await fhevm
        .createEncryptedInput(cpmmAddress, signers.alice.address)
        .add16(Number(aliceRevKey))
        .encrypt();

      await cpmm.connect(signers.alice).revokeOperation(
        revokeInput.handles[0],
        revokeInput.inputProof
      );

      // Process both operations
      await cpmm.processBatch(); // Alice (revoked)
      await cpmm.processBatch(); // Bob (valid)

      // Alice should have same token balances
      const aliceToken0After = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1After = await getDecryptedBalance(token1, token1Address, signers.alice);
      expect(aliceToken0After).to.equal(aliceToken0Before);
      expect(aliceToken1After).to.equal(aliceToken1Before);

      // Alice should have 0 LP
      const aliceLP = await getDecryptedLPBalance(signers.alice);
      expect(aliceLP).to.equal(0n);

      // Bob should have his claimed LP
      const bobLP = await getDecryptedLPBalance(signers.bob);
      expect(bobLP).to.equal(250000n);
    });

    it("should have no effect when revoking with wrong key", async function () {
      await setupUserWithTokens(signers.alice, 500000n, 500000n);
      await setupUserWithTokens(signers.bob, 500000n, 500000n);

      await enqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 500000n);
      await enqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 500000n);

      const wrongKey = 12345n;
      const revokeInput = await fhevm
        .createEncryptedInput(cpmmAddress, signers.alice.address)
        .add16(Number(wrongKey))
        .encrypt();

      await cpmm.connect(signers.alice).revokeOperation(
        revokeInput.handles[0],
        revokeInput.inputProof
      );

      await cpmm.processBatch();
      await cpmm.processBatch();

      const aliceLP = await getDecryptedLPBalance(signers.alice);
      const bobLP = await getDecryptedLPBalance(signers.bob);

      expect(aliceLP).to.equal(500000n);
      expect(bobLP).to.equal(500000n);
    });

    it("should emit BatchAwaitingDecryption with final operation", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);

      await cpmm.processBatch();
      
      // Process second operation, it should also emit BatchAwaitingDecryption because it's the final operation
      await expect(cpmm.processBatch())
        .to.emit(cpmm, "BatchAwaitingDecryption");

      expect(await cpmm.isAwaitingDecryption()).to.be.true;
    });

    it("should prevent further processing once awaiting decryption", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);

      await cpmm.processBatch();
      await cpmm.processBatch();

      // Try to process again
      await expect(cpmm.processBatch()).to.be.revertedWithCustomError(
        cpmm,
        "AwaitingDecryption"
      );
    });

  });

  describe("View Functions", function () {
    beforeEach(async function () {
      await initializePool(signers.deployer, 1000000n, 1000000n);
    });

    it("should track getCurrentBatchSize", async function () {
      expect(await cpmm.getCurrentBatchSize()).to.equal(0);
      
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      expect(await cpmm.getCurrentBatchSize()).to.equal(1);
      
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);
      expect(await cpmm.getCurrentBatchSize()).to.equal(2);
    });

    it("should track hasMoreOperations correctly", async function () {
      // Before any operations, hasMoreOperations should be false
      expect(await cpmm.hasMoreOperations()).to.be.false;

      // Enqueue 2 operations
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);

      // Start processing first operation
      await cpmm.processBatch();
      
      // After first operation, there's still one more to process
      expect(await cpmm.hasMoreOperations()).to.be.true;

      // Process second operation
      await cpmm.processBatch();
      
      // After all operations processed, hasMoreOperations should be false
      expect(await cpmm.hasMoreOperations()).to.be.false;
    });

    it("should return false for hasMoreOperations when awaiting decryption", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);

      // Process all operations
      await cpmm.processBatch();
      await cpmm.processBatch();

      // Should be awaiting decryption now
      expect(await cpmm.isAwaitingDecryption()).to.be.true;
      
      // hasMoreOperations should be false when awaiting decryption
      expect(await cpmm.hasMoreOperations()).to.be.false;
    });
  });

  describe("Burn Operations", function () {
    beforeEach(async function () {
      await initializePool(signers.deployer, 1000000n, 1000000n);
    });

    it("should process valid burn with correct token transfers", async function () {
      // Exact LP for 500K deposit: min(500K * 1M / 1M, 500K * 1M / 1M) = 500K LP
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 500000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 500000n);

      // Process mints
      await cpmm.processBatch();
      await cpmm.processBatch();

      // Finalize batch
      const filter = cpmm.filters.BatchAwaitingDecryption();
      const events = await cpmm.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      await finalizeBatchWithDecryption({
        reserve0Handle: lastEvent.args.reserve0Handle,
        reserve1Handle: lastEvent.args.reserve1Handle,
        totalSupplyHandle: lastEvent.args.totalSupplyHandle,
      });

      // Verify public reserves
      // After mints: 1M + 500K + 500K = 2M each, totalSupply = 1M + 500K + 500K = 2M
      expect(await cpmm.publicReserve0()).to.equal(2000000n);
      expect(await cpmm.publicReserve1()).to.equal(2000000n);
      expect(await cpmm.publicTotalSupply()).to.equal(2000000n);

      const aliceLPBefore = await getDecryptedLPBalance(signers.alice);
      expect(aliceLPBefore).to.equal(500000n);

      // 500000 * 2000000 / 2000000 = 500000
      const expectedAmount0 = (500000n * 2000000n) / 2000000n;
      const expectedAmount1 = (500000n * 2000000n) / 2000000n;

      // Get Alice's initial token balances
      const aliceToken0Before = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1Before = await getDecryptedBalance(token1, token1Address, signers.alice);

      // Alice burns all her LP
      await enqueueBurn(signers.alice, signers.alice.address, 500000n, expectedAmount0, expectedAmount1);
      await enqueueBurn(signers.bob, signers.bob.address, 500000n, expectedAmount0, expectedAmount1);

      // Process burns
      await cpmm.processBatch();
      await cpmm.processBatch();

      // Verify Alice's LP was burned
      const aliceLPAfter = await getDecryptedLPBalance(signers.alice);
      expect(aliceLPAfter).to.equal(0n);

      // Verify Alice received tokens - should get back exactly what she deposited
      const aliceToken0After = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1After = await getDecryptedBalance(token1, token1Address, signers.alice);

      const token0Received = aliceToken0After - aliceToken0Before;
      const token1Received = aliceToken1After - aliceToken1Before;

      expect(token0Received).to.equal(expectedAmount0);
      expect(token1Received).to.equal(expectedAmount1);

      console.log("Burn test results:");
      console.log("Token0 received:", token0Received, "(deposited 500000)");
      console.log("Token1 received:", token1Received, "(deposited 500000)");
    });

    it("should reject burn with overclaimed amounts (get 0 tokens)", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);

      await cpmm.processBatch();
      await cpmm.processBatch();

      // Finalize batch
      const filter = cpmm.filters.BatchAwaitingDecryption();
      const events = await cpmm.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      await finalizeBatchWithDecryption({
        reserve0Handle: lastEvent.args.reserve0Handle,
        reserve1Handle: lastEvent.args.reserve1Handle,
        totalSupplyHandle: lastEvent.args.totalSupplyHandle,
      });

      // Alice tries to overclaim
      // Correct amount: 250000 * 2000000 / 1500000 = 333333
      const overclaimedAmount = 400000n;

      const aliceToken0Before = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1Before = await getDecryptedBalance(token1, token1Address, signers.alice);
      const aliceLPBefore = await getDecryptedLPBalance(signers.alice);

      await enqueueBurn(signers.alice, signers.alice.address, 250000n, overclaimedAmount, overclaimedAmount);
      await enqueueBurn(signers.bob, signers.bob.address, 250000n, 333333n, 333333n);

      await cpmm.processBatch();
      await cpmm.processBatch();

      // Alice should receive 0 tokens due to overclaim
      const aliceToken0After = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1After = await getDecryptedBalance(token1, token1Address, signers.alice);

      expect(aliceToken0After - aliceToken0Before).to.equal(0n);
      expect(aliceToken1After - aliceToken1Before).to.equal(0n);

      // Alice's LP should still be there
      const aliceLPAfter = await getDecryptedLPBalance(signers.alice);
      expect(aliceLPAfter).to.equal(250000n);
    });

    it("should handle partial burn", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 250000n);

      await cpmm.processBatch();
      await cpmm.processBatch();

      // Finalize batch
      const filter = cpmm.filters.BatchAwaitingDecryption();
      const events = await cpmm.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      await finalizeBatchWithDecryption({
        reserve0Handle: lastEvent.args.reserve0Handle,
        reserve1Handle: lastEvent.args.reserve1Handle,
        totalSupplyHandle: lastEvent.args.totalSupplyHandle,
      });

      // Alice burns half her LP
      const aliceLPBefore = await getDecryptedLPBalance(signers.alice);
      expect(aliceLPBefore).to.equal(250000n);

      const expectedAmount = (125000n * 2000000n) / 1500000n;

      const aliceToken0Before = await getDecryptedBalance(token0, token0Address, signers.alice);

      await enqueueBurn(signers.alice, signers.alice.address, 125000n, expectedAmount, expectedAmount);
      await enqueueBurn(signers.bob, signers.bob.address, 125000n, expectedAmount, expectedAmount);

      await cpmm.processBatch();
      await cpmm.processBatch();

      // Alice should still have half her LP
      const aliceLPAfter = await getDecryptedLPBalance(signers.alice);
      expect(aliceLPAfter).to.equal(125000n);

      // Alice should have received tokens
      const aliceToken0After = await getDecryptedBalance(token0, token0Address, signers.alice);
      expect(aliceToken0After - aliceToken0Before).to.equal(expectedAmount);
      
      console.log("Partial burn test - Alice LP before:", aliceLPBefore, "after:", aliceLPAfter);
      console.log("Token0 received:", aliceToken0After - aliceToken0Before);
    });
  });

  describe("Swap Operations", function () {
    beforeEach(async function () {
      await initializePool(signers.deployer, 1000000n, 1000000n);
    });

    it("should process valid swap with K invariant check", async function () {
      // Swap 100K token0 -> token1, claim 90K (valid with 0.3% fee)
      await setupTokensAndEnqueueSwap(signers.alice, signers.alice.address, 100000n, 90000n, 1);
      await setupTokensAndEnqueueSwap(signers.bob, signers.bob.address, 50000n, 45000n, 1);

      // Get Alice's token1 balance before processing
      const aliceToken1Before = await getDecryptedBalance(token1, token1Address, signers.alice);

      // Process both operations
      await cpmm.processBatch();
      await cpmm.processBatch();

      // Verify Alice's token1 balance increased
      const aliceToken1After = await getDecryptedBalance(token1, token1Address, signers.alice);
      const token1Received = aliceToken1After - aliceToken1Before;
      
      // Should get the claimed amount
      expect(token1Received).to.equal(90000n);
    });

    it("should enqueue swap with encrypted direction and verify opposite directions", async function () {
      // Alice: swap token0 -> token1
      // Bob: swap token1 -> token0
      await setupTokensAndEnqueueSwap(signers.alice, signers.alice.address, 100000n, 90000n, 1);
      await setupTokensAndEnqueueSwap(signers.bob, signers.bob.address, 100000n, 90000n, 0);

      // Get initial balances
      const aliceToken0Before = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1Before = await getDecryptedBalance(token1, token1Address, signers.alice);
      const bobToken0Before = await getDecryptedBalance(token0, token0Address, signers.bob);
      const bobToken1Before = await getDecryptedBalance(token1, token1Address, signers.bob);

      // Process both operations
      await cpmm.processBatch();
      await cpmm.processBatch();

      // Get balances after processing
      const aliceToken0After = await getDecryptedBalance(token0, token0Address, signers.alice);
      const aliceToken1After = await getDecryptedBalance(token1, token1Address, signers.alice);
      const bobToken0After = await getDecryptedBalance(token0, token0Address, signers.bob);
      const bobToken1After = await getDecryptedBalance(token1, token1Address, signers.bob);

      // Alice should have less token0, more token1
      expect(aliceToken0Before - aliceToken0After).to.equal(100000n);
      expect(aliceToken1After - aliceToken1Before).to.equal(90000n);

      // Bob should have less token1, more token0
      expect(bobToken1Before - bobToken1After).to.equal(100000n);
      expect(bobToken0After - bobToken0Before).to.equal(90000n);
    });

    it("should reject swap with invalid claimed output", async function () {
      // 99K is too high for 100K in with 0.3% fee
      await setupTokensAndEnqueueSwap(signers.alice, signers.alice.address, 100000n, 99000n, 1);
      await setupTokensAndEnqueueSwap(signers.bob, signers.bob.address, 50000n, 45000n, 1);

      // Get Alice's token1 balance before processing
      const aliceToken1Before = await getDecryptedBalance(token1, token1Address, signers.alice);

      await cpmm.processBatch();
      await cpmm.processBatch();

      // Verify Alice's balance didn't change
      const aliceToken1After = await getDecryptedBalance(token1, token1Address, signers.alice);
      const token1Received = aliceToken1After - aliceToken1Before;
      
      expect(token1Received).to.equal(0n);
    });
  });

  describe("Mixed Batch Operations", function () {
    beforeEach(async function () {
      await initializePool(signers.deployer, 1000000n, 1000000n);
    });

    it("should process mixed mint and swap in same batch", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 250000n);
      await setupTokensAndEnqueueSwap(signers.bob, signers.bob.address, 100000n, 90000n, 1);

      await cpmm.processBatch();
      await cpmm.processBatch();

      expect(await cpmm.isAwaitingDecryption()).to.be.true;
    });

    it("should process all three operation types in same batch", async function () {
      await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, 500000n, 500000n, 500000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 500000n, 500000n, 500000n);

      await cpmm.processBatch();
      await cpmm.processBatch();

      const filter = cpmm.filters.BatchAwaitingDecryption();
      const events = await cpmm.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      await finalizeBatchWithDecryption({
        reserve0Handle: lastEvent.args.reserve0Handle,
        reserve1Handle: lastEvent.args.reserve1Handle,
        totalSupplyHandle: lastEvent.args.totalSupplyHandle,
      });

      const aliceLPBefore = await getDecryptedLPBalance(signers.alice);
      const aliceToken0Before = await getDecryptedBalance(token0, token0Address, signers.alice);

      await enqueueBurn(signers.alice, signers.alice.address, 250000n, 250000n, 250000n);
      await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, 200000n, 200000n, 200000n);
      await setupTokensAndEnqueueSwap(signers.carol, signers.carol.address, 50000n, 45000n, 1);

      const carolToken0Before = await getDecryptedBalance(token0, token0Address, signers.carol);

      await cpmm.processBatch();
      await cpmm.processBatch();
      await cpmm.processBatch();

      const aliceLPAfter = await getDecryptedLPBalance(signers.alice);
      const aliceToken0After = await getDecryptedBalance(token0, token0Address, signers.alice);
      const carolToken0After = await getDecryptedBalance(token0, token0Address, signers.carol);

      expect(aliceLPBefore - aliceLPAfter).to.equal(250000n);
      expect(aliceToken0After - aliceToken0Before).to.equal(250000n);
      expect(carolToken0Before - carolToken0After).to.equal(50000n);
    });
  });

  describe("Overflow Protection", function () {
    it("should reject mint that would overflow reserves", async function () {
      // Start with reserves near the max uint64
      const initialAmount = 2n ** 63n - 100n;
      
      await setupUserWithTokens(signers.alice, initialAmount, initialAmount);
      const handles = await performInitialMint(signers.alice, signers.alice.address, initialAmount, initialAmount);
      await finalizeBatchWithDecryption(handles);

      //get public reserves and total supply
      const preserve0 = await cpmm.publicReserve0();
      const preserve1 = await cpmm.publicReserve1();
      const totalSupply = await cpmm.publicTotalSupply();

      console.log("Initial state: preserve0:", preserve0, "preserve1:", preserve1, "totalSupply:", totalSupply);

      // Bob tries to add more which would overflow reserves after carol's mint
      const overflowAmount = 2n ** 63n;
      await setupUserWithTokens(signers.bob, overflowAmount, overflowAmount);
      
      // Carol makes a small valid mint
      const carolAmount = 1000000n;
      await setupUserWithTokens(signers.carol, carolAmount, carolAmount);
      const carolLP = (carolAmount * totalSupply) / preserve0;
      
      // Calculate proportionally correct LP claim for Bob's amount
      const bobLPClaim = (overflowAmount * totalSupply) / preserve0;

      console.log("Bob's claim: bobLPClaim:", bobLPClaim, "overflowAmount:", overflowAmount);

      await enqueueMint(signers.carol, signers.carol.address, carolAmount, carolAmount, carolLP);
      await enqueueMint(signers.bob, signers.bob.address, overflowAmount, overflowAmount, bobLPClaim);

      await cpmm.processBatch();
      await cpmm.processBatch();

      // finalize batch
      const filter = cpmm.filters.BatchAwaitingDecryption();
      const events = await cpmm.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      await finalizeBatchWithDecryption({
        reserve0Handle: lastEvent.args.reserve0Handle,
        reserve1Handle: lastEvent.args.reserve1Handle,
        totalSupplyHandle: lastEvent.args.totalSupplyHandle,
      });

      const carolLPBalanceAfter = await getDecryptedLPBalance(signers.carol);
      const bobLPBalanceAfter = await getDecryptedLPBalance(signers.bob);
      console.log("Carol's LP balance after: carolLPBalanceAfter:", carolLPBalanceAfter, "carolLP:", carolLP);
      console.log("Bob's LP balance after: bobLPBalanceAfter:", bobLPBalanceAfter, "bobLP:", bobLPClaim);

      // Carol's mint should succeed
      expect(carolLPBalanceAfter).to.equal(carolLP);
      // Bob's mint should fail since it would overflow reserves
      expect(bobLPBalanceAfter).to.equal(0n);
    });
  });
  
  describe("Invariant Tests - Exact Calculations", function () {
    beforeEach(async function () {
      await initializePool(signers.deployer, 1000000n, 1000000n);
    });

    // Helper to calculate exact LP for proportional mint
    function calculateExactLP(amount0: bigint, amount1: bigint, reserve0: bigint, reserve1: bigint, totalSupply: bigint): bigint {
      const lp0 = (amount0 * totalSupply) / reserve0;
      const lp1 = (amount1 * totalSupply) / reserve1;
      return lp0 < lp1 ? lp0 : lp1;
    }

    // Helper to calculate exact amountOut for swap
    function calculateExactAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
      const amountInWithFee = amountIn * 997n;
      const numerator = amountInWithFee * reserveOut;
      const denominator = reserveIn * 1000n + amountInWithFee;
      return numerator / denominator;
    }

    // Helper to calculate exact token amounts for burn
    function calculateExactBurnAmounts(liquidity: bigint, reserve0: bigint, reserve1: bigint, totalSupply: bigint): { amount0: bigint; amount1: bigint } {
      return {
        amount0: (liquidity * reserve0) / totalSupply,
        amount1: (liquidity * reserve1) / totalSupply,
      };
    }

    // Helper to finalize current batch
    async function finalizeCurrent() {
      const filter = cpmm.filters.BatchAwaitingDecryption();
      const events = await cpmm.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      await finalizeBatchWithDecryption({
        reserve0Handle: lastEvent.args.reserve0Handle,
        reserve1Handle: lastEvent.args.reserve1Handle,
        totalSupplyHandle: lastEvent.args.totalSupplyHandle,
      });
    }

    describe("Exact Proportional Mint", function () {
      it("should succeed with exact calculated LP", async function () {
        // Get public reserves after initialization
        const reserve0 = await cpmm.publicReserve0();
        const reserve1 = await cpmm.publicReserve1();
        const totalSupply = await cpmm.publicTotalSupply();

        console.log("Initial state: reserve0:", reserve0, "reserve1:", reserve1, "totalSupply:", totalSupply);

        const amount0 = 500000n;
        const amount1 = 500000n;
        const exactLP = calculateExactLP(amount0, amount1, reserve0, reserve1, totalSupply);
        console.log("Exact LP for 500K/500K:", exactLP);

        // Mint with exact LP
        await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, amount0, amount1, exactLP);
        await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, amount0, amount1, exactLP);

        await cpmm.processBatch();
        await cpmm.processBatch();

        // Verify Alice got exact LP
        const aliceLP = await getDecryptedLPBalance(signers.alice);
        expect(aliceLP).to.equal(exactLP);
        console.log("Alice LP received:", aliceLP, " expected:", exactLP);
      });

      it("should fail with LP + 1", async function () {
        const amount0 = 500000n;
        const amount1 = 500000n;
        const exactLP1 = calculateExactLP(amount0, amount1, 1000000n, 1000000n, 1000000n);
        
        await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, amount0, amount1, exactLP1);
        await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, amount0, amount1, exactLP1);

        await cpmm.processBatch();
        await cpmm.processBatch();
        await finalizeCurrent();

        // Get public reserves after batch
        const newReserve0 = await cpmm.publicReserve0();
        const newReserve1 = await cpmm.publicReserve1();
        const newTotalSupply = await cpmm.publicTotalSupply();
        console.log("After batch 1: reserve0:", newReserve0, "reserve1:", newReserve1, "totalSupply:", newTotalSupply);

        // Calculate exact LP
        const exactLP2 = calculateExactLP(amount0, amount1, newReserve0, newReserve1, newTotalSupply);
        const overclaimLP = exactLP2 + 1n;
        console.log("Exact LP from new reserves:", exactLP2, "overclaim:", overclaimLP);

        // Try to mint with LP + 1
        await setupTokensAndEnqueueMint(signers.carol, signers.carol.address, amount0, amount1, overclaimLP);
        // Dave claims exact
        await setupTokensAndEnqueueMint(signers.dave, signers.dave.address, amount0, amount1, exactLP2);

        await cpmm.processBatch();
        await cpmm.processBatch();

        // Carol should get 0 LP
        const carolLP = await getDecryptedLPBalance(signers.carol);
        expect(carolLP).to.equal(0n);
        console.log("Carol LP overclaim:", carolLP);

        // Dave should get exact LP (valid claim)
        const daveLP = await getDecryptedLPBalance(signers.dave);
        expect(daveLP).to.equal(exactLP2);
        console.log("Dave LP exact:", daveLP);
      });
    });

    describe("Exact Swap (K Invariant)", function () {
      it("should succeed with exact calculated amountOut", async function () {
        const reserve0 = await cpmm.publicReserve0();
        const reserve1 = await cpmm.publicReserve1();

        // Calculate exact amountOut for 100K token0 -> token1
        const amountIn = 100000n;
        const exactOut = calculateExactAmountOut(amountIn, reserve0, reserve1);
        console.log("Exact amountOut for 100K in:", exactOut);

        // Swap with exact calculated output
        await setupTokensAndEnqueueSwap(signers.alice, signers.alice.address, amountIn, exactOut, 1);
        await setupTokensAndEnqueueSwap(signers.bob, signers.bob.address, amountIn, exactOut, 1);

        const aliceToken1Before = await getDecryptedBalance(token1, token1Address, signers.alice);

        await cpmm.processBatch();
        await cpmm.processBatch();

        const aliceToken1After = await getDecryptedBalance(token1, token1Address, signers.alice);
        const received = aliceToken1After - aliceToken1Before;

        expect(received).to.equal(exactOut);
        console.log("Alice received:", received, " expected:", exactOut);
      });

      it("should fail second swap using stale reserves", async function () {
        const reserve0 = await cpmm.publicReserve0();
        const reserve1 = await cpmm.publicReserve1();

        const amountIn = 100000n;
        const exactOut = calculateExactAmountOut(amountIn, reserve0, reserve1);
        console.log("Exact amountOut based on public reserves:", exactOut);

        // Both Alice and Bob use the same calculation
        await setupTokensAndEnqueueSwap(signers.alice, signers.alice.address, amountIn, exactOut, 1);
        await setupTokensAndEnqueueSwap(signers.bob, signers.bob.address, amountIn, exactOut, 1);

        const aliceToken1Before = await getDecryptedBalance(token1, token1Address, signers.alice);
        const bobToken1Before = await getDecryptedBalance(token1, token1Address, signers.bob);

        await cpmm.processBatch();
        // Bob should fail because reserves changed
        await cpmm.processBatch(); 

        const aliceToken1After = await getDecryptedBalance(token1, token1Address, signers.alice);
        const bobToken1After = await getDecryptedBalance(token1, token1Address, signers.bob);

        const aliceReceived = aliceToken1After - aliceToken1Before;
        const bobReceived = bobToken1After - bobToken1Before;

        // Alice should succeed
        expect(aliceReceived).to.equal(exactOut);
        console.log("Alice received:", aliceReceived, " expected:", exactOut);

        // Bob should fail because reserves changed after Alice's swap
        expect(bobReceived).to.equal(0n);
        console.log("Bob received:", bobReceived, " expected: 0");
      });
    });

    describe("Cross-Batch Reserve Updates", function () {
      it("should succeed with recalculated amounts after finalization", async function () {
        const reserve0 = await cpmm.publicReserve0();
        const reserve1 = await cpmm.publicReserve1();

        // Swap changes reserves
        const amountIn = 100000n;
        const exactOut1 = calculateExactAmountOut(amountIn, reserve0, reserve1);
        
        await setupTokensAndEnqueueSwap(signers.alice, signers.alice.address, amountIn, exactOut1, 1);
        await setupTokensAndEnqueueSwap(signers.bob, signers.bob.address, amountIn, exactOut1, 1);

        await cpmm.processBatch();
        await cpmm.processBatch();
        await finalizeCurrent();

        const newReserve0 = await cpmm.publicReserve0();
        const newReserve1 = await cpmm.publicReserve1();
        console.log("After batch reserve0:", newReserve0, "reserve1:", newReserve1);

        // Swap with recalculated amounts
        const exactOut2 = calculateExactAmountOut(amountIn, newReserve0, newReserve1);
        console.log("Exact amountOut from new reserves:", exactOut2);

        await setupTokensAndEnqueueSwap(signers.carol, signers.carol.address, amountIn, exactOut2, 1);
        await setupTokensAndEnqueueSwap(signers.dave, signers.dave.address, amountIn, exactOut2, 1);

        const carolToken1Before = await getDecryptedBalance(token1, token1Address, signers.carol);

        await cpmm.processBatch();
        await cpmm.processBatch();

        const carolToken1After = await getDecryptedBalance(token1, token1Address, signers.carol);
        const carolReceived = carolToken1After - carolToken1Before;

        // Carol should succeed with recalculated amount
        expect(carolReceived).to.equal(exactOut2);
        console.log("Carol received:", carolReceived, " expected:", exactOut2);
      });
    });

    describe("Exact Burn", function () {
      it("should succeed with exact calculated token amounts", async function () {
        // Mint some LP
        const mintAmount = 500000n;
        const exactLP = calculateExactLP(mintAmount, mintAmount, 1000000n, 1000000n, 1000000n);
        
        await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, mintAmount, mintAmount, exactLP);
        await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, mintAmount, mintAmount, exactLP);

        await cpmm.processBatch();
        await cpmm.processBatch();
        await finalizeCurrent();

        const reserve0 = await cpmm.publicReserve0();
        const reserve1 = await cpmm.publicReserve1();
        const totalSupply = await cpmm.publicTotalSupply();
        console.log("After mint reserve0:", reserve0, "reserve1:", reserve1, "totalSupply:", totalSupply);

        // Calculate exact burn amounts for Alice's LP
        const aliceLP = await getDecryptedLPBalance(signers.alice);
        const { amount0: exactAmount0, amount1: exactAmount1 } = calculateExactBurnAmounts(aliceLP, reserve0, reserve1, totalSupply);
        console.log("Exact burn amounts for", aliceLP, "LP:", exactAmount0, exactAmount1);

        const aliceToken0Before = await getDecryptedBalance(token0, token0Address, signers.alice);

        // Burn with exact amounts
        await enqueueBurn(signers.alice, signers.alice.address, aliceLP, exactAmount0, exactAmount1);
        await enqueueBurn(signers.bob, signers.bob.address, exactLP, exactAmount0, exactAmount1);

        await cpmm.processBatch();
        await cpmm.processBatch();

        const aliceToken0After = await getDecryptedBalance(token0, token0Address, signers.alice);
        const received = aliceToken0After - aliceToken0Before;

        expect(received).to.equal(exactAmount0);
        console.log("Alice received:", received, " expected:", exactAmount0);
      });

      it("should fail with amounts + 1", async function () {
        // Mint some LP
        const mintAmount = 500000n;
        const exactLP = calculateExactLP(mintAmount, mintAmount, 1000000n, 1000000n, 1000000n);
        
        await setupTokensAndEnqueueMint(signers.alice, signers.alice.address, mintAmount, mintAmount, exactLP);
        await setupTokensAndEnqueueMint(signers.bob, signers.bob.address, mintAmount, mintAmount, exactLP);

        await cpmm.processBatch();
        await cpmm.processBatch();
        await finalizeCurrent();

        // Alice burns with exact amounts
        let reserve0 = await cpmm.publicReserve0();
        let reserve1 = await cpmm.publicReserve1();
        let totalSupply = await cpmm.publicTotalSupply();
        
        const aliceLP = await getDecryptedLPBalance(signers.alice);
        const { amount0: exactAmount0, amount1: exactAmount1 } = calculateExactBurnAmounts(aliceLP, reserve0, reserve1, totalSupply);

        await enqueueBurn(signers.alice, signers.alice.address, aliceLP, exactAmount0, exactAmount1);
        await enqueueBurn(signers.bob, signers.bob.address, exactLP, exactAmount0, exactAmount1);

        await cpmm.processBatch();
        await cpmm.processBatch();
        await finalizeCurrent();

        // Get reserves
        reserve0 = await cpmm.publicReserve0();
        reserve1 = await cpmm.publicReserve1();
        totalSupply = await cpmm.publicTotalSupply();
        console.log("After burn batch - reserve0:", reserve0, "reserve1:", reserve1, "totalSupply:", totalSupply);

        // Mint more LP for Carol and Dave
        await setupTokensAndEnqueueMint(signers.carol, signers.carol.address, mintAmount, mintAmount, 250000n);
        await setupTokensAndEnqueueMint(signers.dave, signers.dave.address, mintAmount, mintAmount, 250000n);

        await cpmm.processBatch();
        await cpmm.processBatch();
        await finalizeCurrent();

        // Get reserves again
        reserve0 = await cpmm.publicReserve0();
        reserve1 = await cpmm.publicReserve1();
        totalSupply = await cpmm.publicTotalSupply();

        // Carol tries to burn with amounts + 1
        const carolLP = await getDecryptedLPBalance(signers.carol);
        const { amount0: carolExact0, amount1: carolExact1 } = calculateExactBurnAmounts(carolLP, reserve0, reserve1, totalSupply);
        const overclaimAmount0 = carolExact0 + 1n;
        const overclaimAmount1 = carolExact1 + 1n;
        console.log("Carol exact amounts:", carolExact0, carolExact1, "overclaim:", overclaimAmount0, overclaimAmount1);

        const carolToken0Before = await getDecryptedBalance(token0, token0Address, signers.carol);

        await enqueueBurn(signers.carol, signers.carol.address, carolLP, overclaimAmount0, overclaimAmount1);
        // Dave burns with exact
        const daveLP = await getDecryptedLPBalance(signers.dave);
        await enqueueBurn(signers.dave, signers.dave.address, daveLP, carolExact0, carolExact1);

        await cpmm.processBatch();
        await cpmm.processBatch();

        const carolToken0After = await getDecryptedBalance(token0, token0Address, signers.carol);
        const carolReceived = carolToken0After - carolToken0Before;

        // Carol should get 0
        expect(carolReceived).to.equal(0n);
        console.log("Carol received:", carolReceived, " expected: 0");
      });
    });
  });
});
