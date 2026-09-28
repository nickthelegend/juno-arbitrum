// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "@chainlink/shared/interfaces/AggregatorV3Interface.sol";

import {ICurveMath, IJunoFactory} from "./interfaces/IJuno.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "./external/IUniswapV3.sol";
import {JunoCurve} from "./JunoCurve.sol";
import {JunoToken} from "./JunoToken.sol";

/// @title JunoFactory
/// @notice Launches Juno markets. A post launch creates its token, a curve
/// (an EIP-1167 clone of `curveImpl`), and the Uniswap v3 pool the curve will
/// graduate into — created and initialised now, at the curve's final price, so
/// graduation lands at exactly the price the last buyer paid.
///
/// The four presets are fixed at deployment and cannot be changed. The owner
/// only curates which quote tokens and which Chainlink feeds may be used.
contract JunoFactory is IJunoFactory, Ownable {
    uint256 public constant POST_SUPPLY = 1_000_000_000e18;
    uint8 public constant TIGHT_NAV = 3;

    address public immutable curveImpl;
    ICurveMath public immutable curveMath;
    address public immutable weth;
    address public immutable positionManager;
    IUniswapV3Factory public immutable uniswapFactory;
    address public immutable sequencerFeed;
    address public treasury;

    mapping(uint8 => Preset) internal _presets;
    uint8 public presetCount;
    mapping(address => bool) public quoteAllowed;
    mapping(address => bool) public feedAllowed;
    address[] public curves;
    mapping(address => address) public curveOf; // token => curve

    event QuoteAllowed(address indexed quote, bool allowed);
    event FeedAllowed(address indexed feed, bool allowed);
    event TreasurySet(address indexed treasury);

    constructor(
        ICurveMath curveMath_,
        address weth_,
        address positionManager_,
        address uniswapFactory_,
        address sequencerFeed_,
        address treasury_,
        address owner_
    ) Ownable(owner_) {
        curveMath = curveMath_;
        weth = weth_;
        positionManager = positionManager_;
        uniswapFactory = IUniswapV3Factory(uniswapFactory_);
        sequencerFeed = sequencerFeed_;
        treasury = treasury_;
        curveImpl = address(new JunoCurve());

        // content: cheap early, steep late. Posts and reels.
        _addPreset(Preset(900, 100, 600, 20, 10_000, 2e18, 100e18, false));
        // thin-name: deep at the issue price, thins out.
        _addPreset(Preset(500, 60, 900, 35, 3_000, 2e18, 100e18, false));
        // ipo-book: deep at both ends, thin in the middle.
        _addPreset(Preset(400, 50, 900, 30, 3_000, 2e18, 100e18, false));
        // tight-nav: near flat, for trackers held to a Chainlink band.
        _addPreset(Preset(200, 25, 300, 50, 3_000, 1.001e18, 3e18, true));

        quoteAllowed[address(0)] = true; // native ETH
    }

    // ---------------------------------------------------------------- admin

    function setQuote(address quote, bool allowed) external onlyOwner {
        quoteAllowed[quote] = allowed;
        emit QuoteAllowed(quote, allowed);
    }

    function setFeed(address feed, bool allowed) external onlyOwner {
        feedAllowed[feed] = allowed;
        emit FeedAllowed(feed, allowed);
    }

    function setTreasury(address treasury_) external onlyOwner {
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    // ---------------------------------------------------------------- views

    function preset(uint8 id) external view returns (Preset memory) {
        if (id >= presetCount) revert BadPreset();
        return _presets[id];
    }

    function curveCount() external view returns (uint256) {
        return curves.length;
    }

    // ---------------------------------------------------------------- launch

    /// @notice Launch a post or reel. Send ETH to make the first buy in the
    /// same transaction; the tokens go to the creator.
    function launch(LaunchParams calldata p, uint256 minOut) external payable returns (address curve, address token) {
        if (p.preset >= presetCount) revert BadPreset();
        Preset memory pr = _presets[p.preset];
        if (pr.trackerOnly) revert BadPreset();
        if (!quoteAllowed[p.quote]) revert BadQuote();
        if (msg.value > 0 && p.quote != address(0)) revert BadQuote();
        _checkShape(pr, p.p0, p.capFp);

        (curve, token) = _deploy(
            Deploy({
                name: p.name,
                symbol: p.symbol,
                uri: p.metadataURI,
                presetId: p.preset,
                pr: pr,
                quote: p.quote,
                supply: POST_SUPPLY,
                p0: p.p0,
                capFp: p.capFp,
                feed: address(0),
                bandBps: 0,
                maxAge: 0
            })
        );

        if (msg.value > 0) {
            JunoCurve(payable(curve)).buyFor{value: msg.value}(msg.sender, minOut, block.timestamp);
        }
    }

    /// @notice Launch a stock tracker: a tight-nav curve quoted in an
    /// allowlisted stablecoin and held to an allowlisted Chainlink feed.
    function launchTracker(TrackerParams calldata p) external returns (address curve, address token) {
        Preset memory pr = _presets[TIGHT_NAV];
        if (p.quote == address(0) || !quoteAllowed[p.quote]) revert BadQuote();
        if (!feedAllowed[p.feed]) revert BadFeed();
        if (p.bandBps < 10 || p.bandBps > 2_000) revert BadParams();
        if (p.maxAge < 1 hours || p.maxAge > 7 days) revert BadParams();
        if (p.supply < 100e18 || p.supply > POST_SUPPLY) revert BadParams();
        (, int256 answer,,,) = AggregatorV3Interface(p.feed).latestRoundData();
        if (answer <= 0) revert BadFeed();
        _checkShape(pr, p.p0, p.capFp);

        (curve, token) = _deploy(
            Deploy({
                name: p.name,
                symbol: p.symbol,
                uri: p.metadataURI,
                presetId: TIGHT_NAV,
                pr: pr,
                quote: p.quote,
                supply: p.supply,
                p0: p.p0,
                capFp: p.capFp,
                feed: p.feed,
                bandBps: p.bandBps,
                maxAge: p.maxAge
            })
        );
    }

    // ---------------------------------------------------------------- internals

    struct Deploy {
        string name;
        string symbol;
        string uri;
        uint8 presetId;
        Preset pr;
        address quote;
        uint256 supply;
        uint256 p0;
        uint256 capFp;
        address feed;
        uint16 bandBps;
        uint32 maxAge;
    }

    function _addPreset(Preset memory pr) internal {
        _presets[presetCount] = pr;
        presetCount++;
    }

    function _checkShape(Preset memory pr, uint256 p0, uint256 capFp) internal pure {
        if (p0 == 0 || p0 > 1e30) revert BadParams();
        if (capFp < pr.minCapFp || capFp > pr.maxCapFp) revert BadCap();
    }

    function _deploy(Deploy memory d) internal returns (address curve, address token) {
        curve = Clones.clone(curveImpl);
        token = address(new JunoToken(d.name, d.symbol, d.uri, d.supply, curve));
        uint256 curveSupply = (d.supply * d.pr.curveSupplyPct) / 100;

        // The price the curve ends at is the price the pool opens at.
        uint256 finalPrice = curveMath.priceAt(d.presetId, d.p0, d.capFp, curveSupply, curveSupply);
        address quoteToken = d.quote == address(0) ? weth : d.quote;
        address pool = _createPool(token, quoteToken, d.pr.poolFee, finalPrice);
        JunoToken(token).setPool(pool);

        JunoCurve(payable(curve)).initialize(
            JunoCurve.InitParams({
                token: token,
                quote: d.quote,
                creator: msg.sender,
                preset: d.presetId,
                feeStartBps: d.pr.feeStartBps,
                feeEndBps: d.pr.feeEndBps,
                feeDecaySeconds: d.pr.feeDecaySeconds,
                poolFee: d.pr.poolFee,
                tickSpacing: uniswapFactory.feeAmountTickSpacing(d.pr.poolFee),
                p0: d.p0,
                capFp: d.capFp,
                supply: d.supply,
                curveSupply: curveSupply,
                graduationPrice: finalPrice,
                pool: pool,
                feed: d.feed,
                bandBps: d.bandBps,
                maxAge: d.maxAge,
                math: curveMath,
                treasury: treasury,
                weth: weth,
                positionManager: positionManager,
                sequencerFeed: sequencerFeed
            })
        );

        curves.push(curve);
        curveOf[token] = curve;
        emit Launched(
            curve,
            token,
            msg.sender,
            d.presetId,
            d.quote,
            d.feed,
            d.bandBps,
            d.supply,
            curveSupply,
            d.p0,
            d.capFp,
            pool,
            d.uri
        );
    }

    /// @dev Create the token/quote pool and set its price to `price` (quote
    /// base units per whole token). sqrtPriceX96 = sqrt(token1/token0 raw) * 2^96.
    function _createPool(address token, address quoteToken, uint24 fee, uint256 price) internal returns (address pool) {
        pool = uniswapFactory.getPool(token, quoteToken, fee);
        if (pool == address(0)) pool = uniswapFactory.createPool(token, quoteToken, fee);
        uint256 ratioX192 = token < quoteToken
            ? Math.mulDiv(price, 1 << 192, 1e18) // quote per token
            : Math.mulDiv(1e18, 1 << 192, price); // token per quote
        IUniswapV3Pool(pool).initialize(uint160(Math.sqrt(ratioX192)));
    }
}
