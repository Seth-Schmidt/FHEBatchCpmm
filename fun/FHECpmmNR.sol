// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "./interfaces/IERC7984.sol";
import {ERC7984} from "./token/ERC7984.sol";
import {FHEMath} from "./libraries/FHEMath.sol";
import {FHEMathNR} from "./libraries/FHEMathNR.sol";

/**
 * @title FHECpmmNR
 * @dev Constant Product Market Maker (CPMM) with Newton-Raphson sqrt for initial liquidity.
 * 
 * This version uses Babylonian sqrt method instead of linear average,
 * aiming for better accuracy while staying under HCU limits.
 * 
 * Key features:
 * - Encrypted reserves (euint64)
 * - Encrypted totalSupply (inherited from ERC7984)
 * - Newton-Raphson division for proportional liquidity calculations
 * - Babylonian sqrt for initial liquidity (better than linear average)
 */
contract FHECpmmNR is ERC7984, ZamaEthereumConfig {
    // ============================================
    // State Variables
    // ============================================
    
    address public factory;
    IERC7984 public token0;
    IERC7984 public token1;
    address public token0address;
    address public token1address;
    
    euint64 private _reserve0;
    euint64 private _reserve1;
    
    bool private _isLiqInitialized;
    
    struct PreMintAmounts {
        euint64 amount0;
        euint64 amount1;
        bool isSet;
    }
    mapping(address => PreMintAmounts) private _preMintAmounts;
    
    uint64 private constant MINIMUM_LIQUIDITY = 1000;
    
    // Test variables
    euint64 public lastDivisionResult;
    euint64 public lastSqrtResult;
    
    // Errors
    
    error Forbidden();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error Overflow();
    error NoPreMintAmounts();

    // Events
    
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

    constructor() ERC7984("FHE CPMM NR LP", "FHE-NR-LP", "") {
        factory = msg.sender;
    }

    function initialize(address _token0, address _token1) external {
        if (msg.sender != factory) revert Forbidden();
        if (address(token0) != address(0)) revert Forbidden();
        token0 = IERC7984(_token0);
        token1 = IERC7984(_token1);
        token0address = _token0;
        token1address = _token1;
    }

    function getReserves() external view returns (euint64 reserve0, euint64 reserve1) {
        reserve0 = _reserve0;
        reserve1 = _reserve1;
    }

    function prepareMint(
        externalEuint64 amount0,
        externalEuint64 amount1,
        bytes calldata inputProof
    ) external {
        euint64 encAmount0 = FHE.fromExternal(amount0, inputProof);
        euint64 encAmount1 = FHE.fromExternal(amount1, inputProof);

        FHE.allowThis(encAmount0);
        FHE.allowThis(encAmount1);
        FHE.allowTransient(encAmount0, token0address);
        FHE.allowTransient(encAmount1, token1address);
        
        token0.confidentialTransferFrom(msg.sender, address(this), encAmount0);
        token1.confidentialTransferFrom(msg.sender, address(this), encAmount1);
        
        _preMintAmounts[msg.sender] = PreMintAmounts({
            amount0: encAmount0,
            amount1: encAmount1,
            isSet: true
        });
    }

    function mint(address to) external {
        if (to == address(0) || to == address(this)) revert InvalidTo();
        
        PreMintAmounts memory preMint = _preMintAmounts[msg.sender];
        if (!preMint.isSet) revert NoPreMintAmounts();
        
        delete _preMintAmounts[msg.sender];
        
        euint64 encAmount0 = preMint.amount0;
        euint64 encAmount1 = preMint.amount1;

        euint64 liquidity;
        
        if (!_isLiqInitialized) {
            // First mint: Use Newton-Raphson Babylonian sqrt
            liquidity = _calculateInitialLiquidity(encAmount0, encAmount1);
            _mint(address(this), FHE.asEuint64(MINIMUM_LIQUIDITY));
            _isLiqInitialized = true;
        } else {
            euint64 totalSupply = confidentialTotalSupply();
            liquidity = _calculateProportionalLiquidity(encAmount0, encAmount1, totalSupply);
        }
        
        _mint(to, liquidity);
        
        _reserve0 = FHE.add(_reserve0, encAmount0);
        _reserve1 = FHE.add(_reserve1, encAmount1);
        
        emit Mint(msg.sender, encAmount0, encAmount1);
        emit Sync(_reserve0, _reserve1);
    }

    function _calculateInitialLiquidity(
        euint64 amount0,
        euint64 amount1
    ) internal returns (euint64) {
        // Use Newton-Raphson Babylonian sqrt
        euint64 liquidity = _sqrt(amount0, amount1);
        euint64 result = FHE.sub(liquidity, FHE.asEuint64(MINIMUM_LIQUIDITY));
        return result;
    }

    function _calculateProportionalLiquidity(
        euint64 amount0,
        euint64 amount1,
        euint64 totalSupply
    ) internal returns (euint64) {
        euint64 liquidity0 = _divideUsingReciprocal(
            FHE.mul(amount0, totalSupply),
            _reserve0
        );
        
        euint64 liquidity1 = _divideUsingReciprocal(
            FHE.mul(amount1, totalSupply),
            _reserve1
        );
        
        return FHE.min(liquidity0, liquidity1);
    }

    /**
     * @dev Compute sqrt(amount0 * amount1) using Babylonian method.
     * Uses simplified initial guess + 1 NR iteration for 1/x.
     */
    function _sqrt(euint64 amount0, euint64 amount1) internal returns (euint64 result) {
        result = FHEMathNR.sqrt(amount0, amount1);
        
        // Store result for testing
        lastSqrtResult = result;
        FHE.allowThis(lastSqrtResult);
        FHE.allow(lastSqrtResult, msg.sender);
        
        return result;
    }

    function _divideUsingReciprocal(
        euint64 numerator,
        euint64 denominator
    ) internal returns (euint64) {
        return FHEMath.divide(numerator, denominator);
    }
}

