// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title JunoToken
/// @notice The token of one Juno post. The whole supply is minted to the
/// post's curve, which sells it and, once full, seeds a Uniswap v3 pool.
///
/// Two small departures from a plain ERC-20:
/// - The curve can pull tokens without an allowance, so selling is one
///   transaction instead of approve + sell.
/// - Until the curve graduates, no one but the curve can send tokens into the
///   post's Uniswap v3 pool. The pool is created and priced at launch; this
///   stops anyone seeding it early at a different price.
contract JunoToken is ERC20, ERC20Burnable {
    address public immutable curve;
    address public immutable factory;
    address public pool;
    bool public graduated;
    string public metadataURI;

    error OnlyCurve();
    error OnlyFactory();
    error PoolLocked();
    error PoolSet();

    constructor(string memory name_, string memory symbol_, string memory uri_, uint256 supply_, address curve_)
        ERC20(name_, symbol_)
    {
        curve = curve_;
        factory = msg.sender;
        metadataURI = uri_;
        _mint(curve_, supply_);
    }

    function setPool(address pool_) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (pool != address(0) || pool_ == address(0)) revert PoolSet();
        pool = pool_;
    }

    function markGraduated() external {
        if (msg.sender != curve) revert OnlyCurve();
        graduated = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!graduated && to == pool && pool != address(0) && from != curve) revert PoolLocked();
        super._update(from, to, value);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal override {
        if (spender == curve) return;
        super._spendAllowance(owner, spender, value);
    }
}
