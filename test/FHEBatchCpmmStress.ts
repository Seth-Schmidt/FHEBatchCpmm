import { expect } from "chai";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { FHEBatchCpmm, FHEConfidentialToken } from "../types";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

const MIN_BATCH_SIZE = 8;

async function deployFixture() {
  const signers = await ethers.getSigners();
  
  const TokenFactory = await ethers.getContractFactory("FHEConfidentialToken");
  const token0 = (await TokenFactory.deploy("Token0", "T0")) as FHEConfidentialToken;
  const token1 = (await TokenFactory.deploy("Token1", "T1")) as FHEConfidentialToken;
  await token0.waitForDeployment();
  await token1.waitForDeployment();
  const token0Address = await token0.getAddress();
  const token1Address = await token1.getAddress();
  
  const AggregatorFactory = await ethers.getContractFactory("FHEBatchCpmm");
  const aggregator = (await AggregatorFactory.deploy(
    MIN_BATCH_SIZE,
    token0Address,
    token1Address
  )) as FHEBatchCpmm;
  await aggregator.waitForDeployment();
  const aggregatorAddress = await aggregator.getAddress();
  
  return { 
    aggregator, 
    aggregatorAddress, 
    token0, 
    token1, 
    token0Address, 
    token1Address,
    signers
  };
}

