import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";

import { theme } from "../theme";

/**
 * What a preset's curve actually looks like.
 *
 * The four presets differ by sixteen liquidity weights, and the weights are the
 * entire point — they decide whether early size fills at the issue price or
 * gaps the print. Describing that in a sentence and showing nothing asks
 * someone to take the most important decision on the screen on trust.
 *
 * These are drawn from the same weights the launch actually uses, so the shape
 * is the shape. More liquidity in a segment means more supply absorbed per unit
 * of price, which is a *flatter* stretch of curve — so the drawn height at each
 * step is the inverse of the weight, accumulated.
 */

const SEGMENTS = 16;

/** Mirrors `lib/juno/curves.ts`. Geometric ratios and the book shape. */
export const PRESET_WEIGHTS: Record<string, number[]> = {
  content: Array.from({ length: SEGMENTS }, (_, i) => Number(Math.pow(1.2, i).toFixed(6))),
  "thin-name": Array.from({ length: SEGMENTS }, (_, i) => Number(Math.pow(0.82, i).toFixed(6))),
  "ipo-book": Array.from({ length: SEGMENTS }, (_, i) => {
    const mid = (SEGMENTS - 1) / 2;
    const t = (i - mid) / mid;
    return Number((0.25 + 0.75 * t * t).toFixed(6));
  }),
  "tight-nav": Array.from({ length: SEGMENTS }, () => 1),
};

const W = 120;
const H = 48;

export function CurvePreview({
  preset,
  active = false,
}: {
  preset: string;
  active?: boolean;
}) {
  const weights = PRESET_WEIGHTS[preset] ?? PRESET_WEIGHTS.content;

  // Price climbs fastest where liquidity is thinnest, so each step rises by the
  // inverse of its weight. Normalised to the box rather than to an absolute
  // price — this is the curve's *character*, not a quote.
  const steps: number[] = [];
  let total = 0;
  for (const weight of weights) {
    total += 1 / Math.max(weight, 0.001);
    steps.push(total);
  }
  const peak = steps[steps.length - 1] || 1;

  const points = steps.map((value, i) => {
    const x = (i / (SEGMENTS - 1)) * W;
    const y = H - (value / peak) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = `M${points.join(" L")}`;
  const area = `${line} L${W},${H} L0,${H} Z`;
  const stroke = active ? theme.colors.onLime : theme.colors.muted;

  return (
    <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <Defs>
        <LinearGradient id={`cv-${preset}`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor={stroke} stopOpacity={active ? 0.3 : 0.16} />
          <Stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={area} fill={`url(#cv-${preset})`} />
      <Path d={line} stroke={stroke} strokeWidth={2} fill="none" strokeLinejoin="round" />
    </Svg>
  );
}
