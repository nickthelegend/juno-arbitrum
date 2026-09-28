import React, { useMemo, useState } from "react";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";
import styled from "styled-components/native";

import { Caption, Segmented } from "./kit";
import { BUCKETS, defaultBucket, toCandles, type Bucket, type Tick } from "../lib/candles";
import { theme } from "../theme";

/**
 * A candlestick chart, built from the pool's own trades.
 *
 * Nothing streams OHLC for a Juno pool — there is no exchange behind it and no
 * indexer in front of it. What exists is every executed swap, decoded from the
 * pool's vault deltas, and a candle is just those swaps grouped by time: first
 * price open, last price close, extremes high and low, quote size summed into
 * volume. So these are real candles over real fills, not a shape fitted to a
 * line.
 *
 * ## What that honestly means
 *
 * A bucket nobody traded in has no candle, and none is drawn. Carrying the last
 * close forward would manufacture a flat candle for a period where nothing
 * happened, which on a thin market is most of them — it would turn "this pool
 * traded four times" into a dense chart implying continuous activity. A gap is
 * the truthful rendering.
 *
 * Candle bodies are therefore also the wrong place to read liquidity from. The
 * volume strip underneath is, and it is drawn from the same trades.
 */

const W = 340;
const PRICE_H = 168;
const VOL_H = 34;
const AXIS_W = 62;
const PLOT_W = W - AXIS_W - 6;

