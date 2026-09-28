// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CurveMathRef} from "../src/CurveMathRef.sol";
import {JunoFactory} from "../src/JunoFactory.sol";
import {JunoCurve} from "../src/JunoCurve.sol";
import {JunoToken} from "../src/JunoToken.sol";
import {ICurveMath, IJunoCurve, IJunoFactory} from "../src/interfaces/IJuno.sol";
import {IUniswapV3Pool} from "../src/external/IUniswapV3.sol";
import {MockAggregator} from "../src/test-helpers/MockAggregator.sol";
import {TestUSDC} from "../src/test-helpers/TestUSDC.sol";

/// Shared setup: a fork of Arbitrum One, so launches create real Uniswap v3
/// pools and graduation mints a real position. Pinned for reproducibility.
abstract contract JunoFixture is Test {
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address constant NPM = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address constant V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    uint256 constant FORK_BLOCK = 509730772;

    CurveMathRef math;
    JunoFactory factory;
    TestUSDC usdc;
    MockAggregator tsla;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");

    uint256 constant P0 = 20_000_000; // wei per whole token: 0.02 ETH at 1B supply
    uint256 constant CAP = 25e18;

    function setUp() public virtual {
        vm.createSelectFork(vm.envString("ARB_ONE_RPC"), FORK_BLOCK);
        math = new CurveMathRef();
        factory = new JunoFactory(ICurveMath(address(math)), WETH, NPM, V3_FACTORY, address(0), treasury, address(this));
        usdc = new TestUSDC();
        tsla = new MockAggregator("TSLA / USD", 8, 361_22000000, block.timestamp);
        factory.setQuote(address(usdc), true);
        factory.setFeed(address(tsla), true);
        _clean();
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(creator, 10 ether);
    }

    /// @dev makeAddr keys are public, and on Arbitrum One they carry EIP-7702
    /// sweeper delegations that forward any ETH they receive. Clear them.
    function _clean() internal {
        vm.etch(creator, "");
        vm.etch(alice, "");
        vm.etch(bob, "");
        vm.etch(treasury, "");
    }

    function _launchPost(uint8 presetId) internal returns (JunoCurve curve, JunoToken token) {
        vm.prank(creator);
        (address c, address t) = factory.launch(
            IJunoFactory.LaunchParams("City After Rain", "NEON", "ipfs://meta", presetId, address(0), P0, CAP), 0
        );
        curve = JunoCurve(payable(c));
        token = JunoToken(t);
    }

    /// TSLA tracker: 10,000 tokens, curve from 1% under to ~1% over the stock.
    function _launchTracker() internal returns (JunoCurve curve, JunoToken token) {
        uint256 ref = 361_220000; // $361.22 in USDC units per token
        vm.prank(creator);
        (address c, address t) = factory.launchTracker(
            IJunoFactory.TrackerParams({
                name: "Tesla tracker",
                symbol: "jTSLA",
                metadataURI: "ipfs://tsla",
                quote: address(usdc),
                feed: address(tsla),
                bandBps: 200,
                maxAge: 26 hours,
                supply: 10_000e18,
                p0: (ref * 99) / 100,
                capFp: 1.02e18
            })
        );
        curve = JunoCurve(payable(c));
        token = JunoToken(t);
    }

    function _fullCost(JunoCurve curve) internal view returns (uint256) {
        return math.costToBuy(curve.preset(), curve.p0(), curve.capFp(), curve.curveSupply(), 0, curve.curveSupply());
    }
}

