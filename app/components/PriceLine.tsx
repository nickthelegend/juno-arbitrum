import { useMemo, useState } from "react";
import { PanResponder, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";
import styled from "styled-components/native";

import { Caption } from "./kit";
import { theme } from "../theme";

/**
 * The price, as one line, at the top of the screen.
 *
 * A candle chart answers "what happened in each interval". This answers "what
 * is it doing", which is the question someone has in the first two seconds of
 * opening a coin — so it is the hero, drawn edge to edge with no card around
 * it and no axis furniture competing with it.
 *
 * ## It is still every real trade
 *
 * The line joins fills, not samples. Two consequences are load-bearing:
 * spacing is real time, so eight trades in ten minutes cluster rather than
 * spreading into eight even sessions; and the y range is the data's own, not
 * zero-based, because a zero baseline flattens every real move on a curve
 * whose price is a millionth of a cent.
 *
 * The last point keeps its dot. On a market with four fills, a bare line is a
 * claim to continuous quotation that nobody made.
 *
 * ## Colour
 *
 * From the move across the window, and never alone: the figure beside the
 * chart carries a sign, because Juno's up/down pair sits only just above the
 * colourblind separation floor.
 */

export type Tick = { t: string; price: number };

export type Span = "1H" | "1D" | "1W" | "1M" | "ALL";

export const SPANS: { id: Span; label: string }[] = [
  { id: "1H", label: "1H" },
  { id: "1D", label: "1D" },
  { id: "1W", label: "1W" },
  { id: "1M", label: "1M" },
  { id: "ALL", label: "All" },
];

/** Said in words. "past D" is not a period anyone recognises. */
const WINDOW_WORDS: Record<Span, string> = {
  "1H": "past hour",
  "1D": "past day",
  "1W": "past week",
  "1M": "past month",
  ALL: "all time",
};

const WINDOW_MS: Record<Span, number> = {
  "1H": 3_600_000,
  "1D": 86_400_000,
  "1W": 7 * 86_400_000,
  "1M": 30 * 86_400_000,
  ALL: Number.POSITIVE_INFINITY,
};

/**
 * Ticks inside the span — but never fewer than two.
 *
 * A one-point line is not a line, and a span that happens to contain one fill
 * would otherwise render as a dot in the corner. Falling back to the last two
 * is a smaller lie than an empty chart, and the span pill stays selected so it
 * is clear which window was asked for.
 */
export function withinSpan(ticks: Tick[], span: Span, now = Date.now()): Tick[] {
  if (span === "ALL") return ticks;
  const cut = now - WINDOW_MS[span];
  const inside = ticks.filter((tick) => Date.parse(tick.t) >= cut);
  return inside.length >= 2 ? inside : ticks.slice(-2);
}

export function PriceLine({
  ticks,
  livePrice,
  format,
  partial,
  height = 168,
}: {
  ticks: Tick[];
  /** The curve's price right now, appended so the line ends at today. */
  livePrice: number;
  format: (value: number) => string;
  /** The swap walk was cut short: this is a prefix of the history. */
  partial?: boolean;
  height?: number;
}) {
  const [span, setSpan] = useState<Span>("1D");
  const [width, setWidth] = useState(0);
  // Where the finger is, as an index into the drawn series. Null when nobody
  // is touching it — the readout then shows the latest price rather than
  // nothing, so the space it occupies never collapses.
  const [held, setHeld] = useState<number | null>(null);

  const series = useMemo(() => {
    const base = withinSpan(ticks, span);
    if (base.length === 0) return [];
    const last = base[base.length - 1];
    // The live price is a real reading and the newest one there is. Appending
    // it is what stops the line ending at the last trade and implying nothing
    // has happened since.
    return Number.isFinite(livePrice) && livePrice > 0 && livePrice !== last.price
      ? [...base, { t: new Date().toISOString(), price: livePrice }]
      : base;
  }, [ticks, span, livePrice]);

  const geometry = useMemo(() => {
    if (series.length < 2 || width <= 0) return null;

    const times = series.map((tick) => Date.parse(tick.t));
    const prices = series.map((tick) => tick.price);
    const t0 = times[0];
    const t1 = times[times.length - 1];
    const span_ = Math.max(t1 - t0, 1);

    const low = Math.min(...prices);
    const high = Math.max(...prices);
    // A flat series has no range to scale against; give it one so the line
    // sits in the middle instead of dividing by zero.
    const pad = high === low ? Math.max(high * 0.05, Number.EPSILON) : (high - low) * 0.14;
    const top = high + pad;
    const bottom = low - pad;

    /* Inset by the end dot's radius. The line is meant to run edge to edge,
       but a 4.5pt circle centred on x=width is a half-circle: the last point —
       the live price, the one the readout is about — was sliced in half by the
       screen. */
    const inset = 6;
    const span_x = Math.max(width - inset * 2, 1);
    const x = (time: number) => inset + ((time - t0) / span_) * span_x;
    const y = (price: number) =>
      inset + (height - inset * 2) - ((price - bottom) / (top - bottom)) * (height - inset * 2);

    const points = series.map((tick, i) => ({ x: x(times[i]), y: y(tick.price), price: tick.price, t: tick.t }));
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
    const area = `${d} L${width.toFixed(2)} ${height} L0 ${height} Z`;

    return { points, d, area };
  }, [series, width, height]);

  const first = series[0]?.price ?? null;
  const shownIndex = held ?? (geometry ? geometry.points.length - 1 : null);
  const shown = shownIndex !== null && geometry ? geometry.points[shownIndex] : null;
  const move = first !== null && first > 0 && shown ? (shown.price - first) / first : null;
  const rising = move === null ? true : move >= 0;
  const stroke = rising ? theme.colors.pos : theme.colors.neg;

  /*
   * Drag to read a price off the line.
   *
   * Nearest point by x rather than by proximity in both axes: a finger is
   * scrubbing along time, and a vertical component would make the readout jump
   * to a different moment because the line happened to bend nearer the thumb.
   */
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => locate(event.nativeEvent.locationX),
        onPanResponderMove: (event) => locate(event.nativeEvent.locationX),
        onPanResponderRelease: () => setHeld(null),
        onPanResponderTerminate: () => setHeld(null),
      }),
    // `geometry` is read inside `locate`; rebuilding the responder when the
    // points change is what keeps the scrub aligned after a span switch.
    [geometry],
  );

  function locate(touchX: number) {
    if (!geometry) return;
    let best = 0;
    let bestGap = Number.POSITIVE_INFINITY;
    geometry.points.forEach((point, index) => {
      const gap = Math.abs(point.x - touchX);
      if (gap < bestGap) {
        bestGap = gap;
        best = index;
      }
    });
    setHeld(best);
  }

  return (
    <View>
      <Readout>
        <Price>{shown ? format(shown.price) : format(livePrice)}</Price>
        <Row>
          {move === null ? (
            <Caption>—</Caption>
          ) : (
            <Move $rising={rising}>
              {move >= 0 ? "+" : ""}
              {(move * 100).toFixed(2)}%
            </Move>
          )}
          <Caption>{held !== null && shown ? new Date(shown.t).toLocaleString() : WINDOW_WORDS[span]}</Caption>
        </Row>
      </Readout>

      <Plot
        style={{ height }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        {...pan.panHandlers}
      >
        {geometry ? (
          <Svg width={width} height={height}>
            <Defs>
              <LinearGradient id="priceFade" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={stroke} stopOpacity={0.16} />
                <Stop offset="1" stopColor={stroke} stopOpacity={0} />
              </LinearGradient>
            </Defs>

            <Path d={geometry.area} fill="url(#priceFade)" />
            <Path
              d={geometry.d}
              stroke={stroke}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />

            {/* The end of the line, and where a finger is. Both are real
                readings, so both get a dot. */}
            <Circle
              cx={geometry.points[geometry.points.length - 1].x}
              cy={geometry.points[geometry.points.length - 1].y}
              r={4.5}
              fill={stroke}
            />
            {held !== null && shown ? (
              <>
                <Path
                  d={`M${shown.x.toFixed(2)} 0 L${shown.x.toFixed(2)} ${height}`}
                  stroke={theme.colors.line}
                  strokeWidth={1}
                />
                <Circle cx={shown.x} cy={shown.y} r={5.5} fill={theme.colors.surface} />
                <Circle cx={shown.x} cy={shown.y} r={3.5} fill={stroke} />
              </>
            ) : null}
          </Svg>
        ) : series.length >= 2 ? (
          // Enough to draw, not yet measured. An empty plot until the width
          // arrives — this said "No trades yet." over a coin with thirteen.
          <Empty />
        ) : (
          <Empty>
            <Caption>
              {partial
                ? "Price history could not be read — the RPC is rate-limiting."
                : series.length === 1
                  ? "One trade so far — not enough to draw a line."
                  : "No trades yet."}
            </Caption>
          </Empty>
        )}
      </Plot>

      <Spans>
        {SPANS.map((option) => (
          <SpanPill
            key={option.id}
            $on={option.id === span}
            onPress={() => setSpan(option.id)}
            accessibilityRole="button"
            accessibilityState={{ selected: option.id === span }}
          >
            <SpanText $on={option.id === span}>{option.label}</SpanText>
          </SpanPill>
        ))}
      </Spans>

      {partial && geometry ? (
        <Caption style={{ textAlign: "center", marginTop: 2 }}>
          Some history would not load — this line is a prefix.
        </Caption>
      ) : null}
    </View>
  );
}

