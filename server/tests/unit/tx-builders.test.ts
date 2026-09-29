import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  erc20Abi,
  parseEther,
  parseUnits,
  zeroAddress,
} from "viem";

import { junoCurveAbi, junoFactoryAbi } from "@config/abi";

/**
 * The transaction builders, with every chain read mocked. Each test decodes
 * the calldata the builder returns with the real ABI and asserts the
 * function and its arguments — the same bytes the app would send.
 */

const CURVE = "0x00000000000000000000000000000000000c0001";
const TOKEN = "0x00000000000000000000000000000000000c0002";
const USDC = "0x00000000000000000000000000000000000c0003";
const FACTORY = "0x00000000000000000000000000000000000fac70";
const TRADER = "0x1111111111111111111111111111111111111111";
const CREATOR = "0x2222222222222222222222222222222222222222";
const E18 = 10n ** 18n;

const mocks = vi.hoisted(() => ({
  simulateContract: vi.fn(),
  estimateGas: vi.fn(),
  readCurveState: vi.fn(),
  quoteBuy: vi.fn(),
  quoteBuyExactOut: vi.fn(),
  quoteSell: vi.fn(),
  ethBalance: vi.fn(),
  tokenBalances: vi.fn(),
  allowance: vi.fn(),
  readFactoryPreset: vi.fn(),
}));

vi.mock("@/lib/juno/chains", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/juno/chains")>();
  return {
    ...actual,
    requireDeployment: () => ({ chainId: 421614, factory: FACTORY, curveMath: null, usdc: USDC, weth: zeroAddress, feeds: {} }),
    publicClient: () => ({
      simulateContract: mocks.simulateContract,
      estimateGas: mocks.estimateGas,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 0n }),
    }),
  };
});

vi.mock("@/lib/juno/chainlink", () => ({ quoteUsdRate: async (symbol: string) => (symbol === "USDC" ? 1 : 2500) }));

vi.mock("@/lib/juno/onchain", () => ({
  readCurveState: mocks.readCurveState,
  quoteBuy: mocks.quoteBuy,
  quoteBuyExactOut: mocks.quoteBuyExactOut,
  quoteSell: mocks.quoteSell,
  ethBalance: mocks.ethBalance,
  tokenBalances: mocks.tokenBalances,
  allowance: mocks.allowance,
  readFactoryPreset: mocks.readFactoryPreset,
}));

const { buildClaim, buildGraduate, buildLaunch, buildSwap, capFpOf, launchP0, padGas, parseAmount, revertMessage, simulationError } =
  await import("@/lib/juno/tx");
const { CallerError } = await import("@/lib/juno/api");

function state(over: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    quote: zeroAddress,
    creator: CREATOR,
    preset: 0,
    p0: 20_000_000n,
    capFp: 25n * E18,
    supply: 1_000_000_000n * E18,
    curveSupply: 800_000_000n * E18,
    sold: 1_000n * E18,
    quoteReserve: 10n ** 15n,
    creatorFees: 5n * 10n ** 13n,
    protocolFees: 5n * 10n ** 13n,
    feeBps: 100n,
    price: 20_000_000n,
    graduationPrice: 500_000_000n,
    graduated: false,
    pool: "0x5555555555555555555555555555555555555555",
    positionId: 0n,
    feed: zeroAddress,
    bandBps: 0,
    maxAge: 0,
    launchedAt: 1n,
    ...over,
  };
}

const row = (over: Record<string, unknown> = {}) =>
  ({
    token: TOKEN,
    curve: CURVE,
    creator: CREATOR,
    quote: null,
    quoteSymbol: "ETH",
    quoteDecimals: 18,
    preset: 0,
    feed: null,
    symbol: "POST",
    chainId: 421614,
    ...over,
  }) as never;

