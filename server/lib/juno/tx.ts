import "server-only";

import {
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  numberToHex,
  formatUnits,
  parseEther,
  parseUnits,
  zeroAddress,
  type Abi,
} from "viem";

import { junoCurveAbi, junoFactoryAbi } from "@config/abi";
import { CallerError } from "./api";
import { publicClient, requireDeployment, type ChainId, SEPOLIA } from "./chains";
import { quoteUsdRate } from "./chainlink";
import { CURVE_PRESETS, POST_SUPPLY_UNITS } from "./curves";
import {
  allowance,
  ethBalance,
  quoteBuy,
  quoteBuyExactOut,
  quoteSell,
  readCurveState,
  readFactoryPreset,
  tokenBalances,
  type BuyQuoteRaw,
  type CurveStateRaw,
} from "./onchain";
import type { CurveRow } from "./registry";
import type { CurvePresetId } from "./types";

/**
 * Transactions built on the server, sent from the device.
 *
 * The app does not carry ABIs or quoting logic. It asks for steps —
 * `{ to, data, value }` — and sends them in order with Privy's
 * `eth_sendTransaction`, then calls `tx/record` with the last hash. Every
 * build is simulated from the sender's address before it is returned, so a
 * transaction that would revert comes back as a 400 in words instead of a
 * failed send; balances are checked first for the same reason.
 */

type Hex = `0x${string}`;

/**
 * One transaction for the device to send. `gas` is an explicit limit (decimal
 * string): Arbitrum's estimate for `graduate()` runs short because of the
 * 63/64 rule on the nested Uniswap mint, so every step carries a padded one.
 */
export type TxStep = { label: string; to: string; data: Hex; value: string; gas: string };

export type TxBuild<Q = Record<string, unknown>> = {
  chainId: ChainId;
  steps: TxStep[];
  quote: Q;
};

/** What a person keeps back for gas: 0.0005 ETH. */
export const GAS_RESERVE_WEI = parseEther("0.0005");
export const DEFAULT_SLIPPAGE_BPS = 100;
export const DEADLINE_SECONDS = 10 * 60;

/* ------------------------------------------------------------------ */
/* Errors in words                                                     */
/* ------------------------------------------------------------------ */

/**
 * The app copy for each contract error (docs/API.md). Exported so the app
 * and tests agree on the words.
 */
export function revertMessage(errorName: string | undefined, args: readonly unknown[] = []): string {
  switch (errorName) {
    case "MarketClosed":
      return "Market closed — the stock price is stale, so buys are paused. You can still sell.";
    case "OutsideBand": {
      const bps = Number(args[2] ?? 0);
      const pct = Number.isFinite(bps) && bps > 0 ? `${Number((bps / 100).toFixed(2))}%` : "the band";
      return `This buy would push the price more than ${pct} above the stock. Try a smaller amount.`;
    }
    case "Slippage":
      return "The price moved. Try again or raise slippage.";
    case "Expired":
      return "Took too long to sign. Try again.";
    case "AlreadyGraduated":
      return "This market moved to Uniswap.";
    case "SoldOut":
      return "Curve is full — graduating.";
    case "NotCreator":
      return "Only this coin's creator can claim its fees.";
    case "NotFull":
      return "The curve is not full yet, so it cannot graduate.";
    case "NotGraduated":
      return "This market has not graduated yet.";
    case "ZeroAmount":
      return "That amount is too small.";
    case "WrongValue":
      return "The payment does not match this market's quote asset.";
    case "SequencerDown":
      return "Arbitrum's sequencer feed says it was just down, so tracker buys are paused for a moment. You can still sell.";
    case "BadFeed":
      return "The stock price feed is not answering, so buys are paused. You can still sell.";
    case "BadPreset":
      return "That curve preset is not available for this launch.";
    case "BadCap":
      return "That cap multiple is outside what this preset allows.";
    case "BadQuote":
      return "That quote asset is not allowed.";
    case "BadParams":
      return "The launch parameters were rejected.";
    case "TransferFailed":
      return "The payout transfer failed.";
    case "ERC20InsufficientBalance":
      return "Not enough balance for this trade.";
    case "ERC20InsufficientAllowance":
      return "The USDC approval is too small. Approve again.";
    default:
      return "This transaction would fail on-chain. Try a different amount.";
  }
}

