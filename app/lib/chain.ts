import { ADDRESSES, APP_CHAIN_ID, type ChainAddresses } from "@config/addresses";
import { junoCurveAbi, junoFactoryAbi } from "@config/abi";
import {
  BaseError,
  createPublicClient,
  decodeErrorResult,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Abi,
  type Chain,
  type Hex,
} from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

/**
 * The chain the app talks to, and everything that depends on which one it is.
 *
 * One place, so no screen hardcodes an explorer, a network name or an RPC.
 * `EXPO_PUBLIC_CHAIN_ID` picks the chain (Arbitrum Sepolia by default); the
 * addresses come from `config/addresses.ts`, the same file the contracts'
 * deploy scripts write to and the server reads.
 */

const CHAINS: Record<number, Chain> = {
  [arbitrumSepolia.id]: arbitrumSepolia,
  [arbitrum.id]: arbitrum,
};

export const CHAIN_ID: number = (() => {
  const raw = Number(process.env.EXPO_PUBLIC_CHAIN_ID ?? APP_CHAIN_ID);
  return CHAINS[raw] ? raw : APP_CHAIN_ID;
})();

export const CHAIN: Chain = CHAINS[CHAIN_ID]!;
export const CHAIN_ADDRESSES: ChainAddresses = ADDRESSES[CHAIN_ID]!;
export const IS_TESTNET = CHAIN_ID !== arbitrum.id;

/** "Arbitrum Sepolia". */
export const NETWORK_NAME = CHAIN_ADDRESSES.name;
/** What the money is, said once wherever a balance is shown. */
export const NETWORK_LABEL = IS_TESTNET ? `${NETWORK_NAME} · test ETH` : NETWORK_NAME;

/**
 * Where the stock prices come from, said plainly. Chainlink publishes no
 * equity feeds on Arbitrum Sepolia, so there each tracker reads a feed that
 * Juno's keeper keeps equal to Chainlink's Arbitrum One price (answer and
 * timestamp). On Arbitrum One it is Chainlink's own feed.
 */
export const FEED_SOURCE = IS_TESTNET ? "Chainlink, mirrored" : "Chainlink";
export const FEED_NOTE: string | null = IS_TESTNET
  ? "Chainlink has no stock feeds on Arbitrum Sepolia, so these prices are Chainlink's Arbitrum One prices, copied here by Juno's feed keeper."
  : null;

const RPC_URL = process.env.EXPO_PUBLIC_RPC_URL || CHAIN.rpcUrls.default.http[0];

/** Reads receipts and replays reverts. Everything else comes from the Juno API. */
export const publicClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL, { retryCount: 2, timeout: 20_000 }),
});

export function chainFor(chainId: number): Chain | null {
  return CHAINS[chainId] ?? null;
}

/** An Arbiscan link. `address` covers contracts and tokens alike. */
export function explorer(kind: "tx" | "address" | "token", id: string, chainId = CHAIN_ID): string {
  const base = (ADDRESSES[chainId] ?? CHAIN_ADDRESSES).explorer;
  return `${base}/${kind}/${id}`;
}

/** The graduated market, on Uniswap's own explorer. */
export function uniswapPoolUrl(pool: string, chainId = CHAIN_ID): string {
  const network = chainId === arbitrum.id ? "arbitrum" : "arbitrum_sepolia";
  return `https://app.uniswap.org/explore/pools/${network}/${pool}`;
}

export function validAddress(value: string | null | undefined): value is `0x${string}` {
  return !!value && isAddress(value, { strict: false });
}

/** Checksummed for display. The server stores and returns lowercase. */
export function displayAddress(value: string): string {
  try {
    return getAddress(value);
  } catch {
    return value;
  }
}