describe("FHEBatchCpmm Stress Tests", function () {
  let signers: HardhatEthersSigner[];
  let aggregator: FHEBatchCpmm;
  let aggregatorAddress: string;
  let token0: FHEConfidentialToken;
  let token1: FHEConfidentialToken;
  let token0Address: string;
  let token1Address: string;

  beforeEach(async function () {
    const fixture = await deployFixture();
    aggregator = fixture.aggregator;
    aggregatorAddress = fixture.aggregatorAddress;
    token0 = fixture.token0;
    token1 = fixture.token1;
    token0Address = fixture.token0Address;
    token1Address = fixture.token1Address;
    signers = fixture.signers;
  });

  async function getDecryptedBalance(
    token: FHEConfidentialToken,
    tokenAddress: string,
    user: HardhatEthersSigner
  ): Promise<bigint> {
    const encryptedBalance = await token.confidentialBalanceOf(user.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, encryptedBalance, tokenAddress, user);
  }

  async function getDecryptedLPBalance(user: HardhatEthersSigner): Promise<bigint> {
    const encryptedBalance = await aggregator.confidentialBalanceOf(user.address);
    return fhevm.userDecryptEuint(FhevmType.euint64, encryptedBalance, aggregatorAddress, user);
  }

  async function setupUserWithTokens(user: HardhatEthersSigner, amount0: bigint, amount1: bigint) {
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
    await token0.connect(user).setOperator(aggregatorAddress, expirationTimestamp);
    await token1.connect(user).setOperator(aggregatorAddress, expirationTimestamp);
  }

  async function performInitialMint(
    user: HardhatEthersSigner,
    to: string,
    amount0: bigint,
    amount1: bigint
  ): Promise<{ reserve0Handle: string; reserve1Handle: string; totalSupplyHandle: string }> {
    const encryptedInput = await fhevm
      .createEncryptedInput(aggregatorAddress, user.address)
      .add64(amount0)
      .add64(amount1)
      .encrypt();

    const tx = await aggregator.connect(user).initialMint(
      to,
      encryptedInput.handles[0],
      encryptedInput.handles[1],
      encryptedInput.inputProof
    );
    await tx.wait();

    const filter = aggregator.filters.BatchAwaitingDecryption();
    const events = await aggregator.queryFilter(filter);
    const lastEvent = events[events.length - 1];

    return {
      reserve0Handle: lastEvent.args.reserve0Handle,
      reserve1Handle: lastEvent.args.reserve1Handle,
      totalSupplyHandle: lastEvent.args.totalSupplyHandle,
    };
  }

  async function finalizeBatchWithDecryption(handles: {
    reserve0Handle: string;
    reserve1Handle: string;
    totalSupplyHandle: string;
  }) {
    const results = await fhevm.publicDecrypt([
      handles.reserve0Handle,
      handles.reserve1Handle,
      handles.totalSupplyHandle,
    ]);

    const reserve0 = results.clearValues[handles.reserve0Handle as `0x${string}`];
    const reserve1 = results.clearValues[handles.reserve1Handle as `0x${string}`];
    const totalSupply = results.clearValues[handles.totalSupplyHandle as `0x${string}`];

    const cleartexts = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint64", "uint64", "uint64"],
      [reserve0, reserve1, totalSupply]
    );

    await aggregator.finalizeBatch(cleartexts, results.decryptionProof);
  }

  async function initializePool(user: HardhatEthersSigner, amount0: bigint, amount1: bigint) {
    await setupUserWithTokens(user, amount0, amount1);
    const handles = await performInitialMint(user, user.address, amount0, amount1);
    await finalizeBatchWithDecryption(handles);
  }

  async function enqueueMint(
    user: HardhatEthersSigner,
    to: string,
    amount0: bigint,
    amount1: bigint,
    claimedLiquidity: bigint
  ): Promise<string> {
    const encryptedInput = await fhevm
      .createEncryptedInput(aggregatorAddress, user.address)
      .add64(amount0)
      .add64(amount1)
      .add64(claimedLiquidity)
      .encrypt();

    const tx = await aggregator.connect(user).enqueueMint(
      to,
      encryptedInput.handles[0],
      encryptedInput.handles[1],
      encryptedInput.handles[2],
      encryptedInput.inputProof
    );
    await tx.wait();

    const filter = aggregator.filters.OperationQueued();
    const events = await aggregator.queryFilter(filter);
    const lastEvent = events[events.length - 1];
    
    return lastEvent.args.revocationKeyHandle;
  }

  async function enqueueBurn(
    user: HardhatEthersSigner,
    to: string,
    liquidity: bigint,
    claimedAmount0: bigint,
    claimedAmount1: bigint
  ): Promise<string> {
    const encryptedInput = await fhevm
      .createEncryptedInput(aggregatorAddress, user.address)
      .add64(liquidity)
      .add64(claimedAmount0)
      .add64(claimedAmount1)
      .encrypt();

    const tx = await aggregator.connect(user).enqueueBurn(
      to,
      encryptedInput.handles[0],
      encryptedInput.handles[1],
      encryptedInput.handles[2],
      encryptedInput.inputProof
    );
    await tx.wait();

    const filter = aggregator.filters.OperationQueued();
    const events = await aggregator.queryFilter(filter);
    const lastEvent = events[events.length - 1];

    return lastEvent.args.revocationKeyHandle;
  }

  async function enqueueSwap(
    user: HardhatEthersSigner,
    to: string,
    amountIn: bigint,
    claimedOut: bigint,
    tokenOut: number
  ): Promise<string> {
    const encryptedInput = await fhevm
      .createEncryptedInput(aggregatorAddress, user.address)
      .add64(amountIn)
      .add64(claimedOut)
      .add8(tokenOut)
      .encrypt();

    const tx = await aggregator.connect(user).enqueueSwap(
      to,
      encryptedInput.handles[0],
      encryptedInput.handles[1],
      encryptedInput.handles[2],
      encryptedInput.inputProof
    );
    await tx.wait();

    const filter = aggregator.filters.OperationQueued();
    const events = await aggregator.queryFilter(filter);
    const lastEvent = events[events.length - 1];
    
    return lastEvent.args.revocationKeyHandle;
  }

  function calculateSwapOutput(
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    slippageBps: bigint = 100n
  ): bigint {
    const amountInWithFee = amountIn * 997n;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 1000n + amountInWithFee;
    const exactOut = numerator / denominator;
    return exactOut * (10000n - slippageBps) / 10000n;
  }

  function calculateExactLP(
    amount0: bigint,
    amount1: bigint,
    reserve0: bigint,
    reserve1: bigint,
    totalSupply: bigint,
    slippageBps: bigint = 0n
  ): bigint {
    const lp0 = (amount0 * totalSupply) / reserve0;
    const lp1 = (amount1 * totalSupply) / reserve1;
    const exactLP = lp0 < lp1 ? lp0 : lp1;
    return exactLP * (10000n - slippageBps) / 10000n;
  }

  function calculateBurnAmounts(
    liquidity: bigint,
    reserve0: bigint,
    reserve1: bigint,
    totalSupply: bigint,
    slippageBps: bigint = 0n
  ): { amount0: bigint; amount1: bigint } {
    const exact0 = (liquidity * reserve0) / totalSupply;
    const exact1 = (liquidity * reserve1) / totalSupply;
    return {
      amount0: exact0 * (10000n - slippageBps) / 10000n,
      amount1: exact1 * (10000n - slippageBps) / 10000n,
    };
  }

  async function finalizeCurrent() {
    const filter = aggregator.filters.BatchAwaitingDecryption();
    const events = await aggregator.queryFilter(filter);
    const lastEvent = events[events.length - 1];
    await finalizeBatchWithDecryption({
      reserve0Handle: lastEvent.args.reserve0Handle,
      reserve1Handle: lastEvent.args.reserve1Handle,
      totalSupplyHandle: lastEvent.args.totalSupplyHandle,
    });
  }

  async function processAllOperations(count: number) {
    for (let i = 0; i < count; i++) {
      await aggregator.processBatch();
    }
  }

  describe("Large Batch Processing", function () {
    it("should process two consecutive batches of 20 mixed operations", async function () {
      this.timeout(600000);

      const initialAmount = 10000000000n; // 10K tokens (6 decimals)
      await initializePool(signers[0], initialAmount, initialAmount);

      let reserve0 = await aggregator.publicReserve0();
      let reserve1 = await aggregator.publicReserve1();
      let totalSupply = await aggregator.publicTotalSupply();
      console.log("Initial - R0:", reserve0, "R1:", reserve1, "TS:", totalSupply);

      // Track LP holders for burns
      const lpHolders: Map<number, bigint> = new Map();

      // === BATCH 1: 20 operations ===
      console.log("\n=== Enqueueing Batch 1 (20 ops) ===");

      // Op 1: Mint (signer 1)
      const mint1Amount = 500000000n;
      const mint1LP = calculateExactLP(mint1Amount, mint1Amount, reserve0, reserve1, totalSupply, 500n);
      await setupUserWithTokens(signers[1], mint1Amount, mint1Amount);
      await enqueueMint(signers[1], signers[1].address, mint1Amount, mint1Amount, mint1LP);
      lpHolders.set(1, mint1LP);

      // Op 2: Swap T0->T1 (signer 2)
      const swap2In = 100000000n;
      const swap2Out = calculateSwapOutput(swap2In, reserve0, reserve1, 100n);
      await setupUserWithTokens(signers[2], swap2In, 0n);
      await enqueueSwap(signers[2], signers[2].address, swap2In, swap2Out, 1);

      // Op 3: Swap T1->T0 (signer 3)
      const swap3In = 150000000n;
      const swap3Out = calculateSwapOutput(swap3In, reserve1, reserve0, 100n);
      await setupUserWithTokens(signers[3], 0n, swap3In);
      await enqueueSwap(signers[3], signers[3].address, swap3In, swap3Out, 0);

      // Op 4: Swap T0->T1 (signer 4)
      const swap4In = 80000000n;
      const swap4Out = calculateSwapOutput(swap4In, reserve0, reserve1, 150n);
      await setupUserWithTokens(signers[4], swap4In, 0n);
      await enqueueSwap(signers[4], signers[4].address, swap4In, swap4Out, 1);

      // Op 5: Mint (signer 5)
      const mint5Amount = 300000000n;
      const mint5LP = calculateExactLP(mint5Amount, mint5Amount, reserve0, reserve1, totalSupply, 500n);
      await setupUserWithTokens(signers[5], mint5Amount, mint5Amount);
      await enqueueMint(signers[5], signers[5].address, mint5Amount, mint5Amount, mint5LP);
      lpHolders.set(5, mint5LP);

      // Op 6: Swap T1->T0 (signer 6)
      const swap6In = 200000000n;
      const swap6Out = calculateSwapOutput(swap6In, reserve1, reserve0, 100n);
      await setupUserWithTokens(signers[6], 0n, swap6In);
      await enqueueSwap(signers[6], signers[6].address, swap6In, swap6Out, 0);

      // Op 7: Swap T0->T1 (signer 7)
      const swap7In = 120000000n;
      const swap7Out = calculateSwapOutput(swap7In, reserve0, reserve1, 50n);
      await setupUserWithTokens(signers[7], swap7In, 0n);
      await enqueueSwap(signers[7], signers[7].address, swap7In, swap7Out, 1);

      // Op 8: Swap T1->T0 (signer 8)
      const swap8In = 175000000n;
      const swap8Out = calculateSwapOutput(swap8In, reserve1, reserve0, 200n);
      await setupUserWithTokens(signers[8], 0n, swap8In);
      await enqueueSwap(signers[8], signers[8].address, swap8In, swap8Out, 0);

      // Op 9: Mint (signer 9)
      const mint9Amount = 400000000n;
      const mint9LP = calculateExactLP(mint9Amount, mint9Amount, reserve0, reserve1, totalSupply, 500n);
      await setupUserWithTokens(signers[9], mint9Amount, mint9Amount);
      await enqueueMint(signers[9], signers[9].address, mint9Amount, mint9Amount, mint9LP);
      lpHolders.set(9, mint9LP);

      // Op 10: Swap T0->T1 (signer 10)
      const swap10In = 90000000n;
      const swap10Out = calculateSwapOutput(swap10In, reserve0, reserve1, 100n);
      await setupUserWithTokens(signers[10], swap10In, 0n);
      await enqueueSwap(signers[10], signers[10].address, swap10In, swap10Out, 1);

      // Op 11: Swap T1->T0 (signer 11)
      const swap11In = 130000000n;
      const swap11Out = calculateSwapOutput(swap11In, reserve1, reserve0, 150n);
      await setupUserWithTokens(signers[11], 0n, swap11In);
      await enqueueSwap(signers[11], signers[11].address, swap11In, swap11Out, 0);

      // Op 12: Swap T0->T1 (signer 12)
      const swap12In = 110000000n;
      const swap12Out = calculateSwapOutput(swap12In, reserve0, reserve1, 100n);
      await setupUserWithTokens(signers[12], swap12In, 0n);
      await enqueueSwap(signers[12], signers[12].address, swap12In, swap12Out, 1);

      // Op 13: Mint (signer 13)
      const mint13Amount = 250000000n;
      const mint13LP = calculateExactLP(mint13Amount, mint13Amount, reserve0, reserve1, totalSupply, 500n);
      await setupUserWithTokens(signers[13], mint13Amount, mint13Amount);
      await enqueueMint(signers[13], signers[13].address, mint13Amount, mint13Amount, mint13LP);
      lpHolders.set(13, mint13LP);

      // Op 14: Swap T1->T0 (signer 14)
      const swap14In = 160000000n;
      const swap14Out = calculateSwapOutput(swap14In, reserve1, reserve0, 100n);
      await setupUserWithTokens(signers[14], 0n, swap14In);
      await enqueueSwap(signers[14], signers[14].address, swap14In, swap14Out, 0);

      // Op 15: Swap T0->T1 (signer 15)
      const swap15In = 140000000n;
      const swap15Out = calculateSwapOutput(swap15In, reserve0, reserve1, 50n);
      await setupUserWithTokens(signers[15], swap15In, 0n);
      await enqueueSwap(signers[15], signers[15].address, swap15In, swap15Out, 1);

      // Op 16: Swap T1->T0 (signer 16)
      const swap16In = 180000000n;
      const swap16Out = calculateSwapOutput(swap16In, reserve1, reserve0, 200n);
      await setupUserWithTokens(signers[16], 0n, swap16In);
      await enqueueSwap(signers[16], signers[16].address, swap16In, swap16Out, 0);

      // Op 17: Swap T0->T1 (signer 17)
      const swap17In = 95000000n;
      const swap17Out = calculateSwapOutput(swap17In, reserve0, reserve1, 100n);
      await setupUserWithTokens(signers[17], swap17In, 0n);
      await enqueueSwap(signers[17], signers[17].address, swap17In, swap17Out, 1);

      // Op 18: Swap T1->T0 (signer 18)
      const swap18In = 125000000n;
      const swap18Out = calculateSwapOutput(swap18In, reserve1, reserve0, 150n);
      await setupUserWithTokens(signers[18], 0n, swap18In);
      await enqueueSwap(signers[18], signers[18].address, swap18In, swap18Out, 0);

      // Op 19: Burn (signer 1 - 20% of LP)
      const burn19LP = lpHolders.get(1)! / 5n;
      const burn19Amounts = calculateBurnAmounts(burn19LP, reserve0, reserve1, totalSupply, 500n);
      await enqueueBurn(signers[1], signers[1].address, burn19LP, burn19Amounts.amount0, burn19Amounts.amount1);

      // Op 20: Burn (signer 5 - 25% of LP)
      const burn20LP = lpHolders.get(5)! / 4n;
      const burn20Amounts = calculateBurnAmounts(burn20LP, reserve0, reserve1, totalSupply, 500n);
      await enqueueBurn(signers[5], signers[5].address, burn20LP, burn20Amounts.amount0, burn20Amounts.amount1);

      expect(await aggregator.getCurrentBatchSize()).to.equal(20);
      console.log("Batch 1 queued: 20 operations");

      // Process batch 1
      console.log("Processing batch 1...");
      await processAllOperations(20);
      await finalizeCurrent();

      reserve0 = await aggregator.publicReserve0();
      reserve1 = await aggregator.publicReserve1();
      totalSupply = await aggregator.publicTotalSupply();
      console.log("After Batch 1 - R0:", reserve0, "R1:", reserve1, "TS:", totalSupply);

      expect(reserve0).to.be.gt(0n);
      expect(reserve1).to.be.gt(0n);
      expect(totalSupply).to.be.gt(0n);

      // === BATCH 2: 20 operations ===
      console.log("\n=== Enqueueing Batch 2 (20 ops) ===");

      // Op 1: Swap T0->T1 (signer 19)
      const swap2_1In = 85000000n;
      const swap2_1Out = calculateSwapOutput(swap2_1In, reserve0, reserve1, 100n);
      await setupUserWithTokens(signers[19], swap2_1In, 0n);
      await enqueueSwap(signers[19], signers[19].address, swap2_1In, swap2_1Out, 1);

      // Op 2: Swap T1->T0 (signer 2)
      const swap2_2In = 145000000n;
      const swap2_2Out = calculateSwapOutput(swap2_2In, reserve1, reserve0, 150n);
      await setupUserWithTokens(signers[2], 0n, swap2_2In);
      await enqueueSwap(signers[2], signers[2].address, swap2_2In, swap2_2Out, 0);

      // Op 3: Mint (signer 3)
      const mint2_3Amount = 350000000n;
      const mint2_3LP = calculateExactLP(mint2_3Amount, mint2_3Amount, reserve0, reserve1, totalSupply, 500n);
      await setupUserWithTokens(signers[3], mint2_3Amount, mint2_3Amount);
      await enqueueMint(signers[3], signers[3].address, mint2_3Amount, mint2_3Amount, mint2_3LP);

      // Op 4: Swap T0->T1 (signer 4)
      const swap2_4In = 105000000n;
      const swap2_4Out = calculateSwapOutput(swap2_4In, reserve0, reserve1, 100n);
      await setupUserWithTokens(signers[4], swap2_4In, 0n);
      await enqueueSwap(signers[4], signers[4].address, swap2_4In, swap2_4Out, 1);

      // Op 5: Swap T1->T0 (signer 6)
      const swap2_5In = 165000000n;
      const swap2_5Out = calculateSwapOutput(swap2_5In, reserve1, reserve0, 200n);
      await setupUserWithTokens(signers[6], 0n, swap2_5In);
      await enqueueSwap(signers[6], signers[6].address, swap2_5In, swap2_5Out, 0);

      // Op 6: Burn (signer 9 - 15% of LP)
      const burn2_6LP = lpHolders.get(9)! * 15n / 100n;
      const burn2_6Amounts = calculateBurnAmounts(burn2_6LP, reserve0, reserve1, totalSupply, 500n);
      await enqueueBurn(signers[9], signers[9].address, burn2_6LP, burn2_6Amounts.amount0, burn2_6Amounts.amount1);

      // Op 7: Swap T0->T1 (signer 7)
      const swap2_7In = 75000000n;
      const swap2_7Out = calculateSwapOutput(swap2_7In, reserve0, reserve1, 50n);
      await setupUserWithTokens(signers[7], swap2_7In, 0n);
      await enqueueSwap(signers[7], signers[7].address, swap2_7In, swap2_7Out, 1);

      // Op 8: Swap T1->T0 (signer 8)
      const swap2_8In = 135000000n;
      const swap2_8Out = calculateSwapOutput(swap2_8In, reserve1, reserve0, 100n);
      await setupUserWithTokens(signers[8], 0n, swap2_8In);
      await enqueueSwap(signers[8], signers[8].address, swap2_8In, swap2_8Out, 0);

      // Op 9: Mint (signer 10)
      const mint2_9Amount = 275000000n;
      const mint2_9LP = calculateExactLP(mint2_9Amount, mint2_9Amount, reserve0, reserve1, totalSupply, 500n);
      await setupUserWithTokens(signers[10], mint2_9Amount, mint2_9Amount);
      await enqueueMint(signers[10], signers[10].address, mint2_9Amount, mint2_9Amount, mint2_9LP);

      // Op 10: Swap T0->T1 (signer 11)
      const swap2_10In = 115000000n;
      const swap2_10Out = calculateSwapOutput(swap2_10In, reserve0, reserve1, 100n);
      await setupUserWithTokens(signers[11], swap2_10In, 0n);
      await enqueueSwap(signers[11], signers[11].address, swap2_10In, swap2_10Out, 1);

      // Op 11: Swap T1->T0 (signer 12)
      const swap2_11In = 155000000n;
      const swap2_11Out = calculateSwapOutput(swap2_11In, reserve1, reserve0, 150n);
      await setupUserWithTokens(signers[12], 0n, swap2_11In);
      await enqueueSwap(signers[12], signers[12].address, swap2_11In, swap2_11Out, 0);

      // Op 12: Swap T0->T1 (signer 14)
      const swap2_12In = 70000000n;
      const swap2_12Out = calculateSwapOutput(swap2_12In, reserve0, reserve1, 100n);
      await setupUserWithTokens(signers[14], swap2_12In, 0n);
      await enqueueSwap(signers[14], signers[14].address, swap2_12In, swap2_12Out, 1);

      // Op 13: Mint (signer 15)
      const mint2_13Amount = 225000000n;
      const mint2_13LP = calculateExactLP(mint2_13Amount, mint2_13Amount, reserve0, reserve1, totalSupply, 500n);
      await setupUserWithTokens(signers[15], mint2_13Amount, mint2_13Amount);
      await enqueueMint(signers[15], signers[15].address, mint2_13Amount, mint2_13Amount, mint2_13LP);

      // Op 14: Swap T1->T0 (signer 16)
      const swap2_14In = 190000000n;
      const swap2_14Out = calculateSwapOutput(swap2_14In, reserve1, reserve0, 200n);
      await setupUserWithTokens(signers[16], 0n, swap2_14In);
      await enqueueSwap(signers[16], signers[16].address, swap2_14In, swap2_14Out, 0);

      // Op 15: Swap T0->T1 (signer 17)
      const swap2_15In = 100000000n;
      const swap2_15Out = calculateSwapOutput(swap2_15In, reserve0, reserve1, 50n);
      await setupUserWithTokens(signers[17], swap2_15In, 0n);
      await enqueueSwap(signers[17], signers[17].address, swap2_15In, swap2_15Out, 1);

      // Op 16: Swap T1->T0 (signer 18)
      const swap2_16In = 140000000n;
      const swap2_16Out = calculateSwapOutput(swap2_16In, reserve1, reserve0, 100n);
      await setupUserWithTokens(signers[18], 0n, swap2_16In);
      await enqueueSwap(signers[18], signers[18].address, swap2_16In, swap2_16Out, 0);

      // Op 17: Burn (signer 13 - 10% of LP)
      const burn2_17LP = lpHolders.get(13)! / 10n;
      const burn2_17Amounts = calculateBurnAmounts(burn2_17LP, reserve0, reserve1, totalSupply, 500n);
      await enqueueBurn(signers[13], signers[13].address, burn2_17LP, burn2_17Amounts.amount0, burn2_17Amounts.amount1);

      // Op 18: Swap T0->T1 (signer 19)
      const swap2_18In = 88000000n;
      const swap2_18Out = calculateSwapOutput(swap2_18In, reserve0, reserve1, 100n);
      await setupUserWithTokens(signers[19], swap2_18In, 0n);
      await enqueueSwap(signers[19], signers[19].address, swap2_18In, swap2_18Out, 1);

      // Op 19: Swap T1->T0 (signer 2)
      const swap2_19In = 170000000n;
      const swap2_19Out = calculateSwapOutput(swap2_19In, reserve1, reserve0, 150n);
      await setupUserWithTokens(signers[2], 0n, swap2_19In);
      await enqueueSwap(signers[2], signers[2].address, swap2_19In, swap2_19Out, 0);

      // Op 20: Swap T0->T1 (signer 4)
      const swap2_20In = 92000000n;
      const swap2_20Out = calculateSwapOutput(swap2_20In, reserve0, reserve1, 100n);
      await setupUserWithTokens(signers[4], swap2_20In, 0n);
      await enqueueSwap(signers[4], signers[4].address, swap2_20In, swap2_20Out, 1);

      expect(await aggregator.getCurrentBatchSize()).to.equal(20);
      console.log("Batch 2 queued: 20 operations");

      // Process batch 2
      console.log("Processing batch 2...");
      await processAllOperations(20);
      await finalizeCurrent();

      const finalReserve0 = await aggregator.publicReserve0();
      const finalReserve1 = await aggregator.publicReserve1();
      const finalTotalSupply = await aggregator.publicTotalSupply();
      console.log("\nFinal - R0:", finalReserve0, "R1:", finalReserve1, "TS:", finalTotalSupply);

      expect(finalReserve0).to.be.gt(0n);
      expect(finalReserve1).to.be.gt(0n);
      expect(finalTotalSupply).to.be.gt(0n);

      // Verify some LP balances
      const signer1LP = await getDecryptedLPBalance(signers[1]);
      const signer9LP = await getDecryptedLPBalance(signers[9]);
      console.log("Signer 1 LP:", signer1LP, "Signer 9 LP:", signer9LP);

      expect(signer1LP).to.be.gt(0n);
      expect(signer9LP).to.be.gt(0n);

      console.log("\n=== Stress test completed successfully ===");
    });
  });
});