const buyQuote = (over: Record<string, unknown> = {}) => ({
  tokensOut: 400_000n * E18,
  quoteIn: parseEther("0.01"),
  fee: parseEther("0.0001"),
  priceAfter: 21_000_000n,
  bandOk: true,
  marketOpen: true,
  refPrice: 0n,
  ...over,
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.simulateContract.mockResolvedValue({ result: undefined });
  mocks.estimateGas.mockResolvedValue(100_000n);
  mocks.readCurveState.mockResolvedValue(state());
  mocks.ethBalance.mockResolvedValue(parseEther("1"));
  mocks.tokenBalances.mockResolvedValue([parseUnits("5000", 6)]);
  mocks.allowance.mockResolvedValue(0n);
});

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as InstanceType<typeof CallerError>;
  }
  throw new Error("expected a rejection");
}

describe("buildSwap: buys", () => {
  it("builds buy(minOut, deadline) with the ETH as value, simulated from the trader", async () => {
    mocks.quoteBuy.mockResolvedValue(buyQuote());
    const before = Math.floor(Date.now() / 1000);
    const build = await buildSwap({ chainId: 421614, row: row(), trader: TRADER, side: "buy", amountIn: "0.01" });

    expect(build.chainId).toBe(421614);
    expect(build.steps).toHaveLength(1);
    const [step] = build.steps;
    expect(step).toMatchObject({ label: "Buy", to: CURVE, value: parseEther("0.01").toString(), gas: "130000" });
    const call = decodeFunctionData({ abi: junoCurveAbi, data: step.data });
    expect(call.functionName).toBe("buy");
    const [minOut, deadline] = call.args as readonly [bigint, bigint];
    expect(minOut).toBe((400_000n * E18 * 9_900n) / 10_000n);
    expect(Number(deadline)).toBeGreaterThanOrEqual(before + 600);
    expect(Number(deadline)).toBeLessThanOrEqual(before + 602);

    expect(mocks.quoteBuy).toHaveBeenCalledWith(421614, CURVE, parseEther("0.01"));
    expect(mocks.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ account: TRADER, address: CURVE, functionName: "buy", value: parseEther("0.01") }),
    );
    expect(build.quote).toMatchObject({ side: "buy", amountOut: 400_000, minimumAmountOut: 396_000, slippageBps: 100 });
    expect(build.quoteUsdRate).toBe(2500);
  });

  it("honours slippageBps", async () => {
    mocks.quoteBuy.mockResolvedValue(buyQuote());
    const build = await buildSwap({ chainId: 421614, row: row(), trader: TRADER, side: "buy", amountIn: 0.01, slippageBps: 500 });
    const [minOut] = decodeFunctionData({ abi: junoCurveAbi, data: build.steps[0].data }).args as readonly [bigint];
    expect(minOut).toBe((400_000n * E18 * 9_500n) / 10_000n);
  });

  it("puts an approve first when the USDC allowance is short, and does not simulate the buy yet", async () => {
    mocks.readCurveState.mockResolvedValue(state({ quote: USDC }));
    mocks.quoteBuy.mockResolvedValue(buyQuote({ quoteIn: parseUnits("25", 6), fee: parseUnits("0.25", 6), tokensOut: 100n * E18 }));
    mocks.allowance.mockResolvedValue(parseUnits("1", 6));
    const build = await buildSwap({
      chainId: 421614,
      row: row({ quote: USDC, quoteSymbol: "USDC", quoteDecimals: 6 }),
      trader: TRADER,
      side: "buy",
      amountIn: "25",
    });

    expect(build.steps.map((s) => s.label)).toEqual(["Approve USDC", "Buy"]);
    const approve = decodeFunctionData({ abi: erc20Abi, data: build.steps[0].data });
    expect(build.steps[0].to).toBe(USDC);
    expect(approve.functionName).toBe("approve");
    expect((approve.args[0] as string).toLowerCase()).toBe(CURVE);
    expect(approve.args[1]).toBe(parseUnits("25", 6));

    const buy = decodeFunctionData({ abi: junoCurveAbi, data: build.steps[1].data });
    expect(buy.functionName).toBe("buyWithQuote");
    expect((buy.args as readonly bigint[])[0]).toBe(parseUnits("25", 6));
    expect(build.steps[1].value).toBe("0");
    expect(mocks.simulateContract).not.toHaveBeenCalled();
    // The buy is estimated as if the approve had landed: a state override on the allowance slot.
    const buyEstimate = mocks.estimateGas.mock.calls[1][0];
    expect(buyEstimate.stateOverride[0].address).toBe(USDC);
    expect(build.steps.map((s) => s.gas)).toEqual(["130000", "130000"]);
  });

  it("falls back to a fixed gas limit when the pending buy cannot be estimated", async () => {
    mocks.readCurveState.mockResolvedValue(state({ quote: USDC }));
    mocks.quoteBuy.mockResolvedValue(buyQuote({ quoteIn: parseUnits("25", 6), tokensOut: 100n * E18 }));
    mocks.estimateGas.mockResolvedValueOnce(50_000n).mockRejectedValueOnce(new Error("execution reverted"));
    const build = await buildSwap({
      chainId: 421614,
      row: row({ quote: USDC, quoteSymbol: "USDC", quoteDecimals: 6 }),
      trader: TRADER,
      side: "buy",
      amountIn: "25",
    });
    expect(build.steps.map((s) => s.gas)).toEqual(["65000", "1500000"]);
  });

  it("skips the approve and simulates when the allowance already covers it", async () => {
    mocks.readCurveState.mockResolvedValue(state({ quote: USDC }));
    mocks.quoteBuy.mockResolvedValue(buyQuote({ quoteIn: parseUnits("25", 6), tokensOut: 100n * E18 }));
    mocks.allowance.mockResolvedValue(parseUnits("100", 6));
    const build = await buildSwap({
      chainId: 421614,
      row: row({ quote: USDC, quoteSymbol: "USDC", quoteDecimals: 6 }),
      trader: TRADER,
      side: "buy",
      amountIn: "25",
    });
    expect(build.steps.map((s) => s.label)).toEqual(["Buy"]);
    expect(mocks.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "buyWithQuote" }));
  });

  it("builds an exact-out buy with maxIn above the quote, paid as value", async () => {
    mocks.quoteBuyExactOut.mockResolvedValue(buyQuote({ tokensOut: 1_000n * E18, quoteIn: parseEther("0.02") }));
    const build = await buildSwap({ chainId: 421614, row: row(), trader: TRADER, side: "buy", amountOut: "1000" });
    const call = decodeFunctionData({ abi: junoCurveAbi, data: build.steps[0].data });
    expect(call.functionName).toBe("buyExactOut");
    const [tokensOut, maxIn] = call.args as readonly [bigint, bigint, bigint];
    expect(tokensOut).toBe(1_000n * E18);
    expect(maxIn).toBe(parseEther("0.0202"));
    expect(build.steps[0].value).toBe(parseEther("0.0202").toString());
    expect(build.quote).toMatchObject({ exactOut: true, amountIn: 0.02, maximumAmountIn: 0.0202 });
  });

  it("refuses a buy the wallet can pay for but not its gas", async () => {
    mocks.quoteBuy.mockResolvedValue(buyQuote());
    // 0.01 ETH buy + 130,000 gas at 0.1 gwei (0.000013 ETH) = 0.010013 ETH needed.
    mocks.ethBalance.mockResolvedValue(parseEther("0.010005"));
    const error = await rejection(buildSwap({ chainId: 421614, row: row(), trader: TRADER, side: "buy", amountIn: "0.01" }));
    expect(error).toBeInstanceOf(CallerError);
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/Not enough ETH/);
    expect(error.extra.needed).toBe(0.010013);
  });

  it("refuses a buy larger than the balance before simulating anything", async () => {
    mocks.quoteBuy.mockResolvedValue(buyQuote());
    mocks.ethBalance.mockResolvedValue(parseEther("0.005"));
    const error = await rejection(buildSwap({ chainId: 421614, row: row(), trader: TRADER, side: "buy", amountIn: "0.01" }));
    expect(error.message).toMatch(/Not enough ETH/);
    expect(mocks.simulateContract).not.toHaveBeenCalled();
  });

  it("builds a buy for a wallet holding only the buy plus its real gas (no flat reserve)", async () => {
    mocks.quoteBuy.mockResolvedValue(buyQuote());
    mocks.ethBalance.mockResolvedValue(parseEther("0.010014"));
    const build = await buildSwap({ chainId: 421614, row: row(), trader: TRADER, side: "buy", amountIn: "0.01" });
    expect(build.steps).toHaveLength(1);
  });

  it("refuses a tracker buy the contract would reject for the band or a stale feed", async () => {
    const tracker = row({ feed: "0x3609baaa0a9b1f0fe4d6cc01884585d0e191c3e3", quote: USDC, quoteSymbol: "USDC", quoteDecimals: 6 });
    mocks.readCurveState.mockResolvedValue(state({ quote: USDC, bandBps: 200 }));
    mocks.quoteBuy.mockResolvedValue(buyQuote({ bandOk: false }));
    const band = await rejection(buildSwap({ chainId: 421614, row: tracker, trader: TRADER, side: "buy", amountIn: "25" }));
    expect(band.message).toBe("This buy would push the price more than 2% above the stock. Try a smaller amount.");
    expect(band.extra.reason).toBe("OutsideBand");

    mocks.quoteBuy.mockResolvedValue(buyQuote({ marketOpen: false }));
    const closed = await rejection(buildSwap({ chainId: 421614, row: tracker, trader: TRADER, side: "buy", amountIn: "25" }));
    expect(closed.message).toMatch(/^Market closed/);
  });

  it("says a graduated market moved to Uniswap", async () => {
    mocks.readCurveState.mockResolvedValue(state({ graduated: true }));
    const error = await rejection(buildSwap({ chainId: 421614, row: row(), trader: TRADER, side: "buy", amountIn: "0.01" }));
    expect(error.message).toBe("This market moved to Uniswap.");
  });

  it("maps a simulation revert to the app's words", async () => {
    mocks.quoteBuy.mockResolvedValue(buyQuote());
    mocks.simulateContract.mockRejectedValue(
      new ContractFunctionRevertedError({
        abi: junoCurveAbi,
        functionName: "buy",
        data: encodeErrorResult({ abi: junoCurveAbi, errorName: "Slippage", args: [1n, 2n] }),
      }),
    );
    const error = await rejection(buildSwap({ chainId: 421614, row: row(), trader: TRADER, side: "buy", amountIn: "0.01" }));
    expect(error.message).toBe("The price moved. Try again or raise slippage.");
    expect(error.extra.reason).toBe("Slippage");
  });
});