contract JunoLaunchTest is JunoFixture {
    function test_launchCreatesTokenCurveAndPricedPool() public {
        (JunoCurve curve, JunoToken token) = _launchPost(0);
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.balanceOf(address(curve)), token.totalSupply());
        assertEq(curve.curveSupply(), 200_000_000e18);
        assertEq(curve.creator(), creator);
        assertEq(factory.curveOf(address(token)), address(curve));
        assertEq(token.metadataURI(), "ipfs://meta");

        // The pool exists and is already priced at the curve's final price.
        IUniswapV3Pool pool = IUniswapV3Pool(curve.pool());
        (uint160 sqrtP,,,,,,) = pool.slot0();
        assertGt(sqrtP, 0);
        uint256 finalPrice = curve.graduationPrice();
        uint256 poolPrice = address(token) < WETH
            ? (uint256(sqrtP) * uint256(sqrtP) * 1e18) >> 192
            : (1e18 << 192) / (uint256(sqrtP) * uint256(sqrtP));
        assertApproxEqRel(poolPrice, finalPrice, 1e14); // 0.01%
        assertApproxEqRel(finalPrice, P0 * 25, 1e15);
    }

    function test_launchWithFirstBuy() public {
        vm.prank(creator);
        (address c, address t) = factory.launch{value: 0.001 ether}(
            IJunoFactory.LaunchParams("Reel", "REEL", "ipfs://r", 0, address(0), P0, CAP), 1
        );
        assertGt(IERC20(t).balanceOf(creator), 0);
        assertEq(JunoCurve(payable(c)).sold(), IERC20(t).balanceOf(creator));
    }

    function test_rejectsBadLaunches() public {
        vm.startPrank(creator);
        vm.expectRevert(IJunoFactory.BadPreset.selector);
        factory.launch(IJunoFactory.LaunchParams("x", "x", "", 3, address(0), P0, 2e18), 0); // tracker-only
        vm.expectRevert(IJunoFactory.BadPreset.selector);
        factory.launch(IJunoFactory.LaunchParams("x", "x", "", 9, address(0), P0, CAP), 0);
        vm.expectRevert(IJunoFactory.BadCap.selector);
        factory.launch(IJunoFactory.LaunchParams("x", "x", "", 0, address(0), P0, 1.5e18), 0);
        vm.expectRevert(IJunoFactory.BadQuote.selector);
        factory.launch(IJunoFactory.LaunchParams("x", "x", "", 0, makeAddr("junk"), P0, CAP), 0);
        vm.expectRevert(IJunoFactory.BadParams.selector);
        factory.launch(IJunoFactory.LaunchParams("x", "x", "", 0, address(0), 0, CAP), 0);
        vm.stopPrank();
    }

    function test_rejectsBadTrackers() public {
        IJunoFactory.TrackerParams memory p = IJunoFactory.TrackerParams(
            "t", "t", "", address(usdc), address(tsla), 200, 26 hours, 10_000e18, 358_000000, 1.02e18
        );
        p.feed = makeAddr("unlisted");
        vm.expectRevert(IJunoFactory.BadFeed.selector);
        factory.launchTracker(p);
        p.feed = address(tsla);
        p.quote = address(0);
        vm.expectRevert(IJunoFactory.BadQuote.selector);
        factory.launchTracker(p);
        p.quote = address(usdc);
        p.bandBps = 5;
        vm.expectRevert(IJunoFactory.BadParams.selector);
        factory.launchTracker(p);
        p.bandBps = 200;
        p.capFp = 4e18;
        vm.expectRevert(IJunoFactory.BadCap.selector);
        factory.launchTracker(p);
    }

    function test_onlyOwnerCurates() public {
        vm.prank(alice);
        vm.expectRevert();
        factory.setFeed(alice, true);
    }
}

