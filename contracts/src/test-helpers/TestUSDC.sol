// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC
/// @notice Six-decimal test dollar for Arbitrum Sepolia, mintable by anyone in
/// small amounts, so new users can try stock trackers without a USDC faucet.
/// Never deployed on Arbitrum One, where trackers use Circle's USDC.
contract TestUSDC is ERC20 {
    uint256 public constant MAX_MINT = 10_000e6;

    error TooMuch();

    constructor() ERC20("Juno Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert TooMuch();
        _mint(to, amount);
    }
}