/** Every error the builders can meet, so viem can name them. */
const ERRORS_ABI = [
  ...junoCurveAbi.filter((item) => item.type === "error"),
  ...junoFactoryAbi.filter((item) => item.type === "error"),
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
] as const;

const CURVE_ABI = [...junoCurveAbi.filter((item) => item.type !== "error"), ...ERRORS_ABI] as Abi;
const FACTORY_ABI = [...junoFactoryAbi.filter((item) => item.type !== "error"), ...ERRORS_ABI] as Abi;

/** Turn a failed simulation into the words the app shows. */
export function simulationError(error: unknown): CallerError | Error {
  if (error instanceof CallerError) return error;
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      return new CallerError(revertMessage(name, reverted.data?.args ?? []), 400, { reason: name ?? "revert" });
    }
    if (error.walk((e) => e instanceof InsufficientFundsError)) {
      return new CallerError("Not enough ETH to pay for this and its gas.", 400, { reason: "InsufficientFunds" });
    }
    if (/execution reverted|revert/i.test(error.message)) {
      return new CallerError(revertMessage(undefined), 400, { reason: "revert" });
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function simulate(
  chainId: ChainId,
  input: { account: string; address: string; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint },
): Promise<unknown> {
  try {
    const { result } = await publicClient(chainId).simulateContract({
      account: input.account as Hex,
      address: input.address as Hex,
      abi: input.abi,
      functionName: input.functionName,
      args: input.args,
      value: input.value,
    } as Parameters<ReturnType<typeof publicClient>["simulateContract"]>[0]);
    return result;
  } catch (error) {
    throw simulationError(error);
  }
}

/* ------------------------------------------------------------------ */
/* Amounts                                                             */
/* ------------------------------------------------------------------ */

/** A UI-unit decimal ("0.01", 5) → base units. Rejects anything that is not a plain positive number. */
export function parseAmount(value: unknown, decimals: number, field: string): bigint {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new CallerError(`"${field}" must be greater than zero`);
    text = value.toFixed(decimals).replace(/\.?0+$/, "");
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    throw new CallerError(`"${field}" is required`);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) throw new CallerError(`"${field}" must be a decimal number like 0.01`);
  const [whole, fraction = ""] = text.split(".");
  const amount = parseUnits(`${whole}.${fraction.slice(0, decimals) || "0"}`, decimals);
  if (amount <= 0n) throw new CallerError(`"${field}" must be greater than zero`);
  return amount;
}

export function slippageBps(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_SLIPPAGE_BPS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 5_000) throw new CallerError('"slippageBps" must be a whole number from 0 to 5000');
  return n;
}

export const minusSlippage = (amount: bigint, bps: number) => (amount * BigInt(10_000 - bps)) / 10_000n;
export const plusSlippage = (amount: bigint, bps: number) => (amount * BigInt(10_000 + bps) + 9_999n) / 10_000n;

export function deadline(nowMs = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + DEADLINE_SECONDS);
}

const fmt = (amount: bigint, decimals: number) => Number(formatUnits(amount, decimals));

function step(label: string, to: string, data: Hex, value = 0n): TxStep {
  return { label, to: to.toLowerCase(), data, value: value.toString(), gas: "0" };
}

/* ------------------------------------------------------------------ */
/* Gas                                                                 */
/* ------------------------------------------------------------------ */

export const GAS_PAD_BPS = 13_000n; // ×1.3
export const GRADUATE_PAD_BPS = 15_000n; // ×1.5
export const GRADUATE_MIN_GAS = 3_000_000n;
/** For a step that cannot be estimated yet (a buy behind a pending approve). */
export const FALLBACK_GAS = 1_500_000n;

export function padGas(estimate: bigint, kind: "default" | "graduate" = "default"): bigint {
  if (kind === "graduate") {
    const padded = (estimate * GRADUATE_PAD_BPS + 9_999n) / 10_000n;
    return padded > GRADUATE_MIN_GAS ? padded : GRADUATE_MIN_GAS;
  }
  return (estimate * GAS_PAD_BPS + 9_999n) / 10_000n;
}

/**
 * The storage slot of `allowance[owner][spender]` in an OpenZeppelin ERC-20
 * (`_allowances` is slot 1) — Juno's TestUSDC. Used to estimate a buy as if
 * its approve had already landed.
 */
