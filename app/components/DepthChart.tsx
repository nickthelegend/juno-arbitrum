import { useState } from "react";
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop } from "react-native-svg";
import styled from "styled-components/native";

import { juno, type DepthPoint } from "../lib/api";
import { money } from "../lib/format";
import { useApi } from "../lib/useApi";
import { theme } from "../theme";

/**
 * How far a buy of each size moves this coin's price.
 *
 * A bonding curve's "price" is only the price of an infinitesimal trade, and
 * the difference between the four presets is entirely in how fast that gives
 * way with size. The server quotes twelve log-spaced sizes against the live
 * curve with the same `swapQuote` the buy button uses; this draws them.
 *
 * The y axis is curve movement with the fee taken out. The fee is a constant
 * percentage, so including it would lift every point by the same amount and
 * hide the one thing the chart exists to show.
 */

const H = 132;
const PAD = { top: 10, right: 8, bottom: 6, left: 8 };

export function DepthChart({ mint }: { mint: string }) {
  const depth = useApi(() => juno.depth(mint, "buy"), [mint]);
  const [width, setWidth] = useState(0);

  const points = (depth.data?.points ?? []).filter(
    (p) => p.amountIn > 0 && Number.isFinite(p.curveImpact),
  );
  const rate = depth.data?.quoteUsdRate ?? 1;

  if (depth.loading && !depth.data) {
    return (
      <Box>
        <Title>Depth</Title>
        <Muted>Quoting the curve…</Muted>
      </Box>
    );
  }
  if (points.length < 2) {
    return (
      <Box>
        <Title>Depth</Title>
        <Muted>{depth.error ? "The curve could not be quoted just now." : "Not enough curve left to chart."}</Muted>
      </Box>
    );
  }

  const readout = pick(points);

  return (
    <Box>
      <Title>What a buy moves the price</Title>
      <Muted>Quoted against the live curve · fee excluded</Muted>
      <Plot onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 ? <Chart points={points} width={width} /> : null}
      </Plot>
      <Axis>
        <AxisText>{money(points[0].amountIn * rate, "USD", { compact: true })}</AxisText>
        <AxisText>size, log scale</AxisText>
        <AxisText>
          {money(points[points.length - 1].amountIn * rate, "USD", { compact: true })}
        </AxisText>
      </Axis>
      <Readout>
        {readout.map((p) => (
          <ReadCell key={p.amountIn}>
            <ReadValue>{pct(p.curveImpact)}</ReadValue>
            <Muted>buying {money(p.amountIn * rate, "USD", { compact: true })}</Muted>
          </ReadCell>
        ))}
      </Readout>
    </Box>
  );
}

function Chart({ points, width }: { points: DepthPoint[]; width: number }) {
  const lo = Math.log(points[0].amountIn);
  const hi = Math.log(points[points.length - 1].amountIn);
  const top = Math.max(...points.map((p) => p.curveImpact), 1e-6);
  const innerW = width - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const xy = points.map((p) => ({
    x: PAD.left + ((Math.log(p.amountIn) - lo) / Math.max(hi - lo, 1e-9)) * innerW,
    y: PAD.top + innerH - (p.curveImpact / top) * innerH,
  }));
  const line = `M${xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L")}`;
  const base = PAD.top + innerH;
  const area = `${line} L${xy[xy.length - 1].x.toFixed(1)},${base} L${xy[0].x.toFixed(1)},${base} Z`;
  const last = xy[xy.length - 1];

  return (
    <Svg width={width} height={H}>
      <Defs>
        <LinearGradient id="depth-fill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0%" stopColor={theme.colors.text} stopOpacity={0.14} />
          <Stop offset="100%" stopColor={theme.colors.text} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Line x1={PAD.left} x2={width - PAD.right} y1={base} y2={base} stroke={theme.colors.line} />
      <Path d={area} fill="url(#depth-fill)" />
      <Path d={line} stroke={theme.colors.text} strokeWidth={2} fill="none" strokeLinejoin="round" />
      <Circle cx={last.x} cy={last.y} r={3.5} fill={theme.colors.text} />
    </Svg>
  );
}

/** Three sizes worth reading: small, middling, and the largest quoted. */
function pick(points: DepthPoint[]): DepthPoint[] {
  const at = (f: number) => points[Math.min(points.length - 1, Math.round(f * (points.length - 1)))];
  return [...new Set([at(0.35), at(0.7), at(1)])];
}

function pct(ratio: number): string {
  const value = ratio * 100;
  if (value < 0.01) return "<0.01%";
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)}%`;
}

const Box = styled.View`
  margin-top: 16px;
  padding: 14px;
  border-radius: 16px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const Title = styled.Text`
  font-size: 15px;
  font-weight: 700;
  color: ${(p) => p.theme.colors.text};
`;

const Muted = styled.Text`
  margin-top: 2px;
  font-size: 12px;
  color: ${(p) => p.theme.colors.muted};
`;

const Plot = styled.View`
  margin-top: 10px;
  height: ${H}px;
`;

const Axis = styled.View`
  flex-direction: row;
  justify-content: space-between;
  margin-top: 4px;
`;

const AxisText = styled.Text`
  font-size: 11px;
  color: ${(p) => p.theme.colors.faint};
`;

const Readout = styled.View`
  flex-direction: row;
  margin-top: 12px;
  gap: 8px;
`;

const ReadCell = styled.View`
  flex: 1;
  padding: 10px;
  border-radius: 12px;
  background-color: ${(p) => p.theme.colors.surface};
`;

const ReadValue = styled.Text`
  font-size: 16px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.text};
`;
