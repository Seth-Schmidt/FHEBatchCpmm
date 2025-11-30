import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * Full batch lifecycle: enqueue 2 mints, process batch, decrypt, finalize
 * 
 * Example:
 *   npx hardhat --network sepolia task:batch-lifecycle \
 *     --pair 0xPairAddress \
 *     --amount 500000
 */
task("task:batch-lifecycle", "Runs a full batch lifecycle with 2 mint operations")
  .addParam("pair", "The FHEBatchCpmm pair address")
  .addOptionalParam("amount", "Amount per mint (default: 500000 = 0.5 tokens with 6 decimals)", "500000")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, fhevm } = hre;

    await fhevm.initializeCLIApi();

    const signers = await ethers.getSigners();
    const signer = signers[0];
    const pairAddress = taskArguments.pair;
    const amount = BigInt(taskArguments.amount);

    console.log("Pair address:", pairAddress);
    console.log("Signer:", signer.address);
    console.log("Amount per mint:", amount);

    // Get pair contract
    const pair = await ethers.getContractAt("FHEBatchCpmm", pairAddress, signer);

    // Get current state
    const minBatchSize = await pair.minBatchSize();
    const currentBatchId = await pair.currentBatchId();
    const publicReserve0 = await pair.publicReserve0();
    const publicReserve1 = await pair.publicReserve1();
    const publicTotalSupply = await pair.publicTotalSupply();

    console.log("Current State:");
    console.log("Min batch size:", minBatchSize);
    console.log("Current batch ID:", currentBatchId);
    console.log("Public Reserve0:", publicReserve0);
    console.log("Public Reserve1:", publicReserve1);
    console.log("Public TotalSupply:", publicTotalSupply);

    // Calculate proportional amounts and LP claim
    // LP = amount * totalSupply / reserve (take minimum)
    const lp0 = (amount * publicTotalSupply) / publicReserve0;
    const lp1 = (amount * publicTotalSupply) / publicReserve1;
    const claimedLP = lp0 < lp1 ? lp0 : lp1;
    // Apply 5% slippage
    const claimedLPWithSlippage = (claimedLP * 95n) / 100n;

    console.log("Calculated Values!");
    console.log("Amount0:", amount);
    console.log("Amount1:", amount);
    console.log("Claimed LP (with 5% slippage):", claimedLPWithSlippage);

    // Get token addresses and set operators if needed
    const token0Address = await pair.token0Address();
    const token1Address = await pair.token1Address();
    const token0 = await ethers.getContractAt("FHEConfidentialToken", token0Address, signer);
    const token1 = await ethers.getContractAt("FHEConfidentialToken", token1Address, signer);

    const maxUint48 = 2n ** 48n - 1n;
    console.log("Ensuring operator approvals...");
    await (await token0.setOperator(pairAddress, maxUint48)).wait();
    await (await token1.setOperator(pairAddress, maxUint48)).wait();
    console.log("Operators set");

    // Enqueue first mint
    console.log("Enqueueing Mint 1!");
    const enc1 = await fhevm
      .createEncryptedInput(pairAddress, signer.address)
      .add64(amount)
      .add64(amount)
      .add64(claimedLPWithSlippage)
      .encrypt();

    const tx1 = await pair.enqueueMint(
      signer.address,
      enc1.handles[0],
      enc1.handles[1],
      enc1.handles[2],
      enc1.inputProof
    );
    console.log("Waiting for tx:", tx1.hash);
    await tx1.wait();
    console.log("Mint 1 enqueued");

    // Enqueue second mint
    console.log("Enqueueing Mint 2!");
    const enc2 = await fhevm
      .createEncryptedInput(pairAddress, signer.address)
      .add64(amount)
      .add64(amount)
      .add64(claimedLPWithSlippage)
      .encrypt();

    const tx2 = await pair.enqueueMint(
      signer.address,
      enc2.handles[0],
      enc2.handles[1],
      enc2.handles[2],
      enc2.inputProof
    );
    console.log("Waiting for tx:", tx2.hash);
    await tx2.wait();
    console.log("Mint 2 enqueued");

    // Process batch (call minBatchSize times)
    console.log("Processing Batch!");
    for (let i = 0; i < Number(minBatchSize); i++) {
      console.log(`Processing operation ${i + 1}/${minBatchSize}...`);
      const processTx = await pair.processBatch();
      await processTx.wait();
    }
    console.log("All operations processed");

    // Get BatchAwaitingDecryption event
    const filter = pair.filters.BatchAwaitingDecryption();
    const events = await pair.queryFilter(filter);
    const lastEvent = events[events.length - 1];

    console.log("Batch Awaiting Decryption!");
    console.log("Reserve0 Handle:", lastEvent.args.reserve0Handle);
    console.log("Reserve1 Handle:", lastEvent.args.reserve1Handle);
    console.log("TotalSupply Handle:", lastEvent.args.totalSupplyHandle);

    // Decrypt reserves
    console.log("Decrypting reserves...");
    const results = await fhevm.publicDecrypt([
      lastEvent.args.reserve0Handle,
      lastEvent.args.reserve1Handle,
      lastEvent.args.totalSupplyHandle,
    ]);

    const newReserve0 = results.clearValues[lastEvent.args.reserve0Handle as `0x${string}`];
    const newReserve1 = results.clearValues[lastEvent.args.reserve1Handle as `0x${string}`];
    const newTotalSupply = results.clearValues[lastEvent.args.totalSupplyHandle as `0x${string}`];

    console.log("Decrypted Reserve0:", newReserve0);
    console.log("Decrypted Reserve1:", newReserve1);
    console.log("Decrypted TotalSupply:", newTotalSupply);

    // Finalize batch
    console.log("Finalizing Batch!");
    const cleartexts = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint64", "uint64", "uint64"],
      [newReserve0, newReserve1, newTotalSupply]
    );

    const finalizeTx = await pair.finalizeBatch(cleartexts, results.decryptionProof);
    console.log("Waiting for finalize tx:", finalizeTx.hash);
    const finalizeReceipt = await finalizeTx.wait();
    console.log("finalizeBatch tx status:", finalizeReceipt?.status === 1 ? "success" : "failed");

    // Verify final state
    const finalReserve0 = await pair.publicReserve0();
    const finalReserve1 = await pair.publicReserve1();
    const finalTotalSupply = await pair.publicTotalSupply();
    const finalBatchId = await pair.currentBatchId();

    console.log("Final State!");
    console.log("Public Reserve0:", finalReserve0);
    console.log("Public Reserve1:", finalReserve1);
    console.log("Public TotalSupply:", finalTotalSupply);
    console.log("Current Batch ID:", finalBatchId);

    console.log("Reserve Changes!");
    console.log("Reserve0 change:", BigInt(finalReserve0) - BigInt(publicReserve0));
    console.log("Reserve1 change:", BigInt(finalReserve1) - BigInt(publicReserve1));
    console.log("TotalSupply change:", BigInt(finalTotalSupply) - BigInt(publicTotalSupply));

    console.log("Batch lifecycle complete!");
  });