import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * Set initial liquidity for a CPMM pair
 * 
 * Example:
 *   npx hardhat --network sepolia task:initial-mint \
 *     --pair 0xPairAddress \
 *     --amount0 1000000 \
 *     --amount1 1000000
 */
task("task:initial-mint", "Sets initial liquidity for a CPMM pair")
  .addParam("pair", "The FHEBatchCpmm pair address")
  .addParam("amount0", "Amount of token0 (in base units, e.g., 1000000 = 1 token with 6 decimals)")
  .addParam("amount1", "Amount of token1 (in base units)")
  .addOptionalParam("token0", "Token0 contract address (reads from pair if not provided)")
  .addOptionalParam("token1", "Token1 contract address (reads from pair if not provided)")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, fhevm } = hre;

    await fhevm.initializeCLIApi();

    const signers = await ethers.getSigners();
    const signer = signers[0];
    const pairAddress = taskArguments.pair;

    console.log("Pair address:", pairAddress);
    console.log("Signer:", signer.address);

    // Get pair contract
    const pair = await ethers.getContractAt("FHEBatchCpmm", pairAddress, signer);

    // Get token addresses from pair if not provided
    const token0Address = taskArguments.token0 || await pair.token0Address();
    const token1Address = taskArguments.token1 || await pair.token1Address();

    console.log("Token0:", token0Address);
    console.log("Token1:", token1Address);

    const amount0 = BigInt(taskArguments.amount0);
    const amount1 = BigInt(taskArguments.amount1);

    console.log("Amount0:", amount0);
    console.log("Amount1:", amount1);

    // Get token contracts
    const token0 = await ethers.getContractAt("FHEConfidentialToken", token0Address, signer);
    const token1 = await ethers.getContractAt("FHEConfidentialToken", token1Address, signer);

    // Set operator with timestamp-based expiration
    const block = await ethers.provider.getBlock("latest");
    const blockTimestamp = block?.timestamp || 0;
    const expirationTimestamp = blockTimestamp + 1000000000;
    
    console.log("Setting pair as operator for Token0...");
    const tx0 = await token0.setOperator(pairAddress, expirationTimestamp);
    await tx0.wait();
    console.log("Token0 operator set");

    console.log("Setting pair as operator for Token1...");
    const tx1 = await token1.setOperator(pairAddress, expirationTimestamp);
    await tx1.wait();
    console.log("Token1 operator set");

    // Encrypt amounts
    console.log("Encrypting amounts...");
    const encryptedInput = await fhevm
      .createEncryptedInput(pairAddress, signer.address)
      .add64(amount0)
      .add64(amount1)
      .encrypt();

    // Call initialMint
    console.log("Calling initialMint...");
    const tx = await pair.initialMint(
      signer.address,
      encryptedInput.handles[0],
      encryptedInput.handles[1],
      encryptedInput.inputProof
    );
    console.log("Waiting for tx:", tx.hash);
    const receipt = await tx.wait();
    console.log("initialMint tx status:", receipt?.status === 1 ? "success" : "failed");

    // Parse BatchAwaitingDecryption event
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

    // Extract clear values using handle as key
    const reserve0 = results.clearValues[lastEvent.args.reserve0Handle as `0x${string}`];
    const reserve1 = results.clearValues[lastEvent.args.reserve1Handle as `0x${string}`];
    const totalSupply = results.clearValues[lastEvent.args.totalSupplyHandle as `0x${string}`];

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

    // Verify public reserves
    const publicReserve0 = await pair.publicReserve0();
    const publicReserve1 = await pair.publicReserve1();
    const publicTotalSupply = await pair.publicTotalSupply();

    console.log("Public Reserves Updated!");
    console.log("Public Reserve0:", publicReserve0);
    console.log("Public Reserve1:", publicReserve1);
    console.log("Public TotalSupply:", publicTotalSupply);

    console.log("Initial mint complete!");
  });