contract JunoTradeTest is JunoFixture {
    JunoCurve curve;
    JunoToken token;

    function setUp() public override {
        super.setUp();
        (curve, token) = _launchPost(0);
    }

    function _solvent() internal view {
        assertGe(address(curve).balance, curve.quoteReserve() + curve.creatorFees() + curve.protocolFees());
        uint256 buyback = curve.sold() == 0
            ? 0
            : math.proceedsToSell(curve.preset(), curve.p0(), curve.capFp(), curve.curveSupply(), curve.sold(), curve.sold());
        assertGe(curve.quoteReserve(), buyback);
    }

    function test_buySplitsFeesAndMatchesQuote() public {
        IJunoCurve.BuyQuote memory q = curve.quoteBuy(0.001 ether);
        vm.expectEmit(true, false, false, false, address(curve));
        emit IJunoCurve.Trade(alice, true, 0, 0, 0, 0, 0, 0);
        vm.prank(alice);
        uint256 out = curve.buy{value: 0.001 ether}(q.tokensOut, block.timestamp);
        assertEq(out, q.tokensOut);
        assertEq(token.balanceOf(alice), out);
        assertEq(curve.sold(), out);
        // 9% launch fee, split evenly.
        assertApproxEqAbs(curve.creatorFees() + curve.protocolFees(), 0.00009 ether, 1e9);
        assertApproxEqAbs(curve.creatorFees(), curve.protocolFees(), 1);
        assertGt(curve.currentPrice(), P0);
        _solvent();
    }

    function test_sellNeedsNoApprove() public {
        vm.prank(alice);
        uint256 out = curve.buy{value: 0.001 ether}(0, block.timestamp);
        uint256 before = alice.balance;
        IJunoCurve.SellQuote memory q = curve.quoteSell(out);
        vm.prank(alice);
        uint256 got = curve.sell(out, q.quoteOut, block.timestamp);
        assertEq(got, q.quoteOut);
        assertEq(alice.balance, before + got);
        assertEq(token.balanceOf(alice), 0);
        assertEq(curve.sold(), 0);
        assertLt(got, 0.001 ether);
        _solvent();
    }

    function testFuzz_roundTripNeverProfits(uint96 amountIn, uint32 wait) public {
        uint256 value = bound(amountIn, 1e9, 0.09 ether);
        vm.prank(alice);
        uint256 out = curve.buy{value: value}(0, block.timestamp);
        vm.warp(vm.getBlockTimestamp() + bound(wait, 0, 2 days));
        vm.prank(alice);
        uint256 back = curve.sell(out, 0, block.timestamp);
        assertLe(back, value);
        _solvent();
    }

    function testFuzz_interleavedTradersStaySolvent(uint96 a, uint96 b, bool bobSells) public {
        vm.prank(alice);
        // The whole curve costs ~0.1 ETH at this p0; stay below the fill.
        curve.buy{value: bound(a, 1e9, 0.04 ether)}(0, block.timestamp);
        vm.prank(bob);
        uint256 bobOut = curve.buy{value: bound(b, 1e9, 0.04 ether)}(0, block.timestamp);
        if (bobSells) {
            vm.prank(bob);
            curve.sell(bobOut, 0, block.timestamp);
        }
        uint256 aliceTokens = token.balanceOf(alice);
        vm.prank(alice);
        curve.sell(aliceTokens, 0, block.timestamp);
        _solvent();
    }

    function test_slippageAndDeadline() public {
        IJunoCurve.BuyQuote memory q = curve.quoteBuy(0.001 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IJunoCurve.Slippage.selector, q.tokensOut, q.tokensOut + 1));
        curve.buy{value: 0.001 ether}(q.tokensOut + 1, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(IJunoCurve.Expired.selector);
        curve.buy{value: 0.001 ether}(0, block.timestamp - 1);
        vm.prank(alice);
        vm.expectRevert(IJunoCurve.ZeroAmount.selector);
        curve.buy{value: 0}(0, block.timestamp);
    }

    function test_buyExactOutRefundsChange() public {
        uint256 want = 1_000_000e18;
        IJunoCurve.BuyQuote memory q = curve.quoteBuyExactOut(want);
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 paid = curve.buyExactOut{value: q.quoteIn + 1 ether}(want, q.quoteIn, block.timestamp);
        assertEq(paid, q.quoteIn);
        assertEq(token.balanceOf(alice), want);
        assertEq(alice.balance, before - paid);
        vm.prank(alice);
        vm.expectRevert();
        curve.buyExactOut{value: 1 ether}(want, q.quoteIn / 2, block.timestamp);
    }

    function test_feeDecays() public {
        uint256 t0 = vm.getBlockTimestamp();
        assertEq(curve.currentFeeBps(), 900);
        vm.warp(t0 + 300);
        uint256 mid = curve.currentFeeBps();
        assertEq(mid, 165); // 100 + 800 * e^-2.5
        vm.warp(t0 + 600);
        assertEq(curve.currentFeeBps(), 100);
    }

    function test_creatorClaims() public {
        vm.prank(alice);
        curve.buy{value: 0.01 ether}(0, block.timestamp);
        uint256 owed = curve.creatorFees();
        assertGt(owed, 0);
        vm.prank(alice);
        vm.expectRevert(IJunoCurve.NotCreator.selector);
        curve.claimCreatorFees();
        uint256 before = creator.balance;
        vm.prank(creator);
        curve.claimCreatorFees();
        assertEq(creator.balance, before + owed);
        assertEq(curve.creatorFees(), 0);
        vm.prank(creator);
        vm.expectRevert(IJunoCurve.ZeroAmount.selector);
        curve.claimCreatorFees();

        uint256 proto = curve.protocolFees();
        curve.claimProtocolFees();
        assertEq(treasury.balance, proto);
        _solvent();
    }

    function test_poolLockedUntilGraduation() public {
        vm.prank(alice);
        uint256 out = curve.buy{value: 0.001 ether}(0, block.timestamp);
        address pool = curve.pool();
        vm.prank(alice);
        vm.expectRevert(JunoToken.PoolLocked.selector);
        token.transfer(pool, out);
        vm.prank(alice);
        token.transfer(bob, out); // ordinary transfers are fine
    }

    function test_fillRefundsAndGraduates() public {
        uint256 cost = _fullCost(curve);
        uint256 before = alice.balance;
        vm.prank(alice);
        curve.buy{value: cost * 2}(0, block.timestamp);
        assertEq(curve.sold(), curve.curveSupply());
        uint256 spent = before - alice.balance;
        assertLt(spent, cost * 2); // change came back
        assertGe(spent, cost);

        vm.prank(bob);
        vm.expectRevert(IJunoCurve.SoldOut.selector);
        curve.buy{value: 1 ether}(0, block.timestamp);

        uint256 reserve = curve.quoteReserve();
        vm.expectEmit(true, false, false, false, address(curve));
        emit IJunoCurve.Graduated(curve.pool(), 0, 0, 0, 0);
        curve.graduate();
        assertTrue(curve.graduated());
        assertTrue(token.graduated());
        assertGt(curve.positionId(), 0);
        IUniswapV3Pool pool = IUniswapV3Pool(curve.pool());
        assertGt(pool.liquidity(), 0);
        assertApproxEqRel(IERC20(WETH).balanceOf(address(pool)), reserve, 1e15);
        assertEq(token.balanceOf(address(curve)), 0); // rest burned
        assertLt(token.totalSupply(), 1_000_000_000e18);

        vm.expectRevert(IJunoCurve.AlreadyGraduated.selector);
        curve.graduate();
        vm.prank(alice);
        vm.expectRevert(IJunoCurve.AlreadyGraduated.selector);
        curve.sell(1e18, 0, block.timestamp);

        // After graduation the token moves freely, pool included.
        vm.prank(alice);
        token.transfer(address(pool), 1e18);
        curve.collectLpFees();
    }

    function test_cannotGraduateEarly() public {
        vm.expectRevert(IJunoCurve.NotFull.selector);
        curve.graduate();
        vm.expectRevert(IJunoCurve.NotGraduated.selector);
        curve.collectLpFees();
    }

    function test_allPresetsGraduate() public {
        for (uint8 id = 0; id < 3; id++) {
            (JunoCurve c,) = _launchPost(id);
            uint256 value = _fullCost(c) * 2;
            vm.prank(alice);
            c.buy{value: value}(0, block.timestamp);
            c.graduate();
            assertGt(IUniswapV3Pool(c.pool()).liquidity(), 0);
        }
    }
}