describe("buildSwap: quoteOnly (visitors)", () => {
  it("quotes a buy with no balance reads, no simulation and no steps", async () => {
    mocks.quoteBuy.mockResolvedValue(buyQuote());
    mocks.ethBalance.mockResolvedValue(0n);
    const build = await buildSwap({ chainId: 421614, row: row(), trader: zeroAddress, side: "buy", amountIn: "0.01", quoteOnly: true });
    expect(build.steps).toEqual([]);
    expect(build.quote).toMatchObject({ side: "buy", amountOut: 400_000, fee: 0.0001 });
    expect(mocks.ethBalance).not.toHaveBeenCalled();
    expect(mocks.allowance).not.toHaveBeenCalled();
    expect(mocks.simulateContract).not.toHaveBeenCalled();
    expect(mocks.estimateGas).not.toHaveBeenCalled();
  });

  it("still refuses a tracker buy outside the band, as the contract would", async () => {
    const tracker = row({ feed: "0x3609baaa0a9b1f0fe4d6cc01884585d0e191c3e3", quote: USDC, quoteSymbol: "USDC", quoteDecimals: 6 });
    mocks.readCurveState.mockResolvedValue(state({ quote: USDC, bandBps: 100 }));
    mocks.quoteBuy.mockResolvedValue(buyQuote({ bandOk: false }));
    const band = await rejection(buildSwap({ chainId: 421614, row: tracker, trader: zeroAddress, side: "buy", amountIn: "9500", quoteOnly: true }));
    expect(band.extra.reason).toBe("OutsideBand");
    expect(mocks.tokenBalances).not.toHaveBeenCalled();
  });

  it("quotes a sell without reading the holder's balance", async () => {
    mocks.quoteSell.mockResolvedValue({ quoteOut: parseEther("0.001"), fee: parseEther("0.00001"), priceAfter: 19_000_000n });
    const build = await buildSwap({ chainId: 421614, row: row(), trader: zeroAddress, side: "sell", amountIn: "100", quoteOnly: true });
    expect(build.steps).toEqual([]);
    expect(build.quote).toMatchObject({ side: "sell", amountOut: 0.001 });
    expect(mocks.tokenBalances).not.toHaveBeenCalled();
    expect(mocks.simulateContract).not.toHaveBeenCalled();
  });
});

