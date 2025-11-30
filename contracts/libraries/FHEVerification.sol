// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint128, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";

/**
 * @title FHEVerification
 * @dev Library for FHE-based verification functions used in AMM operations.
 *      All functions use euint128 for intermediate calculations to prevent overflow.
 */
library FHEVerification {
    /**
     * @dev Checks: claimed * reserve <= amount * totalSupply
     * @param claimed - claimed amount
     * @param reserve - reserve amount
     * @param amount - input amount
     * @param totalSupply - total supply
     * @return valid - proportional check
     */
    function checkProportional(
        euint64 claimed,
        euint64 reserve,
        euint64 amount,
        euint64 totalSupply
    ) internal returns (ebool) {
        euint128 lhs = FHE.mul(FHE.asEuint128(claimed), FHE.asEuint128(reserve));
        euint128 rhs = FHE.mul(FHE.asEuint128(amount), FHE.asEuint128(totalSupply));
        return FHE.le(lhs, rhs);
    }

    /**
     * @dev Verify burn amount with cross-multiplication.
     *      claimedAmount <= liquidity * reserve / totalSupply
     *      CclaimedAmount * totalSupply <= liquidity * reserve
     * @param claimedAmount - claimed output amount
     * @param liquidity - LP tokens being burned
     * @param reserve - reserve of the token being claimed
     * @param totalSupply - total LP supply
     * @return valid - whether the burn amount is valid
     */
    function verifyBurnAmount(
        euint64 claimedAmount,
        euint64 liquidity,
        euint64 reserve,
        euint64 totalSupply
    ) internal returns (ebool) {
        euint128 lhs = FHE.mul(FHE.asEuint128(claimedAmount), FHE.asEuint128(totalSupply));
        euint128 rhs = FHE.mul(FHE.asEuint128(liquidity), FHE.asEuint128(reserve));
        return FHE.le(lhs, rhs);
    }

    /**
     * @dev Verify swap via Uniswap V2 K invariant with 0.3% fee.
     *      (reserveIn + amountIn) * 1000 - amountIn * 3) * (reserveOut - claimedOut) * 1000
     *      >= reserveIn * reserveOut * 1000000
     *      Uses euint128 for K calculations to reduce overflow risk.
     *      Can still overflow if balanceInAdjusted or balanceOutAdjusted is too large
     *      Same issue is present for newBalanceIn * 1000 and newBalanceOut * 1000
     *      For 6-decimal tokens, this allows up to ~18 billion tokens per reserve
     * @param amountIn - input amount
     * @param claimedOut - claimed output amount
     * @param reserveIn - input reserve
     * @param reserveOut - output reserve
     * @return valid - whether the swap is valid
     */
    function verifySwap(
        euint64 amountIn,
        euint64 claimedOut,
        euint64 reserveIn,
        euint64 reserveOut
    ) internal returns (ebool) {
        // Liquidity check first
        ebool valid = FHE.lt(claimedOut, reserveOut);

        // Check for reserve overflow
        euint64 newBalanceIn = FHE.add(reserveIn, amountIn);
        ebool reserveOverflow = FHE.lt(newBalanceIn, reserveIn);
        valid = FHE.and(valid, FHE.not(reserveOverflow));

        euint64 newBalanceOut = FHE.sub(reserveOut, claimedOut);
        
        // balanceInAdjusted = newBalanceIn * 1000 - amountIn * 3
        euint128 balanceInScaled128 = FHE.mul(FHE.asEuint128(newBalanceIn), 1000);
        euint128 feeDeduction128 = FHE.mul(FHE.asEuint128(amountIn), 3);
        euint128 balanceInAdjusted = FHE.sub(balanceInScaled128, feeDeduction128);
        
        // balanceOutAdjusted = newBalanceOut * 1000
        euint128 balanceOutAdjusted = FHE.mul(FHE.asEuint128(newBalanceOut), 1000);
        
        // Use euint128 for K calculations to reduce overflow risk
        euint128 newK = FHE.mul(balanceInAdjusted, balanceOutAdjusted);
        euint128 oldK = FHE.mul(FHE.asEuint128(reserveIn), FHE.asEuint128(reserveOut));
        euint128 oldKScaled = FHE.mul(oldK, 1000000);
        
        valid = FHE.and(valid, FHE.ge(newK, oldKScaled));
        
        return valid;
    }

    /**
     * @dev Verify proportional liquidity with cross-multiplication.
     *
     * @param amount0 - amount of token0 being deposited
     * @param amount1 - amount of token1 being deposited
     * @param claimedLiquidity - claimed LP tokens
     * @param reserve0 - reserve of token0
     * @param reserve1 - reserve of token1
     * @param totalSupply - total LP supply
     * @return liquidity - validated liquidity amount (0 if invalid)
     */
    function verifyProportionalLiquidity(
        euint64 amount0,
        euint64 amount1,
        euint64 claimedLiquidity,
        euint64 reserve0,
        euint64 reserve1,
        euint64 totalSupply
    ) internal returns (euint64) {
        // claimedLiquidity * reserve0 <= amount0 * totalSupply
        ebool valid0 = checkProportional(claimedLiquidity, reserve0, amount0, totalSupply);
        
        // claimedLiquidity * reserve1 <= amount1 * totalSupply
        ebool valid1 = checkProportional(claimedLiquidity, reserve1, amount1, totalSupply);
        
        ebool valid = FHE.and(valid0, valid1);
        
        // Return claimedLiquidity if valid, else 0
        return FHE.select(valid, claimedLiquidity, FHE.asEuint64(0));
    }

    /**
     * @dev Check for reserve overflow after adding amounts.
     * @param reserve0 - current reserve0
     * @param reserve1 - current reserve1
     * @param amount0 - amount to add to reserve0
     * @param amount1 - amount to add to reserve1
     * @return overflow - whether adding amounts would cause overflow
     */
    function checkReserveOverflow(
        euint64 reserve0,
        euint64 reserve1,
        euint64 amount0,
        euint64 amount1
    ) internal returns (ebool) {
        euint64 newReserve0 = FHE.add(reserve0, amount0);
        euint64 newReserve1 = FHE.add(reserve1, amount1);
        return FHE.or(FHE.lt(newReserve0, reserve0), FHE.lt(newReserve1, reserve1));
    }

    /**
     * @dev Validate mint: check proportional claim and reserve overflow.
     *      Returns zeroed amounts if invalid.
     * @param amount0 - amount of token0 being deposited
     * @param amount1 - amount of token1 being deposited
     * @param claimedLiq - claimed LP tokens
     * @param reserve0 - current reserve of token0
     * @param reserve1 - current reserve of token1
     * @param totalSupply - total LP supply
     * @return actualAmount0 - validated amount0 (0 if invalid)
     * @return actualAmount1 - validated amount1 (0 if invalid)
     * @return actualLiquidity - validated liquidity (0 if invalid)
     */
    function verifyMint(
        euint64 amount0,
        euint64 amount1,
        euint64 claimedLiq,
        euint64 reserve0,
        euint64 reserve1,
        euint64 totalSupply
    ) internal returns (euint64, euint64, euint64) {
        euint64 zero = FHE.asEuint64(0);
        
        // Verify proportional claim
        euint64 liquidity = verifyProportionalLiquidity(
            amount0, amount1, claimedLiq, reserve0, reserve1, totalSupply
        );
        
        // Check reserve overflow and combine with proportional validity
        ebool overflow = checkReserveOverflow(reserve0, reserve1, amount0, amount1);
        ebool finalValid = FHE.and(FHE.ne(liquidity, zero), FHE.not(overflow));
        
        return (
            FHE.select(finalValid, amount0, zero),
            FHE.select(finalValid, amount1, zero),
            FHE.select(finalValid, liquidity, zero)
        );
    }
}