contract JunoTrackerTest is JunoFixture {
    JunoCurve curve;
    JunoToken token;

    function setUp() public override {
        super.setUp();
        (curve, token) = _launchTracker();
        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(curve), type(uint256).max);
    }

    function test_inBandBuySucceeds() public {
        IJunoCurve.BuyQuote memory q = curve.quoteBuy(1_000e6);
        assertTrue(q.bandOk);
        assertTrue(q.marketOpen);
        assertEq(q.refPrice, 361_220000);
        vm.prank(alice);
        uint256 out = curve.buyWithQuote(1_000e6, q.tokensOut, block.timestamp);
        assertGt(out, 2e18); // ~2.7 tokens at ~$361
        assertEq(usdc.balanceOf(address(curve)), 1_000e6);
    }

    function test_outOfBandBuyReverts() public {
        // The stock drops 5%: the curve (~$358) now sits above the 2% band.
        tsla.setAnswer(343_159000_00, block.timestamp);
        IJunoCurve.BuyQuote memory q = curve.quoteBuy(100e6);
        assertFalse(q.bandOk);
        vm.prank(alice);
        vm.expectPartialRevert(IJunoCurve.OutsideBand.selector);
        curve.buyWithQuote(100e6, 0, block.timestamp);
    }

    function test_bigBuyThatWouldBreachBandReverts() public {
        // The curve (~$357.61) sits just under the band ($350.80 x 1.02 =
        // $357.82). A small buy fits; a $60k buy would lift it past the band.
        tsla.setAnswer(350_800000_00, block.timestamp);
        for (uint256 i; i < 6; i++) usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        curve.buyWithQuote(100e6, 0, block.timestamp);
        vm.prank(alice);
        vm.expectPartialRevert(IJunoCurve.OutsideBand.selector);
        curve.buyWithQuote(60_000e6, 0, block.timestamp);
    }

    function test_staleFeedBlocksBuysNotSells() public {
        vm.prank(alice);
        uint256 out = curve.buyWithQuote(500e6, 0, block.timestamp);
        vm.warp(vm.getBlockTimestamp() + 27 hours);
        IJunoCurve.BuyQuote memory q = curve.quoteBuy(100e6);
        assertFalse(q.marketOpen);
        vm.prank(alice);
        vm.expectPartialRevert(IJunoCurve.MarketClosed.selector);
        curve.buyWithQuote(100e6, 0, block.timestamp);
        // Sells stay open.
        vm.prank(alice);
        uint256 back = curve.sell(out, 0, block.timestamp);
        assertGt(back, 0);
        assertLt(back, 500e6);
    }

    function test_badFeedAnswerReverts() public {
        tsla.setAnswer(0, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(IJunoCurve.BadFeed.selector);
        curve.buyWithQuote(100e6, 0, block.timestamp);
    }

    function test_ethBuyRejectedOnUsdcCurve() public {
        vm.prank(alice);
        vm.expectRevert(IJunoCurve.WrongValue.selector);
        curve.buy{value: 1 ether}(0, block.timestamp);
    }
}