describe("buildSwap: sells", () => {
  it("builds sell(tokensIn, minOut, deadline) with no approve step", async () => {
    mocks.tokenBalances.mockResolvedValue([1_000n * E18]);
    mocks.quoteSell.mockResolvedValue({ quoteOut: parseEther("0.0099"), fee: parseEther("0.0001"), priceAfter: 19_000_000n });
    const build = await buildSwap({ chainId: 421614, row: row(), trader: TRADER, side: "sell", amountIn: "500" });
    expect(build.steps).toHaveLength(1);
    const call = decodeFunctionData({ abi: junoCurveAbi, data: build.steps[0].data });
    expect(call.functionName).toBe("sell");
    const [tokensIn, minOut] = call.args as readonly [bigint, bigint, bigint];
    expect(tokensIn).toBe(500n * E18);
    expect(minOut).toBe((parseEther("0.0099") * 9_900n) / 10_000n);
    expect(build.steps[0].value).toBe("0");
  });

  it("refuses to sell more than the wallet holds", async () => {
    mocks.tokenBalances.mockResolvedValue([10n * E18]);
    const error = await rejection(buildSwap({ chainId: 421614, row: row(), trader: TRADER, side: "sell", amountIn: "500" }));
    expect(error.message).toBe("Not enough POST: you hold 10.");
  });
});

