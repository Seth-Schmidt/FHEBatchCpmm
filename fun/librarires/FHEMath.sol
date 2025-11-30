// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";

/**
 * @title FHEMath
 * @dev Library for FHE mathematical operations including Newton-Raphson division.
 * Uses bit-shifting (2^30 scale) instead of division for efficiency.
 * Separated into a library to help manage HCU transaction depth limits.
 */
library FHEMath {
    // Bit-shift scale factor: 2^30 ≈ 10^9
    uint8 internal constant SCALE_BITS = 30;
    uint64 internal constant SCALE = uint64(1) << SCALE_BITS;           // 2^30 = 1,073,741,824
    uint64 internal constant TWO_SCALED = uint64(2) << SCALE_BITS;      // 2 * 2^30 = 2^31
    
    // For final division: we need to shift by 2*SCALE_BITS = 60
    // But we'll restructure to only need SCALE_BITS shift at the end
    uint8 internal constant DOUBLE_SCALE_BITS = 60;
    
    // Power-of-2 thresholds for initial guess selection
    // NOTE: With 2 Newton iterations, ~8% max error is a fundamental limitation
    // regardless of how many thresholds we use. The error occurs when b is far
    // from the optimal point for the selected guess.
    uint64 internal constant THRESHOLD_20 = 1 << 20;    // 2^20 = 1,048,576
    uint64 internal constant THRESHOLD_25 = 1 << 25;    // 2^25 = 33,554,432
    uint64 internal constant THRESHOLD_30 = 1 << 30;    // 2^30 = 1,073,741,824
    uint64 internal constant THRESHOLD_35 = uint64(1) << 35;    // 2^35 = 34,359,738,368
    uint64 internal constant THRESHOLD_40 = uint64(1) << 40;    // 2^40 = 1,099,511,627,776
    
    // Initial guesses for each range (optimal for upper bound of range)
    // For range [2^k, 2^(k+5)), guess = SCALE² / 2^(k+5) = 2^(55-k)
    uint64 internal constant GUESS_LT20 = SCALE << 10;   // 2^40, for b < 2^20
    uint64 internal constant GUESS_LT25 = SCALE << 5;    // 2^35, for b < 2^25
    uint64 internal constant GUESS_LT30 = SCALE;         // 2^30, for b < 2^30
    uint64 internal constant GUESS_LT35 = SCALE >> 5;    // 2^25, for b < 2^35
    uint64 internal constant GUESS_LT40 = SCALE >> 10;   // 2^20, for b < 2^40
    uint64 internal constant GUESS_GTE40 = SCALE >> 15;  // 2^15, for b >= 2^40

    /**
     * @dev Compute adaptive initial guess for reciprocal based on magnitude of b.
     * Uses encrypted comparisons and selects to choose the best guess.
     * 
     * NOTE: With only 2 Newton iterations (HCU limit), ~8% max error is fundamental.
     * The error occurs when b is in the lower half of its range (far from the
     * guess's optimal point). More thresholds don't significantly help.
     * 
     * @param b The value to compute reciprocal for (encrypted)
     * @return x Initial guess for SCALE²/b
     */
    function getAdaptiveInitialGuess(euint64 b) internal returns (euint64) {
        // Compare b against power-of-2 thresholds
        ebool lt20 = FHE.lt(b, FHE.asEuint64(THRESHOLD_20));
        ebool lt25 = FHE.lt(b, FHE.asEuint64(THRESHOLD_25));
        ebool lt30 = FHE.lt(b, FHE.asEuint64(THRESHOLD_30));
        ebool lt35 = FHE.lt(b, FHE.asEuint64(THRESHOLD_35));
        ebool lt40 = FHE.lt(b, FHE.asEuint64(THRESHOLD_40));
        
        // Cascading select from largest to smallest b range
        euint64 x = FHE.asEuint64(GUESS_GTE40);              // Default for b >= 2^40
        x = FHE.select(lt40, FHE.asEuint64(GUESS_LT40), x);  // [2^35, 2^40)
        x = FHE.select(lt35, FHE.asEuint64(GUESS_LT35), x);  // [2^30, 2^35)
        x = FHE.select(lt30, FHE.asEuint64(GUESS_LT30), x);  // [2^25, 2^30)
        x = FHE.select(lt25, FHE.asEuint64(GUESS_LT25), x);  // [2^20, 2^25)
        x = FHE.select(lt20, FHE.asEuint64(GUESS_LT20), x);  // [0, 2^20)
        
        return x;
    }

    /**
     * @dev Compute reciprocal of b using unrolled Newton-Raphson (2 iterations).
     * Formula: x_{n+1} = x_n × (2 - b × x_n / SCALE) / SCALE
     * 
     * 
     * NOTE: 2 iterations is the maximum allowed by HCU limits.
     * 
     * @param b The value to compute reciprocal of (encrypted)
     * @return Reciprocal SCALE²/b in scaled form
     */
    function computeReciprocal(euint64 b) internal returns (euint64) {
        // Adaptive initial guess based on magnitude of b
        euint64 x = getAdaptiveInitialGuess(b);
        euint64 two = FHE.asEuint64(TWO_SCALED);
        
        // Iteration 1 (unrolled) - using bit shifts instead of division
        euint64 bx1 = FHE.shr(FHE.mul(b, x), SCALE_BITS);
        euint64 twoMinusBx1 = FHE.sub(two, bx1);
        euint64 x1 = FHE.shr(FHE.mul(x, twoMinusBx1), SCALE_BITS);
        
        // Iteration 2 (unrolled)
        euint64 bx2 = FHE.shr(FHE.mul(b, x1), SCALE_BITS);
        euint64 twoMinusBx2 = FHE.sub(two, bx2);
        euint64 x2 = FHE.shr(FHE.mul(x1, twoMinusBx2), SCALE_BITS);
        
        return x2;
    }

    /**
     * @dev Divide numerator by denominator using reciprocal with adaptive guess.
     * Result = numerator / denominator
     * 
     * Computed as: (numerator × (SCALE/denominator)) >> SCALE_BITS
     * 
     * @param numerator The numerator
     * @param denominator The denominator
     * @return result numerator / denominator
     */
    function divide(
        euint64 numerator,
        euint64 denominator
    ) internal returns (euint64) {
        euint64 inv = computeReciprocal(denominator);
        euint64 product = FHE.mul(numerator, inv);
        return FHE.shr(product, SCALE_BITS);
    }

    // ============================================
    // Square Root Approximation (Linear Average)
    // ============================================
    
    /**
     * @dev Compute approximate sqrt(a * b) using linear average.
     * 
     * This uses the arithmetic-geometric mean inequality approximation:
     * sqrt(a * b) ≈ (a + b) / 2 when a ≈ b
     * 
     * @param a First value (encrypted)
     * @param b Second value (encrypted)
     * @return Approximation of sqrt(a * b)
     */
    function sqrtApprox(euint64 a, euint64 b) internal returns (euint64) {
        // Linear average: (a + b) / 2
        // This equals sqrt(a*b) when a = b, and overestimates otherwise
        euint64 sum = FHE.add(a, b);
        return FHE.shr(sum, 1);  // Divide by 2 using bit shift
    }
}
