// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockAggregator
/// @notice Stands in for a Chainlink equity feed on Arbitrum Sepolia, where
/// Chainlink publishes none. `scripts/keep-feeds-fresh.ts` copies the real
/// Arbitrum One feed's answer and timestamp into it, so a Sepolia tracker is
/// held to the same price, and goes stale on the same weekends, as mainnet.
contract MockAggregator is Ownable {
    uint8 public immutable decimals;
    string public description;
    uint80 internal _round;
    int256 internal _answer;
    uint256 internal _updatedAt;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    constructor(string memory description_, uint8 decimals_, int256 answer_, uint256 updatedAt_) Ownable(msg.sender) {
        description = description_;
        decimals = decimals_;
        _set(answer_, updatedAt_);
    }

    function version() external pure returns (uint256) {
        return 4;
    }

    function setAnswer(int256 answer_, uint256 updatedAt_) external onlyOwner {
        _set(answer_, updatedAt_);
    }

    function _set(int256 answer_, uint256 updatedAt_) internal {
        _round += 1;
        _answer = answer_;
        _updatedAt = updatedAt_;
        emit AnswerUpdated(answer_, _round, updatedAt_);
    }

    function latestAnswer() external view returns (int256) {
        return _answer;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_round, _answer, _updatedAt, _updatedAt, _round);
    }
}