export function ozAllowanceSlot(owner: string, spender: string): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner as Hex, 1n]));
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender as Hex, inner]));
}

async function estimate(
  chainId: ChainId,
  from: string,
  item: TxStep,
  options: { kind?: "default" | "graduate"; pendingApprove?: { token: string; spender: string; amount: bigint } } = {},
): Promise<TxStep> {
  const client = publicClient(chainId);
  const base = { account: from as Hex, to: item.to as Hex, data: item.data, value: BigInt(item.value) };
  let gas: bigint | null = null;
  try {
    gas = await client.estimateGas(
      options.pendingApprove
        ? {
            ...base,
            stateOverride: [
              {
                address: options.pendingApprove.token as Hex,
                stateDiff: [
                  {
                    slot: ozAllowanceSlot(from, options.pendingApprove.spender),
                    value: numberToHex(options.pendingApprove.amount, { size: 32 }),
                  },
                ],
              },
            ],
          }
        : base,
    );
  } catch (error) {
    if (!options.pendingApprove) throw simulationError(error);
  }
  const limit = gas === null ? FALLBACK_GAS : padGas(gas, options.kind);
  return { ...item, gas: limit.toString() };
}

async function requireEth(chainId: ChainId, owner: string, needed: bigint, what: string): Promise<void> {
  const balance = await ethBalance(chainId, owner);
  if (balance < needed) {
    throw new CallerError(
      `Not enough ETH: you have ${fmt(balance, 18)} ETH and ${what} needs ${fmt(needed, 18)} ETH, including about 0.0005 ETH for gas.`,
      400,
      { reason: "InsufficientFunds", balance: fmt(balance, 18), needed: fmt(needed, 18) },
    );
  }
}

/**
 * The last check before a build is returned: the wallet can pay every step's
 * value plus its gas at today's max fee. A launch is ~6M gas (it deploys a
 * token and creates the Uniswap pool), which a flat reserve understates.
 */
