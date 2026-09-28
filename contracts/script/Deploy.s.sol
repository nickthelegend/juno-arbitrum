// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AggregatorV3Interface} from "@chainlink/shared/interfaces/AggregatorV3Interface.sol";

import {CurveMathRef} from "../src/CurveMathRef.sol";
import {JunoFactory} from "../src/JunoFactory.sol";
import {ICurveMath} from "../src/interfaces/IJuno.sol";
import {MockAggregator} from "../src/test-helpers/MockAggregator.sol";
import {TestUSDC} from "../src/test-helpers/TestUSDC.sol";

/// Deploys Juno on the current chain.
///
/// CURVE_MATH must be the address of the activated Stylus program (deploy it
/// first with `cargo stylus deploy`). On Arbitrum Sepolia this script also
/// deploys TestUSDC, three MockAggregators seeded with the given prices, and
/// CurveMathRef (for the Stylus/Solidity differential check only; curves never
/// call it). On Arbitrum One it allowlists Circle USDC and the real Chainlink
/// feeds.
///
///   forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast
contract Deploy is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address curveMath = vm.envAddress("CURVE_MATH");
        address treasury = vm.envOr("TREASURY", deployer);

        vm.startBroadcast(key);
        if (block.chainid == 421614) {
            _sepolia(curveMath, deployer, treasury);
        } else if (block.chainid == 42161) {
            _one(curveMath, deployer, treasury);
        } else {
            revert("unsupported chain");
        }
        vm.stopBroadcast();
    }

    function _sepolia(address curveMath, address deployer, address treasury) internal {
        JunoFactory factory = new JunoFactory(
            ICurveMath(curveMath),
            0x980B62Da83eFf3D4576C647993b0c1D7faf17c73, // WETH
            0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65, // NonfungiblePositionManager
            0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e, // UniswapV3Factory
            address(0), // no sequencer uptime feed on Sepolia
            treasury,
            deployer
        );
        TestUSDC usdc = new TestUSDC();
        factory.setQuote(address(usdc), true);

        // Seeded from Arbitrum One; scripts/keep-feeds-fresh.ts keeps them in step.
        MockAggregator tsla = new MockAggregator("TSLA / USD", 8, int256(vm.envUint("SEED_TSLA")), block.timestamp);
        MockAggregator nvda = new MockAggregator("NVDA / USD", 8, int256(vm.envUint("SEED_NVDA")), block.timestamp);
        MockAggregator aapl = new MockAggregator("AAPL / USD", 8, int256(vm.envUint("SEED_AAPL")), block.timestamp);
        factory.setFeed(address(tsla), true);
        factory.setFeed(address(nvda), true);
        factory.setFeed(address(aapl), true);

        // The reference maths is only needed for the Stylus differential test,
        // which can inject its bytecode into an eth_call; deploy it only if asked.
        address ref = vm.envOr("DEPLOY_REF", false) ? address(new CurveMathRef()) : address(0);

        console.log("FACTORY", address(factory));
        console.log("CURVE_IMPL", factory.curveImpl());
        console.log("USDC", address(usdc));
        console.log("FEED_TSLA", address(tsla));
        console.log("FEED_NVDA", address(nvda));
        console.log("FEED_AAPL", address(aapl));
        if (ref != address(0)) console.log("CURVE_MATH_REF", ref);
    }

    function _one(address curveMath, address deployer, address treasury) internal {
        JunoFactory factory = new JunoFactory(
            ICurveMath(curveMath),
            0x82aF49447D8a07e3bd95BD0d56f35241523fBab1, // WETH
            0xC36442b4a4522E871399CD717aBDD847Ab11FE88, // NonfungiblePositionManager
            0x1F98431c8aD98523631AE4a59f267346ea31F984, // UniswapV3Factory
            0xFdB631F5EE196F0ed6FAa767959853A9F217697D, // L2 sequencer uptime feed
            treasury,
            deployer
        );
        factory.setQuote(0xaf88d065e77c8cC2239327C5EDb3A432268e5831, true); // USDC
        address[3] memory feeds = [
            0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3, // TSLA / USD
            0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F, // NVDA / USD
            0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c // AAPL / USD
        ];
        for (uint256 i; i < 3; i++) {
            (, int256 answer,,,) = AggregatorV3Interface(feeds[i]).latestRoundData();
            require(answer > 0, "feed");
            factory.setFeed(feeds[i], true);
        }
        console.log("FACTORY", address(factory));
        console.log("CURVE_IMPL", factory.curveImpl());
    }
}
