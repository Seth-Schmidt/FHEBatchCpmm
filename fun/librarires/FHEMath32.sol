// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint32, ebool} from "@fhevm/solidity/lib/FHE.sol";


library FHEMath32 {
    // Bit-shift scale factor: 2^10 = 1024
    // Max safe SCALE for uint32 is ~1625 (cube root of 2^32)
    uint8 internal constant SCALE_BITS = 10;
    uint32 internal constant SCALE = uint32(1) << SCALE_BITS;           // 2^10 = 1,024
    uint32 internal constant TWO_SCALED = uint32(2) << SCALE_BITS;      // 2 * 2^10 = 2,048
    
    // Power-of-2 thresholds for initial guess selection
    uint32 internal constant THRESHOLD_8 = 1 << 8;      // 2^8 = 256
    uint32 internal constant THRESHOLD_12 = 1 << 12;    // 2^12 = 4,096
    uint32 internal constant THRESHOLD_16 = 1 << 16;    // 2^16 = 65,536
    uint32 internal constant THRESHOLD_20 = 1 << 20;    // 2^20 = 1,048,576
    uint32 internal constant THRESHOLD_24 = 1 << 24;    // 2^24 = 16,777,216
    
    // Initial guesses for each range (targeting SCALE²/b convergence)
    // SCALE² = 2^20, guess = SCALE² / midpoint_of_range
    // [0, 2^8): midpoint ≈ 2^4, guess = 2^20/2^4 = 2^16
    // [2^8, 2^12): midpoint ≈ 2^10, guess = 2^20/2^10 = 2^10 = SCALE
    // [2^12, 2^16): midpoint ≈ 2^14, guess = 2^20/2^14 = 2^6
    // [2^16, 2^20): midpoint ≈ 2^18, guess = 2^20/2^18 = 2^2
    // [2^20, ...): guess = 1 (minimum, SCALE²/b < 1 for b > 2^20)
    uint32 internal constant GUESS_LT8 = SCALE << 6;    // 2^16 = 65,536
    uint32 internal constant GUESS_LT12 = SCALE;        // 2^10 = 1,024 (SCALE)
    uint32 internal constant GUESS_LT16 = SCALE >> 4;   // 2^6 = 64
    uint32 internal constant GUESS_LT20 = SCALE >> 8;   // 2^2 = 4
    uint32 internal constant GUESS_GTE20 = 1;           // minimum for large b

    /**
     * @dev Compute adaptive initial guess for reciprocal based on magnitude of b.
     */
    function getAdaptiveInitialGuess(euint32 b) internal returns (euint32) {
        ebool lt8 = FHE.lt(b, FHE.asEuint32(THRESHOLD_8));
        ebool lt12 = FHE.lt(b, FHE.asEuint32(THRESHOLD_12));
        ebool lt16 = FHE.lt(b, FHE.asEuint32(THRESHOLD_16));
        ebool lt20 = FHE.lt(b, FHE.asEuint32(THRESHOLD_20));
        
        euint32 x = FHE.asEuint32(GUESS_GTE20);
        x = FHE.select(lt20, FHE.asEuint32(GUESS_LT20), x);
        x = FHE.select(lt16, FHE.asEuint32(GUESS_LT16), x);
        x = FHE.select(lt12, FHE.asEuint32(GUESS_LT12), x);
        x = FHE.select(lt8, FHE.asEuint32(GUESS_LT8), x);
        
        return x;
    }

    /**
     * @dev Compute reciprocal using 3 Newton-Raphson iterations.
     * More iterations than euint64 version due to lower HCU cost per operation.
     */
    function computeReciprocal(euint32 b) internal returns (euint32) {
        euint32 x = getAdaptiveInitialGuess(b);
        euint32 two = FHE.asEuint32(TWO_SCALED);
        
        // Iteration 1
        euint32 bx1 = FHE.shr(FHE.mul(b, x), SCALE_BITS);
        euint32 twoMinusBx1 = FHE.sub(two, bx1);
        euint32 x1 = FHE.shr(FHE.mul(x, twoMinusBx1), SCALE_BITS);
        
        // Iteration 2
        euint32 bx2 = FHE.shr(FHE.mul(b, x1), SCALE_BITS);
        euint32 twoMinusBx2 = FHE.sub(two, bx2);
        euint32 x2 = FHE.shr(FHE.mul(x1, twoMinusBx2), SCALE_BITS);
        
        // Iteration 3 (extra iteration possible due to lower HCU cost)
        euint32 bx3 = FHE.shr(FHE.mul(b, x2), SCALE_BITS);
        euint32 twoMinusBx3 = FHE.sub(two, bx3);
        euint32 x3 = FHE.shr(FHE.mul(x2, twoMinusBx3), SCALE_BITS);
        
        return x3;
    }

    /**
     * @dev Divide numerator by denominator.
     * Result is scaled by SCALE.
     */
    function divide(
        euint32 numerator,
        euint32 denominator
    ) internal returns (euint32) {
        euint32 inv = computeReciprocal(denominator);
        euint32 product = FHE.mul(numerator, inv);
        return FHE.shr(product, SCALE_BITS);
    }
}