contract JunoSequencerTest is JunoFixture {
    MockAggregator sequencer;

    function setUp() public override {
        vm.createSelectFork(vm.envString("ARB_ONE_RPC"), FORK_BLOCK);
        math = new CurveMathRef();
        sequencer = new MockAggregator("L2 Sequencer Uptime", 0, 0, block.timestamp - 2 hours);
        factory = new JunoFactory(ICurveMath(address(math)), WETH, NPM, V3_FACTORY, address(sequencer), treasury, address(this));
        usdc = new TestUSDC();
        tsla = new MockAggregator("TSLA / USD", 8, 361_22000000, block.timestamp);
        factory.setQuote(address(usdc), true);
        factory.setFeed(address(tsla), true);
        _clean();
    }

    function test_sequencerDownBlocksTrackerBuys() public {
        (JunoCurve curve,) = _launchTracker();
        usdc.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(address(curve), type(uint256).max);
        curve.buyWithQuote(100e6, 0, block.timestamp); // up for 2h: fine
        vm.stopPrank();

        sequencer.setAnswer(1, block.timestamp); // down
        vm.prank(alice);
        vm.expectRevert(IJunoCurve.SequencerDown.selector);
        curve.buyWithQuote(100e6, 0, block.timestamp);

        sequencer.setAnswer(0, block.timestamp); // back, but inside the grace hour
        vm.prank(alice);
        vm.expectRevert(IJunoCurve.SequencerDown.selector);
        curve.buyWithQuote(100e6, 0, block.timestamp);
    }
}

