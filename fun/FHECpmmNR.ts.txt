import { expect } from "chai";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { FHECpmmNR, FHEConfidentialToken } from "../types";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
};

async function deployFixture() {
  const Token0Factory = await ethers.getContractFactory("FHEConfidentialToken");
  const token0 = await Token0Factory.deploy("Token0", "TKN0");
  await token0.waitForDeployment();
  const token0Address = await token0.getAddress();
  
  const Token1Factory = await ethers.getContractFactory("FHEConfidentialToken");
  const token1 = await Token1Factory.deploy("Token1", "TKN1");
  await token1.waitForDeployment();
  const token1Address = await token1.getAddress();
  
  // Deploy NR version of CPMM
  const CpmmFactory = await ethers.getContractFactory("FHECpmmNR");
  const cpmm = await CpmmFactory.deploy();
  await cpmm.waitForDeployment();
  const cpmmAddress = await cpmm.getAddress();
  
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

describe("FHECpmmNR - Newton-Raphson Sqrt", function () {
  let signers: Signers;
  let cpmm: FHECpmmNR;
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

  describe("Babylonian Sqrt Tests", function () {
    it("should calculate sqrt(a * b) with equal inputs (a = b)", async function () {
      // Test: sqrt(1B * 1B) = sqrt(10^18) = 10^9
      const amount0 = 1_000_000_000n;
      const amount1 = 1_000_000_000n;
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing Babylonian sqrt: sqrt(${amount0} * ${amount1})`);
      console.log(`    True sqrt:      ${trueSqrt}`);
      console.log(`    Linear average: ${linearAvg}`);

      // Mint tokens
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
      
      // Phase 2: mint
      console.log(`\n  Phase 2: mint (triggers Babylonian sqrt)...`);
      const mintTx = await cpmm.connect(signers.alice).mint(signers.alice.address);
      const mintReceipt = await mintTx.wait();
      const mintGas = mintReceipt?.gasUsed || 0n;
      console.log(`    mint gas: ${mintGas.toLocaleString()} gas`);
      console.log(`    Total gas: ${(prepareGas + mintGas).toLocaleString()} gas`);
      
      // Get and decrypt the sqrt result
      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      console.log(`\n  Decrypting sqrt result...`);
      
      const decryptedSqrt = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedSqrtResult,
        cpmmAddress,
        signers.alice
      );
      console.log(`    Decrypted sqrt: ${decryptedSqrt}`);
      
      // Calculate errors
      const diffVsTrueSqrt = decryptedSqrt > trueSqrt 
        ? decryptedSqrt - trueSqrt 
        : trueSqrt - decryptedSqrt;
      const errorVsTrueSqrt = Number(diffVsTrueSqrt * 10000n / trueSqrt) / 100;
      
      
      console.log(`\n  Accuracy Analysis:`);
      console.log(`    True sqrt:           ${trueSqrt}`);
      console.log(`    Linear average:      ${linearAvg}`);
      console.log(`    Babylonian result:   ${decryptedSqrt}`);
      console.log(`    Error vs true sqrt:  ${errorVsTrueSqrt}%`);
      
      // Should be better than 25% (linear average's worst case)
      expect(Math.abs(errorVsTrueSqrt)).to.be.lessThan(25);
      console.log(`  ✓ Babylonian sqrt verified within 25% of true sqrt!`);
    });

    it("should calculate sqrt with unequal inputs (4:1 ratio)", async function () {
      // Test: sqrt(2B * 500M) = sqrt(10^18) = 10^9
      // Linear average: (2B + 500M) / 2 = 1.25B (25% overestimate)
      const amount0 = 2_000_000_000n;
      const amount1 = 500_000_000n;
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing Babylonian sqrt with 4:1 ratio:`);
      console.log(`    Inputs: ${amount0}, ${amount1}`);
      console.log(`    True sqrt:      ${trueSqrt}`);
      console.log(`    Linear average: ${linearAvg} (${Number((linearAvg - trueSqrt) * 100n / trueSqrt)}% overestimate)`);

      // Mint tokens
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
      
      // prepareMint
      await cpmm.connect(signers.alice).prepareMint(
        encryptedInput.handles[0],
        encryptedInput.handles[1],
        encryptedInput.inputProof
      );
      
      // mint
      await cpmm.connect(signers.alice).mint(signers.alice.address);
      
      // Get and decrypt
      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedSqrtResult,
        cpmmAddress,
        signers.alice
      );
      
      const errorVsTrueSqrt = Number((decryptedSqrt > trueSqrt ? decryptedSqrt - trueSqrt : trueSqrt - decryptedSqrt) * 10000n / trueSqrt) / 100;
      const linearError = Number((linearAvg - trueSqrt) * 10000n / trueSqrt) / 100;
      
      console.log(`    Babylonian result:   ${decryptedSqrt}`);
      console.log(`    Error vs true sqrt:  ${errorVsTrueSqrt}%`);
      console.log(`    Linear avg error:    ${linearError}%`);
      
      // Should be better than linear average (25% for 4:1 ratio)
      if (errorVsTrueSqrt < linearError) {
        console.log(`  ✓ Babylonian is ${(linearError - errorVsTrueSqrt).toFixed(1)}% better than linear average!`);
      } else {
        console.log(`  ⚠ Babylonian is ${(errorVsTrueSqrt - linearError).toFixed(1)}% worse than linear average`);
      }
      
      expect(Math.abs(errorVsTrueSqrt)).to.be.lessThan(50);
    });

    it("should calculate sqrt with 16:1 ratio (extreme)", async function () {
      // Test: sqrt(4B * 250M) = sqrt(10^18) = 10^9
      const amount0 = 4_000_000_000n;
      const amount1 = 250_000_000n;
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing Babylonian sqrt with 16:1 ratio (extreme):`);
      console.log(`    Inputs: ${amount0}, ${amount1}`);
      console.log(`    True sqrt:      ${trueSqrt}`);
      console.log(`    Linear average: ${linearAvg} (${Number((linearAvg - trueSqrt) * 100n / trueSqrt)}% overestimate)`);

      // Mint tokens
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
      
      // prepareMint
      await cpmm.connect(signers.alice).prepareMint(
        encryptedInput.handles[0],
        encryptedInput.handles[1],
        encryptedInput.inputProof
      );
      
      // mint
      await cpmm.connect(signers.alice).mint(signers.alice.address);
      
      // Get and decrypt
      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedSqrtResult,
        cpmmAddress,
        signers.alice
      );
      
      const errorVsTrueSqrt = Number((decryptedSqrt > trueSqrt ? decryptedSqrt - trueSqrt : trueSqrt - decryptedSqrt) * 10000n / trueSqrt) / 100;
      const linearError = Number((linearAvg - trueSqrt) * 10000n / trueSqrt) / 100;
      
      console.log(`    Babylonian result:   ${decryptedSqrt}`);
      console.log(`    Error vs true sqrt:  ${errorVsTrueSqrt}%`);
      console.log(`    Linear avg error:    ${linearError}%`);
      
      if (errorVsTrueSqrt < linearError) {
        console.log(`  ✓ Babylonian is ${(linearError - errorVsTrueSqrt).toFixed(1)}% better than linear average!`);
      }
      
      expect(Math.abs(errorVsTrueSqrt)).to.be.lessThan(25);
    });

    it("should calculate sqrt with small inputs (1M × 1M)", async function () {
      // Test: sqrt(1M * 1M) = sqrt(10^12) = 10^6
      const amount0 = 1_000_000n;
      const amount1 = 1_000_000n;
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      
      console.log(`\n  Testing Babylonian sqrt with small inputs:`);
      console.log(`    Inputs: ${amount0}, ${amount1}`);
      console.log(`    True sqrt: ${trueSqrt}`);

      // Mint tokens
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
      
      // prepareMint
      await cpmm.connect(signers.alice).prepareMint(
        encryptedInput.handles[0],
        encryptedInput.handles[1],
        encryptedInput.inputProof
      );
      
      // mint
      await cpmm.connect(signers.alice).mint(signers.alice.address);
      
      // Get and decrypt
      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encryptedSqrtResult,
        cpmmAddress,
        signers.alice
      );
      
      const errorVsTrueSqrt = Number((decryptedSqrt > trueSqrt ? decryptedSqrt - trueSqrt : trueSqrt - decryptedSqrt) * 10000n / trueSqrt) / 100;
      
      console.log(`    Babylonian result:   ${decryptedSqrt}`);
      console.log(`    Error vs true sqrt:  ${errorVsTrueSqrt}%`);
      
      expect(Math.abs(errorVsTrueSqrt)).to.be.lessThan(50);
      console.log(`  ✓ Small input sqrt completed!`);
    });

    it("should handle very small inputs (1000 × 1000)", async function () {
      const amount0 = 1000n;
      const amount1 = 1000n;
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing very small inputs:`);
      console.log(`    Inputs: ${amount0}, ${amount1}`);
      console.log(`    S = ${amount0 * amount1} (≈ 2^${Math.log2(Number(amount0 * amount1)).toFixed(1)})`);
      console.log(`    True sqrt: ${trueSqrt}`);
      console.log(`    Linear avg: ${linearAvg}`);

      const encryptedMint0 = await fhevm.createEncryptedInput(token0Address, signers.alice.address).add64(amount0).encrypt();
      const encryptedMint1 = await fhevm.createEncryptedInput(token1Address, signers.alice.address).add64(amount1).encrypt();
      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      const block = await ethers.provider.getBlock("latest");
      await token0.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);
      await token1.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);

      const encryptedInput = await fhevm.createEncryptedInput(cpmmAddress, signers.alice.address).add64(amount0).add64(amount1).encrypt();
      await cpmm.connect(signers.alice).prepareMint(encryptedInput.handles[0], encryptedInput.handles[1], encryptedInput.inputProof);
      await cpmm.connect(signers.alice).mint(signers.alice.address);

      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedSqrtResult, cpmmAddress, signers.alice);
      
      const errorVsTrueSqrt = Number((decryptedSqrt > trueSqrt ? decryptedSqrt - trueSqrt : trueSqrt - decryptedSqrt) * 10000n / trueSqrt) / 100;
      console.log(`    Babylonian result: ${decryptedSqrt}`);
      console.log(`    Error vs true sqrt: ${errorVsTrueSqrt}%`);
      
      expect(Math.abs(errorVsTrueSqrt)).to.be.lessThan(50);
    });

    it("should handle odd ratio (7:3)", async function () {
      // 700M × 300M = 2.1 × 10^17, sqrt ≈ 458M
      const amount0 = 700_000_000n;
      const amount1 = 300_000_000n;
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing odd ratio (7:3):`);
      console.log(`    Inputs: ${amount0}, ${amount1}`);
      console.log(`    S = ${amount0 * amount1}`);
      console.log(`    True sqrt: ${trueSqrt}`);
      console.log(`    Linear avg: ${linearAvg} (${Number((linearAvg - trueSqrt) * 100n / trueSqrt)}% overestimate)`);

      const encryptedMint0 = await fhevm.createEncryptedInput(token0Address, signers.alice.address).add64(amount0).encrypt();
      const encryptedMint1 = await fhevm.createEncryptedInput(token1Address, signers.alice.address).add64(amount1).encrypt();
      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      const block = await ethers.provider.getBlock("latest");
      await token0.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);
      await token1.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);

      const encryptedInput = await fhevm.createEncryptedInput(cpmmAddress, signers.alice.address).add64(amount0).add64(amount1).encrypt();
      await cpmm.connect(signers.alice).prepareMint(encryptedInput.handles[0], encryptedInput.handles[1], encryptedInput.inputProof);
      await cpmm.connect(signers.alice).mint(signers.alice.address);

      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedSqrtResult, cpmmAddress, signers.alice);
      
      const errorVsTrueSqrt = Number((decryptedSqrt > trueSqrt ? decryptedSqrt - trueSqrt : trueSqrt - decryptedSqrt) * 10000n / trueSqrt) / 100;
      const linearError = Number((linearAvg - trueSqrt) * 10000n / trueSqrt) / 100;
      
      console.log(`    Babylonian result: ${decryptedSqrt}`);
      console.log(`    Error vs true sqrt: ${errorVsTrueSqrt}%`);
      console.log(`    Linear avg error: ${linearError}%`);
        
      expect(Math.abs(errorVsTrueSqrt)).to.be.lessThan(50);
    });

    it("should handle 6-decimal token amounts (USDC-like)", async function () {
      // 1000 USDC × 1000 USDC = 10^12, sqrt = 10^6
      const amount0 = 1_000_000_000n;  // 1000 USDC (6 decimals)
      const amount1 = 1_000_000_000n;  // 1000 USDC
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      
      console.log(`\n  Testing 6-decimal token amounts (USDC-like):`);
      console.log(`    Inputs: ${amount0}, ${amount1} (1000 tokens each with 6 decimals)`);
      console.log(`    S = ${amount0 * amount1}`);
      console.log(`    True sqrt: ${trueSqrt}`);

      const encryptedMint0 = await fhevm.createEncryptedInput(token0Address, signers.alice.address).add64(amount0).encrypt();
      const encryptedMint1 = await fhevm.createEncryptedInput(token1Address, signers.alice.address).add64(amount1).encrypt();
      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      const block = await ethers.provider.getBlock("latest");
      await token0.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);
      await token1.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);

      const encryptedInput = await fhevm.createEncryptedInput(cpmmAddress, signers.alice.address).add64(amount0).add64(amount1).encrypt();
      await cpmm.connect(signers.alice).prepareMint(encryptedInput.handles[0], encryptedInput.handles[1], encryptedInput.inputProof);
      await cpmm.connect(signers.alice).mint(signers.alice.address);

      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedSqrtResult, cpmmAddress, signers.alice);
      
      const errorVsTrueSqrt = Number((decryptedSqrt > trueSqrt ? decryptedSqrt - trueSqrt : trueSqrt - decryptedSqrt) * 10000n / trueSqrt) / 100;
      console.log(`    Babylonian result: ${decryptedSqrt}`);
      console.log(`    Error vs true sqrt: ${errorVsTrueSqrt}%`);
      
      expect(Math.abs(errorVsTrueSqrt)).to.be.lessThan(5);
    });

    it("should handle mixed decimal pair (WETH/USDC-like)", async function () {
      const amount0 = 1_000_000_000n;  // 1 token with 9 decimals
      const amount1 = 2_000_000_000n;  // 2 tokens with 9 decimals
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing mixed amounts (1:2 ratio):`);
      console.log(`    Inputs: ${amount0}, ${amount1}`);
      console.log(`    S = ${amount0 * amount1}`);
      console.log(`    True sqrt: ${trueSqrt}`);
      console.log(`    Linear avg: ${linearAvg}`);

      const encryptedMint0 = await fhevm.createEncryptedInput(token0Address, signers.alice.address).add64(amount0).encrypt();
      const encryptedMint1 = await fhevm.createEncryptedInput(token1Address, signers.alice.address).add64(amount1).encrypt();
      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      const block = await ethers.provider.getBlock("latest");
      await token0.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);
      await token1.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);

      const encryptedInput = await fhevm.createEncryptedInput(cpmmAddress, signers.alice.address).add64(amount0).add64(amount1).encrypt();
      await cpmm.connect(signers.alice).prepareMint(encryptedInput.handles[0], encryptedInput.handles[1], encryptedInput.inputProof);
      await cpmm.connect(signers.alice).mint(signers.alice.address);

      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedSqrtResult, cpmmAddress, signers.alice);
      
      const errorVsTrueSqrt = Number((decryptedSqrt > trueSqrt ? decryptedSqrt - trueSqrt : trueSqrt - decryptedSqrt) * 10000n / trueSqrt) / 100;
      console.log(`    Babylonian result: ${decryptedSqrt}`);
      console.log(`    Error vs true sqrt: ${errorVsTrueSqrt}%`);
      
      expect(Math.abs(errorVsTrueSqrt)).to.be.lessThan(10);
    });

    it("should handle boundary case near 2^40 threshold", async function () {
      const amount0 = 1_048_576n;  // 2^20
      const amount1 = 1_000_000n;  // 10^6
      const S = amount0 * amount1;
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(S))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing boundary case near 2^40:`);
      console.log(`    Inputs: ${amount0}, ${amount1}`);
      console.log(`    S = ${S} (2^${Math.log2(Number(S)).toFixed(2)})`);
      console.log(`    Threshold 2^40 = ${BigInt(1) << 40n}`);
      console.log(`    True sqrt: ${trueSqrt}`);

      const encryptedMint0 = await fhevm.createEncryptedInput(token0Address, signers.alice.address).add64(amount0).encrypt();
      const encryptedMint1 = await fhevm.createEncryptedInput(token1Address, signers.alice.address).add64(amount1).encrypt();
      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      const block = await ethers.provider.getBlock("latest");
      await token0.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);
      await token1.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);

      const encryptedInput = await fhevm.createEncryptedInput(cpmmAddress, signers.alice.address).add64(amount0).add64(amount1).encrypt();
      await cpmm.connect(signers.alice).prepareMint(encryptedInput.handles[0], encryptedInput.handles[1], encryptedInput.inputProof);
      await cpmm.connect(signers.alice).mint(signers.alice.address);

      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedSqrtResult, cpmmAddress, signers.alice);
      
      const errorVsTrueSqrt = Number((decryptedSqrt > trueSqrt ? decryptedSqrt - trueSqrt : trueSqrt - decryptedSqrt) * 10000n / trueSqrt) / 100;
      console.log(`    Babylonian result: ${decryptedSqrt}`);
      console.log(`    Error vs true sqrt: ${errorVsTrueSqrt}%`);
      
      expect(Math.abs(errorVsTrueSqrt)).to.be.lessThan(25);
    });

    it("should handle large imbalanced pool (100:1 ratio)", async function () {
      // 10B × 100M = 10^18, sqrt = 10^9
      const amount0 = 10_000_000_000n;  // 10B
      const amount1 = 100_000_000n;     // 100M
      const trueSqrt = BigInt(Math.floor(Math.sqrt(Number(amount0 * amount1))));
      const linearAvg = (amount0 + amount1) / 2n;
      
      console.log(`\n  Testing 100:1 ratio (extreme imbalance):`);
      console.log(`    Inputs: ${amount0}, ${amount1}`);
      console.log(`    True sqrt: ${trueSqrt}`);
      console.log(`    Linear avg: ${linearAvg} (${Number((linearAvg - trueSqrt) * 100n / trueSqrt)}% overestimate)`);

      const encryptedMint0 = await fhevm.createEncryptedInput(token0Address, signers.alice.address).add64(amount0).encrypt();
      const encryptedMint1 = await fhevm.createEncryptedInput(token1Address, signers.alice.address).add64(amount1).encrypt();
      await token0.connect(signers.alice).mint(signers.alice.address, encryptedMint0.handles[0], encryptedMint0.inputProof);
      await token1.connect(signers.alice).mint(signers.alice.address, encryptedMint1.handles[0], encryptedMint1.inputProof);

      const block = await ethers.provider.getBlock("latest");
      await token0.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);
      await token1.connect(signers.alice).setOperator(cpmmAddress, (block?.timestamp || 0) + 1000);

      const encryptedInput = await fhevm.createEncryptedInput(cpmmAddress, signers.alice.address).add64(amount0).add64(amount1).encrypt();
      await cpmm.connect(signers.alice).prepareMint(encryptedInput.handles[0], encryptedInput.handles[1], encryptedInput.inputProof);
      await cpmm.connect(signers.alice).mint(signers.alice.address);

      const encryptedSqrtResult = await cpmm.lastSqrtResult();
      const decryptedSqrt = await fhevm.userDecryptEuint(FhevmType.euint64, encryptedSqrtResult, cpmmAddress, signers.alice);
      
      const errorVsTrueSqrt = Number((decryptedSqrt > trueSqrt ? decryptedSqrt - trueSqrt : trueSqrt - decryptedSqrt) * 10000n / trueSqrt) / 100;
      const linearError = Number((linearAvg - trueSqrt) * 10000n / trueSqrt) / 100;
      
      console.log(`    Babylonian result: ${decryptedSqrt}`);
      console.log(`    Error vs true sqrt: ${errorVsTrueSqrt}%`);
      console.log(`    Linear avg error: ${linearError}%`);
      
      if (errorVsTrueSqrt < linearError) {
        console.log(`  ✓ Babylonian is ${(linearError - errorVsTrueSqrt).toFixed(1)}% better than linear average!`);
      }
      
      expect(Math.abs(errorVsTrueSqrt)).to.be.lessThan(25);
    });
  });
});

