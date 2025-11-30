// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHEBatchCpmm} from "./FHEBatchCpmm.sol";

/**
 * @title FHEBatchCpmmFactory
 * @dev Factory contract for deploying FHEBatchCpmm pairs.
 */
contract FHEBatchCpmmFactory {
    // ============ Events ============
    event PairCreated(
        address indexed token0,
        address indexed token1,
        address pair,
        uint256 pairIndex
    );

    // ============ State ============
    uint256 public immutable minBatchSize;
    
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    // ============ Constructor ============
    constructor(uint256 _minBatchSize) {
        require(_minBatchSize > 0, "Min batch size must be > 0");
        minBatchSize = _minBatchSize;
    }

    // ============ View Functions ============
    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    // ============ Pair Creation ============
    /**
     * @notice Create a new FHEBatchCpmm pair for two tokens.
     * @dev Reverts if pair already exists.
     * @param tokenA First token address
     * @param tokenB Second token address
     * @return pair Address of the newly created pair
     */
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "Identical addresses");
        
        (address token0, address token1) = tokenA < tokenB 
            ? (tokenA, tokenB) 
            : (tokenB, tokenA);
        
        require(token0 != address(0), "Zero address");
        require(getPair[token0][token1] == address(0), "Pair exists");

        FHEBatchCpmm newPair = new FHEBatchCpmm(minBatchSize, token0, token1);
        pair = address(newPair);

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair, allPairs.length - 1);
    }
}

