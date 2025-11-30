// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "./interfaces/IERC7984.sol";
import {ERC7984} from "./token/ERC7984.sol";
import {FHEConfidentialToken} from "./token/FHEConfidentialToken.sol";
import {FHEMath} from "./libraries/FHEMath.sol";

/**
 * @title FHECpmm
 * @dev Constant Product Market Maker (CPMM) with fully encrypted reserves using FHE.
 */
contract FHECpmm is ERC7984, ZamaEthereumConfig {
    // ============================================
    // State Variables
    // ============================================
    
    address public factory;
    IERC7984 public token0;
    IERC7984 public token1;
    address public token0address;
    address public token1address;
    
    euint64 private _reserve0;  // Encrypted reserve of token0
    euint64 private _reserve1;  // Encrypted reserve of token1
    
    bool private _isLiqInitialized;  // Tracks if first liquidity has been provided
    
    // Pre-mint storage: user -> (amount0, amount1)
    struct PreMintAmounts {
        euint64 amount0;
        euint64 amount1;
        bool isSet;
    }
    mapping(address => PreMintAmounts) private _preMintAmounts;
    
    // Minimum liquidity locked forever (like Uniswap V2)
    uint64 private constant MINIMUM_LIQUIDITY = 1000;
    
    // Test variables to store results (for testing purposes)
    euint64 public lastDivisionResult;
    euint64 public lastSqrtResult;
    
    // ============================================
    // Errors
    // ============================================
    
    error Forbidden();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error Overflow();
    error NoPreMintAmounts();

    // ============================================
    // Events
    // ============================================
    
    event Mint(address indexed sender, euint64 amount0, euint64 amount1);
    event Burn(address indexed sender, euint64 amount0, euint64 amount1, address indexed to);
    event Swap(
        address indexed sender,
        euint64 amount0In,
        euint64 amount1In,
        euint64 amount0Out,
        euint64 amount1Out,
        address indexed to
    );
    event Sync(euint64 reserve0, euint64 reserve1);

    // ============================================
    // Constructor
    // ============================================

    constructor() ERC7984("FHE CPMM LP", "FHE-LP", "") {
        factory = msg.sender;
        
    }

    // ============================================
    // Initialization
    // ============================================

    function initialize(address _token0, address _token1) external {
        if (msg.sender != factory) revert Forbidden();
        if (address(token0) != address(0)) revert Forbidden(); // Already initialized
        token0 = IERC7984(_token0);
        token1 = IERC7984(_token1);
        token0address = _token0;
        token1address = _token1;
    }

    // ============================================
    // View Functions
    // ============================================

    function getReserves() external view returns (euint64 reserve0, euint64 reserve1) {
        reserve0 = _reserve0;
        reserve1 = _reserve1;
    }

    // ============================================
    // Core AMM Functions
    // ============================================

    /**
     * @dev Mint liquidity tokens.
     * @param to Address to receive the liquidity tokens
     * @param amount0 Encrypted amount of token0 to add
     * @param amount1 Encrypted amount of token1 to add
     * @param inputProof Single input proof for both encrypted amounts
     * @return liquidity Encrypted amount of liquidity tokens minted
     */
    /**
     * @dev Prepare mint by converting encrypted amounts and transferring tokens.
     * This is a separate transaction to reduce HCU cost in the actual mint.
     * @param amount0 Encrypted amount of token0 to add
     * @param amount1 Encrypted amount of token1 to add
     * @param inputProof Single input proof for both encrypted amounts
     */
    function prepareMint(
        externalEuint64 amount0,
        externalEuint64 amount1,
        bytes calldata inputProof
    ) external {
        // Convert external encrypted values to internal using single proof
        euint64 encAmount0 = FHE.fromExternal(amount0, inputProof);
        euint64 encAmount1 = FHE.fromExternal(amount1, inputProof);

        // Allow this contract and token contracts to access the amounts
        FHE.allowThis(encAmount0);
        FHE.allowThis(encAmount1);
        FHE.allowTransient(encAmount0, token0address);
        FHE.allowTransient(encAmount1, token1address);
        
        // Transfer tokens from sender to this contract
        token0.confidentialTransferFrom(msg.sender, address(this), encAmount0);
        token1.confidentialTransferFrom(msg.sender, address(this), encAmount1);
        
        // Store pre-mint amounts for msg.sender
        _preMintAmounts[msg.sender] = PreMintAmounts({
            amount0: encAmount0,
            amount1: encAmount1,
            isSet: true
        });
    }

    /**
     * @dev Mint liquidity tokens using pre-stored amounts from prepareMint.
     * Tokens must have been transferred via prepareMint before calling this.
     * @param to Address to receive the liquidity tokens
     */
    function mint(address to) external {
        if (to == address(0) || to == address(this)) revert InvalidTo();
        
        // Retrieve pre-mint amounts (tokens already transferred in prepareMint)
        PreMintAmounts memory preMint = _preMintAmounts[msg.sender];
        if (!preMint.isSet) revert NoPreMintAmounts();
        
        // Clear pre-mint amounts to prevent reuse
        delete _preMintAmounts[msg.sender];
        
        euint64 encAmount0 = preMint.amount0;
        euint64 encAmount1 = preMint.amount1;

        euint64 liquidity;
        
        // Use plaintext flag to avoid expensive FHE operations on first mint
        if (!_isLiqInitialized) {
            // First mint: Use linear average approximation
            liquidity = _calculateInitialLiquidity(encAmount0, encAmount1);
            
            // Lock minimum liquidity to contract itself (similar to Uniswap V2's burn to address(0))
            // The contract must never burn its own LP tokens
            _mint(address(this), FHE.asEuint64(MINIMUM_LIQUIDITY));
            
            // Set initialized flag
            _isLiqInitialized = true;
        } else {
            // Subsequent mints: Proportional liquidity using Newton-Raphson division
            euint64 totalSupply = confidentialTotalSupply();
            liquidity = _calculateProportionalLiquidity(encAmount0, encAmount1, totalSupply);
        }
        
        // Mint liquidity tokens to the provider
        _mint(to, liquidity);
        
        // Update reserves
        _reserve0 = FHE.add(_reserve0, encAmount0);
        _reserve1 = FHE.add(_reserve1, encAmount1);
        
        emit Mint(msg.sender, encAmount0, encAmount1);
        emit Sync(_reserve0, _reserve1);
    }

    // ============================================
    // Internal Helper Functions
    // ============================================

    /**
     * @dev Calculate initial liquidity for first mint.
     * Uses Newton-Raphson inverse sqrt
     * @param amount0 Encrypted amount of token0
     * @param amount1 Encrypted amount of token1
     * @return liquidity sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY
     */
    function _calculateInitialLiquidity(
        euint64 amount0,
        euint64 amount1
    ) internal returns (euint64) {
        // Calculate sqrt(amount0 * amount1) using Newton-Raphson inverse sqrt
        euint64 liquidity = _sqrt(amount0, amount1);
        
        // Subtract MINIMUM_LIQUIDITY (locked forever like Uniswap V2)
        euint64 result = FHE.sub(liquidity, FHE.asEuint64(MINIMUM_LIQUIDITY));
        
        return result;
    }

    /**
     * @dev Calculate proportional liquidity for subsequent mints.
     * Uses Newton-Raphson reciprocal to compute division without dividing by encrypted values.
     * @param amount0 Encrypted amount of token0
     * @param amount1 Encrypted amount of token1
     * @param totalSupply Current encrypted total supply
     * @return liquidity min(amount0 × totalSupply / reserve0, amount1 × totalSupply / reserve1)
     */
    function _calculateProportionalLiquidity(
        euint64 amount0,
        euint64 amount1,
        euint64 totalSupply
    ) internal returns (euint64) {
        // Calculate liquidity from token0: amount0 × totalSupply / reserve0
        euint64 liquidity0 = _divideUsingReciprocal(
            FHE.mul(amount0, totalSupply),
            _reserve0
        );
        
        // Calculate liquidity from token1: amount1 × totalSupply / reserve1
        euint64 liquidity1 = _divideUsingReciprocal(
            FHE.mul(amount1, totalSupply),
            _reserve1
        );
        
        // Return minimum (ensures proportional deposits)
        return FHE.min(liquidity0, liquidity1);
    }

    /**
     * @dev Compute approximate sqrt(amount0 * amount1) using linear average.
     * 
     * Uses the formula: sqrt(a * b) ≈ (a + b) / 2
     * 
     * @param amount0 First amount
     * @param amount1 Second amount
     * @return result Approximation of sqrt(amount0 × amount1)
     */
    function _sqrt(euint64 amount0, euint64 amount1) internal returns (euint64 result) {
        result = FHEMath.sqrtApprox(amount0, amount1);
        
        // Store result for testing (allows decryption)
        lastSqrtResult = result;
        FHE.allowThis(lastSqrtResult);  // Allow contract to access
        FHE.allow(lastSqrtResult, msg.sender);  // Allow caller to decrypt
        
        return result;
    }
    

    /**
     * @dev Divide numerator by denominator using FHEMath library.
     * Uses Newton-Raphson for reciprocal calculation.
     * @param numerator The numerator
     * @param denominator The denominator
     * @return result numerator / denominator
     */
    function _divideUsingReciprocal(
        euint64 numerator,
        euint64 denominator
    ) internal returns (euint64) {
        return FHEMath.divide(numerator, denominator);
    }
}