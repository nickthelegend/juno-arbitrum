// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Pure pricing maths for Juno curves. Deployed as a Stylus (Rust)
/// program; `CurveMathRef.sol` is the Solidity reference used in tests.
///
/// A curve sells `supply` tokens across 16 segments. Segment i's price rises
/// linearly from P[i] to P[i+1], with P[i] = p0 * r^i and r = capFp^(1/16).
/// The preset's weight for i decides how many tokens it holds. All prices are
/// "quote base units per whole token" (1e18 token units), so an 18-decimal
/// quote reads as wei-per-token and USDC as 6-decimal cents-per-token.
interface ICurveMath {
    function boundaries(uint8 preset, uint256 p0, uint256 capFp, uint256 supply)
        external
        view
        returns (uint256[] memory prices, uint256[] memory sizes);

    function priceAt(uint8 preset, uint256 p0, uint256 capFp, uint256 supply, uint256 sold)
        external
        view
        returns (uint256);

    /// Quote cost of buying `amount` tokens starting at `sold`, rounded up.
    function costToBuy(uint8 preset, uint256 p0, uint256 capFp, uint256 supply, uint256 sold, uint256 amount)
        external
        view
        returns (uint256);

    /// Quote returned for selling `amount` tokens ending at `sold`, rounded down.
    function proceedsToSell(uint8 preset, uint256 p0, uint256 capFp, uint256 supply, uint256 sold, uint256 amount)
        external
        view
        returns (uint256);

    /// Most tokens `cost` buys from `sold` (never more than supply - sold).
    function amountForCost(uint8 preset, uint256 p0, uint256 capFp, uint256 supply, uint256 sold, uint256 cost)
        external
        view
        returns (uint256);

    /// Trading fee after `elapsed` seconds: end + (start - end) * e^(-5 * elapsed / decay).
    function feeBps(uint256 startBps, uint256 endBps, uint256 decaySeconds, uint256 elapsed)
        external
        view
        returns (uint256);
}

interface IJunoCurve {
    struct State {
        address token;
        address quote; // address(0) = native ETH
        address creator;
        uint8 preset;
        uint256 p0;
        uint256 capFp;
        uint256 supply; // token total supply
        uint256 curveSupply; // tokens the curve sells before graduation
        uint256 sold;
        uint256 quoteReserve; // quote held for sellers and graduation, fees excluded
        uint256 creatorFees; // unclaimed, in quote
        uint256 protocolFees; // unclaimed, in quote
        uint256 feeBps; // current trading fee
        uint256 price; // current curve price
        uint256 graduationPrice; // P[16]
        bool graduated;
        address pool; // Uniswap v3 pool, fixed at launch
        uint256 positionId; // v3 position NFT, set at graduation
        address feed; // Chainlink feed, trackers only
        uint16 bandBps;
        uint32 maxAge;
        uint64 launchedAt;
    }

    struct BuyQuote {
        uint256 tokensOut;
        uint256 quoteIn; // gross, fee included
        uint256 fee;
        uint256 priceAfter;
        bool bandOk; // always true for non-trackers
        bool marketOpen; // always true for non-trackers
        uint256 refPrice; // feed price in quote units per token, 0 if none
    }

    struct SellQuote {
        uint256 quoteOut; // net, fee removed
        uint256 fee;
        uint256 priceAfter;
    }

    event Trade(
        address indexed trader,
        bool isBuy,
        uint256 quoteAmount,
        uint256 tokenAmount,
        uint256 feeCreator,
        uint256 feeProtocol,
        uint256 priceAfter,
        uint256 soldAfter
    );
    event CreatorFeesClaimed(address indexed creator, uint256 amount);
    event ProtocolFeesClaimed(address indexed treasury, uint256 amount);
    event Graduated(address indexed pool, uint256 positionId, uint256 tokenLiquidity, uint256 quoteLiquidity, uint256 burned);
    event LpFeesCollected(uint256 tokenAmount, uint256 quoteAmount);

    error MarketClosed(uint256 updatedAt, uint256 maxAge);
    error OutsideBand(uint256 priceAfter, uint256 refPrice, uint16 bandBps);
    error BadFeed();
    error SequencerDown();
    error Slippage(uint256 got, uint256 limit);
    error Expired();
    error AlreadyGraduated();
    error NotGraduated();
    error SoldOut();
    error NotFull();
    error NotCreator();
    error ZeroAmount();
    error WrongValue();
    error TransferFailed();

    function state() external view returns (State memory);
    function quoteBuy(uint256 quoteIn) external view returns (BuyQuote memory);
    function quoteBuyExactOut(uint256 tokensOut) external view returns (BuyQuote memory);
    function quoteSell(uint256 tokensIn) external view returns (SellQuote memory);

    function buy(uint256 minOut, uint256 deadline) external payable returns (uint256 tokensOut);
    function buyFor(address to, uint256 minOut, uint256 deadline) external payable returns (uint256 tokensOut);
    function buyWithQuote(uint256 quoteIn, uint256 minOut, uint256 deadline) external returns (uint256 tokensOut);
    function buyExactOut(uint256 tokensOut, uint256 maxIn, uint256 deadline) external payable returns (uint256 quoteIn);
    function sell(uint256 tokensIn, uint256 minOut, uint256 deadline) external returns (uint256 quoteOut);
    function claimCreatorFees() external returns (uint256);
    function claimProtocolFees() external returns (uint256);
    function graduate() external;
    function collectLpFees() external;
}

interface IJunoFactory {
    struct Preset {
        uint16 feeStartBps;
        uint16 feeEndBps;
        uint32 feeDecaySeconds;
        uint16 curveSupplyPct; // % of supply sold on the curve
        uint24 poolFee; // Uniswap v3 fee tier at graduation
        uint64 minCapFp; // allowed capFp range, 1e18 = 1x
        uint128 maxCapFp;
        bool trackerOnly;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        uint8 preset;
        address quote; // address(0) = ETH
        uint256 p0;
        uint256 capFp;
    }

    struct TrackerParams {
        string name;
        string symbol;
        string metadataURI;
        address quote; // USDC
        address feed;
        uint16 bandBps;
        uint32 maxAge;
        uint256 supply; // whole-token-scaled (1e18) total supply
        uint256 p0;
        uint256 capFp;
    }

    event Launched(
        address indexed curve,
        address indexed token,
        address indexed creator,
        uint8 preset,
        address quote,
        address feed,
        uint16 bandBps,
        uint256 supply,
        uint256 curveSupply,
        uint256 p0,
        uint256 capFp,
        address pool,
        string metadataURI
    );

    error BadPreset();
    error BadCap();
    error BadQuote();
    error BadFeed();
    error BadParams();

    function launch(LaunchParams calldata p, uint256 minOut) external payable returns (address curve, address token);
    function launchTracker(TrackerParams calldata p) external returns (address curve, address token);
    function preset(uint8 id) external view returns (Preset memory);
    function curveCount() external view returns (uint256);
    function curves(uint256 i) external view returns (address);
}
