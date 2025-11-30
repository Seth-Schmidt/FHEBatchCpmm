// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";

/**
 * @title FHEMathNR
 * @dev Library for FHE sqrt using Babylonian method inspired by Uniswap V3.
 * 
 * Uniswap V3 uses bit-scanning to find MSB, then 7 Babylonian iterations.
 * We adapt this for FHE 
 * Key formula: r = (r + S/r) / 2
 * In FHE: r = (r + S * inv_r >> SCALE_BITS) >> 1
 */
library FHEMathNR {
    // Scale for fixed-point reciprocal: 2^30
    uint8 internal constant SCALE_BITS = 30;
    uint64 internal constant SCALE = uint64(1) << SCALE_BITS;
    uint64 internal constant TWO_SCALED = uint64(2) << SCALE_BITS;
    
    // Bit-scan thresholds for initial guess (3 ranges - simple and effective)
    // 
    // Key constraint: For S/r = S * invR >> SCALE_BITS to work,
    // we need invR = SCALE / r to be >= 1, so r <= SCALE = 2^30
    //
    // Ranges:
    // S < 2^20:  sqrt in [1, 2^10),      r = 2^10,  invR = 2^20
    // S < 2^40:  sqrt in [2^10, 2^20),   r = 2^20,  invR = 2^10
    // S >= 2^40: sqrt in [2^20, 2^32),   r = 2^30,  invR = 1
    //
    // Note: For S in [2^40, 2^60), the guess r = 2^30 can be up to 1024x off
    // from the true sqrt. But after 1 Babylonian iteration, error reduces to:
    // - S ≈ 2^60 (10^18): sqrt ≈ 2^30, r = 2^30, error ≈ 0%
    // - S ≈ 2^57 (2×10^17): sqrt ≈ 2^28.5, r = 2^30 (2.8x off), error ≈ 38%
    // - S ≈ 2^54: sqrt ≈ 2^27, r = 2^30 (8x off), error ≈ 78%
    // - S ≈ 2^40: sqrt ≈ 2^20, r = 2^30 (1024x off), error ≈ 99.9%
    //
    // The sweet spot is S ≈ 10^18 (typical large AMM pools).
    // For smaller S, the linear average may actually be better.
    
    uint64 internal constant THRESHOLD_20 = 1 << 20;           // ~1M
    uint64 internal constant THRESHOLD_40 = uint64(1) << 40;   // ~1T
    
    uint64 internal constant R_GUESS_10 = 1 << 10;     // 1024, for S < 2^20
    uint64 internal constant R_GUESS_20 = 1 << 20;     // ~1M, for S < 2^40
    uint64 internal constant R_GUESS_30 = 1 << 30;     // ~1B, for S >= 2^40 (MAX)
    
    // Corresponding reciprocal guesses: SCALE / r = 2^30 / r
    uint64 internal constant INV_GUESS_10 = SCALE >> 10;  // 2^20 for r=2^10
    uint64 internal constant INV_GUESS_20 = SCALE >> 20;  // 2^10 for r=2^20
    uint64 internal constant INV_GUESS_30 = 1;            // 1 for r=2^30

    /**
     * @dev Get initial guess r for sqrt(S) using bit-scan approach.
     * Also returns initial guess for 1/r (scaled by SCALE).
     * 
     * Uses 2 comparisons + 2 selects = 4 FHE ops (minimal)
     */
    function getBitScanGuesses(euint64 S) internal returns (euint64 r, euint64 invR) {
        ebool lt20 = FHE.lt(S, FHE.asEuint64(THRESHOLD_20));
        ebool lt40 = FHE.lt(S, FHE.asEuint64(THRESHOLD_40));
        
        // Default to largest range (S >= 2^40)
        r = FHE.asEuint64(R_GUESS_30);
        invR = FHE.asEuint64(INV_GUESS_30);
        
        // Cascade from largest to smallest
        r = FHE.select(lt40, FHE.asEuint64(R_GUESS_20), r);
        invR = FHE.select(lt40, FHE.asEuint64(INV_GUESS_20), invR);
        
        r = FHE.select(lt20, FHE.asEuint64(R_GUESS_10), r);
        invR = FHE.select(lt20, FHE.asEuint64(INV_GUESS_10), invR);
        
        return (r, invR);
    }

    /**
     * @dev Compute sqrt(a * b) using Babylonian method with 1 iteration.
     * 
     * Based on Uniswap V3's approach but adapted for FHE:
     * 1. Bit-scan to find initial guess r ≈ sqrt(S)
     * 2. One Babylonian iteration: r = (r + S/r) / 2
     * 
     * NOTE: 2 iterations would require FHEMath.divide(S, r1) which exceeds HCU limits.
     * 
     * @param a First value (encrypted)
     * @param b Second value (encrypted)
     * @return sqrt(a * b)
     */
    function sqrt(euint64 a, euint64 b) internal returns (euint64) {
        // S = a * b
        euint64 S = FHE.mul(a, b);
        
        // Get initial guesses via bit-scan
        (euint64 r, euint64 invR) = getBitScanGuesses(S);
        
        // Babylonian iteration: r_new = (r + S/r) / 2
        // Compute S/r = S * invR >> SCALE_BITS
        euint64 sOverR = FHE.shr(FHE.mul(S, invR), SCALE_BITS);
        euint64 rNew = FHE.shr(FHE.add(r, sOverR), 1);
        
        return rNew;
    }

    /**
     * @dev Compute approximate sqrt(a * b) using linear average.
     * Fallback if NR exceeds HCU limits.
     */
    function sqrtApprox(euint64 a, euint64 b) internal returns (euint64) {
        euint64 sum = FHE.add(a, b);
        return FHE.shr(sum, 1);
    }
}

