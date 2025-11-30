// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint32, externalEuint32} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {FHEMath32} from "./libraries/FHEMath32.sol";

/**
 * @title FHEMath32Test
 * @dev Test contract to verify euint32 division fits within HCU limits.
 */
contract FHEMath32Test is ZamaEthereumConfig {
    euint32 public lastResult;
    
    /**
     * @dev Test division with euint32 and 3 Newton-Raphson iterations.
     * Uses externalEuint32 type directly for proper proof verification.
     */
    function testDivide(
        externalEuint32 encNumerator,
        externalEuint32 encDenominator,
        bytes calldata inputProof
    ) external {
        euint32 numerator = FHE.fromExternal(encNumerator, inputProof);
        euint32 denominator = FHE.fromExternal(encDenominator, inputProof);
        
        euint32 result = FHEMath32.divide(numerator, denominator);
        
        lastResult = result;
        FHE.allowThis(lastResult);
        FHE.allow(lastResult, msg.sender);
    }
}

