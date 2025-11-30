// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {
    FHE, 
    euint64, externalEuint64, 
    euint16, externalEuint16, 
    euint8, externalEuint8, 
    ebool
} from "@fhevm/solidity/lib/FHE.sol";

import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "./interfaces/IERC7984.sol";
import {ERC7984} from "./token/ERC7984.sol";
import {FHEVerification} from "./libraries/FHEVerification.sol";

/**
 * @title FHEBatchCpmm
 * @dev Batch processing AMM with encrypted reserves.
 *
 * - Reserves are always private (encrypted)
 * - Public reserves are revealed only after batch processing completes
 * - Transactions processed one-by-one
 * - Minimum batch size required before processing can begin
 *
 * Batch lifecycle:
 * 1. Users call enqueueMint(), enqueueBurn(), or enqueueSwap() to join current batch
 * 2. Once minBatchSize reached, anyone calls processBatch() repeatedly
 * 3. After all operations processed, processBatch() marks reserves for decryption
 * 4. Off-chain decryption occurs
 * 5. Anyone calls finalizeBatch() with decryption proof
 * 6. Public reserves updated, batch advances
 */
contract FHEBatchCpmm is ERC7984, ZamaEthereumConfig {
    // ============ Errors ============
    error BatchProcessing();
    error BatchNotFull();
    error AwaitingDecryption();
    error BatchNotAwaitingDecryption();
    error InvalidTo();
    error BatchAlreadyFinalized();
    error NotInitialized();
    error AlreadyInitialized();

    // ============ Enums ============
    enum OperationType { Mint, Burn, Swap }

    // ============ Structs ============
    struct Operation {
        address owner;
        address to;                 // Recipient of tokens/LP
        OperationType opType;
        
        // Mint/Burn fields
        euint64 amount0;            // Mint: input, Burn: claimed output
        euint64 amount1;            // Mint: input, Burn: claimed output
        euint64 liquidityAmount;    // Mint: claimed LP, Burn: LP to burn
        
        // Swap fields
        euint64 amountIn;           // Input amount (user sends)
        euint64 claimedOut;         // Claimed output amount (user receives)
        euint8 tokenOut;            // 0 = token0 out, 1 = token1 out
        
        uint256 batchId;
        euint16 revocationKey;      // Encrypted revocation key (user decrypts off-chain to revoke later)
        ebool revoked;              // true if revoked
        bool processed;             
    }

    struct BatchMeta {
        bool processing;            // True while batch is being processed
        bool awaitingDecryption;    // True after all operations processed, waiting for proof
        bool executed;              // True after finalization complete
        uint256 nextProcessIndex;   // Index of next operation to process
    }

    // ============ Constants ============
    uint64 public constant MINIMUM_LIQUIDITY = 1000;

    // ============ Configuration ============
    uint256 public immutable minBatchSize;
    
    // Token pair
    IERC7984 public token0;
    IERC7984 public token1;
    address public token0Address;
    address public token1Address;

    // ============ State ============
    bool public isInitialized;
    uint256 public currentBatchId;
    
    // Private reserves
    euint64 internal _reserve0;
    euint64 internal _reserve1;
    
    // Handles for pending decryption
    bytes32 internal _pendingReserve0Handle;
    bytes32 internal _pendingReserve1Handle;
    bytes32 internal _pendingTotalSupplyHandle;
    
    // Public reserves (revealed after batch completion for price discovery)
    uint64 public publicReserve0;
    uint64 public publicReserve1;
    uint64 public publicTotalSupply;
    
    // Operation queue
    uint256 public nextOperationId;
    mapping(uint256 => Operation) public operations;
    mapping(uint256 => uint256[]) internal batchOperations;
    mapping(uint256 => BatchMeta) public batches;
    

    // ============ Events ============
    event OperationQueued(
        uint256 indexed batchId,
        address indexed owner,
        OperationType opType,
        euint16 revocationKeyHandle
    );
    event RevocationAttempted(uint256 indexed batchId);
    event BatchProcessingStarted(uint256 indexed batchId);
    event MintProcessed(uint256 indexed opId, address indexed to, bool initialMint);
    event BurnProcessed(uint256 indexed opId, address indexed to);
    event SwapProcessed(uint256 indexed opId, address indexed to);
    event BatchAwaitingDecryption(
        uint256 indexed batchId,
        bytes32 reserve0Handle,
        bytes32 reserve1Handle,
        bytes32 totalSupplyHandle
    );
    event BatchExecuted(uint256 indexed batchId);
    event PublicReservesUpdated(uint64 reserve0, uint64 reserve1, uint64 totalSupply);

    // ============ Constructor ============
    constructor(
        uint256 _minBatchSize,
        address _token0,
        address _token1
    ) ERC7984("FHE LP Token", "FHELP", "") {
        require(_minBatchSize > 0, "Min batch size must be > 0");
        require(_token0 != address(0) && _token1 != address(0), "Invalid token addresses");
        minBatchSize = _minBatchSize;
        token0 = IERC7984(_token0);
        token1 = IERC7984(_token1);
        token0Address = _token0;
        token1Address = _token1;
    }

    // ============ Initial Mint ============

    /**
     * @notice Initialize the pool with the first liquidity deposit.
     * @dev Can only be called once. Executes immediately.
     *      After calling, must wait for off-chain decryption and call finalizeBatch()
     *      to reveal initial reserves before other operations can be queued.
     * @param to Recipient of LP tokens
     * @param amount0Handle Encrypted amount of token0
     * @param amount1Handle Encrypted amount of token1
     * @param inputProof FHEVM input proof
     */
    function initialMint(
        address to,
        externalEuint64 amount0Handle,
        externalEuint64 amount1Handle,
        bytes calldata inputProof
    ) external {
        if (isInitialized) revert AlreadyInitialized();
        if (to == address(0)) revert InvalidTo();
        
        euint64 amount0 = FHE.fromExternal(amount0Handle, inputProof);
        euint64 amount1 = FHE.fromExternal(amount1Handle, inputProof);
        
        // (amount0 + amount1) / 2 - MINIMUM_LIQUIDITY
        euint64 liquidity = _calculateInitialLiquidity(amount0, amount1);
        
        // Check if liquidity is valid (non-zero means no underflow)
        euint64 zero = FHE.asEuint64(0);
        ebool valid = FHE.ne(liquidity, zero);
        
        // Only use amounts if liquidity is valid
        euint64 actualAmount0 = FHE.select(valid, amount0, zero);
        euint64 actualAmount1 = FHE.select(valid, amount1, zero);
        euint64 actualLiquidity = FHE.select(valid, liquidity, zero);
        euint64 actualMinLiq = FHE.select(valid, FHE.asEuint64(MINIMUM_LIQUIDITY), zero);
        
        // Transfer tokens (0 if invalid)
        FHE.allowTransient(actualAmount0, token0Address);
        FHE.allowTransient(actualAmount1, token1Address);
        token0.confidentialTransferFrom(msg.sender, address(this), actualAmount0);
        token1.confidentialTransferFrom(msg.sender, address(this), actualAmount1);
        
        // Set reserves (0 if invalid)
        _reserve0 = actualAmount0;
        _reserve1 = actualAmount1;
        FHE.allowThis(_reserve0);
        FHE.allowThis(_reserve1);
        
        // Lock minimum liquidity to contract itself
        _mint(address(this), actualMinLiq);
        
        // Mint LP to user
        _mint(to, actualLiquidity);
        
        isInitialized = true;
        
        _markReservesForDecryption();
    }

    // ============ Queue Functions ============

    /**
     * @notice Queue a mint operation into the current batch.
     * @dev Cannot enqueue while current batch is processing
     *      and pool must be initialized.
     * @param to Recipient of LP tokens
     * @param amount0Handle Encrypted amount of token0
     * @param amount1Handle Encrypted amount of token1
     * @param claimedLiquidityHandle User's claimed LP amount
     * @param inputProof FHEVM input proof
     * @return revocationKey Encrypted revocation key
     */
    function enqueueMint(
        address to,
        externalEuint64 amount0Handle,
        externalEuint64 amount1Handle,
        externalEuint64 claimedLiquidityHandle,
        bytes calldata inputProof
    ) external returns (euint16 revocationKey) {
        uint256 opId = _enqueueOperation(to, OperationType.Mint);

        euint64 amount0 = FHE.fromExternal(amount0Handle, inputProof);
        euint64 amount1 = FHE.fromExternal(amount1Handle, inputProof);
        euint64 claimedLiquidity = FHE.fromExternal(claimedLiquidityHandle, inputProof);

        FHE.allowThis(amount0);
        FHE.allowThis(amount1);
        FHE.allowThis(claimedLiquidity);

        Operation storage op = operations[opId];
        op.amount0 = amount0;
        op.amount1 = amount1;
        op.liquidityAmount = claimedLiquidity;
        
        return op.revocationKey;
    }

    /**
     * @notice Queue a burn operation into the current batch.
     * @dev User must have LP tokens. Tokens are burned during processing.
     * @param to Recipient of token0/token1
     * @param liquidityHandle Encrypted LP amount to burn
     * @param claimedAmount0Handle Encrypted claimed token0 output
     * @param claimedAmount1Handle Encrypted claimed token1 output
     * @param inputProof FHEVM input proof
     * @return revocationKey Encrypted revocation key
     */
    function enqueueBurn(
        address to,
        externalEuint64 liquidityHandle,
        externalEuint64 claimedAmount0Handle,
        externalEuint64 claimedAmount1Handle,
        bytes calldata inputProof
    ) external returns (euint16 revocationKey) {
        uint256 opId = _enqueueOperation(to, OperationType.Burn);

        euint64 liquidity = FHE.fromExternal(liquidityHandle, inputProof);
        euint64 claimedAmount0 = FHE.fromExternal(claimedAmount0Handle, inputProof);
        euint64 claimedAmount1 = FHE.fromExternal(claimedAmount1Handle, inputProof);

        FHE.allowThis(liquidity);
        FHE.allowThis(claimedAmount0);
        FHE.allowThis(claimedAmount1);

        Operation storage op = operations[opId];
        op.liquidityAmount = liquidity;
        op.amount0 = claimedAmount0;
        op.amount1 = claimedAmount1;
        
        return op.revocationKey;
    }

    /**
     * @notice Queue a swap operation into the current batch.
     * @dev Direction is set via tokenOut (0 = token0 out, 1 = token1 out).
     * @param to Recipient of output tokens
     * @param amountInHandle Encrypted input amount
     * @param claimedOutHandle Encrypted claimed output amount
     * @param tokenOutHandle Encrypted output token
     * @param inputProof FHEVM input proof
     * @return revocationKey Encrypted revocation key
     */
    function enqueueSwap(
        address to,
        externalEuint64 amountInHandle,
        externalEuint64 claimedOutHandle,
        externalEuint8 tokenOutHandle,
        bytes calldata inputProof
    ) external returns (euint16 revocationKey) {
        uint256 opId = _enqueueOperation(to, OperationType.Swap);

        euint64 amountIn = FHE.fromExternal(amountInHandle, inputProof);
        euint64 claimedOut = FHE.fromExternal(claimedOutHandle, inputProof);
        euint8 tokenOut = FHE.fromExternal(tokenOutHandle, inputProof);

        FHE.allowThis(amountIn);
        FHE.allowThis(claimedOut);
        FHE.allowThis(tokenOut);

        Operation storage op = operations[opId];
        op.amountIn = amountIn;
        op.claimedOut = claimedOut;
        op.tokenOut = tokenOut;
        
        return op.revocationKey;
    }

    /**
     * @dev Internal helper to create a new operation.
     */
    function _enqueueOperation(address to, OperationType opType) internal returns (uint256 opId) {
        BatchMeta storage meta = batches[currentBatchId];
        if (meta.processing || meta.awaitingDecryption) revert BatchProcessing();
        if (to == address(0)) revert InvalidTo();
        if (!isInitialized) revert NotInitialized();

        opId = ++nextOperationId;

        // Generate random revocation key
        euint16 revocationKey = FHE.randEuint16();
        FHE.allow(revocationKey, msg.sender);
        FHE.allowThis(revocationKey);
        
        ebool encryptedFalse = FHE.asEbool(false);
        FHE.allowThis(encryptedFalse);
        
        operations[opId] = Operation({
            owner: msg.sender,
            to: to,
            opType: opType,
            amount0: FHE.asEuint64(0),
            amount1: FHE.asEuint64(0),
            liquidityAmount: FHE.asEuint64(0),
            amountIn: FHE.asEuint64(0),
            claimedOut: FHE.asEuint64(0),
            tokenOut: FHE.asEuint8(0),
            revocationKey: revocationKey,
            revoked: encryptedFalse,
            batchId: currentBatchId,
            processed: false
        });

        batchOperations[currentBatchId].push(opId);
        // user decrypts off-chain to get the key values
        emit OperationQueued(currentBatchId, msg.sender, opType, revocationKey);
    }

    /**
     * @notice Revoke a queued operation using encrypted revocation key.
     * @dev User provides a fresh encryption of their revocation key value.
     * @param encryptedKey Fresh encryption of the revocation key value
     * @param inputProof Proof for the encrypted input
     */
    function revokeOperation(
        externalEuint16 encryptedKey,
        bytes calldata inputProof
    ) external {
        BatchMeta storage meta = batches[currentBatchId];
        if (meta.awaitingDecryption) revert AwaitingDecryption();
        
        euint16 providedKey = FHE.fromExternal(encryptedKey, inputProof);
        
        uint256[] storage ids = batchOperations[currentBatchId];
        for (uint256 i = 0; i < ids.length; ++i) {
            Operation storage op = operations[ids[i]];
            
            ebool keyMatches = FHE.eq(providedKey, op.revocationKey);
            ebool notProcessed = FHE.asEbool(!op.processed);
            ebool canRevoke = FHE.and(keyMatches, notProcessed);
            
            // Conditionally set revoked flag
            op.revoked = FHE.select(canRevoke, FHE.asEbool(true), op.revoked);
            FHE.allowThis(op.revoked);
        }
        
        emit RevocationAttempted(currentBatchId);
    }

    // ============ Batch Processing ============

    /**
     * @notice Process the current batch.
     * @dev Call repeatedly until all operations are processed.
     *      - First call: checks minBatchSize, starts processing
     *      - Next calls: process one operation each
     *      - Final operation automatically marks reserves for decryption
     *      
     *      Note: Revoked operations are still processed with zero amounts to hide
     *      which operations were cancelled. This preserves privacy.
     */
    function processBatch() external {
        BatchMeta storage meta = batches[currentBatchId];
        uint256[] storage ids = batchOperations[currentBatchId];

        // Cannot process if already awaiting decryption or finalized
        if (meta.awaitingDecryption) revert AwaitingDecryption();
        if (meta.executed) revert BatchAlreadyFinalized();

        // If not processing, check threshold and initialize
        if (!meta.processing) {
            if (ids.length < minBatchSize) revert BatchNotFull();
            meta.processing = true;
            emit BatchProcessingStarted(currentBatchId);
        }

        // Process next unprocessed operation
        while (meta.nextProcessIndex < ids.length) {
            uint256 opId = ids[meta.nextProcessIndex];
            ++meta.nextProcessIndex;

            Operation storage op = operations[opId];
            if (op.processed) continue;

            _processOperation(opId, op);
            
            // If this was the last operation, mark for decryption immediately
            if (meta.nextProcessIndex >= ids.length) {
                _markReservesForDecryption();
            }
            return;
        }

        // all operations already processed, mark for decryption
        // should never happen
        _markReservesForDecryption();
    }

    /**
     * @dev Dispatch operation to appropriate handler.
     */
    function _processOperation(uint256 opId, Operation storage op) internal {
        if (op.opType == OperationType.Mint) {
            _processMint(opId, op);
        } else if (op.opType == OperationType.Burn) {
            _processBurn(opId, op);
        } else {
            _processSwap(opId, op);
        }
    }

    /**
     * @dev Mark reserves and total supply for public decryption.
     */
    function _markReservesForDecryption() internal {
        BatchMeta storage meta = batches[currentBatchId];
        euint64 totalSupply = confidentialTotalSupply();
        
        // Mark as publicly decryptable
        FHE.makePubliclyDecryptable(_reserve0);
        FHE.makePubliclyDecryptable(_reserve1);
        FHE.makePubliclyDecryptable(totalSupply);
        
        // Store handles for verification in finalizeBatch
        _pendingReserve0Handle = FHE.toBytes32(_reserve0);
        _pendingReserve1Handle = FHE.toBytes32(_reserve1);
        _pendingTotalSupplyHandle = FHE.toBytes32(totalSupply);
        
        meta.processing = false;
        meta.awaitingDecryption = true;
        
        emit BatchAwaitingDecryption(
            currentBatchId,
            _pendingReserve0Handle,
            _pendingReserve1Handle,
            _pendingTotalSupplyHandle
        );
    }

    /**
     * @notice Finalize batch with decryption proof.
     * @dev Called after off-chain decryption is complete.
     * @param cleartexts ABI-encoded (uint64, uint64, uint64) for reserve0, reserve1, totalSupply
     * @param decryptionProof Proof for the decryption
     */
    function finalizeBatch(
        bytes calldata cleartexts,
        bytes calldata decryptionProof
    ) external {
        BatchMeta storage meta = batches[currentBatchId];
        if (!meta.awaitingDecryption) revert BatchNotAwaitingDecryption();

        // Verify the decryption proof
        bytes32[] memory handles = new bytes32[](3);
        handles[0] = _pendingReserve0Handle;
        handles[1] = _pendingReserve1Handle;
        handles[2] = _pendingTotalSupplyHandle;
        
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        // Decode the cleartexts
        (uint64 r0, uint64 r1, uint64 ts) = abi.decode(
            cleartexts,
            (uint64, uint64, uint64)
        );

        // Set public reserves
        publicReserve0 = r0;
        publicReserve1 = r1;
        publicTotalSupply = ts;

        // Finalize batch state
        meta.awaitingDecryption = false;
        meta.executed = true;

        emit BatchExecuted(currentBatchId);
        emit PublicReservesUpdated(r0, r1, ts);

        // Move to next batch
        ++currentBatchId;
    }

    // ============ Internal Operation Processing ============

    /**
     * @dev Process a single mint operation.
     *      If revoked, all amounts are zeroed.
     */
    function _processMint(uint256 opId, Operation storage op) internal {
        // Zero out amounts if revoked
        euint64 zero = FHE.asEuint64(0);
        euint64 amount0 = FHE.select(op.revoked, zero, op.amount0);
        euint64 amount1 = FHE.select(op.revoked, zero, op.amount1);
        euint64 claimedLiq = FHE.select(op.revoked, zero, op.liquidityAmount);
        
        // Verify proportional claim and check for reserve overflow
        (euint64 actualAmount0, euint64 actualAmount1, euint64 actualLiquidity) = 
            FHEVerification.verifyMint(
                amount0, amount1, claimedLiq,
                _reserve0, _reserve1, confidentialTotalSupply()
            );
        
        // Transfer tokens from caller (0 if invalid)
        FHE.allowTransient(actualAmount0, token0Address);
        FHE.allowTransient(actualAmount1, token1Address);
        token0.confidentialTransferFrom(op.owner, address(this), actualAmount0);
        token1.confidentialTransferFrom(op.owner, address(this), actualAmount1);
        
        // Update reserves
        _reserve0 = FHE.add(_reserve0, actualAmount0);
        _reserve1 = FHE.add(_reserve1, actualAmount1);
        FHE.allowThis(_reserve0);
        FHE.allowThis(_reserve1);

        _mint(op.to, actualLiquidity);
        
        op.processed = true;
        emit MintProcessed(opId, op.to, false);
    }

    /**
     * @dev Process a single burn operation.
     *      If revoked, all amounts are zeroed.
     */
    function _processBurn(uint256 opId, Operation storage op) internal {
        // Zero out amounts if revoked
        euint64 zero = FHE.asEuint64(0);
        euint64 claimedAmount0 = FHE.select(op.revoked, zero, op.amount0);
        euint64 claimedAmount1 = FHE.select(op.revoked, zero, op.amount1);
        euint64 liquidityToBurn = FHE.select(op.revoked, zero, op.liquidityAmount);
        
        euint64 totalSupply = confidentialTotalSupply();
        
        // Verify both claimed amounts via cross-multiplication
        ebool valid0 = FHEVerification.verifyBurnAmount(claimedAmount0, liquidityToBurn, _reserve0, totalSupply);
        ebool valid1 = FHEVerification.verifyBurnAmount(claimedAmount1, liquidityToBurn, _reserve1, totalSupply);
        ebool valid = FHE.and(valid0, valid1);
        
        euint64 actualOut0 = FHE.select(valid, claimedAmount0, zero);
        euint64 actualOut1 = FHE.select(valid, claimedAmount1, zero);
        euint64 actualBurn = FHE.select(valid, liquidityToBurn, zero);
        
        // Burn LP tokens from user (0 if revoked or invalid)
        _burn(op.owner, actualBurn);
        
        // Transfer tokens to recipient (0 if revoked or invalid)
        FHE.allowTransient(actualOut0, token0Address);
        FHE.allowTransient(actualOut1, token1Address);
        token0.confidentialTransfer(op.to, actualOut0);
        token1.confidentialTransfer(op.to, actualOut1);
        
        // Update reserves
        _reserve0 = FHE.sub(_reserve0, actualOut0);
        _reserve1 = FHE.sub(_reserve1, actualOut1);
        FHE.allowThis(_reserve0);
        FHE.allowThis(_reserve1);
        
        op.processed = true;
        emit BurnProcessed(opId, op.to);
    }

    /**
     * @dev Process a single swap operation.
     *      Uses 4-transfer pattern to hide swap direction.
     *      If revoked, all amounts are zeroed.
     */
    function _processSwap(uint256 opId, Operation storage op) internal {
        // Zero out amounts if revoked
        euint64 zero = FHE.asEuint64(0);
        euint64 amountIn = FHE.select(op.revoked, zero, op.amountIn);
        euint64 claimedOut = FHE.select(op.revoked, zero, op.claimedOut);
        
        // tokenOut: 0 = token0 out (user sends token1), 1 = token1 out (user sends token0)
        ebool isToken1Out = FHE.eq(op.tokenOut, FHE.asEuint8(1));
        
        // Select reserves based on encrypted direction
        euint64 reserveIn = FHE.select(isToken1Out, _reserve0, _reserve1);
        euint64 reserveOut = FHE.select(isToken1Out, _reserve1, _reserve0);
        
        // Verify K invariant with 0.3% fee
        ebool valid = FHEVerification.verifySwap(amountIn, claimedOut, reserveIn, reserveOut);
        
        // Compute actual amounts (0 if invalid or revoked)
        euint64 actualIn = FHE.select(valid, amountIn, zero);
        euint64 actualOut = FHE.select(valid, claimedOut, zero);
        
        // Compute all 4 transfer amounts (2 will be zero based on direction)
        euint64 token0In = FHE.select(isToken1Out, actualIn, zero);   // token1 out = user sends token0
        euint64 token1In = FHE.select(isToken1Out, zero, actualIn);   // token0 out = user sends token1
        euint64 token0Out = FHE.select(isToken1Out, zero, actualOut); // token0 out = user receives token0
        euint64 token1Out = FHE.select(isToken1Out, actualOut, zero); // token1 out = user receives token1
        
        // Allow transfers
        FHE.allowTransient(token0In, token0Address);
        FHE.allowTransient(token1In, token1Address);
        FHE.allowTransient(token0Out, token0Address);
        FHE.allowTransient(token1Out, token1Address);
        
        // Execute all 4 transfers (zeros are no-ops)
        token0.confidentialTransferFrom(op.owner, address(this), token0In);
        token1.confidentialTransferFrom(op.owner, address(this), token1In);
        token0.confidentialTransfer(op.to, token0Out);
        token1.confidentialTransfer(op.to, token1Out);
        
        // Update reserves
        _reserve0 = FHE.select(isToken1Out,
            FHE.add(_reserve0, actualIn),
            FHE.sub(_reserve0, actualOut));
        _reserve1 = FHE.select(isToken1Out,
            FHE.sub(_reserve1, actualOut),
            FHE.add(_reserve1, actualIn));
        FHE.allowThis(_reserve0);
        FHE.allowThis(_reserve1);
        
        op.processed = true;
        emit SwapProcessed(opId, op.to);
    }

    // note: add reference to use small initial amounts
    /**
     * @dev Calculate initial liquidity using linear average approximation.
     *      sqrt(a * b) ≈ (a + b) / 2 when a ≈ b
     */
    function _calculateInitialLiquidity(
        euint64 amount0,
        euint64 amount1
    ) internal returns (euint64) {
        euint64 sum = FHE.add(amount0, amount1);
        euint64 halfSum = FHE.shr(sum, 1);
        euint64 minLiq = FHE.asEuint64(MINIMUM_LIQUIDITY);
        
        // If halfSum < MINIMUM_LIQUIDITY, return 0
        ebool underflow = FHE.lt(halfSum, minLiq);
        euint64 result = FHE.sub(halfSum, minLiq);

        ebool sumOverflow = FHE.lt(sum, amount0);
        ebool invalid = FHE.or(sumOverflow, underflow);

        // return 0 if underflow
        return FHE.select(invalid, FHE.asEuint64(0), result);
    }

    // ============ View Functions ============

    /**
     * @notice Get the number of operations in the current batch.
     */
    function getCurrentBatchSize() external view returns (uint256) {
        return batchOperations[currentBatchId].length;
    }

    /**
     * @notice Check if current batch is ready to process.
     */
    function isBatchReady() external view returns (bool) {
        return batchOperations[currentBatchId].length >= minBatchSize;
    }

    /**
     * @notice Check if batch has more operations to process.
     * @dev Note: revoked operations are still processed (with zeroed amounts),
     *      so we only check if there are unprocessed operations.
     */
    function hasMoreOperations() external view returns (bool) {
        BatchMeta storage meta = batches[currentBatchId];
        if (!meta.processing || meta.awaitingDecryption || meta.executed) return false;
        
        uint256[] storage ids = batchOperations[currentBatchId];
        for (uint256 i = meta.nextProcessIndex; i < ids.length; i++) {
            Operation storage op = operations[ids[i]];
            if (!op.processed) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Check if batch is awaiting decryption proof.
     */
    function isAwaitingDecryption() external view returns (bool) {
        return batches[currentBatchId].awaitingDecryption;
    }
}
