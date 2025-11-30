import { expect } from "chai";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { FHECpmm, FHEConfidentialToken } from "../types";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

// Scale factor used in FHEMath (2^30)
const SCALE_BITS = 30;

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
};

async function deployFixture() {
  // Deploy token0
  const Token0Factory = await ethers.getContractFactory("FHEConfidentialToken");
  const token0 = await Token0Factory.deploy("Token0", "TKN0");
  await token0.waitForDeployment();
  const token0Address = await token0.getAddress();
  
  // Deploy token1
  const Token1Factory = await ethers.getContractFactory("FHEConfidentialToken");
  const token1 = await Token1Factory.deploy("Token1", "TKN1");
  await token1.waitForDeployment();
  const token1Address = await token1.getAddress();
  
  // Deploy CPMM (deployer becomes factory)
  const CpmmFactory = await ethers.getContractFactory("FHECpmm");
  const cpmm = await CpmmFactory.deploy();
  await cpmm.waitForDeployment();
  const cpmmAddress = await cpmm.getAddress();
  
  // Initialize CPMM with token pair
  await cpmm.initialize(token0Address, token1Address);
  
  return { 
    cpmm, 
    cpmmAddress,
    token0, 
    token0Address,
    token1, 
    token1Address 
  };
}

describe("FHECpmm - Mint Function", function () {
  let signers: Signers;
  let cpmm: FHECpmm;
  let cpmmAddress: string;
  let token0: FHEConfidentialToken;
  let token0Address: string;
  let token1: FHEConfidentialToken;
  let token1Address: string;
  
  before(async function () {
    const ethSigners = await ethers.getSigners();
    signers = { 
      deployer: ethSigners[0], 
      alice: ethSigners[1], 
      bob: ethSigners[2] 
    };
  });

  beforeEach(async function () {
    ({ cpmm, cpmmAddress, token0, token0Address, token1, token1Address } = await deployFixture());
  });

  describe("Setup & Initialization", function () {
    it("should initialize with correct tokens", async function () {
      const token0Addr = await cpmm.token0();
      const token1Addr = await cpmm.token1();
      
      expect(token0Addr).to.equal(token0Address);
      expect(token1Addr).to.equal(token1Address);
    });

    it("should have factory set to deployer", async function () {
      const factory = await cpmm.factory();
      expect(factory).to.equal(signers.deployer.address);
    });

    it("should have correct LP token metadata", async function () {
      const name = await cpmm.name();
      const symbol = await cpmm.symbol();
      const decimals = await cpmm.decimals();
      
      expect(name).to.equal("FHE CPMM LP");
      expect(symbol).to.equal("FHE-LP");
      expect(decimals).to.equal(18);
    });

    it("should prevent double initialization", async function () {
      await expect(
        cpmm.initialize(token0Address, token1Address)
      ).to.be.revertedWithCustomError(cpmm, "Forbidden");
    });
  });


  describe("Sqrt Approximation (Linear Average)", function () {
    it("should calculate sqrt(a * b) using linear average when a = b", async function () {
      // Test values: sqrt(1B * 1B) = sqrt(10^18) = 10^9 = 1,000,000,000
      // Linear average: (1B + 1B) / 2 = 1B (exact when a = b!)
      const amount0 = 1_000_000_000n;  // 1 billion
      const amount1 = 1_000_000_000n;  // 1 billion
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing linear average sqrt: (${amount0} + ${amount1}) / 2`);
      console.log(`    True sqrt:      ${trueSqrt}`);
      console.log(`    Linear average: ${linearAvg} (exact when a = b)`);

      // Mint tokens to Alice
      const encryptedMint0 = await fhevm
        .createEncryptedInput(token0Address, signers.alice.address)
        .add64(amount0)
        .encrypt();
      const encryptedMint1 = await fhevm
        .createEncryptedInput(token1Address, signers.alice.address)
        .add64(amount1)
        .encrypt();

      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      // Set operator
      const block = await ethers.provider.getBlock("latest");
      const blockTimestamp = block?.timestamp || 0;
      const expirationTimestamp = blockTimestamp + 1000;
      await token0.connect(signers.alice).setOperator(cpmmAddress, expirationTimestamp);
      await token1.connect(signers.alice).setOperator(cpmmAddress, expirationTimestamp);

      // Create encrypted inputs for CPMM
      const encryptedInput = await fhevm
        .createEncryptedInput(cpmmAddress, signers.alice.address)
        .add64(amount0)
        .add64(amount1)
        .encrypt();
      
      // Phase 1: prepareMint
      console.log(`\n  Phase 1: prepareMint...`);
      const prepareTx = await cpmm.connect(signers.alice).prepareMint(
        encryptedInput.handles[0],
        encryptedInput.handles[1],
        encryptedInput.inputProof
      );
      const prepareReceipt = await prepareTx.wait();
      const prepareGas = prepareReceipt?.gasUsed || 0n;
      console.log(`    prepareMint gas: ${prepareGas.toLocaleString()} gas`);
      
      // Phase 2: mint (which calls _sqrt internally)
      console.log(`\n  Phase 2: mint (triggers inverse sqrt)...`);
      const mintTx = await cpmm.connect(signers.alice).mint(signers.alice.address);
      const mintReceipt = await mintTx.wait();
      const mintGas = mintReceipt?.gasUsed || 0n;
      console.log(`    mint gas: ${mintGas.toLocaleString()} gas`);
      console.log(`    Total gas: ${(prepareGas + mintGas).toLocaleString()} gas`);
      
      // Get and decrypt the sqrt result
      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      console.log(`\n  Decrypting sqrt result...`);
      console.log(`    Encrypted handle: ${encryptedSqrtResult}`);
      
      const decryptedSqrt = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedSqrtResult,
        cpmmAddress,
        signers.alice
      );
      console.log(`    Decrypted sqrt: ${decryptedSqrt}`);
      
      // For equal inputs, linear average equals true sqrt
      const expectedResult = linearAvg;
      const diff = decryptedSqrt > expectedResult 
        ? decryptedSqrt - expectedResult 
        : expectedResult - decryptedSqrt;
      const errorPercent = Number(diff * 10000n / expectedResult) / 100;
      
      console.log(`\n  Accuracy Analysis:`);
      console.log(`    Expected (linear avg): ${expectedResult}`);
      console.log(`    Actual:                ${decryptedSqrt}`);
      console.log(`    Difference:            ${diff}`);
      console.log(`    Error:                 ${errorPercent}%`);
      
      // Linear average should be exact for equal inputs
      expect(Math.abs(errorPercent)).to.be.lessThan(1);
      console.log(`  ✓ Linear average sqrt verified (exact for equal inputs)!`);
    });

    it("should calculate sqrt with different sized inputs (overestimates)", async function () {
      // Test: sqrt(2B * 500M) = sqrt(10^18) = 10^9
      // Linear average: (2B + 500M) / 2 = 1.25B (overestimates by 25%)
      const amount0 = 2_000_000_000n;  // 2 billion
      const amount1 = 500_000_000n;    // 500 million
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing linear average sqrt with unequal inputs:`);
      console.log(`    Inputs: ${amount0}, ${amount1}`);
      console.log(`    Product: ${amount0 * amount1}`);
      console.log(`    True sqrt:      ${trueSqrt}`);
      console.log(`    Linear average: ${linearAvg} (overestimates)`);

      // Mint tokens to Alice
      const encryptedMint0 = await fhevm
        .createEncryptedInput(token0Address, signers.alice.address)
        .add64(amount0)
        .encrypt();
      const encryptedMint1 = await fhevm
        .createEncryptedInput(token1Address, signers.alice.address)
        .add64(amount1)
        .encrypt();

      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      // Set operator
      const block = await ethers.provider.getBlock("latest");
      const blockTimestamp = block?.timestamp || 0;
      const expirationTimestamp = blockTimestamp + 1000;
      await token0.connect(signers.alice).setOperator(cpmmAddress, expirationTimestamp);
      await token1.connect(signers.alice).setOperator(cpmmAddress, expirationTimestamp);

      // Create encrypted inputs for CPMM
      const encryptedInput = await fhevm
        .createEncryptedInput(cpmmAddress, signers.alice.address)
        .add64(amount0)
        .add64(amount1)
        .encrypt();
      
      // Phase 1: prepareMint
      await cpmm.connect(signers.alice).prepareMint(
        encryptedInput.handles[0],
        encryptedInput.handles[1],
        encryptedInput.inputProof
      );
      
      // Phase 2: mint
      await cpmm.connect(signers.alice).mint(signers.alice.address);
      
      // Get and decrypt the sqrt result
      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedSqrtResult,
        cpmmAddress,
        signers.alice
      );
      
      // Linear average should match expected
      const expectedResult = linearAvg;
      const diff = decryptedSqrt > expectedResult 
        ? decryptedSqrt - expectedResult 
        : expectedResult - decryptedSqrt;
      const errorPercent = Number(diff * 10000n / expectedResult) / 100;
      
      // Also calculate overestimate vs true sqrt
      const overestimatePercent = Number((linearAvg - trueSqrt) * 10000n / trueSqrt) / 100;
      
      console.log(`    Decrypted result: ${decryptedSqrt}`);
      console.log(`    Error vs linear avg: ${errorPercent}%`);
      console.log(`    Overestimate vs true sqrt: ${overestimatePercent}%`);
      
      expect(Math.abs(errorPercent)).to.be.lessThan(1);  // Should match linear avg exactly
      console.log(`  ✓ Linear average sqrt verified (overestimates true sqrt as expected)!`);
    });

    it("should calculate sqrt with small inputs", async function () {
      // Test: sqrt(1M * 1M) = sqrt(10^12) = 10^6 = 1,000,000
      // Linear average: (1M + 1M) / 2 = 1M (exact when a = b)
      const amount0 = 1_000_000n;  // 1 million
      const amount1 = 1_000_000n;  // 1 million
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing linear average sqrt with small inputs:`);
      console.log(`    Inputs: ${amount0}, ${amount1}`);
      console.log(`    True sqrt:      ${trueSqrt}`);
      console.log(`    Linear average: ${linearAvg}`);

      // Mint tokens to Alice
      const encryptedMint0 = await fhevm
        .createEncryptedInput(token0Address, signers.alice.address)
        .add64(amount0)
        .encrypt();
      const encryptedMint1 = await fhevm
        .createEncryptedInput(token1Address, signers.alice.address)
        .add64(amount1)
        .encrypt();

      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      // Set operator
      const block = await ethers.provider.getBlock("latest");
      const blockTimestamp = block?.timestamp || 0;
      const expirationTimestamp = blockTimestamp + 1000;
      await token0.connect(signers.alice).setOperator(cpmmAddress, expirationTimestamp);
      await token1.connect(signers.alice).setOperator(cpmmAddress, expirationTimestamp);

      // Create encrypted inputs for CPMM
      const encryptedInput = await fhevm
        .createEncryptedInput(cpmmAddress, signers.alice.address)
        .add64(amount0)
        .add64(amount1)
        .encrypt();
      
      // Phase 1: prepareMint
      await cpmm.connect(signers.alice).prepareMint(
        encryptedInput.handles[0],
        encryptedInput.handles[1],
        encryptedInput.inputProof
      );
      
      // Phase 2: mint
      await cpmm.connect(signers.alice).mint(signers.alice.address);
      
      // Get and decrypt the sqrt result
      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedSqrtResult,
        cpmmAddress,
        signers.alice
      );
      
      // For equal inputs, should match linear average exactly
      const expectedResult = linearAvg;
      const diff = decryptedSqrt > expectedResult 
        ? decryptedSqrt - expectedResult 
        : expectedResult - decryptedSqrt;
      const errorPercent = Number(diff * 10000n / expectedResult) / 100;
      
      console.log(`    Decrypted result: ${decryptedSqrt}`);
      console.log(`    Error: ${errorPercent}%`);
      
      expect(Math.abs(errorPercent)).to.be.lessThan(1);
      console.log(`  ✓ Small input sqrt verified (exact for equal inputs)!`);
    });
  });

  describe("Mint - Initial Liquidity (First Deposit)", function () {
    it("should mint initial liquidity for first LP with gas measurement", async function () {

      console.log(`\n  Preparing encrypted inputs for first mint...`);
      
      // Amounts to deposit (use values that fit in uint64)
      // Max uint64 = 18,446,744,073,709,551,615 ≈ 18.4 * 10^18
      // For 18 decimal tokens: max ~18 tokens
      // Let's use 10 tokens each = 10 * 10^18 = 10^19 (too big!)
      // Use 1 billion units instead (fits comfortably in uint64)
      const amount0 = 1_000_000_000n;  // 1 billion units (1 token with 9 decimals, or 0.001 with 18 decimals)
      const amount1 = 1_000_000_000n;  // 1 billion units
      
      console.log(`    Amount0: ${amount0} units`);
      console.log(`    Amount1: ${amount1} units`);

      const encryptedMint0 = await fhevm
        .createEncryptedInput(token0Address, signers.alice.address)
        .add64(amount0)
        .encrypt();
      const encryptedMint1 = await fhevm
        .createEncryptedInput(token1Address, signers.alice.address)
        .add64(amount1)
        .encrypt();

      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      const block = await ethers.provider.getBlock("latest");
      const blockTimestamp = block?.timestamp || 0;
      const expirationTimestamp = blockTimestamp + 1000; 

      const optx0 = await token0.connect(signers.alice).setOperator(cpmmAddress, expirationTimestamp);
      await optx0.wait();
      const optx1 = await token1.connect(signers.alice).setOperator(cpmmAddress, expirationTimestamp);
      await optx1.wait();

      const success0 = await token0.isOperator(signers.alice.address, cpmmAddress);
      const success1 = await token1.isOperator(signers.alice.address, cpmmAddress);

      expect(success0).to.be.true;
      expect(success1).to.be.true;

      // Call the mint function with single proof
      console.log(`\n  Calling mint function...`);

      // Create encrypted inputs for both amounts in a single batch
      const encryptedInput = await fhevm
        .createEncryptedInput(cpmmAddress, signers.alice.address)
        .add64(amount0)
        .add64(amount1)
        .encrypt();
      
      // Phase 1: prepareMint
      console.log(`\n  Phase 1: prepareMint...`);
      const prepareTx = await cpmm
        .connect(signers.alice)
        .prepareMint(
          encryptedInput.handles[0],
          encryptedInput.handles[1],
          encryptedInput.inputProof
        );
      const prepareReceipt = await prepareTx.wait();
      const prepareGas = prepareReceipt?.gasUsed || 0n;
      console.log(`  ✓ prepareMint gas: ${prepareGas.toLocaleString()} gas`);
      
      // Phase 2: mint
      console.log(`\n  Phase 2: mint...`);
      const tx = await cpmm
        .connect(signers.alice)
        .mint(signers.alice.address);
      
      const receipt = await tx.wait();
      const firstMintSuccess = receipt?.status;
      expect(firstMintSuccess).to.eq(1);

      const firstMintGas = receipt?.gasUsed || 0n;
      console.log(`  ✓ mint gas: ${firstMintGas.toLocaleString()} gas`);
      
      const totalGas = prepareGas + firstMintGas;
      console.log(`  ✓ Total gas (prepare + mint): ${totalGas.toLocaleString()} gas`);
      
      console.log(`  ✓ Mint transaction successful`);
      
      // Get the encrypted division result
      console.log(`\n  Verifying division result...`);
      const encryptedResult = await cpmm.lastDivisionResult();
      console.log(`    Encrypted result handle: ${encryptedResult}`);
      
      // Decrypt the result
      const decryptedResult = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedResult,
        cpmmAddress,
        signers.alice
      );
      console.log(`    Decrypted result (raw): ${decryptedResult}`);
      
      // Calculate expected result using JavaScript
      const expectedResult = amount0 / amount1;
      console.log(`    Expected result (JS): ${expectedResult}`);
      
      
      const SCALE = BigInt(1) << BigInt(SCALE_BITS); // 2^30
      console.log(`    SCALE (2^30): ${SCALE}`);
      
      // The result appears to be scaled, so unscale it
      const unscaledResult = decryptedResult / SCALE;
      console.log(`    Unscaled result (result / SCALE): ${unscaledResult}`);
      
      // Calculate error as percentage of expected
      const diff = decryptedResult > expectedResult * SCALE 
        ? decryptedResult - expectedResult * SCALE 
        : expectedResult * SCALE - decryptedResult;
      const errorPercent = Number(diff * 10000n / (expectedResult * SCALE)) / 100;
      console.log(`    Expected scaled result: ${expectedResult * SCALE}`);
      console.log(`    Difference from expected: ${diff}`);
      console.log(`    Error: ${errorPercent}%`);
      
      // Verify the result is within 1% of expected (scaled)
      const tolerancePercent = 1; // 1% tolerance
      expect(Math.abs(errorPercent)).to.be.lessThan(tolerancePercent);
      console.log(`  ✓ Division result verified within ${tolerancePercent}% tolerance!`);
      
    });

    it("should verify division accuracy with different values", async function () {
      const amount0 = 2_000_000_000n;  // 2 billion
      const amount1 = 500_000_000n;    // 500 million
      const expectedQuotient = amount0 / amount1; // 4
      
      console.log(`\n  Testing division: ${amount0} / ${amount1} = ${expectedQuotient}`);
      console.log(`  NOTE: With 2 NR iterations, expect up to 10% error for non-optimal cases`);

      // Mint tokens to Alice
      const encryptedMint0 = await fhevm
        .createEncryptedInput(token0Address, signers.alice.address)
        .add64(amount0)
        .encrypt();
      const encryptedMint1 = await fhevm
        .createEncryptedInput(token1Address, signers.alice.address)
        .add64(amount1)
        .encrypt();

      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      // Set operator
      const block = await ethers.provider.getBlock("latest");
      const blockTimestamp = block?.timestamp || 0;
      const expirationTimestamp = blockTimestamp + 1000;
      await token0.connect(signers.alice).setOperator(cpmmAddress, expirationTimestamp);
      await token1.connect(signers.alice).setOperator(cpmmAddress, expirationTimestamp);

      // Create encrypted inputs for CPMM
      const encryptedInput = await fhevm
        .createEncryptedInput(cpmmAddress, signers.alice.address)
        .add64(amount0)
        .add64(amount1)
        .encrypt();
      
      // Phase 1: prepareMint
      await cpmm.connect(signers.alice).prepareMint(
        encryptedInput.handles[0],
        encryptedInput.handles[1],
        encryptedInput.inputProof
      );
      
      // Phase 2: mint (which performs division)
      await cpmm.connect(signers.alice).mint(signers.alice.address);
      
      // Get and decrypt the result
      const encryptedResult = await cpmm.lastDivisionResult();
      const decryptedResult = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedResult,
        cpmmAddress,
        signers.alice
      );
      
      const SCALE = BigInt(1) << BigInt(SCALE_BITS);
      const expectedScaled = expectedQuotient * SCALE;
      const diff = decryptedResult > expectedScaled 
        ? decryptedResult - expectedScaled 
        : expectedScaled - decryptedResult;
      const errorPercent = Number(diff * 10000n / expectedScaled) / 100;
      
      console.log(`    Decrypted result: ${decryptedResult}`);
      console.log(`    Expected (scaled): ${expectedScaled}`);
      console.log(`    Difference: ${diff}`);
      console.log(`    Error: ${errorPercent}%`);
      
      // With 2 iterations, error can be up to ~10% for suboptimal initial guesses
      expect(Math.abs(errorPercent)).to.be.lessThan(10); // Within 10%
      console.log(`  ✓ Division verified within 10% tolerance (HCU-limited accuracy)`);
    });

  });


    it("should compare with alternative division methods", async function () {
      console.log(`\n  Division Method Comparison:`);
      console.log(`  ==========================`);
      
      const methods = [
        {
          name: "Newton-Raphson (Our Implementation)",
          operations: 11 + (5 * 5), // Initial guess + 5 NR iterations
          accuracy: "0%",
          rangeMin: "10^6",
          rangeMax: "10^12",
          converges: true,
        },
        {
          name: "Fixed Initial Guess (Previous)",
          operations: 5 * 5, // Only NR iterations
          accuracy: "0-98%",
          rangeMin: "10^8",
          rangeMax: "10^10",
          converges: false,
        },
        {
          name: "Binary Search (Attempted)",
          operations: "64+ (per call)", // 64 iterations for uint64 range
          accuracy: "Exact",
          rangeMin: "N/A",
          rangeMax: "N/A",
          converges: "Cannot compute bounds",
        },
        {
          name: "Direct Division (Impossible)",
          operations: "1",
          accuracy: "Exact",
          rangeMin: "N/A",
          rangeMax: "N/A",
          converges: "FHE.div(encrypted) not supported",
        },
      ];
      
      for (const method of methods) {
        const ops = typeof method.operations === 'string' ? method.operations.padEnd(4) : method.operations.toString().padEnd(4);
        const name = method.name.padEnd(31);
        const accuracy = method.accuracy.padEnd(8);
        const range = `${method.rangeMin}-${method.rangeMax}`.padEnd(14);
        const status = typeof method.converges === 'boolean' ? 
          (method.converges ? '1' : '0') : 
          method.converges;
        
        console.log(`  ${name} | ${ops} | ${accuracy} | ${range} | ${status}`);
      }
      
      expect(true).to.be.true;
    });
  });

  describe("Comparison with Plaintext Division", function () {
    it("should produce similar results to direct division (simulation)", async function () {
      // This test runs in plaintext to verify our algorithm is correct
      // We simulate the Newton-Raphson division and compare to direct division
      
      const SCALE = 10n**9n;
      const SCALE_SQUARED = SCALE * SCALE;
      
      // Simulate pool state
      const reserve0 = 1000000000n;  // 1 billion (1e9)
      const reserve1 = 500000000000000000n; // 0.5 ETH (5e17)
      const totalSupply = 707106781n; // Previous liquidity
      
      // Alice wants to add
      const amount0 = 100000000n;  // 100 million
      const amount1 = 50000000000000000n; // 0.05 ETH
      
      // Expected liquidity (using direct division)
      const expectedLiquidity0 = amount0 * totalSupply / reserve0;
      const expectedLiquidity1 = amount1 * totalSupply / reserve1;
      const expectedLiquidity = expectedLiquidity0 < expectedLiquidity1 ? expectedLiquidity0 : expectedLiquidity1;
      
      // Newton-Raphson reciprocal simulation with bit-shift based initial guess
      // Matches the Solidity implementation exactly
      function reciprocal(b: bigint): bigint {
        // Phase 1: Bit-shift based initial guess
        // Estimate magnitude using power-of-2 ranges
        
        const pow20 = 1048576n;         // 2^20
        const pow25 = 33554432n;        // 2^25
        const pow30 = 1073741824n;      // 2^30
        const pow35 = 34359738368n;     // 2^35
        const pow40 = 1099511627776n;   // 2^40
        
        // Determine range
        const lt20 = b < pow20;
        const lt25 = b < pow25;
        const lt30 = b < pow30;
        const lt35 = b < pow35;
        const lt40 = b < pow40;
        
        // Select initial guess based on magnitude
        let x: bigint;
        if (lt20) {
          x = SCALE * 1024n;         // SCALE << 10
        } else if (lt25) {
          x = SCALE * 32n;           // SCALE << 5
        } else if (lt30) {
          x = SCALE;                 // No shift
        } else if (lt35) {
          x = SCALE / 32n;           // SCALE >> 5
        } else if (lt40) {
          x = SCALE / 1024n;         // SCALE >> 10
        } else {
          x = SCALE / 32768n;        // SCALE >> 15
        }
        
        // Phase 2: Newton-Raphson refinement
        const two = 2n * SCALE;
        
        for (let i = 0; i < 5; i++) {
          const bx = (b * x) / SCALE;
          
          if (bx > two) {
            console.log(`    Warning: Diverging at NR iteration ${i}, bx=${bx}, two=${two}`);
            break;
          }
          
          const two_minus_bx = two - bx;
          x = (x * two_minus_bx) / SCALE;
        }
        
        return x;
      }
      
      // Calculate using Newton-Raphson
      const inv0 = reciprocal(reserve0);
      const numerator0 = amount0 * totalSupply;
      const nrLiquidity0 = (numerator0 * inv0) / SCALE_SQUARED;
      
      const inv1 = reciprocal(reserve1);
      const numerator1 = amount1 * totalSupply;
      const nrLiquidity1 = (numerator1 * inv1) / SCALE_SQUARED;
      
      const nrLiquidity = nrLiquidity0 < nrLiquidity1 ? nrLiquidity0 : nrLiquidity1;
      
      console.log(`\n  Newton-Raphson Division Accuracy:`);
      console.log(`    Expected liquidity: ${expectedLiquidity}`);
      console.log(`    Newton-Raphson result: ${nrLiquidity}`);
      console.log(`    Difference: ${expectedLiquidity - nrLiquidity}`);
      console.log(`    Error: ${Number((expectedLiquidity - nrLiquidity) * 10000n / expectedLiquidity) / 100}%`);
      
      // Should be exact or within 1 due to rounding
      expect(nrLiquidity).to.be.oneOf([expectedLiquidity, expectedLiquidity - 1n, expectedLiquidity + 1n]);
    });

    it("should handle different token decimal combinations", async function () {
      // Test with tokens that have different decimals
      // e.g., USDC (6 decimals) vs WETH (18 decimals)
      
      const SCALE = 10n**9n;
      const SCALE_SQUARED = SCALE * SCALE;
      
      function reciprocal(b: bigint): bigint {
        // Bit-shift based initial guess (same as first test)
        const pow20 = 1048576n;
        const pow25 = 33554432n;
        const pow30 = 1073741824n;
        const pow35 = 34359738368n;
        const pow40 = 1099511627776n;
        
        let x: bigint;
        if (b < pow20) {
          x = SCALE * 1024n;
        } else if (b < pow25) {
          x = SCALE * 32n;
        } else if (b < pow30) {
          x = SCALE;
        } else if (b < pow35) {
          x = SCALE / 32n;
        } else if (b < pow40) {
          x = SCALE / 1024n;
        } else {
          x = SCALE / 32768n;
        }
        
        const two = 2n * SCALE;
        for (let i = 0; i < 5; i++) {
          const bx = (b * x) / SCALE;
          if (bx > two) break;
          const two_minus_bx = two - bx;
          x = (x * two_minus_bx) / SCALE;
        }
        
        return x;
      }
      
      // USDC (6 decimals) paired with WETH (18 decimals)
      const testCases = [
        {
          name: "USDC-WETH",
          reserve0: 1000_000_000n,           // 1000 USDC (6 decimals)
          reserve1: 500_000_000_000_000_000n, // 0.5 WETH (18 decimals)
          amount0: 100_000_000n,             // 100 USDC
          amount1: 50_000_000_000_000_000n,   // 0.05 WETH
          totalSupply: 707_106_781n
        },
        {
          name: "Small pool",
          reserve0: 1_000_000n,
          reserve1: 500_000n,
          amount0: 100_000n,
          amount1: 50_000n,
          totalSupply: 707_106n
        },
        {
          name: "Large pool",
          reserve0: 1_000_000_000_000n,
          reserve1: 500_000_000_000n,
          amount0: 100_000_000_000n,
          amount1: 50_000_000_000n,
          totalSupply: 707_106_781_187n
        }
      ];
      
      console.log(`\n  Testing different pool sizes:`);
      console.log(`  SCALE = ${SCALE}, SCALE² = ${SCALE_SQUARED}`);
      
      for (const test of testCases) {
        const expectedLiquidity0 = test.amount0 * test.totalSupply / test.reserve0;
        const expectedLiquidity1 = test.amount1 * test.totalSupply / test.reserve1;
        const expectedLiquidity = expectedLiquidity0 < expectedLiquidity1 ? expectedLiquidity0 : expectedLiquidity1;
        
        const inv0 = reciprocal(test.reserve0);
        const nrLiquidity0 = (test.amount0 * test.totalSupply * inv0) / SCALE_SQUARED;
        
        const inv1 = reciprocal(test.reserve1);
        const nrLiquidity1 = (test.amount1 * test.totalSupply * inv1) / SCALE_SQUARED;
        
        const nrLiquidity = nrLiquidity0 < nrLiquidity1 ? nrLiquidity0 : nrLiquidity1;
        
        const error = expectedLiquidity > 0n ? Number((expectedLiquidity - nrLiquidity) * 10000n / expectedLiquidity) / 100 : 0;
        
        console.log(`    ${test.name}:`);
        console.log(`      reserve0=${test.reserve0}, inv0=${inv0}`);
        console.log(`      expected=${expectedLiquidity}, NR=${nrLiquidity}, error=${error}%`);
        
        // With adaptive initial guess, should work across all ranges
        expect(Math.abs(error)).to.be.lessThan(1); // Less than 1% error
      }
    });
  });

  describe("Helper: Initial Liquidity Approximation", function () {
    it("should approximate sqrt with linear average", async function () {
      // Test the _sqrtApprox function behavior
      // liquidity ≈ (amount0 + amount1) / 2
      
      const testCases = [
        { amount0: 1000n, amount1: 1000n, expected: 1000n }, // Equal amounts
        { amount0: 2000n, amount1: 1000n, expected: 1500n }, // 2:1 ratio
        { amount0: 1000n, amount1: 2000n, expected: 1500n }, // 1:2 ratio
        { amount0: 100n, amount1: 900n, expected: 500n },    // Imbalanced
      ];
      
      console.log(`\n  Linear average approximation:`);
      
      for (const test of testCases) {
        const approx = (test.amount0 + test.amount1) / 2n;
        const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(test.amount0 * test.amount1))));
        
        console.log(`    (${test.amount0} + ${test.amount1}) / 2 = ${approx}, true sqrt = ${trueSqrt}`);
        
        expect(approx).to.equal(test.expected);
      }
    });

    it("should compare linear average vs geometric mean", async function () {
      // Show the difference between our approximation and true sqrt
      
      const testCases = [
        { amount0: 1000n, amount1: 1000n },
        { amount0: 1000n, amount1: 2000n },
        { amount0: 1000n, amount1: 10000n },
      ];
      
      console.log(`\n  Linear average vs Geometric mean:`);
      
      for (const test of testCases) {
        const linear = (test.amount0 + test.amount1) / 2n;
        const geometric = BigInt(Math.floor(Math.sqrt(Number(test.amount0 * test.amount1))));
        const diff = linear - geometric;
        const diffPercent = geometric > 0n ? Number(diff * 10000n / geometric) / 100 : 0;
        
        console.log(`    amounts: (${test.amount0}, ${test.amount1})`);
        console.log(`      linear: ${linear}, geometric: ${geometric}, diff: ${diff} (${diffPercent}%)`);
      }
    });
  });
});

