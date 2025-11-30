import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

/**
 * Mint test tokens to a given address
 * 
 * Example:
 *   npx hardhat --network sepolia task:mint-test-tokens --to 0x1234...
 *   npx hardhat --network localhost task:mint-test-tokens --to 0x1234...
 */
task("task:mint-test-tokens", "Mints 10 Token0 and 10 Token1 to a given address")
  .addParam("to", "The recipient address")
  .addOptionalParam("token0", "Token0 contract address (uses deployment if not provided)")
  .addOptionalParam("token1", "Token1 contract address (uses deployment if not provided)")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const { ethers, deployments, fhevm } = hre;

    await fhevm.initializeCLIApi();

    const signers = await ethers.getSigners();
    const signer = signers[0];

    // Get token addresses
    const token0Address = taskArguments.token0 || (await deployments.get("Token0")).address;
    const token1Address = taskArguments.token1 || (await deployments.get("Token1")).address;

    console.log("Token0 address:", token0Address);
    console.log("Token1 address:", token1Address);
    console.log("Recipient:", taskArguments.to);

    // 10 tokens with 6 decimals = 10_000_000
    const amount = 10000000n;

    // Get contract instances
    const token0 = await ethers.getContractAt("FHEConfidentialToken", token0Address, signer);
    const token1 = await ethers.getContractAt("FHEConfidentialToken", token1Address, signer);

    // Encrypt the amount for Token0
    console.log("Minting Token0...");
    const encryptedAmount0 = await fhevm
      .createEncryptedInput(token0Address, signer.address)
      .add64(amount)
      .encrypt();

    const tx0 = await token0.mint(
      taskArguments.to,
      encryptedAmount0.handles[0],
      encryptedAmount0.inputProof
    );
    console.log("Waiting for tx: " + tx0.hash + "...");
    const receipt0 = await tx0.wait();
    console.log("Token0 mint tx status: " + (receipt0?.status === 1 ? "success" : "failed"));

    // Encrypt the amount for Token1
    console.log("Minting Token1...");
    const encryptedAmount1 = await fhevm
      .createEncryptedInput(token1Address, signer.address)
      .add64(amount)
      .encrypt();

    const tx1 = await token1.mint(
      taskArguments.to,
      encryptedAmount1.handles[0],
      encryptedAmount1.inputProof
    );
    console.log("Waiting for tx: " + tx1.hash + "...");
    const receipt1 = await tx1.wait();
    console.log("Token1 mint tx status: " + (receipt1?.status === 1 ? "success" : "failed"));

    console.log("Successfully minted 10 Token0 and 10 Token1 to " + taskArguments.to);
  });