export function Candles({
  ticks,
  partial = false,
  livePrice,
  format,
}: {
  /** Undefined when the history was never requested for this view. */
  ticks: Tick[] | undefined;
  /**
   * The swap read was cut short, so `ticks` is a prefix of the real history.
   *
   * An empty partial read is the case worth separating: it is indistinguishable
   * from a pool that has never traded, and saying "No trades yet" there is a
   * claim the app did not earn — the coin's own activity list often shows fills
   * on the same screen.
   */
  partial?: boolean;
  /** The current curve price, marked on the axis. */
  livePrice: number;
  format: (value: number) => string;
}) {
  // Chosen from the data's own span, then the reader can override. A fixed
  // default showed four trades made minutes apart as a single fat candle.
  const [bucket, setBucket] = useState<Bucket | null>(null);
  const resolved = bucket ?? defaultBucket(ticks ?? []);
  const [active, setActive] = useState<number | null>(null);

  const candles = useMemo(() => toCandles(ticks ?? [], resolved), [ticks, resolved]);

  const scale = useMemo(() => {
    if (candles.length === 0) return null;
    const lows = candles.map((c) => c.low);
    const highs = candles.map((c) => c.high);
    // The live price belongs inside the frame — it is the number being marked.
    const min = Math.min(...lows, livePrice);
    const max = Math.max(...highs, livePrice);
    const span = max - min || max || 1;
    return { low: min - span * 0.12, high: max + span * 0.12 };
  }, [candles, livePrice]);

  if (candles.length === 0 || !scale) {
    return (
      <Frame>
        <Empty>
          <Caption>
            {ticks === undefined
              ? "Price history was not loaded for this view."
              : partial
                ? "Trade history could not be read — the RPC is rate-limiting."
                : "No trades yet — nothing to chart."}
          </Caption>
        </Empty>
        <Segmented items={BUCKETS} value={resolved} onChange={setBucket} />
      </Frame>
    );
  }

  const y = (price: number) =>
    PRICE_H - ((price - scale.low) / (scale.high - scale.low)) * PRICE_H;

  const slot = PLOT_W / candles.length;
  const body = Math.max(3, Math.min(14, slot * 0.6));
  const maxVolume = Math.max(...candles.map((c) => c.volume), 1e-12);
  const shown = active === null ? candles[candles.length - 1] : candles[active];
  const liveY = y(livePrice);

  return (
    <Frame>
      {/* The readout, so a value is reachable without a hover the way a phone
          cannot do anyway. */}
      <Readout>
        <ReadoutRow>
          {partial ? <Caption>partial ·</Caption> : null}
          <Caption>O</Caption>
          <Mono>{format(shown.open)}</Mono>
          <Caption>H</Caption>
          <Mono>{format(shown.high)}</Mono>
          <Caption>L</Caption>
          <Mono>{format(shown.low)}</Mono>
          <Caption>C</Caption>
          <Mono $up={shown.close >= shown.open}>{format(shown.close)}</Mono>
        </ReadoutRow>
        <Caption>{new Date(shown.at).toLocaleString()}</Caption>
      </Readout>

      <Svg
        viewBox={`0 0 ${W} ${PRICE_H + VOL_H + 14}`}
        width="100%"
        style={{ aspectRatio: W / (PRICE_H + VOL_H + 14) }}
      >
        {/* Hairline grid with the price axis on the right, as a trader reads it. */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const gy = PRICE_H * f;
          const price = scale.high - (scale.high - scale.low) * f;
          return (
            <Line
              key={`g${f}`}
              x1={0}
              x2={PLOT_W}
              y1={gy}
              y2={gy}
              stroke={theme.colors.line}
              strokeWidth={1}
            />
          );
        })}
        {[0, 0.5, 1].map((f) => (
          <SvgText
            key={`l${f}`}
            x={PLOT_W + 8}
            y={Math.min(PRICE_H - 2, Math.max(9, PRICE_H * f + 3))}
            fontSize={9}
            fill={theme.colors.faint}
          >
            {format(scale.high - (scale.high - scale.low) * f)}
          </SvgText>
        ))}

        {/* The live price, marked on the axis in lime. */}
        <Line
          x1={0}
          x2={PLOT_W}
          y1={liveY}
          y2={liveY}
          stroke={theme.colors.lineStrong}
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        <Rect
          x={PLOT_W + 4}
          y={Math.max(0, liveY - 8)}
          width={AXIS_W - 6}
          height={16}
          rx={8}
          fill={theme.colors.lime}
        />
        <SvgText
          x={PLOT_W + 9}
          y={Math.max(0, liveY - 8) + 11}
          fontSize={9}
          fontWeight="700"
          fill={theme.colors.onLime}
        >
          {format(livePrice)}
        </SvgText>

        {candles.map((candle, i) => {
          const cx = i * slot + slot / 2;
          const up = candle.close >= candle.open;
          const colour = up ? theme.colors.pos : theme.colors.neg;
          const top = y(Math.max(candle.open, candle.close));
          const bottom = y(Math.min(candle.open, candle.close));
          const vh = Math.max(1, (candle.volume / maxVolume) * (VOL_H - 6));

          return (
            <React.Fragment key={candle.at}>
              {/* Wick. */}
              <Line
                x1={cx}
                x2={cx}
                y1={y(candle.high)}
                y2={y(candle.low)}
                stroke={colour}
                strokeWidth={1.4}
              />
              {/* Body. A doji would be invisible without a floor height. */}
              <Rect
                x={cx - body / 2}
                y={top}
                width={body}
                height={Math.max(1.5, bottom - top)}
                rx={1.5}
                fill={colour}
                opacity={i === active ? 1 : 0.92}
              />
              {/* Volume, same colour so the two strips read together. */}
              <Rect
                x={cx - body / 2}
                y={PRICE_H + 14 + (VOL_H - 6) - vh}
                width={body}
                height={vh}
                rx={1}
                fill={colour}
                opacity={0.38}
              />
              {/* A hit band far wider than the candle. */}
              <Rect
                x={i * slot}
                y={0}
                width={slot}
                height={PRICE_H + VOL_H + 14}
                fill="transparent"
                onPressIn={() => setActive(i)}
              />
            </React.Fragment>
          );
        })}
      </Svg>

      <Segmented items={BUCKETS} value={resolved} onChange={setBucket} />
    </Frame>
  );
}


const Frame = styled.View`
  gap: ${(p) => p.theme.space(2)}px;
`;

const Readout = styled.View`
  gap: 2px;
`;

const ReadoutRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
`;

const Mono = styled.Text<{ $up?: boolean }>`
  font-size: ${(p) => p.theme.type.micro.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) =>
    p.$up === undefined
      ? p.theme.colors.text
      : p.$up
        ? p.theme.colors.pos
        : p.theme.colors.neg};
`;

const Empty = styled.View`
  height: ${PRICE_H}px;
  align-items: center;
  justify-content: center;
`;
