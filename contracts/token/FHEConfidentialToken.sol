// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC7984} from "./ERC7984.sol";
import {FHE, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title FHEConfidentialToken
 * @dev Base implementation of the ERC7984 confidential fungible token.
 *
 * This contract:
 * - Inherits the full confidential transfer logic from `ERC7984`
 * - Provides internal `_mint` and `_burn` functions for derived contracts
 * - Uses 18 decimals by default
 */

contract FHEConfidentialToken is ERC7984, ZamaEthereumConfig {
    constructor(string memory name_, string memory symbol_) ERC7984(name_, symbol_, "") {}

    function mint(address to, externalEuint64 amount, bytes memory inputProof) public {
        _mint(to, FHE.fromExternal(amount, inputProof));
    }
    
    function burn(address from, externalEuint64 amount, bytes memory inputProof) public {
        _burn(from, FHE.fromExternal(amount, inputProof));
    }
}