contract JunoEdgeTest is JunoFixture {
    function test_viewsAndAdmin() public {
        (JunoCurve curve, JunoToken token) = _launchPost(1);
        assertEq(factory.curveCount(), 1);
        assertEq(factory.curves(0), address(curve));
        IJunoFactory.Preset memory pr = factory.preset(1);
        assertEq(pr.feeStartBps, 500);
        vm.expectRevert(IJunoFactory.BadPreset.selector);
        factory.preset(4);
        factory.setTreasury(bob);
        assertEq(factory.treasury(), bob);

        IJunoCurve.State memory s = curve.state();
        assertEq(s.token, address(token));
        assertEq(s.feeBps, 500);
        assertEq(s.price, P0);
        (uint256[] memory prices, uint256[] memory sizes) = math.boundaries(1, P0, CAP, s.curveSupply);
        assertEq(prices.length, 17);
        assertEq(sizes.length, 16);
        assertEq(prices[16], s.graduationPrice);

        // Empty and impossible quotes return zeros rather than reverting.
        assertEq(curve.quoteBuy(0).tokensOut, 0);
        assertEq(curve.quoteSell(1).quoteOut, 0);
        assertEq(curve.quoteBuyExactOut(s.curveSupply + 1).quoteIn, 0);

        vm.prank(alice);
        vm.expectRevert(IJunoCurve.WrongValue.selector);
        payable(address(curve)).transfer(1 ether);
        vm.expectRevert(IJunoCurve.ZeroAmount.selector);
        curve.claimProtocolFees();
        vm.prank(alice);
        vm.expectRevert(IJunoCurve.WrongValue.selector);
        curve.buyWithQuote(1, 0, block.timestamp);
    }

    function test_usdcExactOutAndClaims() public {
        (JunoCurve curve, JunoToken token) = _launchTracker();
        usdc.mint(alice, 5_000e6);
        vm.startPrank(alice);
        usdc.approve(address(curve), type(uint256).max);
        IJunoCurve.BuyQuote memory q = curve.quoteBuyExactOut(3e18);
        assertTrue(q.bandOk && q.marketOpen);
        uint256 paid = curve.buyExactOut(3e18, q.quoteIn, block.timestamp);
        assertEq(paid, q.quoteIn);
        assertEq(token.balanceOf(alice), 3e18);
        vm.expectRevert(IJunoCurve.WrongValue.selector);
        curve.buyExactOut{value: 1}(1e18, type(uint256).max, block.timestamp);
        vm.stopPrank();

        uint256 owed = curve.creatorFees();
        vm.prank(creator);
        curve.claimCreatorFees();
        assertEq(usdc.balanceOf(creator), owed);
        curve.claimProtocolFees();
        assertGt(usdc.balanceOf(treasury), 0);
    }

    function test_graduatedQuotesAreEmpty() public {
        (JunoCurve curve,) = _launchPost(2);
        uint256 value = _fullCost(curve) * 2;
        vm.prank(alice);
        curve.buy{value: value}(0, block.timestamp);
        curve.graduate();
        assertEq(curve.quoteBuy(1 ether).tokensOut, 0);
        assertEq(curve.quoteSell(1e18).quoteOut, 0);
        assertEq(curve.quoteBuyExactOut(1e18).quoteIn, 0);
        vm.prank(bob);
        vm.expectRevert(IJunoCurve.AlreadyGraduated.selector);
        curve.buy{value: 1 ether}(0, block.timestamp);
    }
}

