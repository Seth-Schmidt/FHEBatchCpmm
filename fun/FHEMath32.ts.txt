import { expect } from "chai";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

// Scale factor for euint32 version (2^10)
// Smaller than euint64's 2^30 to prevent overflow in uint32 intermediate calculations
const SCALE_BITS = 10;
const SCALE = BigInt(1) << BigInt(SCALE_BITS);

describe("FHEMath32 - euint32 Division Test", function () {
  let signers: { deployer: HardhatEthersSigner; alice: HardhatEthersSigner };
  let testContract: any;
  let testContractAddress: string;

  before(async function () {
    const ethSigners = await ethers.getSigners();
    signers = { deployer: ethSigners[0], alice: ethSigners[1] };
  });

  beforeEach(async function () {
    const Factory = await ethers.getContractFactory("FHEMath32Test");
    testContract = await Factory.deploy();
    await testContract.waitForDeployment();
    testContractAddress = await testContract.getAddress();
  });

  it("should test euint32 division with 3 iterations (HCU test)", async function () {
    // Test: 2000 / 500 = 4
    // Using small values that fit in uint32 with SCALE = 2^15
    const numerator = 2000n;
    const denominator = 500n;
    const expectedQuotient = numerator / denominator; // 4

    console.log(`\n  Testing euint32 division: ${numerator} / ${denominator} = ${expectedQuotient}`);
    console.log(`  SCALE (2^15): ${SCALE}`);

    // Create encrypted inputs
    const encryptedInput = await fhevm
      .createEncryptedInput(testContractAddress, signers.alice.address)
      .add32(Number(numerator))
      .add32(Number(denominator))
      .encrypt();

    console.log(`\n  Calling testDivide...`);
    
    try {
      const tx = await testContract
        .connect(signers.alice)
        .testDivide(
          encryptedInput.handles[0],
          encryptedInput.handles[1],
          encryptedInput.inputProof
        );
      
      const receipt = await tx.wait();
      const gasUsed = receipt?.gasUsed || 0n;
      
      console.log(`  ✓ Transaction succeeded!`);
      console.log(`  Gas used: ${gasUsed.toLocaleString()}`);

      // Decrypt and verify result
      const encryptedResult = await testContract.lastResult();
      const decryptedResult = await fhevm.userDecryptEuint(
        FhevmType.euint32,
        encryptedResult,
        testContractAddress,
        signers.alice
      );

      const expectedScaled = expectedQuotient * SCALE;
      const diff = decryptedResult > expectedScaled 
        ? decryptedResult - expectedScaled 
        : expectedScaled - decryptedResult;
      const errorPercent = Number(diff * 10000n / expectedScaled) / 100;

      console.log(`\n  Results:`);
      console.log(`    Decrypted result: ${decryptedResult}`);
      console.log(`    Expected (scaled): ${expectedScaled}`);
      console.log(`    Difference: ${diff}`);
      console.log(`    Error: ${errorPercent}%`);

      expect(Math.abs(errorPercent)).to.be.lessThan(1); // Should be <1% with 3 iterations
      console.log(`  ✓ Division verified within 1% tolerance!`);

    } catch (error: any) {
      if (error.message.includes("HCUTransactionDepthLimitExceeded")) {
        console.log(`  HCU limit exceeded - euint32 with 3 iterations is too expensive`);
      }
      throw error;
    }
  });
});