export function shortAddress(value: string, head = 6, tail = 4): string {
  const shown = displayAddress(value);
  return shown.length > head + tail + 1 ? `${shown.slice(0, head)}…${shown.slice(-tail)}` : shown;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Revert reasons                                                      */
/* ------------------------------------------------------------------ */

/**
 * Every error the app can meet on a Juno transaction: the curve's, the
 * factory's, and a plain ERC-20's (an approve or a transfer that fails).
 */
const ERROR_ABI = [...junoCurveAbi, ...junoFactoryAbi, ...erc20Abi].filter(
  (item) => item.type === "error",
) as Abi;

export type TxFailure = {
  /** Copy to show. Empty when `cancelled`. */
  message: string;
  /** The person said no in their wallet. Say nothing. */
  cancelled: boolean;
  /** The decoded contract error name, when there was one. */
  reason: string | null;
};

/** Thrown by the wallet once an error has been turned into words. */
export class TxError extends Error {
  readonly cancelled: boolean;
  readonly reason: string | null;
  constructor(failure: TxFailure) {
    super(failure.message || "Cancelled");
    this.name = "TxError";
    this.cancelled = failure.cancelled;
    this.reason = failure.reason;
  }
}

/** The copy in docs/API.md, one line per contract error. */
function explainRevert(name: string, args: readonly unknown[] | undefined): string {
  switch (name) {
    case "MarketClosed":
      return "Market closed — the stock price is stale, so buys are paused. You can still sell.";
    case "OutsideBand": {
      const bandBps = Number(args?.[2] ?? 0);
      const pct = bandBps > 0 ? `${trimPct(bandBps / 100)}%` : "its band";
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
      return "Only the creator can do that.";
    case "NotFull":
      return "The curve is not full yet, so it cannot graduate.";
    case "NotGraduated":
      return "This market has not graduated yet.";
    case "SequencerDown":
      return "Arbitrum's sequencer feed says it is down, so trackers are paused. Try again shortly.";
    case "BadFeed":
      return "The stock's price feed returned no usable price. Buys are paused.";
    case "ZeroAmount":
      return "Enter an amount above zero.";
    case "WrongValue":
      return "The ETH sent did not match the trade. Try again.";
    case "TransferFailed":
      return "A transfer inside the trade failed. Try again.";
    case "ERC20InsufficientBalance":
      return "Not enough balance for this trade.";
    case "ERC20InsufficientAllowance":
      return "The approval did not cover this trade. Try again.";
    case "BadPreset":
    case "BadCap":
    case "BadQuote":
    case "BadParams":
      return "The launch settings were refused by the factory.";
    default:
      return `The transaction was refused (${name}).`;
  }
}

function trimPct(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Find revert data anywhere in an error chain: viem, Privy and wallets all nest it differently. */
function revertData(error: unknown): Hex | null {
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): Hex | null => {
    if (!node || depth > 8 || seen.has(node)) return null;
    seen.add(node);
    if (typeof node === "string") {
      return /^0x[0-9a-fA-F]{8,}$/.test(node) ? (node as Hex) : null;
    }
    if (typeof node !== "object") return null;
    const record = node as Record<string, unknown>;
    for (const key of ["data", "cause", "error", "originalError", "details"]) {
      const found = visit(record[key], depth + 1);
      if (found) return found;
    }
    // Some wallets only put it in the message: "execution reverted: 0x…".
    const message = typeof record.message === "string" ? record.message : "";
    const match = /0x[0-9a-fA-F]{8,}/.exec(message);
    return match && match[0].length % 2 === 0 ? (match[0] as Hex) : null;
  };
  return visit(error, 0);
}

function isUserRejection(error: unknown): boolean {
  let node: unknown = error;
  for (let depth = 0; node && depth < 8; depth += 1) {
    const record = node as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (record.code === 4001 || record.name === "UserRejectedRequestError") return true;
    if (
      typeof record.message === "string" &&
      /user (rejected|denied|cancel)|rejected the request|request (was )?rejected|denied transaction|user closed|cancelled by user|canceled by user/i.test(
        record.message,
      )
    ) {
      return true;
    }
    node = record.cause;
  }
  return false;
}

/** Decode a revert payload, or null when it is not one of ours. */
export function decodeRevert(data: Hex): TxFailure | null {
  try {
    const decoded = decodeErrorResult({ abi: ERROR_ABI, data });
    return {
      message: explainRevert(decoded.errorName, decoded.args as readonly unknown[] | undefined),
      cancelled: false,
      reason: decoded.errorName,
    };
  } catch {
    return null;
  }
}

/**
 * Anything a wallet or RPC threw, as something a person can read.
 *
 * A contract revert becomes the API.md copy; a rejection in the wallet
 * becomes a quiet cancel; the rest keeps the shortest honest message there is.
 */
export function describeTxError(error: unknown): TxFailure {
  if (error instanceof TxError) {
    return { message: error.cancelled ? "" : error.message, cancelled: error.cancelled, reason: error.reason };
  }
  if (isUserRejection(error)) return { message: "", cancelled: true, reason: null };

  const data = revertData(error);
  if (data) {
    const decoded = decodeRevert(data);
    if (decoded) return decoded;
  }

  const text =
    error instanceof BaseError
      ? error.shortMessage
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "The transaction failed";

  if (/insufficient funds/i.test(text)) {
    return { message: "Not enough ETH to pay for this and its gas. Get test ETH from your profile.", cancelled: false, reason: null };
  }
  if (/nonce too low|replacement transaction underpriced|already known/i.test(text)) {
    return { message: "Your wallet had a transaction in flight. Wait a moment and try again.", cancelled: false, reason: null };
  }
  if (/429|rate limit|too many requests|timeout|timed out|fetch failed|network/i.test(text)) {
    return { message: "The network is busy. Try again in a moment.", cancelled: false, reason: null };
  }
  return { message: text.split("\n")[0]!.slice(0, 220), cancelled: false, reason: null };
}

/** Parse a UI-unit decimal string for display. */
export function units(value: bigint, decimals: number): number {
  return Number(formatUnits(value, decimals));
}
