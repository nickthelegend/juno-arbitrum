import { useMemo, useState } from "react";
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import styled from "styled-components/native";

import { Caption } from "./kit";
import { theme } from "../theme";

/**
 * Value over time, with the volume underneath it.
 *
 * Every point is something that actually happened — a trade at a price someone
 * paid — not a sample from a continuous feed. Three consequences follow, and
 * they are the difference between a chart and a decoration:
 *
 * **The dots are drawn.** A bare line through four trades looks like a
 * continuously quoted market. The markers are where value was actually
 * established; the line only joins them.
 *
 * **The x axis is real time.** Sequence spacing would make eight trades in ten
 * minutes look like eight evenly spaced sessions. Clustered points are the
 * truth about when this wallet traded.
 *
 * **The y axis does not start at zero.** For a value series a zero baseline
 * compresses every real move into a flat line near the top. The range is
 * labelled instead of implied.
 *
 * Direction is carried by colour *and* by the signed figure the caller shows
 * beside it — Juno's up/down pair sits only just above the colourblind
 * separation floor, so colour is never the only thing saying which way it went.
 */

export type Point = { t: string; value: number };

export type Range = "H" | "D" | "W" | "M" | "Y" | "ALL";

export const RANGES: { id: Range; label: string }[] = [
  { id: "H", label: "Hour" },
  { id: "D", label: "Day" },
  { id: "W", label: "Week" },
  { id: "M", label: "Month" },
  { id: "Y", label: "Year" },
  { id: "ALL", label: "All" },
];

const WINDOW_MS: Record<Range, number> = {
  H: 3_600_000,
  D: 86_400_000,
  W: 7 * 86_400_000,
  M: 30 * 86_400_000,
  Y: 365 * 86_400_000,
  ALL: Number.POSITIVE_INFINITY,
};

/** Keep points inside the range, but never render a single-point line. */
export function withinRange(points: Point[], range: Range, now = Date.now()): Point[] {
  if (range === "ALL") return points;
  const cut = now - WINDOW_MS[range];
  const inside = points.filter((p) => Date.parse(p.t) >= cut);
  return inside.length >= 2 ? inside : points.slice(-2);
}

const W = 320;
const H = 150;
const PAD = { top: 14, right: 8, bottom: 26, left: 8 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
/** The volume strip under the plot, as in the reference. */
const BAR_H = 26;

export function AreaChart({
  points,
  format,
  bars,
  emptyLabel,
}: {
  points: Point[];
  format: (value: number) => string;
  /** Optional per-point magnitude, drawn as the strip beneath. */
  bars?: number[];
  /**
   * What an empty series means here.
   *
   * The default says "No history yet", which is a claim about the wallet. When
   * the caller knows the read did not finish, that claim is not available and
   * it passes the one that is.
   */
  emptyLabel?: string;
}) {
  const [active, setActive] = useState<number | null>(null);

  const shape = useMemo(() => {
    if (points.length < 2) return null;

    const values = points.map((p) => p.value);
    const times = points.map((p) => Date.parse(p.t));

    const min = Math.min(...values);
    const max = Math.max(...values);
    // A wallet that has always been worth the same has no range to scale to.
    const span = max - min || max || 1;
    const low = min - span * 0.15;
    const high = max + span * 0.15;

    const first = times[0];
    const duration = times[times.length - 1] - first || 1;

    const scaled = points.map((p, i) => ({
      ...p,
      x: PAD.left + ((times[i] - first) / duration) * PLOT_W,
      y: PAD.top + PLOT_H - ((p.value - low) / (high - low)) * PLOT_H,
    }));

    return { scaled, min, max, change: (values[values.length - 1] - values[0]) / (values[0] || 1) };
  }, [points]);

  if (!shape) {
    return (
      <Empty>
        <Caption>
          {points.length === 1
            ? "One data point so far — a line needs two."
            : (emptyLabel ?? "No history yet.")}
        </Caption>
      </Empty>
    );
  }

  const { scaled, min, max, change } = shape;
  const up = change >= 0;
  const stroke = up ? theme.colors.pos : theme.colors.neg;
  const last = scaled[scaled.length - 1];
  const shown = active === null ? last : scaled[active];

  const line = scaled.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${PAD.left},${PAD.top + PLOT_H} ${line} ${last.x.toFixed(1)},${PAD.top + PLOT_H}`;
  const band = PLOT_W / scaled.length;
  const maxBar = bars && bars.length ? Math.max(...bars, 1) : 1;

  return (
    <Wrap>
      <Readout>
        <ReadoutValue>{format(shown.value)}</ReadoutValue>
        <Caption>{new Date(shown.t).toLocaleString()}</Caption>
      </Readout>

      <Svg viewBox={`0 0 ${W} ${H + BAR_H}`} width="100%" style={{ aspectRatio: W / (H + BAR_H) }}>
        <Defs>
          <LinearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
            <Stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
          </LinearGradient>
        </Defs>

        {/* Hairline grid, one shade off the surface — present, not loud. */}
        {[0, 0.5, 1].map((f) => (
          <Line
            key={f}
            x1={PAD.left}
            x2={PAD.left + PLOT_W}
            y1={PAD.top + PLOT_H * f}
            y2={PAD.top + PLOT_H * f}
            stroke={theme.colors.line}
            strokeWidth={1}
          />
        ))}

        <Path d={`M${area.replace(/ /g, " L")}`} fill="url(#areaFill)" />
        <Path
          d={`M${line.replace(/ /g, " L")}`}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* The trades themselves, so a sparse history cannot look continuous. */}
        {scaled.map((p, i) => (
          <Circle
            key={`${p.t}-${i}`}
            cx={p.x}
            cy={p.y}
            r={i === active ? 4.5 : 2.5}
            fill={stroke}
            stroke={theme.colors.surface}
            strokeWidth={1.5}
          />
        ))}

        {active !== null ? (
          <Line
            x1={scaled[active].x}
            x2={scaled[active].x}
            y1={PAD.top}
            y2={PAD.top + PLOT_H}
            stroke={theme.colors.lineStrong}
            strokeWidth={1}
          />
        ) : null}

        {/* Volume strip. */}
        {bars
          ? bars.map((v, i) => {
              const h = Math.max(1, (v / maxBar) * (BAR_H - 6));
              return (
                <Rect
                  key={`bar-${i}`}
                  x={PAD.left + i * band + band * 0.25}
                  y={H + (BAR_H - 6) - h}
                  width={Math.max(1.5, band * 0.5)}
                  height={h}
                  rx={1}
                  fill={theme.colors.lineStrong}
                />
              );
            })
          : null}

        {/* Hit bands, each far wider than its dot. */}
        <G>
          {scaled.map((p, i) => (
            <Rect
              key={`hit-${i}`}
              x={PAD.left + i * band}
              y={0}
              width={band}
              height={H}
              fill="transparent"
              onPressIn={() => setActive(i)}
            />
          ))}
        </G>
      </Svg>

      <Axis>
        <Caption>{format(min)}</Caption>
        <Caption>{format(max)}</Caption>
      </Axis>
    </Wrap>
  );
}

const Wrap = styled.View`
  gap: 6px;
`;

const Readout = styled.View`
  align-items: center;
  gap: 2px;
`;

const ReadoutValue = styled.Text`
  font-size: ${(p) => p.theme.type.body.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.text};
`;

const Axis = styled.View`
  flex-direction: row;
  justify-content: space-between;
`;

const Empty = styled.View`
  height: 150px;
  align-items: center;
  justify-content: center;
`;
