import Svg, { Circle, Path, Rect } from "react-native-svg";

import { theme } from "../theme";

/**
 * The Juno mark.
 *
 * It is the bonding curve, because the bonding curve is the product. Publishing
 * a post opens a curve and the curve *is* the price — so the mark is one
 * confident stroke accelerating upward, ending in a single filled point.
 *
 * What it deliberately is not: a bar chart, a candlestick, an arrow, or a glyph
 * inside a ring. Those say "finance app" and nothing else; every competitor has
 * one. A curve with a point at its end says what this specific thing does, and
 * it survives being shrunk to a 24px tab icon, which a cluster of bars does not.
 *
 * Geometry is fixed rather than parameterised: the whole value of a mark is
 * that it is the same shape everywhere.
 */

/** The curve itself, on a transparent background. */
export function JunoMark({
  size = 32,
  color = theme.colors.lime,
}: {
  size?: number;
  color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {/*
        Starts almost flat and steepens — the shape of a curve where early
        entry is genuinely cheaper, which is the thing the presets are for.
        Stroke width and cap are tuned so the line still reads at 20px.
      */}
      <Path
        d="M9 38.5C9 38.5 18 36.5 24 30C29 24.6 30.5 18.5 30.5 18.5"
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
      />
      {/*
        The point the curve is heading for, held clear of the stroke. Joined up
        they read as one lollipop; separated they read as a curve accelerating
        *toward* something, which is the whole idea.
      */}
      <Circle cx={36.5} cy={10.5} r={4.8} fill={color} />
    </Svg>
  );
}

/**
 * The mark on its own tile — for an app icon, or anywhere it needs a surface
 * of its own rather than borrowing the page's.
 */
export function JunoIcon({ size = 64, radius = 14 }: { size?: number; radius?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <Rect width={48} height={48} rx={radius} fill={theme.colors.ink} />
      <Path
        d="M9 38.5C9 38.5 18 36.5 24 30C29 24.6 30.5 18.5 30.5 18.5"
        stroke={theme.colors.lime}
        strokeWidth={4.6}
        strokeLinecap="round"
      />
      <Circle cx={36.5} cy={10.5} r={4.6} fill={theme.colors.lime} />
    </Svg>
  );
}

/**
 * The lockup: mark plus wordmark.
 *
 * The word is set in the app's own type rather than drawn, so it stays
 * consistent with every other heading and needs no font file of its own.
 */
export function JunoLockup({ size = 28 }: { size?: number }) {
  return <JunoMark size={size} color={theme.colors.ink} />;
}
