import React from "react";
import { ActivityIndicator, Animated, Pressable, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import styled, { css } from "styled-components/native";

import { usePressScale } from "./Press";
import { theme } from "../theme";

/**
 * The component kit, written from scratch with styled-components.
 *
 * One file on purpose. At this size a component per file buys nothing and makes
 * the visual language harder to hold together, which is the thing that actually
 * decides whether an app looks deliberate or assembled.
 */

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

export const Screen = styled.View`
  flex: 1;
  background-color: ${(p) => p.theme.colors.bg};
`;

export const Card = styled.View`
  background-color: ${(p) => p.theme.colors.surface};
  border-radius: ${(p) => p.theme.radius.lg}px;
  padding: ${(p) => p.theme.space(4)}px;
`;

/**
 * One sheet of paper, ruled into entries.
 *
 * This replaces a card per row. A feed of identically-sized white rectangles
 * floating on the canvas is the default shape of every generated interface, and
 * it costs something real here: twelve shadows and twelve gaps of chrome around
 * twelve rows of content, in an app whose subject is a list of things that
 * happened. One surface with hairline rules is denser, quieter, and reads as
 * what it is — a record.
 *
 * It also removes the nested-card problem by construction. A chip or a figure
 * block inside a `Ledger` sits on the same sheet; there is no second card to
 * nest.
 */
export const Ledger = styled.View`
  background-color: ${(p) => p.theme.colors.surface};
  border-radius: ${(p) => p.theme.radius.lg}px;
  overflow: hidden;
  /*
   * Bounded, explicitly.
   *
   * A vertical ScrollView's content container does not reliably cap a child's
   * width, so a Text inside one can measure against an unbounded line and lay
   * itself out on a single row — which the sheet then clips. The tell was that
   * the *shortest* post in the feed was the one cut off: the longer bodies
   * exceeded the over-wide measurement and wrapped anyway, so the bug looked
   * like one bad string rather than a missing constraint.
   */
  align-self: stretch;
  width: 100%;
`;

/**
 * A stack of separate cards, where a `Ledger` is one continuous sheet.
 *
 * A ledger is right when the rows are a *record* — a list of fills, a table of
 * holders — because a shared edge is what makes them read as one document. It
 * is wrong for a feed, where each entry is somebody's separate utterance: run
 * together with only a hairline between them, one person's post and the next
 * person's trade looked like paragraphs of the same thing.
 */
export const Stack = styled.View`
  align-self: stretch;
  width: 100%;
  gap: ${(p) => p.theme.space(3)}px;
`;

/**
 * One entry.
 *
 * Inside a `Ledger` the rule goes above, so the first entry has none. Inside a
 * `Stack` each entry is its own card: `$card` gives it the surface and the
 * radius the sheet would otherwise have provided, and drops the rule, because
 * a gap already separates them and doing both is saying it twice.
 */
export const Entry = styled.View<{ $first?: boolean; $card?: boolean }>`
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-vertical: ${(p) => p.theme.space(4)}px;
  border-top-width: ${(p) => (p.$first || p.$card ? 0 : p.theme.hairline)}px;
  border-top-color: ${(p) => p.theme.colors.line};
  ${(p) =>
    p.$card
      ? `background-color: ${p.theme.colors.surface}; border-radius: ${p.theme.radius.lg}px;`
      : ""}
`;

/**
 * A hairline at the device's own scale.
 *
 * A "1px" rule declared as 1 renders three device pixels thick on a 3× screen,
 * which is the commonest reason a light interface looks heavier than it was
 * drawn.
 */
export const Rule = styled.View`
  height: ${(p) => p.theme.hairline}px;
  background-color: ${(p) => p.theme.colors.line};
`;

/** A card that wants contrast — the one dark surface in a light app. */
export const InkCard = styled.View`
  background-color: ${(p) => p.theme.colors.ink};
  border-radius: ${(p) => p.theme.radius.lg}px;
  padding: ${(p) => p.theme.space(5)}px;
`;

export const Row = styled.View<{ gap?: number; align?: string; justify?: string }>`
  flex-direction: row;
  align-items: ${(p) => p.align ?? "center"};
  justify-content: ${(p) => p.justify ?? "flex-start"};
  ${(p) => (p.gap ? css`gap: ${p.gap}px;` : "")}
`;

export const Col = styled.View<{ gap?: number }>`
  ${(p) => (p.gap ? css`gap: ${p.gap}px;` : "")}
`;

export const Spacer = styled.View<{ h?: number }>`
  height: ${(p) => p.h ?? 12}px;
`;

/* ------------------------------------------------------------------ */
/* Type                                                                */
/* ------------------------------------------------------------------ */

/**
 * Every size in the app comes from `theme.type`, so a step exists in one place
 * and a screen cannot quietly invent a fifteenth.
 */
const step = (name: keyof typeof theme.type) => css`
  font-size: ${theme.type[name].size}px;
  line-height: ${theme.type[name].height}px;
  letter-spacing: ${theme.type[name].tracking}px;
`;

export const Display = styled.Text`
  ${step("display")}
  font-weight: 800;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.text};
`;

export const Title = styled.Text`
  ${step("screen")}
  font-weight: 800;
  color: ${(p) => p.theme.colors.text};
`;

export const Heading = styled.Text`
  ${step("title")}
  font-weight: 700;
  color: ${(p) => p.theme.colors.text};
`;

export const Body = styled.Text<{ muted?: boolean }>`
  ${step("body")}
  color: ${(p) => (p.muted ? p.theme.colors.muted : p.theme.colors.text)};
`;

export const Label = styled.Text<{ muted?: boolean }>`
  ${step("label")}
  font-weight: 500;
  color: ${(p) => (p.muted ? p.theme.colors.muted : p.theme.colors.text)};
`;

export const Caption = styled.Text`
  ${step("caption")}
  font-weight: 500;
  color: ${(p) => p.theme.colors.faint};
`;

/**
 * Figures that line up in columns.
 *
 * Not a monospace family — the platform face with `tabular-nums`, which is the
 * difference between typesetting a number and dressing one up as "technical".
 * A market app reads figures down a column all day; the digits have to hold
 * their tracks, and nothing else about them needs to change.
 */
export const Mono = styled.Text<{ muted?: boolean }>`
  ${step("label")}
  font-weight: 600;
  font-variant: tabular-nums;
  color: ${(p) => (p.muted ? p.theme.colors.muted : p.theme.colors.text)};
`;

/**
 * A figure at the size it deserves when it is the answer on the screen.
 *
 * Distinct from `Mono` because a price someone is deciding on and a price in a
 * column are not the same typographic job, and setting both at 14px was the
 * reason no screen had an obvious subject.
 */
export const Figure = styled.Text<{ tone?: "pos" | "neg" }>`
  ${step("title")}
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) =>
    p.tone === "pos"
      ? p.theme.colors.pos
      : p.tone === "neg"
        ? p.theme.colors.neg
        : p.theme.colors.text};
`;

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type Variant = "lime" | "ink" | "buy" | "sell" | "quiet";

const FILL: Record<Variant, { bg: string; fg: string }> = {
  lime: { bg: theme.colors.lime, fg: theme.colors.onLime },
  ink: { bg: theme.colors.ink, fg: theme.colors.onInk },
  buy: { bg: theme.colors.pos, fg: "#FFFFFF" },
  sell: { bg: theme.colors.neg, fg: "#FFFFFF" },
  quiet: { bg: theme.colors.surfaceAlt, fg: theme.colors.text },
};

const Touchable = styled(Animated.createAnimatedComponent(Pressable))<{
  $bg: string;
  $inactive: boolean;
  $tall: boolean;
}>`
  height: ${(p) => (p.$tall ? 58 : 48)}px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  align-items: center;
  justify-content: center;
  padding-horizontal: ${(p) => p.theme.space(6)}px;
  background-color: ${(p) => p.$bg};
  opacity: ${(p) => (p.$inactive ? 0.45 : 1)};
`;

const ButtonLabel = styled.Text<{ $fg: string }>`
  font-size: ${(p) => p.theme.type.body.size}px;
  font-weight: 700;
  color: ${(p) => p.$fg};
`;

export function Button({
  label,
  onPress,
  variant = "lime",
  loading = false,
  disabled = false,
  tall = false,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  tall?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const fill = FILL[variant];
  const inactive = disabled || loading;

  // A button that does not move under a thumb reads as a picture of a button.
  // There is no hover state on a phone to carry the difference, so the press
  // is the entire conversation — and every button in this app was silent.
  const { scale, onPressIn, onPressOut } = usePressScale();

  return (
    <Touchable
      onPress={inactive ? undefined : onPress}
      onPressIn={inactive ? undefined : onPressIn}
      onPressOut={inactive ? undefined : onPressOut}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      $bg={fill.bg}
      $inactive={inactive}
      $tall={tall}
      style={[{ transform: [{ scale }] }, style]}
    >
      {loading ? (
        <ActivityIndicator color={fill.fg} />
      ) : (
        <ButtonLabel $fg={fill.fg}>{label}</ButtonLabel>
      )}
    </Touchable>
  );
}

/* ------------------------------------------------------------------ */
/* Pill                                                                */
/* ------------------------------------------------------------------ */

const PillBox = styled.View<{ $bg: string }>`
  padding-horizontal: ${(p) => p.theme.space(3)}px;
  padding-vertical: 5px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => p.$bg};
  align-self: flex-start;
`;

const PillText = styled.Text<{ $fg: string }>`
  font-size: ${(p) => p.theme.type.micro.size}px;
  font-weight: 600;
  color: ${(p) => p.$fg};
`;

export function Pill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "pos" | "neg" | "lime" | "ink";
}) {
  const map = {
    neutral: { bg: theme.colors.surfaceAlt, fg: theme.colors.muted },
    pos: { bg: theme.colors.posSoft, fg: theme.colors.pos },
    neg: { bg: theme.colors.negSoft, fg: theme.colors.neg },
    lime: { bg: theme.colors.limeSoft, fg: theme.colors.onLime },
    ink: { bg: theme.colors.ink, fg: theme.colors.onInk },
  }[tone];

  return (
    <PillBox $bg={map.bg}>
      <PillText $fg={map.fg}>{label}</PillText>
    </PillBox>
  );
}

