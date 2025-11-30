# FHE Batch CPMM

A privacy-preserving Constant Product Market Maker (CPMM) built on [Zama's FHEVM](https://docs.zama.org/protocol/solidity-guides/getting-started/overview). This implementation uses Fully Homomorphic Encryption to keep reserves, balances, and swap directions encrypted while still enforcing the constant product invariant.

## Deployed on Sepolia

| Contract | Address |
|----------|---------|
| FHEBatchCpmmFactory | [`0x1db2B5E5d098b75A13450773D7a2b4A7b6b404a5`](https://sepolia.etherscan.io/address/0x1db2B5E5d098b75A13450773D7a2b4A7b6b404a5) |
| FHEBatchCpmm (Pair) | [`0x98d71023D0200bBf4B684970275D67F37cf27618`](https://sepolia.etherscan.io/address/0x98d71023D0200bBf4B684970275D67F37cf27618) |

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
  - [FHEBatchCpmm.sol](#fhebatchcpmmsol)
  - [FHEVerification.sol](#fheverificationsol)
- [Batch Mechanics](#batch-mechanics)
  - [Batch Size and Privacy Tradeoffs](#batch-size-and-privacy-tradeoffs)
  - [Batch States](#batch-states)
  - [Queue Locking](#queue-locking)
  - [Public Reserve Revelation](#public-reserve-revelation)
- [User Operations](#user-operations)
  - [Enqueueing Operations](#enqueueing-operations)
  - [Computing Inputs](#computing-inputs)
  - [Slippage Impact](#slippage-impact)
  - [Lifecycle Example](#lifecycle-example)
- [Design Decisions](#design-decisions)
  - [Why Batch Processing?](#why-batch-processing)
  - [Why User-Provided Claims?](#why-user-provided-claims)
  - [Why Encrypted Swap Direction?](#why-encrypted-swap-direction)
  - [Why Encrypted Revocation?](#why-encrypted-revocation)
  - [Why Linear Average for Initial Liquidity?](#why-linear-average-for-initial-liquidity)
- [Known Limitations](#known-limitations)
  - [Single Operation Information Leakage](#single-operation-information-leakage)
  - [Transaction Latency](#transaction-latency)
  - [Reserve Size Limits](#reserve-size-limits)
  - [HCU Constraints](#hcu-constraints)
  - [Slippage Risk](#slippage-risk)
- [Potential Improvements](#potential-improvements)
- [Test Coverage](#test-coverage)
- [Credits](#credits)

## Overview

Traditional AMMs expose all trading activity on-chain: reserves, swap amounts, and directions are publicly visible. This creates opportunities for MEV extraction through sandwich attacks and front-running. Regardless of MEV risk, this is severly detrimental to users who value privacy. All position sizes, trading patterns, and token balances are known to anyone who cares to look.

This implementation addresses these issues by:

- Processing transactions in batches
- Keeping reserves encrypted during batch processing
- Encrypting swap direction (which token is being sold)
- Revealing only aggregate reserve and totalSupply changes after batch completion
- Uses the OpenZeppelin ERC7984 implementation for confidential transfers and balances

## Quick Start

### Prerequisites

- Node.js v20+
- npm

### Installation

```bash
npm install
```

### Compile

```bash
npm run compile
```

### Test

```bash
# Run all tests
npm run test

# Run specific test file
npx hardhat test test/FHEBatchCpmm.ts
npx hardhat test test/FHEBatchCpmmStress.ts
```

## Architecture

```
contracts/
├── FHEBatchCpmm.sol           # Main CPMM contract
├── libraries/
│   └── FHEVerification.sol    # Verification library
├── token/
│   ├── ERC7984.sol            # OpenZeppelin ERC7984 confidential token base
│   └── FHEConfidentialToken.sol  # Test token implementation
└── interfaces/
    └── IERC7984.sol           # Confidential token interface
```

### [FHEBatchCpmm.sol](contracts/FHEBatchCpmm.sol)

The core CPMM contract implementing a Uniswap V2-style constant product market maker with encrypted state. Operations queue into batches and are processed one at a time to stay within HCU limits. Reserves (`_reserve0`, `_reserve1`) and `totalSupply` remain encrypted during processing and are only revealed after batch completion. The contract supports three operation types: mint, burn, and swap. Swap direction is encrypted via `euint8`, and users can revoke queued operations without revealing which operation was cancelled.

**Functions:**

| Function | Description |
|----------|-------------|
| `initialMint(to, amount0Handle, amount1Handle, inputProof)` | Initialize pool with first liquidity deposit |
| `enqueueMint(to, amount0Handle, amount1Handle, claimedLiquidityHandle, inputProof)` | Queue a mint operation |
| `enqueueBurn(to, liquidityHandle, claimedAmount0Handle, claimedAmount1Handle, inputProof)` | Queue a burn operation |
| `enqueueSwap(to, amountInHandle, claimedOutHandle, tokenOutHandle, inputProof)` | Queue a swap operation |
| `revokeOperation(encryptedKey, inputProof)` | Cancel a queued operation using revocation key |
| `processBatch()` | Process one operation from the current batch |
| `finalizeBatch(cleartexts, decryptionProof)` | Complete batch with decryption proof |

### [FHEVerification.sol](contracts/libraries/FHEVerification.sol)

A library containing all verification logic. Since FHE does not support division on encrypted values, all checks use cross-multiplication.

**The Issue**: For minting and burning, an FHE contract cannot compute traditional UniswapV2 math such as: `amount * totalSupply / reserve` because division requires the denominator to be plaintext. Decrypting reserve data while processing leaks specific user information and defeats the purpose of decrypting it in the first place. Instead, users provide their claimed output, and the contract verifies:

```
claimed * reserve <= amount * totalSupply
```

This transforms division into multiplication, which FHE supports.

Swaps are verified using the traditional constant product invariant equivalent to the UniswapV2 Pair contract.

**Functions:**

| Function | Description |
|----------|-------------|
| `verifyMint(amount0, amount1, claimedLiq, reserve0, reserve1, totalSupply)` | Validates proportional liquidity claims |
| `verifyBurnAmount(claimedAmount, liquidity, reserve, totalSupply)` | Validates burn output claims |
| `verifySwap(amountIn, claimedOut, reserveIn, reserveOut)` | Validates swap against K invariant with 0.3% fee |
| `checkProportional(claimed, reserve, amount, totalSupply)` | Cross-multiplication helper |
| `checkReserveOverflow(reserve0, reserve1, amount0, amount1)` | Detects addition overflow |

**Overflow Protection:**

Intermediate verification calculations cast `euint64` to `euint128` to prevent overflow during multiplication.

Reserves calculations check for over/underflow before adjusting the private reserves. 

## Batch Mechanics

### Batch Size and Privacy Tradeoffs

The `minBatchSize` parameter (set at deployment) controls the minimum number of operations required before a batch can be processed. This creates a fundamental tradeoff:

| Larger Batches | Smaller Batches |
|----------------|-----------------|
|  More privacy (larger anonymity set) | Lower latency |
| Harder to correlate operations | Faster execution |
| Higher latency for users | Easier to correlate operations |
| Operations wait longer | Less privacy |

The optimal batch size depends on the specific market's needs. High-value, privacy-sensitive pools may prefer larger batches, while active trading pools may prefer smaller batches for faster execution.

### Batch States

Each batch progresses through distinct states tracked by the `BatchMeta` struct:

1. **Enqueueing**: Users can call `enqueueMint()`, `enqueueBurn()`, `enqueueSwap()`, or `revokeOperation()`
2. **Processing**: `processBatch()` is called repeatedly, processing one operation per call
3. **Awaiting Decryption**: All operations processed, waiting for off-chain decryption
4. **Finalized**: `finalizeBatch()` called with proof, public reserves updated, next batch begins

### Queue Locking

During the **Processing** and **Awaiting Decryption** states, the queue is locked:

- `enqueueMint()`, `enqueueBurn()`, `enqueueSwap()` will revert with `BatchProcessing()`

This ensures that operations cannot be added while the batch is being processed, maintaining consistency between the encrypted state and the operations being applied. It also ensures that queue growth does not exceed the processing rate effectively blocking the pool.

### Public Reserve Revelation

After all operations in a batch are processed, the contract calls `_markReservesForDecryption()`:

1. **Mark for Decryption**: `FHE.makePubliclyDecryptable()` is called on `_reserve0`, `_reserve1`, and `totalSupply`
2. **Store Handles**: The encrypted handles are stored in `_pendingReserve0Handle`, `_pendingReserve1Handle`, `_pendingTotalSupplyHandle`
3. **Emit Event**: `BatchAwaitingDecryption` event contains the handles for off-chain processing

Off-chain, anyone can:

1. Call `FhevmInstance.publicDecrypt([handle0, handle1, handle2])` to get cleartexts and a decryption proof
2. Submit the cleartexts and proof to `finalizeBatch(cleartexts, decryptionProof)`

The contract verifies the proof using `FHE.checkSignatures()` and updates the public reserves:

```solidity
publicReserve0 = r0;
publicReserve1 = r1;
publicTotalSupply = ts;
```

These public values are used by users to compute their inputs for the next batch.

See the [Zama Documentation](https://docs.zama.org/protocol/solidity-guides/smart-contract/oracle) on decryption for more info.

## User Operations

### Enqueueing Operations

Operations are processed on a **first-come, first-served basis** within each batch. The order is determined by when `enqueueMint()`, `enqueueBurn()`, or `enqueueSwap()` is called. This order is fixed once the operation is queued and cannot be changed by miners or other users.

### Computing Inputs

Users must compute their inputs off-chain using the public reserves. Here's how to calculate inputs for each operation:

**Mint (Add Liquidity):**

```typescript
// Get public reserves
const reserve0 = await cpmm.publicReserve0();
const reserve1 = await cpmm.publicReserve1();
const totalSupply = await cpmm.publicTotalSupply();

// User wants to add amount0 of token0
const amount0 = 1000000n;  // 1 token (6 decimals)

// Calculate proportional amount1
const amount1 = (amount0 * reserve1) / reserve0;

// Calculate expected LP tokens (take minimum of both ratios)
const lp0 = (amount0 * totalSupply) / reserve0;
const lp1 = (amount1 * totalSupply) / reserve1;
const expectedLP = lp0 < lp1 ? lp0 : lp1;

// Apply slippage tolerance (e.g., 1%)
const claimedLP = (expectedLP * 99n) / 100n;
```

**Burn (Remove Liquidity):**

```typescript
// User wants to burn `liquidity` LP tokens
const liquidity = 500000n;

// Calculate expected token outputs
const expectedAmount0 = (liquidity * reserve0) / totalSupply;
const expectedAmount1 = (liquidity * reserve1) / totalSupply;

// Apply slippage tolerance (e.g., 1%)
const claimedAmount0 = (expectedAmount0 * 99n) / 100n;
const claimedAmount1 = (expectedAmount1 * 99n) / 100n;
```

**Swap:**

```typescript
// User wants to swap amountIn of token0 for token1
const amountIn = 100000n;  // 0.1 token

// Calculate expected output using constant product formula with 0.3% fee
const amountInWithFee = amountIn * 997n;
const numerator = amountInWithFee * reserve1;
const denominator = (reserve0 * 1000n) + amountInWithFee;
const expectedOut = numerator / denominator;

// Apply slippage tolerance (e.g., 0.5%)
const claimedOut = (expectedOut * 995n) / 1000n;

// tokenOut = 1 means user receives token1
const tokenOut = 1;
```

### Slippage Impact

Slippage tolerance affects operations in two ways:

1. **Claim Too High**: If `claimedAmount > entitled_amount`, the verification fails and the user receives **nothing**. Their tokens are not transferred, but they still pay gas.

2. **Claim Too Low**: If `claimedAmount < entitled_amount`, the verification passes but the user receives less than they could have. The difference is effectively "donated" to the pool, increasing the value of all LP tokens proportionally.

**Example:**

A user is entitled to 1000 tokens but claims only 950 (5% slippage tolerance):

- User receives: 950 tokens
- "Lost" value: 50 tokens → distributed to all LP holders

This is why users should balance slippage tolerance carefully:

- Too tight (0.1%): High risk of failed transactions if reserves change
- Too loose (10%): Works reliably but may leave significant value on the table

### Revoking Operations

Each enqueue function returns an encrypted `revocationKey` that the user can decrypt off-chain and use later to cancel the operation if needed. The key is also emitted in the `OperationQueued` event as an encrypted handle that only the calling user can decrypt.

When revoking, users must create a fresh encryption of the key value—not reuse the original handle. This prevents others from linking the reocation call to the original enqueue transaction.

**Revocation Example:**

#### 1. User enqueues a swap and receives the revocation key handle
```typescript
const tx = await cpmm.connect(signers.alice).enqueueSwap(
  alice.address,
  amountInHandle,
  claimedOutHandle,
  tokenOutHandle,
  inputProof
);
```

#### 2. Parse the OperationQueued event to get the revocation key handle
```typescript
const filter = cpmm.filters.OperationQueued();
const events = await cpmm.queryFilter(filter);
const lastEvent = events[events.length - 1];
const revocationKeyHandle = lastEvent.args.revocationKeyHandle;
```

#### 3. Decrypt the key off-chain
```typescript
const plainRevocationKey = await fhevm.userDecryptEuint(
   FhevmType.euint16,
   revocationKeyHandle,
   cpmmAddress,
   signers.alice
);
```

#### 4. If user wants to revoke: create a new encryption of the key value
``` typescript
const freshEncryption = await fhevm
  .createEncryptedInput(cpmmAddress, alice.address)
  .add16(keyValue)
  .encrypt();
```

#### 5. Call revokeOperation with the fresh encryption
```typescript
await cpmm.connect(signers.alice).revokeOperation(
  freshEncryption.handles[0],
  freshEncryption.inputProof
);
```

**What Happens on Revocation:**

- The contract loops through all operations in the current batch
- It compares the provided key against each operation's revocation key using `FHE.eq()`
- The matching operation's `revoked` flag is set to `true`
- When the revoked operation is processed, all amounts are zeroed out—no tokens are transferred
- Note that revocations becomes more expensive with a larger queue because the contract must iterate over all operations.

**Privacy Guarantees:**

- Observers see a `RevocationAttempted` event but cannot determine which operation was revoked
- The fresh encryption prevents linking the revoke call to the original enqueue transaction
- All operations are checked regardless of match, hiding which one was targeted

**Timing:**

- Revocation is allowed during the **Enqueueing** and **Processing** states
- Once an operation has been processed (`op.processed = true`), revocation has no effect
- Revocation is blocked during the **Awaiting Decryption** state

### Lifecycle Example

Here's a complete example of a user adding liquidity:

```
1. USER CHECKS PUBLIC STATE
   ├── publicReserve0 = 10,000,000,000 (10K tokens)
   ├── publicReserve1 = 20,000,000,000 (20K tokens)
   └── publicTotalSupply = 14,142,135,623 (≈14.14K LP)

2. USER COMPUTES INPUTS
   ├── amount0 = 1,000,000,000 (1K tokens)
   ├── amount1 = 2,000,000,000 (2K tokens, proportional)
   ├── expectedLP = 1,414,213,562 (≈1.41K LP)
   └── claimedLP = 1,400,000,000 (with 1% slippage)

3. USER ENCRYPTS INPUTS
   └── createEncryptedInput(amount0, amount1, claimedLP)

4. USER CALLS enqueueMint()
   ├── Operation added to current batch
   ├── OperationQueued event emitted with revocationKey
   └── User decrypts revocationKey off-chain (saves for potential revocation)

5. BATCH FILLS UP
   └── Other users add operations until minBatchSize reached

6. ANYONE CALLS processBatch() REPEATEDLY
   ├── First call: BatchProcessingStarted event
   ├── Each call processes one operation
   ├── User's mint: tokens transferred, LP minted
   └── Final call: BatchAwaitingDecryption event

7. OFF-CHAIN DECRYPTION
   └── Anyone calls FhevmInstance.publicDecrypt() with handles

8. ANYONE CALLS finalizeBatch()
   ├── Proof verified via FHE.checkSignatures()
   ├── publicReserve0, publicReserve1, publicTotalSupply updated
   ├── BatchExecuted event
   └── Next batch begins (currentBatchId++)

9. USER CAN NOW:
   ├── Check their LP balance (encrypted, only they can decrypt)
   ├── Queue more operations using new public reserves
   └── Remove liquidity via enqueueBurn()
```

## Design Decisions

### Why Batch Processing?

1. **Privacy**: Batching obscures the relationship between individual operations and their effects on reserves. Users see only the aggregate change after a batch completes.

2. **MEV Resistance**: Within a batch, operation order is fixed at enqueue time. Miners cannot reorder operations to extract value.

3. **HCU Limits**: FHEVM has computational limits per transaction. Batching allows complex operations to be split across multiple calls.

### Why User-Provided Claims?

The contract cannot compute output amounts because FHE division requires a plaintext divisor. Instead:

1. User calculates their expected output off-chain using public reserves
2. User submits their claim (with slippage tolerance built in)
3. Contract verifies: `claim <= entitled_amount`
4. If valid, user receives their claimed amount; if invalid, user receives nothing

This means **users define their own slippage** through their claims. Claiming less than entitled is always valid but leaves value in the pool (benefiting all LP holders).

### Why Encrypted Swap Direction?

The `tokenOut` field is `euint8` (encrypted). The contract uses a 4-transfer pattern in `_processSwap()`:

```solidity
// All 4 transfers execute; 2 will be zero based on direction
token0.confidentialTransferFrom(op.owner, address(this), token0In);
token1.confidentialTransferFrom(op.owner, address(this), token1In);
token0.confidentialTransfer(op.to, token0Out);
token1.confidentialTransfer(op.to, token1Out);
```

Observers see 4 transfer calls but cannot determine which are the "real" transfers which would indicate trade direction in a traditional CPMM.

### Why Encrypted Revocation?

Users receive an encrypted `revocationKey` when enqueueing. To revoke via `revokeOperation()`:

1. User decrypts the key off-chain
2. User re-encrypts the key value with a new ciphertext
3. User calls `revokeOperation(encryptedKey, inputProof)`
4. Contract loops through all operations, comparing keys with `FHE.eq()`
5. Matching operation gets `revoked = true` (encrypted)

Since the key comparison is encrypted and all operations are checked, observers cannot determine which operation was revoked.

### Why Linear Average for Initial Liquidity?

Uniswap V2 uses `sqrt(amount0 * amount1)` for initial liquidity. Computing square root in FHE is expensive and can easily exceed HCU limits for proper accuracy.

The `_calculateInitialLiquidity()` function uses `(amount0 + amount1) / 2` instead. This is exact when `amount0 == amount1` and overestimates otherwise. For initial liquidity, this is acceptable because:

1. The first LP sets the price ratio anyway
2. The approximation only affects LP token quantity, not the pool ratio
3. Subsequent mints use proportional calculation, not square root
4. Initial liquidity can be a small deposit with minimal financial impact

## Known Limitations

### Single Operation Information Leakage

This is one of the most significant privacy challenges with the batch-reveal model.

**The Problem**: If a user is the only one performing a mint or burn in a batch, their position size can be inferred by 
comparing the public `totalSupply` before and after the batch completes. Even with encrypted reserves, the change in LP 
token supply reveals the magnitude of the operation.

**Example**: If `publicTotalSupply` increases by 1,000,000 LP tokens and only one mint occurred, an observer knows exactly how much liquidity was added. Combined with the reserve changes, the exact token amounts deposited can be derived.

**Why We Must Reveal Both Reserves and Total Supply**

The protocol reveals `publicReserve0`, `publicReserve1`, and `publicTotalSupply` after each batch. This is necessary for users to compute their inputs:

- **Swaps** require absolute reserve values to calculate `amountOut` using the constant product formula. The formula `amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)` cannot be computed with ratios alone and the denominator depends on the absolute value of `reserveIn`.

- **Mints and Burns** could theoretically be computed using only the ratios `reserve0/totalSupply` and `reserve1/totalSupply`. However, since we must reveal absolute reserves for swaps, `totalSupply` can be trivially derived: `totalSupply = reserve0 / ratio0`.

**Address Visibility**

Addresses are required to be plaintext for ERC7984 transfers, making it difficult to hide the identity of LP recipients. The LP destination is revealed either through the `msg.sender` of the enqueue call or the plaintext `to` field. Encrypting `to` would require decryption during processing, which defeats the purpose of encryption and would add significant latency.

**Possible Mitigations**:

1. **Paired Mint/Burn Obfuscation**: A user could enqueue both a mint and a revoked burn (or vice versa) in the same batch. Since revocation is encrypted, observers cannot distinguish between executed and cancelled operations, introducing uncertainty about the true net change.

2. **Noisy Public Reserves**: The protocol could apply a noise factor to revealed reserves, hiding true impacts. However, this sacrifices transaction accuracy:
   - Overestimated reserves cause additional slippage for users
   - Underestimated reserves cause failed transactions and wasted gas
   
   This tradeoff may be unacceptable for some use cases, although it was strongly considered for this project and may be implemented in the future.

3. **Higher Minimum Batch Sizes**: Requiring more operations per batch increases the anonymity set, but also increases latency for all users.

4. **Smaller Incremental Operations**: Users can split large mints/burns into smaller amounts across multiple batches and addresses. This sacrifices gas efficiency for improved privacy, as each operation incurs transaction costs. This would not necessarily do anything to obsfucate position sizes if the user is continually a single mint/burn operation in the batch, but it would make tracking require effort.

There is no perfect solution here. Users must evaluate their privacy requirements against the costs of each mitigation strategy.

### Transaction Latency

Operations are not processed until the batch reaches its minimum size. This introduces several challenges:

**Market Deviation**: The pool price can drift significantly from external markets while operations wait in the queue. A swap that was profitable at enqueue time may become unprofitable by the time the batch processes.

**Position Management**: Unlike traditional CPMMs where transactions execute immediately, users must actively monitor their queued operations. This shifts the UX from "instant execution" to something more akin to **limit orders**, where the "trigger" is sufficient pool activity to fill the batch.

**Revocation as Mitigation**: The `revokeOperation()` function allows users to cancel operations if market conditions change unfavorably. However, this requires:
- Active monitoring of market state
- Additional transactions (and gas) to revoke
- Awareness of batch processing status

### Slippage Risk

Users must calculate claims off-chain. If reserves change significantly during batch processing, claims may fail. However, this does not necessarily deviate too far from traditional UniswapV2 style AMM slippage risks where the risk of failure is the same.

## Stalled Processing Queues

A batch could remain in the processing state if batch processing begins and noone calls `processBatch()`, preventing new operations from being enqueued. However, users with currently enqueued transactions would have incentive to continue processing the batch so that their operations would be executed.

## High Gas Costs
FHE operations are gas intensive and require significantly more gas compared to traditional CPMM operations.

## Potential Improvements

### Who Calls `processBatch()`?

Currently, `processBatch()` can be called by anyone. This creates a question of incentives:

| Caller | Incentive | Notes |
|--------|-----------|-------|
| **Users** | Get their operation processed | Must pay gas, may not be first |
| **LP Holders** | Collect swap fees | Fees accrue to reserves, increasing LP value |
| **Protocol/Keeper** | Service fee | Would require implementing a minting/processing fee |

**Current State**: No explicit incentive mechanism exists. In practice, users wanting their operations processed will call `processBatch()`.

**Potential Improvement**: Implement a small processing fee (e.g., 0.01% of operation value) paid to the `processBatch()` caller. This would incentivize keepers to monitor and process batches promptly.

### Deadline Parameters

Operations could include an expiration timestamp:

```solidity
function enqueueMintWithDeadline(
    address to,
    externalEuint64 amount0Handle,
    externalEuint64 amount1Handle,
    externalEuint64 claimedLiquidityHandle,
    uint256 deadline,  // Block timestamp
    bytes calldata inputProof
) external returns (euint16 revocationKey);
```

If the batch hasn't processed by `deadline`, the operation would be automatically treated as revoked. This removes the need for active monitoring but is somewhat redundant with manual revocation.

### Dynamic Batch Sizes

Adjusting `minBatchSize` based on pool activity could balance privacy against latency:

- High activity periods: Larger batches fill quickly, maintain privacy
- Low activity periods: Smaller batches reduce wait times

This would require governance or an automated mechanism to adjust the parameter.

### Keeper Networks

Integration with keeper networks could ensure batches are processed promptly once they reach minimum size, reducing latency for all users.

## Test Coverage

### [FHEBatchCpmm.ts](test/FHEBatchCpmm.ts)

Unit tests covering:

- **Batch Threshold**: Minimum batch size enforcement, `isBatchReady()`, `hasMoreOperations()`
- **Batch Lifecycle**: Processing states, revocation, decryption flow, double finalization prevention
- **Initial Mint**: Pool initialization via `initialMint()`, linear average calculation
- **Proportional Mint**: Cross-multiplication verification via `verifyMint()`, overclaim rejection
- **Burn Operations**: Valid burns via `enqueueBurn()`, overclaim rejection, partial burns
- **Swap Operations**: K invariant verification via `verifySwap()`, direction privacy
- **Mixed Batches**: Multiple operation types in same batch
- **Overflow Protection**: Reserve overflow detection via `checkReserveOverflow()`
- **Revocation**: Encrypted revocation key pattern, no-op processing of revoked operations
- **Invariant Tests**: Exact calculations, slippage behavior, cross-batch reserve updates

### [FHEBatchCpmmStress.ts](test/FHEBatchCpmmStress.ts)

Stress test processing two consecutive batches of 20 operations each:

- Mix of mints, burns, and swaps
- Realistic 6-decimal token amounts (10K token pool)
- 0.5-2% slippage tolerance on claims
- Verifies reserves remain consistent across high-volume scenarios

## Credits

### [Zama FHEVM](https://docs.zama.org/protocol/solidity-guides/getting-started/overview)

Zama's FHEVM provides the Fully Homomorphic Encryption primitives that make privacy-preserving smart contracts possible. This project uses encrypted data types (`euint64`, `euint128`, `euint8`, `euint16`, `ebool`), homomorphic operations (`FHE.add`, `FHE.mul`, `FHE.select`, `FHE.eq`), access control (`FHE.allow`, `FHE.allowThis`, `FHE.allowTransient`), public decryption (`FHE.makePubliclyDecryptable`, `FHE.checkSignatures`), and random number generation (`FHE.randEuint16`).

### [OpenZeppelin Confidential Contracts](https://docs.openzeppelin.com/confidential-contracts/token)

OpenZeppelin's ERC7984 implementation provides the confidential token standard used for both the LP token and the underlying trading pair tokens. The standard supports confidential balances via `euint64`, confidential transfers (`confidentialTransfer`, `confidentialTransferFrom`), the operator pattern for contract approvals, and internal mint/burn functions.