const Readout = styled.View`
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  gap: 2px;
`;

const Price = styled.Text`
  font-size: ${(p) => p.theme.type.display.size}px;
  line-height: ${(p) => p.theme.type.display.height}px;
  letter-spacing: ${(p) => p.theme.type.display.tracking}px;
  font-weight: 800;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.text};
`;

const Row = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 8px;
`;

const Move = styled.Text<{ $rising: boolean }>`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => (p.$rising ? p.theme.colors.pos : p.theme.colors.neg)};
`;

const Plot = styled.View`
  margin-top: ${(p) => p.theme.space(3)}px;
  justify-content: center;
`;

const Empty = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
  padding-horizontal: ${(p) => p.theme.space(4)}px;
`;

const Spans = styled.View`
  flex-direction: row;
  justify-content: center;
  gap: 4px;
  margin-top: ${(p) => p.theme.space(2)}px;
`;

const SpanPill = styled.Pressable<{ $on: boolean }>`
  padding-horizontal: 14px;
  padding-vertical: 7px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => (p.$on ? p.theme.colors.surfaceAlt : "transparent")};
`;

const SpanText = styled.Text<{ $on: boolean }>`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 700;
  letter-spacing: ${(p) => p.theme.type.caption.tracking}px;
  color: ${(p) => (p.$on ? p.theme.colors.text : p.theme.colors.muted)};
`;
