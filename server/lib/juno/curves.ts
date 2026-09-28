/**
 * Juno's bonding-curve presets: names, copy and liquidity shape.
 *
 * The weights are what give a launch its character:
 *
 *   more liquidity in a segment  →  more supply absorbed per unit of price
 *                               →  a flatter stretch of curve
 *
 * The on-chain factory owns every economic parameter (fee schedule, supply
 * split, cap range, Uniswap fee tier) — read them with `factory.preset(id)`.
 * This table holds what the contracts do not: labels and the reasoning shown
 * in the launch form, plus the default cap multiple the server launches with.
 * The weights mirror `CurveMathRef.sol` / the Stylus `CurveMath` exactly.
 */

import type { CurvePresetId } from "./types";

/** Sixteen segments, as in `CurveMath`. */
export const CURVE_SEGMENTS = 16;

/** One billion tokens, 18 decimals, for every post and reel. */
export const DEFAULT_TOTAL_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 18;
export const POST_SUPPLY_UNITS = 1_000_000_000n * 10n ** 18n;

export type CurvePreset = {
  id: CurvePresetId;
  /** The factory's preset id. */
  index: number;
  label: string;
  tagline: string;
  rationale: string;
  /** Sixteen liquidity weights — the shape of the curve. */
  weights: number[];
  /** Cap multiple the server launches with when the creator picks none. */
  defaultCapMultiple: number;
  /** The widest range this preset still behaves as described in. */
  maxCapMultiple?: number;
  /** Trackers only: `launchTracker`, never `launch`. */
  trackerOnly: boolean;
};

/** `ratio > 1` back-loads liquidity (flat late); `ratio < 1` front-loads it (deep near issue). */
function geometric(ratio: number, segments = CURVE_SEGMENTS): number[] {
  return Array.from({ length: segments }, (_, i) => Number(Math.pow(ratio, i).toFixed(6)));
}

/** Deep open, thin middle, deep again near the cap — the shape of an order book. */
function bookShaped(segments = CURVE_SEGMENTS): number[] {
  const mid = (segments - 1) / 2;
  return Array.from({ length: segments }, (_, i) => {
    const t = (i - mid) / mid;
    return Number((0.25 + 0.75 * t * t).toFixed(6));
  });
}

export const CURVE_PRESETS: Record<CurvePresetId, CurvePreset> = {
  content: {
    id: "content",
    index: 0,
    label: "Content",
    tagline: "Default for posts. Cheap entry, graduates on modest volume.",
    rationale:
      "Back-loaded liquidity so early collectors get in cheaply and the curve steepens as the post finds an audience. Fees start high to blunt snipers in the first few minutes, then settle.",
    weights: geometric(1.2),
    defaultCapMultiple: 25,
    trackerOnly: false,
  },
  "thin-name": {
    id: "thin-name",
    index: 1,
    label: "Thin name",
    tagline: "Low float. Deep at the issue price.",
    rationale:
      "Front-loaded liquidity gives a deep book at the issue price, so early size fills without gapping the print. Price only starts moving once real demand clears the opening depth.",
    weights: geometric(0.82),
    defaultCapMultiple: 25,
    trackerOnly: false,
  },
  "ipo-book": {
    id: "ipo-book",
    index: 2,
    label: "IPO book",
    tagline: "Deep open, real discovery mid-curve, flat near the target cap.",
    rationale:
      "A book-shaped curve: depth at the open to absorb the initial auction, a thin middle where price is genuinely discovered, then depth again approaching the target cap so the market does not run away before it graduates.",
    weights: bookShaped(),
    defaultCapMultiple: 25,
    trackerOnly: false,
  },
  "tight-nav": {
    id: "tight-nav",
    index: 3,
    label: "Tight NAV",
    tagline: "Near-flat curve for trackers held to a stock price.",
    rationale:
      "Uniform liquidity across all sixteen segments keeps the curve close to flat, and the contract refuses any buy that would lift it more than the band above the Chainlink price. Behaves like a spread rather than a launch.",
    weights: Array.from({ length: CURVE_SEGMENTS }, () => 1),
    defaultCapMultiple: 1.5,
    maxCapMultiple: 3,
    trackerOnly: true,
  },
};

export const CURVE_PRESET_LIST: CurvePreset[] = Object.values(CURVE_PRESETS);

export const PRESET_BY_INDEX: CurvePresetId[] = ["content", "thin-name", "ipo-book", "tight-nav"];

export function presetFromIndex(index: number): CurvePresetId {
  return PRESET_BY_INDEX[index] ?? "content";
}

export function isPresetId(value: unknown): value is CurvePresetId {
  return typeof value === "string" && value in CURVE_PRESETS;
}
