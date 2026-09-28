// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "@chainlink/shared/interfaces/AggregatorV3Interface.sol";

import {ICurveMath, IJunoCurve} from "./interfaces/IJuno.sol";
import {INonfungiblePositionManager, IWETH9} from "./external/IUniswapV3.sol";
import {JunoToken} from "./JunoToken.sol";

/// @title JunoCurve
/// @notice The market for one Juno post: a bonding curve that sells the post's
/// token for ETH or USDC until full, then moves its liquidity into Uniswap v3.
///
/// - Pricing is delegated to `CurveMath`, a Stylus (Rust) program.
/// - Trading fees start high and decay exponentially after launch; each fee
///   is split evenly between the creator (claimable) and the protocol.
/// - Stock trackers (a Chainlink feed set at launch) refuse any buy that would
///   lift the curve more than `bandBps` above the stock, and refuse all buys
///   while the feed is stale (market closed). Sells are never blocked.
/// - Graduation mints a full-range position in the pool the factory created
///   and priced at launch. The position NFT stays here, so the liquidity is
///   locked; its trading fees are split like the curve's.
///
/// Deployed once as an implementation and cloned per launch (EIP-1167).
contract JunoCurve is IJunoCurve, Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SEQUENCER_GRACE = 1 hours;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    struct InitParams {
        address token;
        address quote;
        address creator;
        uint8 preset;
        uint16 feeStartBps;
        uint16 feeEndBps;
        uint32 feeDecaySeconds;
        uint24 poolFee;
        int24 tickSpacing;
        uint256 p0;
        uint256 capFp;
        uint256 supply;
        uint256 curveSupply;
        uint256 graduationPrice;
        address pool;
        address feed;
        uint16 bandBps;
        uint32 maxAge;
        ICurveMath math;
        address treasury;
        address weth;
        address positionManager;
        address sequencerFeed;
    }

    // Set once at launch.
    address public token;
    address public quote;
    address public creator;
    uint8 public preset;
    uint16 public feeStartBps;
    uint16 public feeEndBps;
    uint32 public feeDecaySeconds;
    uint24 public poolFee;
    int24 public tickSpacing;
    uint64 public launchedAt;
    uint256 public p0;
    uint256 public capFp;
    uint256 public supply;
    uint256 public curveSupply;
    uint256 public graduationPrice;
    address public pool;
    address public feed;
    uint16 public bandBps;
    uint32 public maxAge;
    uint8 internal _quoteDecimals;
    uint8 internal _feedDecimals;
    ICurveMath public math;
    address public treasury;
    address public weth;
    address public positionManager;
    address public sequencerFeed;

    // Moves with trading.
    uint256 public sold;
    uint256 public quoteReserve;
    uint256 public creatorFees;
    uint256 public protocolFees;
    bool public graduated;
    uint256 public positionId;

    constructor() {
        _disableInitializers();
    }

    function initialize(InitParams calldata p) external initializer {
        token = p.token;
        quote = p.quote;
        creator = p.creator;
        preset = p.preset;
        feeStartBps = p.feeStartBps;
        feeEndBps = p.feeEndBps;
        feeDecaySeconds = p.feeDecaySeconds;
        poolFee = p.poolFee;
        tickSpacing = p.tickSpacing;
        launchedAt = uint64(block.timestamp);
        p0 = p.p0;
        capFp = p.capFp;
        supply = p.supply;
        curveSupply = p.curveSupply;
        graduationPrice = p.graduationPrice;
        pool = p.pool;
        feed = p.feed;
        bandBps = p.bandBps;
        maxAge = p.maxAge;
        math = p.math;
        treasury = p.treasury;
        weth = p.weth;
        positionManager = p.positionManager;
        sequencerFeed = p.sequencerFeed;
        _quoteDecimals = p.quote == address(0) ? 18 : IERC20Metadata(p.quote).decimals();
        if (p.feed != address(0)) _feedDecimals = AggregatorV3Interface(p.feed).decimals();
    }

    // ---------------------------------------------------------------- views

    /// @notice The trading fee right now, in basis points.
    function currentFeeBps() public view returns (uint256) {
        return math.feeBps(feeStartBps, feeEndBps, feeDecaySeconds, block.timestamp - launchedAt);
    }

    function currentPrice() public view returns (uint256) {
        return math.priceAt(preset, p0, capFp, curveSupply, sold);
    }

    function state() external view returns (State memory s) {
        s.token = token;
        s.quote = quote;
        s.creator = creator;
        s.preset = preset;
        s.p0 = p0;
        s.capFp = capFp;
        s.supply = supply;
        s.curveSupply = curveSupply;
        s.sold = sold;
        s.quoteReserve = quoteReserve;
        s.creatorFees = creatorFees;
        s.protocolFees = protocolFees;
        s.feeBps = currentFeeBps();
        s.price = currentPrice();
        s.graduationPrice = graduationPrice;
        s.graduated = graduated;
        s.pool = pool;
        s.positionId = positionId;
        s.feed = feed;
        s.bandBps = bandBps;
        s.maxAge = maxAge;
        s.launchedAt = launchedAt;
    }

    function quoteBuy(uint256 quoteIn) external view returns (BuyQuote memory q) {
        if (graduated || quoteIn == 0) return q;
        (uint256 out, uint256 cost, uint256 used) = _fillForQuote(quoteIn, currentFeeBps());
        q.tokensOut = out;
        q.quoteIn = used;
        q.fee = used - cost;
        q.priceAfter = math.priceAt(preset, p0, capFp, curveSupply, sold + out);
        (q.bandOk, q.marketOpen, q.refPrice) = _bandView(q.priceAfter);
    }

    function quoteBuyExactOut(uint256 tokensOut) external view returns (BuyQuote memory q) {
        if (graduated || tokensOut == 0 || tokensOut > curveSupply - sold) return q;
        uint256 cost = math.costToBuy(preset, p0, capFp, curveSupply, sold, tokensOut);
        uint256 fee = _feeOnTop(cost, currentFeeBps());
        q.tokensOut = tokensOut;
        q.quoteIn = cost + fee;
        q.fee = fee;
        q.priceAfter = math.priceAt(preset, p0, capFp, curveSupply, sold + tokensOut);
        (q.bandOk, q.marketOpen, q.refPrice) = _bandView(q.priceAfter);
    }

    function quoteSell(uint256 tokensIn) external view returns (SellQuote memory q) {
        if (graduated || tokensIn == 0 || tokensIn > sold) return q;
        uint256 proceeds = math.proceedsToSell(preset, p0, capFp, curveSupply, sold, tokensIn);
        uint256 fee = Math.mulDiv(proceeds, currentFeeBps(), BPS, Math.Rounding.Ceil);
        q.quoteOut = proceeds - fee;
        q.fee = fee;
        q.priceAfter = math.priceAt(preset, p0, capFp, curveSupply, sold - tokensIn);
    }

    // ---------------------------------------------------------------- trading

    function buy(uint256 minOut, uint256 deadline) external payable nonReentrant returns (uint256) {
        _requireEth();
        return _buy(msg.sender, msg.value, minOut, deadline);
    }

    function buyFor(address to, uint256 minOut, uint256 deadline) external payable nonReentrant returns (uint256) {
        _requireEth();
        return _buy(to, msg.value, minOut, deadline);
    }

    function buyWithQuote(uint256 quoteIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256)
    {
        if (quote == address(0)) revert WrongValue();
        IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteIn);
        return _buy(msg.sender, quoteIn, minOut, deadline);
    }

    function buyExactOut(uint256 tokensOut, uint256 maxIn, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 quoteIn)
    {
        _open(deadline);
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut > curveSupply - sold) revert SoldOut();
        uint256 cost = math.costToBuy(preset, p0, capFp, curveSupply, sold, tokensOut);
        uint256 fee = _feeOnTop(cost, currentFeeBps());
        quoteIn = cost + fee;
        if (quoteIn > maxIn) revert Slippage(quoteIn, maxIn);

        if (quote == address(0)) {
            if (msg.value < quoteIn) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteIn);
        }
        _settleBuy(msg.sender, tokensOut, cost, fee);
        if (quote == address(0) && msg.value > quoteIn) _pay(msg.sender, msg.value - quoteIn);
    }

    function sell(uint256 tokensIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (graduated) revert AlreadyGraduated();
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();
        uint256 proceeds = math.proceedsToSell(preset, p0, capFp, curveSupply, sold, tokensIn);
        uint256 fee = Math.mulDiv(proceeds, currentFeeBps(), BPS, Math.Rounding.Ceil);
        quoteOut = proceeds - fee;
        if (quoteOut < minOut) revert Slippage(quoteOut, minOut);

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        sold -= tokensIn;
        quoteReserve -= proceeds;
        (uint256 toCreator, uint256 toProtocol) = _splitFee(fee);
        uint256 priceAfter = math.priceAt(preset, p0, capFp, curveSupply, sold);
        emit Trade(msg.sender, false, quoteOut, tokensIn, toCreator, toProtocol, priceAfter, sold);
        _pay(msg.sender, quoteOut);
    }

    // ---------------------------------------------------------------- fees

    function claimCreatorFees() external nonReentrant returns (uint256 amount) {
        if (msg.sender != creator) revert NotCreator();
        amount = creatorFees;
        if (amount == 0) revert ZeroAmount();
        creatorFees = 0;
        emit CreatorFeesClaimed(creator, amount);
        _pay(creator, amount);
    }

    function claimProtocolFees() external nonReentrant returns (uint256 amount) {
        amount = protocolFees;
        if (amount == 0) revert ZeroAmount();
        protocolFees = 0;
        emit ProtocolFeesClaimed(treasury, amount);
        _pay(treasury, amount);
    }

    // ---------------------------------------------------------------- graduation

    /// @notice Anyone may graduate a full curve. The pool already exists at
    /// the curve's final price (the factory created it at launch), so the
    /// reserve and the matching number of tokens go in at exactly that price.
    /// Tokens the position does not need are burned.
    function graduate() external nonReentrant {
        if (graduated) revert AlreadyGraduated();
        if (sold < curveSupply) revert NotFull();
        graduated = true;
        uint256 quoteAmount = quoteReserve;
        quoteReserve = 0;
        address quoteToken = quote == address(0) ? weth : quote;
        JunoToken(token).markGraduated();
        if (quote == address(0)) IWETH9(weth).deposit{value: quoteAmount}();

        uint256 tokenBalance = IERC20(token).balanceOf(address(this));
        uint256 tokenAmount = Math.mulDiv(quoteAmount, WAD, graduationPrice);
        if (tokenAmount > tokenBalance) tokenAmount = tokenBalance;

        IERC20(token).forceApprove(positionManager, tokenAmount);
        IERC20(quoteToken).forceApprove(positionManager, quoteAmount);

        bool tokenIsZero = token < quoteToken;
        int24 lower = (MIN_TICK / tickSpacing) * tickSpacing;
        int24 upper = (MAX_TICK / tickSpacing) * tickSpacing;
        (uint256 id,, uint256 a0, uint256 a1) = INonfungiblePositionManager(positionManager).mint(
            INonfungiblePositionManager.MintParams({
                token0: tokenIsZero ? token : quoteToken,
                token1: tokenIsZero ? quoteToken : token,
                fee: poolFee,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: tokenIsZero ? tokenAmount : quoteAmount,
                amount1Desired: tokenIsZero ? quoteAmount : tokenAmount,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        positionId = id;
        (uint256 usedToken, uint256 usedQuote) = tokenIsZero ? (a0, a1) : (a1, a0);

        IERC20(token).forceApprove(positionManager, 0);
        IERC20(quoteToken).forceApprove(positionManager, 0);

        // Rounding dust of the quote goes to the treasury; unused tokens burn.
        uint256 quoteLeft = quoteAmount - usedQuote;
        if (quoteLeft > 0) IERC20(quoteToken).safeTransfer(treasury, quoteLeft);
        uint256 burned = IERC20(token).balanceOf(address(this));
        if (burned > 0) JunoToken(token).burn(burned);

        emit Graduated(pool, id, usedToken, usedQuote, burned);
    }

    /// @notice Collect the graduated position's trading fees and split them
    /// between the creator and the protocol, like the curve's own fees.
    function collectLpFees() external nonReentrant {
        if (!graduated) revert NotGraduated();
        (uint256 a0, uint256 a1) = INonfungiblePositionManager(positionManager).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        address quoteToken = quote == address(0) ? weth : quote;
        (uint256 tokenFees, uint256 quoteFees) = token < quoteToken ? (a0, a1) : (a1, a0);
        _splitOut(token, tokenFees);
        _splitOut(quoteToken, quoteFees);
        emit LpFeesCollected(tokenFees, quoteFees);
    }

    // ---------------------------------------------------------------- internals

    function _requireEth() internal view {
        if (quote != address(0)) revert WrongValue();
    }

    function _open(uint256 deadline) internal view {
        if (graduated) revert AlreadyGraduated();
        if (block.timestamp > deadline) revert Expired();
    }

    function _buy(address to, uint256 quoteIn, uint256 minOut, uint256 deadline) internal returns (uint256 out) {
        _open(deadline);
        if (quoteIn == 0) revert ZeroAmount();
        if (sold >= curveSupply) revert SoldOut();
        uint256 cost;
        uint256 used;
        (out, cost, used) = _fillForQuote(quoteIn, currentFeeBps());
        if (out == 0) revert ZeroAmount();
        if (out < minOut) revert Slippage(out, minOut);
        _settleBuy(to, out, cost, used - cost);
        // Only a buy that fills the curve leaves change.
        if (used < quoteIn) _pay(to, quoteIn - used);
    }

    /// @dev Tokens a gross `quoteIn` buys, what they cost net of fee, and how
    /// much of `quoteIn` is used. Below the fill point the whole input is used
    /// (any rounding remainder counts as fee); a filling buy is charged only
    /// the cost of the remaining tokens plus its fee.
    function _fillForQuote(uint256 quoteIn, uint256 feeBps_)
        internal
        view
        returns (uint256 out, uint256 cost, uint256 used)
    {
        uint256 net = quoteIn - Math.mulDiv(quoteIn, feeBps_, BPS, Math.Rounding.Ceil);
        uint256 room = curveSupply - sold;
        out = math.amountForCost(preset, p0, capFp, curveSupply, sold, net);
        if (out >= room) {
            out = room;
            cost = math.costToBuy(preset, p0, capFp, curveSupply, sold, out);
            used = cost + _feeOnTop(cost, feeBps_);
            if (used > quoteIn) used = quoteIn;
        } else {
            cost = out == 0 ? 0 : math.costToBuy(preset, p0, capFp, curveSupply, sold, out);
            used = quoteIn;
        }
    }

    function _settleBuy(address to, uint256 out, uint256 cost, uint256 fee) internal {
        uint256 priceAfter = math.priceAt(preset, p0, capFp, curveSupply, sold + out);
        if (feed != address(0)) _checkBand(priceAfter);
        sold += out;
        quoteReserve += cost;
        (uint256 toCreator, uint256 toProtocol) = _splitFee(fee);
        emit Trade(to, true, cost + fee, out, toCreator, toProtocol, priceAfter, sold);
        IERC20(token).safeTransfer(to, out);
    }

    /// @dev Fee such that (cost + fee) * (1 - feeBps) >= cost, rounded up.
    function _feeOnTop(uint256 cost, uint256 feeBps_) internal pure returns (uint256) {
        return Math.mulDiv(cost, feeBps_, BPS - feeBps_, Math.Rounding.Ceil);
    }

    function _splitFee(uint256 fee) internal returns (uint256 toCreator, uint256 toProtocol) {
        toCreator = fee / 2;
        toProtocol = fee - toCreator;
        creatorFees += toCreator;
        protocolFees += toProtocol;
    }

    function _splitOut(address asset, uint256 amount) internal {
        if (amount == 0) return;
        uint256 half = amount / 2;
        IERC20(asset).safeTransfer(creator, half);
        IERC20(asset).safeTransfer(treasury, amount - half);
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (quote == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(quote).safeTransfer(to, amount);
        }
    }

    /// @dev Reference price in quote units per whole token.
    function _refPrice() internal view returns (uint256 ref, uint256 updatedAt) {
        (, int256 answer,, uint256 at,) = AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0) revert BadFeed();
        ref = Math.mulDiv(uint256(answer), 10 ** _quoteDecimals, 10 ** _feedDecimals);
        updatedAt = at;
    }

    function _checkBand(uint256 priceAfter) internal view {
        _checkSequencer();
        (uint256 ref, uint256 updatedAt) = _refPrice();
        if (updatedAt + maxAge < block.timestamp) revert MarketClosed(updatedAt, maxAge);
        if (priceAfter > Math.mulDiv(ref, BPS + bandBps, BPS)) revert OutsideBand(priceAfter, ref, bandBps);
    }

    function _bandView(uint256 priceAfter) internal view returns (bool bandOk, bool marketOpen, uint256 ref) {
        if (feed == address(0)) return (true, true, 0);
        uint256 updatedAt;
        (, int256 answer,, uint256 at,) = AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0) return (false, false, 0);
        ref = Math.mulDiv(uint256(answer), 10 ** _quoteDecimals, 10 ** _feedDecimals);
        updatedAt = at;
        marketOpen = updatedAt + maxAge >= block.timestamp && _sequencerUp();
        bandOk = priceAfter <= Math.mulDiv(ref, BPS + bandBps, BPS);
    }

    /// @dev Chainlink's L2 guidance: don't trust a feed while the Arbitrum
    /// sequencer is down or has just come back.
    function _checkSequencer() internal view {
        if (!_sequencerUp()) revert SequencerDown();
    }

    function _sequencerUp() internal view returns (bool) {
        if (sequencerFeed == address(0)) return true;
        (, int256 answer, uint256 startedAt,,) = AggregatorV3Interface(sequencerFeed).latestRoundData();
        return answer == 0 && block.timestamp - startedAt > SEQUENCER_GRACE;
    }

    receive() external payable {
        // WETH unwraps are not used; accept ETH only from the position
        // manager's refunds and WETH itself.
        if (msg.sender != weth && msg.sender != positionManager) revert WrongValue();
    }
}