describe("buildLaunch", () => {
  beforeEach(() => {
    mocks.readFactoryPreset.mockResolvedValue({
      feeStartBps: 900,
      feeEndBps: 100,
      feeDecaySeconds: 600,
      curveSupplyPct: 80,
      poolFee: 10_000,
      minCapFp: 2n * E18,
      maxCapFp: 100n * E18,
      trackerOnly: false,
    });
    mocks.simulateContract.mockResolvedValue({ result: [CURVE, TOKEN] });
  });

  it("encodes factory.launch with the server's p0 and cap, and the initial buy as value", async () => {
    const build = await buildLaunch({
      chainId: 421614,
      creator: CREATOR,
      name: "Sunset",
      symbol: "SUN",
      metadataUri: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      format: "post",
      preset: "content",
      initialBuy: parseEther("0.001"),
    });
    expect(build.steps[0]).toMatchObject({ label: "Launch and buy", to: FACTORY, value: parseEther("0.001").toString() });
    const call = decodeFunctionData({ abi: junoFactoryAbi, data: build.steps[0].data });
    expect(call.functionName).toBe("launch");
    const [params, minOut] = call.args as readonly [Record<string, unknown>, bigint];
    expect(params).toMatchObject({
      name: "Sunset",
      symbol: "SUN",
      metadataURI: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      preset: 0,
      quote: zeroAddress,
      // 0.02 ETH over a billion tokens.
      p0: 20_000_000n,
      capFp: 25n * E18,
    });
    expect(minOut).toBe(0n);
    expect(build.quote).toMatchObject({ predictedCurve: CURVE, predictedToken: TOKEN, initialMarketCapEth: 0.02 });
  });

  it("counts a launch's gas, not just a flat reserve, against the balance", async () => {
    // 6.3M gas at 0.1 gwei is 0.00063 ETH: more than the 0.0005 reserve.
    mocks.estimateGas.mockResolvedValue(6_300_000n);
    mocks.ethBalance.mockResolvedValue(parseEther("0.0011"));
    const error = await rejection(
      buildLaunch({
        chainId: 421614,
        creator: CREATOR,
        name: "Sunset",
        symbol: "SUN",
        metadataUri: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
        format: "post",
        preset: "content",
        initialBuy: parseEther("0.0003"),
      }),
    );
    expect(error.message).toMatch(/Not enough ETH/);
    expect(error.extra.needed).toBeCloseTo(0.0003 + 8_190_000 * 1e-10, 10);
  });

  it("refuses trackers, bad symbols and unpinned metadata", async () => {
    const base = {
      chainId: 421614 as const,
      creator: CREATOR,
      name: "X",
      symbol: "SUN",
      metadataUri: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      format: "post" as const,
      preset: "content" as const,
    };
    expect((await rejection(buildLaunch({ ...base, preset: "tight-nav" }))).message).toMatch(/scripts/);
    expect((await rejection(buildLaunch({ ...base, symbol: "sun!" }))).message).toMatch(/Symbol/);
    expect((await rejection(buildLaunch({ ...base, metadataUri: "hello" }))).message).toMatch(/metadataUri/);
    expect((await rejection(buildLaunch({ ...base, capMultiple: 500 }))).message).toMatch(/outside/);
  });
});

