import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";


/**
 * Finalize a batch that is awaiting decryption
 * 
 * Example:
 *   npx hardhat --network sepolia task:finalize-batch --pair 0xPairAddress
 */
task("task:finalize-batch", "Finalizes a batch that is awaiting decryption")
  .addParam("pair", "The FHEBatchCpmm pair address")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, fhevm } = hre;

    await fhevm.initializeCLIApi();

    const signers = await ethers.getSigners();
    const signer = signers[0];
    const pairAddress = taskArguments.pair;

    console.log("Pair address:", pairAddress);
    console.log("Signer:", signer.address);

    const pair = await ethers.getContractAt("FHEBatchCpmm", pairAddress, signer);

    // Check current batch state
    const currentBatchId = await pair.currentBatchId();
    const batchMeta = await pair.batches(currentBatchId);

    console.log("\nCurrent batch ID:", currentBatchId);
    console.log("Batch processing:", batchMeta.processing);
    console.log("Batch awaiting decryption:", batchMeta.awaitingDecryption);
    console.log("Batch executed:", batchMeta.executed);

    if (!batchMeta.awaitingDecryption) {
      console.log("\nBatch is not awaiting decryption. Nothing to finalize.");
      return;
    }

    // Get BatchAwaitingDecryption event for current batch
    const filter = pair.filters.BatchAwaitingDecryption();
    const events = await pair.queryFilter(filter);
    
    // Find event for current batch
    const batchEvent = events.find(e => e.args.batchId === currentBatchId) || events[events.length - 1];

    if (!batchEvent) {
      console.log("No BatchAwaitingDecryption event found.");
      return;
    }

    console.log("Found BatchAwaitingDecryption event:");
    console.log("Reserve0 Handle:", batchEvent.args.reserve0Handle);
    console.log("Reserve1 Handle:", batchEvent.args.reserve1Handle);
    console.log("TotalSupply Handle:", batchEvent.args.totalSupplyHandle);

    // Decrypt reserves
    console.log("Decrypting reserves...");
    const results = await fhevm.publicDecrypt([
      batchEvent.args.reserve0Handle,
      batchEvent.args.reserve1Handle,
      batchEvent.args.totalSupplyHandle,
    ]);

    const reserve0 = results.clearValues[batchEvent.args.reserve0Handle as `0x${string}`];
    const reserve1 = results.clearValues[batchEvent.args.reserve1Handle as `0x${string}`];
    const totalSupply = results.clearValues[batchEvent.args.totalSupplyHandle as `0x${string}`];

    console.log("Decrypted Reserve0:", reserve0);
    console.log("Decrypted Reserve1:", reserve1);
    console.log("Decrypted TotalSupply:", totalSupply);

    // Finalize batch
    console.log("Finalizing batch...");
    const cleartexts = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint64", "uint64", "uint64"],
      [reserve0, reserve1, totalSupply]
    );

    const finalizeTx = await pair.finalizeBatch(cleartexts, results.decryptionProof);
    console.log("Waiting for finalize tx:", finalizeTx.hash);
    const finalizeReceipt = await finalizeTx.wait();
    console.log("finalizeBatch tx status:", finalizeReceipt?.status === 1 ? "success" : "failed");

    // Verify final state
    const publicReserve0 = await pair.publicReserve0();
    const publicReserve1 = await pair.publicReserve1();
    const publicTotalSupply = await pair.publicTotalSupply();
    const newBatchId = await pair.currentBatchId();

    console.log("Batch Finalized!");
    console.log("Public Reserve0:", publicReserve0);
    console.log("Public Reserve1:", publicReserve1);
    console.log("Public TotalSupply:", publicTotalSupply);
    console.log("New Batch ID:", newBatchId);

    console.log("Finalize batch complete!");
  });