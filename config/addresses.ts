/**
 * Every on-chain address Juno uses, per chain.
 *
 * External addresses (WETH, USDC, Uniswap, Chainlink) were checked on the
 * explorer and with `scripts/check-addresses.ts`. Juno's own contracts are
 * written here by the deploy scripts; null means "not deployed on this chain".
 */
export type ChainAddresses = {
  name: string;
  explorer: string;
  factory: `0x${string}` | null;
  curveImpl: `0x${string}` | null;
  curveMath: `0x${string}` | null;
  /** The USDC trackers are quoted in. On Sepolia this is Juno's own faucet-mintable test USDC. */
  usdc: `0x${string}` | null;
  usdcIsTest: boolean;
  weth: `0x${string}`;
  uniswapV3Factory: `0x${string}`;
  positionManager: `0x${string}`;
  sequencerUptimeFeed: `0x${string}` | null;
  feeds: Partial<Record<"TSLA" | "NVDA" | "AAPL", `0x${string}`>>;
  /** True when `feeds` are Juno's MockAggregators mirroring the Arbitrum One prices. */
  feedsAreMocks: boolean;
  /** Solidity reference maths, deployed on Sepolia only for the Stylus differential check. */
  curveMathRef?: `0x${string}`;
  /** Block the factory was deployed in: where the indexer starts. */
  factoryBlock?: number;
};

export const ADDRESSES: Record<number, ChainAddresses> = {
  421614: {
    factoryBlock: 313703377,
    name: "Arbitrum Sepolia",
    explorer: "https://sepolia.arbiscan.io",
    factory: "0xBc89E74A36a9EFf7B938211ea4B82650DA3BE87a",
    curveImpl: "0x3a4A8c33D8a3BacA2B58d608107a6E1Aa2B9A9F1",
    curveMath: "0x5125c9e14b64acd48bf7116a93c9b66df89a4f37",
    usdc: "0x0afe4b5763813083D487B30215BDD21012c172ab",
    usdcIsTest: true,
    weth: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
    uniswapV3Factory: "0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e",
    positionManager: "0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65",
    sequencerUptimeFeed: null,
    feeds: {
      AAPL: "0xdcbAb4aECD0e58eCE023a4250B45D3a44209d340",
      NVDA: "0x6eeA0940d91822b403E5DFE31bDa377997cc21f3",
      TSLA: "0x293c9eDBB475150D5f1B93E1F9A303c61F4Ad685",
    },
    feedsAreMocks: true,
  },
  42161: {
    name: "Arbitrum One",
    explorer: "https://arbiscan.io",
    factory: null,
    curveImpl: null,
    curveMath: null,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdcIsTest: false,
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    sequencerUptimeFeed: "0xFdB631F5EE196F0ed6FAa767959853A9F217697D",
    // Chainlink "TSLA / USD" etc., 8 decimals, 24h heartbeat, NYSE market hours.
    feeds: {
      TSLA: "0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3",
      NVDA: "0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F",
      AAPL: "0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c",
    },
    feedsAreMocks: false,
  },
};

export const APP_CHAIN_ID = 421614;

/** A tracker's feed is stale after 26h: covers a trading night, not a weekend. */
export const TRACKER_MAX_AGE_SECONDS = 26 * 60 * 60;