describe("buildClaim and buildGraduate", () => {
  it("builds claimCreatorFees() for the creator only", async () => {
    const build = await buildClaim({ chainId: 421614, row: row(), owner: CREATOR });
    expect(decodeFunctionData({ abi: junoCurveAbi, data: build.steps[0].data }).functionName).toBe("claimCreatorFees");
    expect(build.amount).toBe(0.00005);
    const error = await rejection(buildClaim({ chainId: 421614, row: row(), owner: TRADER }));
    expect(error.status).toBe(403);
  });

  it("builds graduate() only for a full curve", async () => {
    const early = await rejection(buildGraduate({ chainId: 421614, row: row(), from: TRADER }));
    expect(early.message).toMatch(/not full/);
    mocks.readCurveState.mockResolvedValue(state({ sold: 800_000_000n * E18 }));
    const build = await buildGraduate({ chainId: 421614, row: row(), from: TRADER });
    expect(decodeFunctionData({ abi: junoCurveAbi, data: build.steps[0].data }).functionName).toBe("graduate");
    // Graduation gets at least 3M gas: the nested Uniswap mint starves under the 63/64 rule.
    expect(build.steps[0].gas).toBe("3000000");
    mocks.estimateGas.mockResolvedValue(2_400_000n);
    const big = await buildGraduate({ chainId: 421614, row: row(), from: TRADER });
    expect(big.steps[0].gas).toBe("3600000");
  });
});

describe("helpers", () => {
  it("parses UI amounts exactly and rejects junk", async () => {
    expect(parseAmount("0.01", 18, "amountIn")).toBe(10n ** 16n);
    expect(parseAmount(25, 6, "amountIn")).toBe(25_000_000n);
    expect(parseAmount("1.1234567", 6, "amountIn")).toBe(1_123_456n);
    expect(() => parseAmount("-1", 18, "amountIn")).toThrow(/decimal/);
    expect(() => parseAmount("0", 18, "amountIn")).toThrow(/greater than zero/);
    expect(() => parseAmount("1e5", 18, "amountIn")).toThrow(/decimal/);
  });

  it("pads gas estimates", () => {
    expect(padGas(100_000n)).toBe(130_000n);
    expect(padGas(100_000n, "graduate")).toBe(3_000_000n);
    expect(padGas(3_000_000n, "graduate")).toBe(4_500_000n);
  });

  it("derives p0 and capFp", () => {
    expect(launchP0(parseEther("1"))).toBe(10n ** 9n);
    expect(capFpOf(1.5)).toBe(15n * 10n ** 17n);
  });

  it("names every documented contract error", () => {
    expect(revertMessage("Expired")).toBe("Took too long to sign. Try again.");
    expect(revertMessage("SoldOut")).toBe("Curve is full — graduating.");
    expect(revertMessage("OutsideBand", [0n, 0n, 150])).toMatch(/1\.5%/);
    const mapped = simulationError(
      new ContractFunctionRevertedError({
        abi: junoCurveAbi,
        functionName: "buy",
        data: encodeErrorResult({ abi: junoCurveAbi, errorName: "MarketClosed", args: [1n, 2n] }),
      }),
    );
    expect(mapped.message).toMatch(/^Market closed/);
  });
});