/* ------------------------------------------------------------------ */
/* Delta                                                               */
/* ------------------------------------------------------------------ */

const DeltaText = styled.Text<{ $fg: string }>`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => p.$fg};
`;

/**
 * The app's chevron, drawn.
 *
 * It was the character `›`, which is a typographic mark set in the body face:
 * it carried that face's own weight and baseline rather than the icon set's
 * stroke, sat a pixel or two off centre, and changed size with the text around
 * it. Every other glyph in this app is authored SVG at a 1.9 stroke; this one
 * pretended to be.
 */
export function Chevron({ size = 16, color = theme.colors.faint }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="m9.5 5.5 6.5 6.5-6.5 6.5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** The same stroke, pointing back. Used by every detail screen's back control. */
export function ChevronLeft({ size = 22, color = theme.colors.text }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M14.5 5.5 8 12l6.5 6.5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Leaves the app. Drawn, for the same reason the chevron is. */
export function ExternalGlyph({ size = 14, color = theme.colors.focus }: GlyphProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M14 4h6v6M20 4l-8.5 8.5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M18 14.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4.5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

type GlyphProps = { size?: number; color?: string };

/** Direction, at the weight of the figure it sits beside. */
function Caret({ up, color }: { up: boolean; color: string }) {
  return (
    <Svg width={9} height={9} viewBox="0 0 12 12" fill={color}>
      <Path d={up ? "M6 2.5 11 9.5H1z" : "M6 9.5 1 2.5h10z"} />
    </Svg>
  );
}

/**
 * A percentage with its direction.
 *
 * Null means unknown — a market whose whole history sits inside the window, or
 * a read that came back short. That renders as an em dash with no arrow and no
 * colour, because an arrow is a claim about which way a price moved and
 * pointing one at a number nobody measured is what a trading screen must never
 * do. The sign is always written out, so the arrow is never the only signal.
 */
export function Delta({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return <DeltaText $fg={theme.colors.faint}>—</DeltaText>;
  }
  const up = pct >= 0;
  const fg = up ? theme.colors.pos : theme.colors.neg;
  return (
    <DeltaRow>
      <Caret up={up} color={fg} />
      <DeltaText $fg={fg}>
        {up ? "+" : ""}
        {(pct * 100).toFixed(2)}%
      </DeltaText>
    </DeltaRow>
  );
}

const DeltaRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 4px;
`;

/** The green/red badge from the portfolio reference. */
const BadgeBox = styled.View<{ $bg: string }>`
  padding-horizontal: 10px;
  padding-vertical: 4px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => p.$bg};
  align-self: center;
`;

export function DeltaBadge({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return (
      <BadgeBox $bg={theme.colors.surfaceAlt}>
        <PillText $fg={theme.colors.faint}>—</PillText>
      </BadgeBox>
    );
  }
  const up = pct >= 0;
  return (
    <BadgeBox $bg={up ? theme.colors.posSoft : theme.colors.negSoft}>
      <PillText $fg={up ? theme.colors.pos : theme.colors.neg}>
        {up ? "+" : ""}
        {(pct * 100).toFixed(1)}%
      </PillText>
    </BadgeBox>
  );
}

/* ------------------------------------------------------------------ */
/* Stat — the three-up row from the profile reference                  */
/* ------------------------------------------------------------------ */

const StatCol = styled.View`
  flex: 1;
  align-items: center;
  gap: 2px;
`;

const StatValue = styled.Text<{ $fg?: string }>`
  font-size: ${(p) => p.theme.type.lead.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => p.$fg ?? p.theme.colors.text};
`;

export function Stat({
  value,
  label,
  tone,
}: {
  value: string;
  label: string;
  tone?: "pos" | "neg";
}) {
  return (
    <StatCol>
      <StatValue
        $fg={tone === "pos" ? theme.colors.pos : tone === "neg" ? theme.colors.neg : undefined}
      >
        {value}
      </StatValue>
      <Caption>{label}</Caption>
    </StatCol>
  );
}

/* ------------------------------------------------------------------ */
/* Tabs — the underline row from the profile reference                 */
/* ------------------------------------------------------------------ */

const TabRow = styled.View`
  flex-direction: row;
  border-bottom-width: 1px;
  border-bottom-color: ${(p) => p.theme.colors.line};
`;

const TabItem = styled.Pressable<{ $on: boolean }>`
  flex: 1;
  align-items: center;
  padding-vertical: ${(p) => p.theme.space(3)}px;
  border-bottom-width: 2px;
  border-bottom-color: ${(p) => (p.$on ? p.theme.colors.text : "transparent")};
`;

const TabLabel = styled.Text<{ $on: boolean }>`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: ${(p) => (p.$on ? 700 : 500)};
  color: ${(p) => (p.$on ? p.theme.colors.text : p.theme.colors.faint)};
`;

export function Tabs<T extends string>({
  items,
  value,
  onChange,
}: {
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <TabRow>
      {items.map((item) => (
        <TabItem
          key={item.id}
          $on={item.id === value}
          onPress={() => onChange(item.id)}
          accessibilityRole="tab"
          accessibilityState={{ selected: item.id === value }}
        >
          <TabLabel $on={item.id === value}>{item.label}</TabLabel>
        </TabItem>
      ))}
    </TabRow>
  );
}

/** Rounded segmented control — the Minute/Hour/Day row from reference 3. */
const SegRow = styled.View`
  flex-direction: row;
  gap: ${(p) => p.theme.space(1)}px;
`;

const Seg = styled.Pressable<{ $on: boolean }>`
  padding-horizontal: ${(p) => p.theme.space(3)}px;
  padding-vertical: ${(p) => p.theme.space(2)}px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => (p.$on ? p.theme.colors.lime : "transparent")};
`;

const SegLabel = styled.Text<{ $on: boolean }>`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: ${(p) => (p.$on ? 700 : 500)};
  color: ${(p) => (p.$on ? p.theme.colors.onLime : p.theme.colors.muted)};
`;

export function Segmented<T extends string>({
  items,
  value,
  onChange,
}: {
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <SegRow>
      {items.map((item) => (
        <Seg
          key={item.id}
          $on={item.id === value}
          onPress={() => onChange(item.id)}
          accessibilityRole="tab"
          accessibilityState={{ selected: item.id === value }}
        >
          <SegLabel $on={item.id === value}>{item.label}</SegLabel>
        </Seg>
      ))}
    </SegRow>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */

const PlaceholderBox = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: ${(p) => p.theme.space(8)}px;
  gap: ${(p) => p.theme.space(1)}px;
`;

const PlaceholderTitle = styled.Text`
  font-size: ${(p) => p.theme.type.body.size}px;
  font-weight: 700;
  color: ${(p) => p.theme.colors.text};
  text-align: center;
`;

const PlaceholderDetail = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  line-height: 21px;
  color: ${(p) => p.theme.colors.muted};
  text-align: center;
`;

export function Placeholder({
  title,
  detail,
  action,
  busy = false,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <PlaceholderBox>
      {busy ? <ActivityIndicator color={theme.colors.muted} /> : null}
      <PlaceholderTitle>{title}</PlaceholderTitle>
      {detail ? <PlaceholderDetail>{detail}</PlaceholderDetail> : null}
      {action ? <Spacer h={16} /> : null}
      {action}
    </PlaceholderBox>
  );
}

export const Skeleton = styled.View<{ h?: number; w?: string | number; round?: number }>`
  height: ${(p) => p.h ?? 16}px;
  width: ${(p) => (typeof p.w === "number" ? `${p.w}px` : (p.w ?? "100%"))};
  border-radius: ${(p) => p.round ?? p.theme.radius.sm}px;
  background-color: ${(p) => p.theme.colors.line};
`;

export const Avatar = styled.Image<{ size?: number }>`
  width: ${(p) => p.size ?? 26}px;
  height: ${(p) => p.size ?? 26}px;
  border-radius: ${(p) => (p.size ?? 26) / 2}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

/** Curve progress. Lime as it approaches the migration threshold. */
const Track = styled.View`
  height: 6px;
  border-radius: 3px;
  background-color: ${(p) => p.theme.colors.line};
  overflow: hidden;
`;

const Fill = styled.View<{ $pct: number }>`
  height: 6px;
  /* A floor so a real but tiny fraction is still visible as a tick — but only
     above zero, which the caller filters out before this renders. */
  width: ${(p) => Math.max(2, Math.min(100, p.$pct))}%;
  background-color: ${(p) => (p.$pct > 70 ? p.theme.colors.lime : p.theme.colors.pos)};
`;

/**
 * Progress toward a goal — graduation, or a savings target.
 *
 * Exactly zero draws an empty track. The 2% floor above exists so that a pool
 * 0.3% of the way to graduating still shows something; applied at zero it drew
 * a sliver of progress for a plan that had never been filled, which is a claim
 * about the world that nothing in the data supports.
 */
export function Progress({ pct }: { pct: number }) {
  return <Track>{pct > 0 ? <Fill $pct={pct} /> : null}</Track>;
}