/// Random buys, sells and claims by three traders. After every step the
/// curve must hold at least what it owes and be able to buy back everything.
contract JunoHandler is Test {
    JunoCurve curve;
    JunoToken token;
    address[3] traders;

    constructor(JunoCurve curve_, JunoToken token_, address[3] memory traders_) {
        curve = curve_;
        token = token_;
        traders = traders_;
    }

    function buy(uint8 who, uint96 amount) external {
        if (curve.sold() >= curve.curveSupply()) return;
        address t = traders[who % 3];
        vm.prank(t);
        curve.buy{value: bound(amount, 1e9, 0.03 ether)}(0, block.timestamp);
    }

    function sell(uint8 who, uint256 share) external {
        address t = traders[who % 3];
        uint256 bal = token.balanceOf(t);
        if (bal == 0) return;
        uint256 amt = bound(share, 1, bal);
        vm.prank(t);
        curve.sell(amt, 0, block.timestamp);
    }

    function claim() external {
        if (curve.creatorFees() == 0) return;
        vm.prank(curve.creator());
        curve.claimCreatorFees();
    }

    function wait(uint32 s) external {
        vm.warp(vm.getBlockTimestamp() + bound(s, 1, 1 hours));
    }
}

/// Stand-ins for the Uniswap v3 factory and pool. Trading never touches
/// Uniswap (only launch and graduation do), so the invariant run needs no
/// fork and can afford the full 128 x 64 campaign.
contract StubPool {
    function initialize(uint160) external {}
}

contract StubV3Factory {
    function getPool(address, address, uint24) external pure returns (address) {
        return address(0);
    }

    function createPool(address, address, uint24) external returns (address) {
        return address(new StubPool());
    }

    function feeAmountTickSpacing(uint24) external pure returns (int24) {
        return 200;
    }
}

contract JunoInvariantTest is Test {
    CurveMathRef math;
    JunoCurve curve;
    JunoToken token;
    JunoHandler handler;

    function setUp() public {
        math = new CurveMathRef();
        JunoFactory factory = new JunoFactory(
            ICurveMath(address(math)), address(0xE7), address(0xA7), address(new StubV3Factory()), address(0), address(0xBEEF), address(this)
        );
        address creator = makeAddr("creator");
        vm.prank(creator);
        (address c, address t) = factory.launch(IJunoFactory.LaunchParams("Inv", "INV", "", 0, address(0), 20_000_000, 25e18), 0);
        curve = JunoCurve(payable(c));
        token = JunoToken(t);
        address[3] memory traders = [makeAddr("t0"), makeAddr("t1"), makeAddr("t2")];
        for (uint256 i; i < 3; i++) vm.deal(traders[i], 1_000 ether);
        handler = new JunoHandler(curve, token, traders);
        targetContract(address(handler));
    }

    function invariant_solvent() public view {
        assertGe(address(curve).balance, curve.quoteReserve() + curve.creatorFees() + curve.protocolFees());
    }

    function invariant_canBuyBackEverything() public view {
        uint256 s = curve.sold();
        if (s == 0) return;
        uint256 owed = math.proceedsToSell(curve.preset(), curve.p0(), curve.capFp(), curve.curveSupply(), s, s);
        assertGe(curve.quoteReserve(), owed);
    }

    function invariant_supplyConserved() public view {
        assertEq(token.balanceOf(address(curve)) + curve.sold(), token.totalSupply());
    }

    function invariant_neverOversold() public view {
        assertLe(curve.sold(), curve.curveSupply());
    }
}