export async function requireFunds(chainId: ChainId, owner: string, steps: TxStep[], what: string): Promise<void> {
  const fees = await publicClient(chainId)
    .estimateFeesPerGas()
    .catch(() => null);
  const maxFee = fees?.maxFeePerGas ?? 0n;
  const gasCost = steps.reduce((sum, item) => sum + BigInt(item.gas) * maxFee, 0n);
  const value = steps.reduce((sum, item) => sum + BigInt(item.value), 0n);
  const needed = value + (gasCost > GAS_RESERVE_WEI ? gasCost : GAS_RESERVE_WEI);
  const balance = await ethBalance(chainId, owner);
  if (balance < needed) {
    throw new CallerError(
      `Not enough ETH: you have ${fmt(balance, 18)} ETH and ${what} needs about ${fmt(needed, 18)} ETH including gas.`,
      400,
      { reason: "InsufficientFunds", balance: fmt(balance, 18), needed: fmt(needed, 18) },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Launch                                                              */
/* ------------------------------------------------------------------ */

const SYMBOL = /^[A-Z0-9]{2,10}$/;

/** Initial market cap for a post launch, in ETH, per chain. */
export function initialMarketCapEth(chainId: ChainId): number {
  const raw = process.env[`JUNO_INITIAL_MCAP_ETH_${chainId}`] ?? process.env.JUNO_INITIAL_MCAP_ETH;
  const n = Number(raw);
  if (raw && Number.isFinite(n) && n > 0) return n;
  return chainId === SEPOLIA ? 0.02 : 1.0;
}

/** p0 in quote base units per whole token: market cap spread over the supply. */
export function launchP0(marketCapWei: bigint, supplyUnits: bigint = POST_SUPPLY_UNITS): bigint {
  return (marketCapWei * 10n ** 18n) / supplyUnits;
}

/** A cap multiple as the factory's 1e18 fixed point. */
export function capFpOf(multiple: number): bigint {
  if (!Number.isFinite(multiple) || multiple < 1) throw new CallerError("The cap multiple must be at least 1");
  return BigInt(Math.round(multiple * 1_000_000)) * 10n ** 12n;
}

export type LaunchRequest = {
  chainId: ChainId;
  creator: string;
  name: string;
  symbol: string;
  metadataUri: string;
  format: "post" | "reel";
  preset: CurvePresetId;
  initialBuy?: bigint;
  capMultiple?: number;
};

export type LaunchQuote = {
  preset: CurvePresetId;
  presetIndex: number;
  p0: string;
  capFp: string;
  initialMarketCapEth: number;
  graduationMarketCapEth: number;
  initialBuy: number;
  /** From the simulation. Clone addresses depend on the factory's nonce, so treat these as a hint. */
  predictedCurve: string | null;
  predictedToken: string | null;
};

export function validateLaunch(input: { name: string; symbol: string; metadataUri: string; preset: string; format: string }): void {
  if (input.name.length > 64) throw new CallerError("Name must be 64 characters or fewer");
  if (!SYMBOL.test(input.symbol)) throw new CallerError("Symbol must be 2-10 characters, letters and digits only");
  if (!(input.preset in CURVE_PRESETS)) {
    throw new CallerError(`Unknown preset "${input.preset}". One of: content, thin-name, ipo-book`);
  }
  if (CURVE_PRESETS[input.preset as CurvePresetId].trackerOnly) {
    throw new CallerError("Stock trackers are launched by Juno's scripts, not from the app.");
  }
  if (input.format !== "post" && input.format !== "reel") throw new CallerError('"format" must be "post" or "reel"');
  if (!/^(ipfs:\/\/|https:\/\/|data:application\/json)/.test(input.metadataUri)) {
    throw new CallerError('"metadataUri" must be an ipfs:// or https:// URI — pin it with /api/juno/metadata first');
  }
}

export async function buildLaunch(request: LaunchRequest): Promise<TxBuild<LaunchQuote>> {
  const { factory } = requireDeployment(request.chainId);
  validateLaunch(request);
  const preset = CURVE_PRESETS[request.preset];
  const onChain = await readFactoryPreset(request.chainId, preset.index);
  if (onChain.trackerOnly) throw new CallerError("That preset is for stock trackers only.");

  const mcapEth = initialMarketCapEth(request.chainId);
  const p0 = launchP0(parseEther(String(mcapEth)));
  const multiple = request.capMultiple ?? preset.defaultCapMultiple;
  const capFp = capFpOf(multiple);
  if (capFp < onChain.minCapFp || capFp > onChain.maxCapFp) {
    throw new CallerError(
      `A ${multiple}x cap is outside this preset's range (${fmt(onChain.minCapFp, 18)}x to ${fmt(onChain.maxCapFp, 18)}x).`,
    );
  }
  const initialBuy = request.initialBuy ?? 0n;
  await requireEth(request.chainId, request.creator, initialBuy + GAS_RESERVE_WEI, "this launch");

  const params = {
    name: request.name,
    symbol: request.symbol,
    metadataURI: request.metadataUri,
    preset: preset.index,
    quote: zeroAddress,
    p0,
    capFp,
  } as const;
  // minOut 0 is safe here: the first buy lands in the same transaction that
  // creates the curve, so nothing can trade in between.
  const args = [params, 0n] as const;
  const result = (await simulate(request.chainId, {
    account: request.creator,
    address: factory,
    abi: FACTORY_ABI,
    functionName: "launch",
    args,
    value: initialBuy,
  })) as readonly [string, string] | undefined;

  const data = encodeFunctionData({ abi: junoFactoryAbi, functionName: "launch", args });
  const steps = [await estimate(request.chainId, request.creator, step(initialBuy > 0n ? "Launch and buy" : "Launch", factory, data, initialBuy))];
  await requireFunds(request.chainId, request.creator, steps, "this launch");
  return {
    chainId: request.chainId,
    steps,
    quote: {
      preset: request.preset,
      presetIndex: preset.index,
      p0: p0.toString(),
      capFp: capFp.toString(),
      initialMarketCapEth: mcapEth,
      graduationMarketCapEth: mcapEth * multiple,
      initialBuy: fmt(initialBuy, 18),
      predictedCurve: result?.[0]?.toLowerCase() ?? null,
      predictedToken: result?.[1]?.toLowerCase() ?? null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Swap                                                                */
/* ------------------------------------------------------------------ */

export type SwapRequest = {
  chainId: ChainId;
  row: CurveRow;
  trader: string;
  side: "buy" | "sell";
  /** UI units: quote on a buy, tokens on a sell. */
  amountIn?: unknown;
  /** Exact-out buy: tokens to receive. */
  amountOut?: unknown;
  slippageBps?: unknown;
  /**
   * Quote without building: no balance checks, no steps. For visitors who have
   * not signed in, so the sheet can show the fee, the impact and a tracker's
   * band verdict before anyone has a wallet. The band and staleness checks
   * still run, exactly as for a real buy.
   */
  quoteOnly?: boolean;
};

export type SwapQuote = {
  side: "buy" | "sell";
  exactOut: boolean;
  /** What is spent: quote on a buy, tokens on a sell. Expected cost on an exact-out buy. */
  amountIn: number;
  /** What is received. */
  amountOut: number;
  minimumAmountOut: number;
  /** Exact-out buys: the most the transaction may spend. */
  maximumAmountIn?: number;
  /** Fee, in quote units. */
  fee: number;
  feeBps: number;
  /** Shortfall against the spot price, fee included. */
  priceImpact: number;
  priceBefore: number;
  priceAfter: number;
  slippageBps: number;
  deadline: number;
  /** Tracker buys: the contract's own band and staleness verdicts (always true for posts). */
  bandOk: boolean;
  marketOpen: boolean;
  /** The tracker's band, bps above the stock a buy may lift the price to (0 for posts). */
  bandBps: number;
  /** The stock price in quote units per token (0 for posts). */
  refPrice: number;
  /** This buy fills the curve; `tx/graduate` can follow. */
  fillsCurve: boolean;
};

function assertBuyable(state: CurveStateRaw, quote: BuyQuoteRaw, row: CurveRow): void {
  if (quote.tokensOut === 0n) throw new CallerError(revertMessage(state.graduated ? "AlreadyGraduated" : "ZeroAmount"), 400);
  if (row.feed && !quote.marketOpen) throw new CallerError(revertMessage("MarketClosed"), 400, { reason: "MarketClosed" });
  if (row.feed && !quote.bandOk) {
    throw new CallerError(revertMessage("OutsideBand", [quote.priceAfter, quote.refPrice, state.bandBps]), 400, {
      reason: "OutsideBand",
    });
  }
}

export async function buildSwap(request: SwapRequest): Promise<TxBuild<SwapQuote> & { pool: string; symbol: string; quoteSymbol: string; quoteUsdRate: number | null }> {
  requireDeployment(request.chainId);
  const { chainId, row, trader, side } = request;
  const curve = row.curve;
  const decimals = row.quoteDecimals;
  const isEth = !row.quote;
  const slip = slippageBps(request.slippageBps);
  const until = deadline();

  const state = await readCurveState(chainId, curve);
  if (state.graduated) throw new CallerError(revertMessage("AlreadyGraduated"), 400, { reason: "AlreadyGraduated", pool: state.pool });
  const spot = fmt(state.price, decimals);
  const steps: TxStep[] = [];
  let quote: SwapQuote;

  if (side === "buy") {
    const exactOut = request.amountOut !== undefined && request.amountOut !== null && request.amountOut !== "";
    let q: BuyQuoteRaw;
    let spend: bigint;
    let minOut: bigint;
    let maxIn: bigint | null = null;

    if (exactOut) {
      const tokensOut = parseAmount(request.amountOut, 18, "amountOut");
      if (tokensOut > state.curveSupply - state.sold) throw new CallerError(revertMessage("SoldOut"), 400, { reason: "SoldOut" });
      q = await quoteBuyExactOut(chainId, curve, tokensOut);
      assertBuyable(state, q, row);
      maxIn = plusSlippage(q.quoteIn, slip);
      spend = maxIn;
      minOut = tokensOut;
    } else {
      const quoteIn = parseAmount(request.amountIn, decimals, "amountIn");
      if (state.sold >= state.curveSupply) throw new CallerError(revertMessage("SoldOut"), 400, { reason: "SoldOut" });
      q = await quoteBuy(chainId, curve, quoteIn);
      assertBuyable(state, q, row);
      spend = quoteIn;
      minOut = minusSlippage(q.tokensOut, slip);
    }

    const quoteOnly = request.quoteOnly === true;
    // Balances before anything is built: a doomed send costs the user gas.
    if (quoteOnly) {
      // nothing to check: no transaction is built
    } else if (isEth) {
      await requireEth(chainId, trader, spend + GAS_RESERVE_WEI, "this buy");
    } else {
      const [usdcBalance] = await tokenBalances(chainId, [{ token: row.quote!, owner: trader }]);
      if (usdcBalance === null) throw new Error("USDC balance read failed");
      if (usdcBalance < spend) {
        throw new CallerError(
          `Not enough USDC: you have ${fmt(usdcBalance, decimals)} and this buy needs ${fmt(spend, decimals)}.`,
          400,
          { reason: "InsufficientFunds", balance: fmt(usdcBalance, decimals), needed: fmt(spend, decimals) },
        );
      }
      await requireEth(chainId, trader, GAS_RESERVE_WEI, "gas");
    }

    let approving = false;
    if (!isEth && !quoteOnly) {
      const current = await allowance(chainId, row.quote!, trader, curve);
      if (current < spend) {
        approving = true;
        steps.push(
          await estimate(
            chainId,
            trader,
            step(
              "Approve USDC",
              row.quote!,
              encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [curve as Hex, spend] }),
            ),
          ),
        );
      }
    }

    const call = exactOut
      ? { functionName: "buyExactOut", args: [q.tokensOut, maxIn!, until] as const, value: isEth ? maxIn! : 0n }
      : isEth
        ? { functionName: "buy", args: [minOut, until] as const, value: spend }
        : { functionName: "buyWithQuote", args: [spend, minOut, until] as const, value: 0n };

    // With an approve still to send, the buy cannot be simulated yet: it
    // would fail on the allowance the first step is about to grant.
    if (!quoteOnly) {
      if (!approving) {
        await simulate(chainId, { account: trader, address: curve, abi: CURVE_ABI, ...call });
      }
      steps.push(
        await estimate(
          chainId,
          trader,
          step(
            "Buy",
            curve,
            encodeFunctionData({ abi: junoCurveAbi, functionName: call.functionName as "buy", args: call.args as never }),
            call.value,
          ),
          approving ? { pendingApprove: { token: row.quote!, spender: curve, amount: spend } } : {},
        ),
      );
    }

    const quoteIn = fmt(q.quoteIn, decimals);
    const tokensOut = fmt(q.tokensOut, 18);
    quote = {
      side,
      exactOut,
      amountIn: quoteIn,
      amountOut: tokensOut,
      minimumAmountOut: fmt(minOut, 18),
      maximumAmountIn: maxIn === null ? undefined : fmt(maxIn, decimals),
      fee: fmt(q.fee, decimals),
      feeBps: Number(state.feeBps),
      priceImpact: spot > 0 && tokensOut > 0 ? quoteIn / tokensOut / spot - 1 : 0,
      priceBefore: spot,
      priceAfter: fmt(q.priceAfter, decimals),
      slippageBps: slip,
      deadline: Number(until),
      bandOk: q.bandOk,
      marketOpen: q.marketOpen,
      bandBps: Number(state.bandBps),
      refPrice: fmt(q.refPrice, decimals),
      fillsCurve: state.sold + q.tokensOut >= state.curveSupply,
    };
  } else {
    const tokensIn = parseAmount(request.amountIn, 18, "amountIn");
    const quoteOnly = request.quoteOnly === true;
    const [held] = quoteOnly ? [tokensIn] : await tokenBalances(chainId, [{ token: row.token, owner: trader }]);
    if (held === null) throw new Error("Token balance read failed");
    if (held < tokensIn) {
      throw new CallerError(`Not enough ${row.symbol}: you hold ${fmt(held, 18)}.`, 400, {
        reason: "InsufficientFunds",
        balance: fmt(held, 18),
        needed: fmt(tokensIn, 18),
      });
    }
    if (tokensIn > state.sold) throw new CallerError("That is more than the curve has sold.", 400);
    if (!quoteOnly) await requireEth(chainId, trader, GAS_RESERVE_WEI, "gas");

    const q = await quoteSell(chainId, curve, tokensIn);
    if (q.quoteOut === 0n) throw new CallerError(revertMessage("ZeroAmount"), 400);
    const minOut = minusSlippage(q.quoteOut, slip);
    const args = [tokensIn, minOut, until] as const;
    if (!quoteOnly) {
      await simulate(chainId, { account: trader, address: curve, abi: CURVE_ABI, functionName: "sell", args });
      steps.push(await estimate(chainId, trader, step("Sell", curve, encodeFunctionData({ abi: junoCurveAbi, functionName: "sell", args }))));
    }

    const out = fmt(q.quoteOut, decimals);
    const size = fmt(tokensIn, 18);
    quote = {
      side,
      exactOut: false,
      amountIn: size,
      amountOut: out,
      minimumAmountOut: fmt(minOut, decimals),
      fee: fmt(q.fee, decimals),
      feeBps: Number(state.feeBps),
      priceImpact: spot > 0 && size > 0 ? 1 - out / size / spot : 0,
      priceBefore: spot,
      priceAfter: fmt(q.priceAfter, decimals),
      slippageBps: slip,
      deadline: Number(until),
      bandOk: true,
      marketOpen: true,
      bandBps: Number(state.bandBps),
      refPrice: 0,
      fillsCurve: false,
    };
  }

  if (request.quoteOnly !== true) await requireFunds(chainId, trader, steps, side === "buy" ? "this buy" : "this sell");
  return {
    chainId,
    steps,
    quote,
    pool: curve,
    symbol: row.symbol,
    quoteSymbol: row.quoteSymbol,
    quoteUsdRate: await quoteUsdRate(row.quoteSymbol).catch(() => null),
  };
}

/* ------------------------------------------------------------------ */
/* Claim and graduate                                                  */
/* ------------------------------------------------------------------ */

export async function buildClaim(input: { chainId: ChainId; row: CurveRow; owner: string }) {
  requireDeployment(input.chainId);
  const state = await readCurveState(input.chainId, input.row.curve);
  if (state.creator.toLowerCase() !== input.owner) {
    throw new CallerError(revertMessage("NotCreator"), 403, { reason: "NotCreator" });
  }
  if (state.creatorFees === 0n) throw new CallerError("Nothing to claim yet.", 400, { reason: "ZeroAmount" });
  await requireEth(input.chainId, input.owner, GAS_RESERVE_WEI, "gas");
  await simulate(input.chainId, {
    account: input.owner,
    address: input.row.curve,
    abi: CURVE_ABI,
    functionName: "claimCreatorFees",
    args: [],
  });
  const amount = fmt(state.creatorFees, input.row.quoteDecimals);
  return {
    chainId: input.chainId,
    steps: [
      await estimate(
        input.chainId,
        input.owner,
        step("Claim fees", input.row.curve, encodeFunctionData({ abi: junoCurveAbi, functionName: "claimCreatorFees" })),
      ),
    ],
    quote: { amount, quoteSymbol: input.row.quoteSymbol },
    amount,
    quoteSymbol: input.row.quoteSymbol,
    quoteUsdRate: await quoteUsdRate(input.row.quoteSymbol).catch(() => null),
    pool: input.row.curve,
    symbol: input.row.symbol,
  };
}

export async function buildGraduate(input: { chainId: ChainId; row: CurveRow; from: string }) {
  requireDeployment(input.chainId);
  const state = await readCurveState(input.chainId, input.row.curve);
  if (state.graduated) throw new CallerError(revertMessage("AlreadyGraduated"), 400, { reason: "AlreadyGraduated", pool: state.pool });
  if (state.sold < state.curveSupply) {
    const pct = Number((state.sold * 10_000n) / (state.curveSupply || 1n)) / 100;
    throw new CallerError(`${revertMessage("NotFull")} It is ${pct}% sold.`, 400, { reason: "NotFull" });
  }
  await requireEth(input.chainId, input.from, GAS_RESERVE_WEI, "gas");
  await simulate(input.chainId, {
    account: input.from,
    address: input.row.curve,
    abi: CURVE_ABI,
    functionName: "graduate",
    args: [],
  });
  return {
    chainId: input.chainId,
    steps: [
      await estimate(
        input.chainId,
        input.from,
        step("Graduate to Uniswap", input.row.curve, encodeFunctionData({ abi: junoCurveAbi, functionName: "graduate" })),
        { kind: "graduate" },
      ),
    ],
    quote: {
      pool: state.pool.toLowerCase(),
      quoteLiquidity: fmt(state.quoteReserve, input.row.quoteDecimals),
      quoteSymbol: input.row.quoteSymbol,
    },
    pool: input.row.curve,
    symbol: input.row.symbol,
  };
}
