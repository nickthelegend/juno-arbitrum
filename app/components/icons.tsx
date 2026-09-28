import Svg, { Circle, Path, Rect } from "react-native-svg";

/**
 * The social glyphs: like, reply, share, sound.
 *
 * Drawn on one 24-unit grid at one stroke weight so a rail of four reads as a
 * set. The heart is the only one with a filled state, because it is the only
 * one that records something about *you* — a reply count or a share button
 * looks the same to everyone.
 */
type Glyph = { size?: number; color?: string; stroke?: number };

export function HeartGlyph({
  size = 28,
  color = "#FFFFFF",
  filled = false,
  stroke = 2,
}: Glyph & { filled?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 20.3s-7.6-4.5-9.3-9.6C1.6 7.2 3.6 3.9 7 3.7c2-.1 3.7 1 5 2.8 1.3-1.8 3-2.9 5-2.8 3.4.2 5.4 3.5 4.3 7-1.7 5.1-9.3 9.6-9.3 9.6z"
        fill={filled ? color : "none"}
        stroke={color}
        strokeWidth={stroke}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ReplyBubble({ size = 28, color = "#FFFFFF", stroke = 2 }: Glyph) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20.5 12c0 4.4-3.8 8-8.5 8-1.2 0-2.3-.2-3.3-.6L3.5 20.5l1.3-4.2A7.6 7.6 0 0 1 3.5 12c0-4.4 3.8-8 8.5-8s8.5 3.6 8.5 8z"
        stroke={color}
        strokeWidth={stroke}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** The paper plane — "send this to someone", which is what share means on a phone. */
export function SendGlyph({ size = 28, color = "#FFFFFF", stroke = 2 }: Glyph) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M21.5 3 10.2 13.8" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
      <Path
        d="M21.5 3 14.6 21l-4.4-7.2L3 9.6 21.5 3z"
        stroke={color}
        strokeWidth={stroke}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** An upload tray — the feed's share, where a plane would be louder than the card. */
export function ShareGlyph({ size = 22, color = "#12150E", stroke = 1.9 }: Glyph) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 15V3.5M7.5 8 12 3.5 16.5 8" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
    </Svg>
  );
}

export function SoundGlyph({ size = 22, color = "#FFFFFF", muted }: Glyph & { muted: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill={color} stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
      {muted ? (
        <Path d="m16 9.5 5 5m0-5-5 5" stroke={color} strokeWidth={2} strokeLinecap="round" />
      ) : (
        <Path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" stroke={color} strokeWidth={2} strokeLinecap="round" />
      )}
    </Svg>
  );
}

export function PlayGlyph({ size = 22, color = "#FFFFFF" }: Glyph) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M7 4.5v15l12.5-7.5z" fill={color} />
    </Svg>
  );
}

export function PauseGlyph({ size = 22, color = "#FFFFFF" }: Glyph) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={6} y={4.5} width={4} height={15} rx={1.2} fill={color} />
      <Rect x={14} y={4.5} width={4} height={15} rx={1.2} fill={color} />
    </Svg>
  );
}

export function PlusGlyph({ size = 12, color = "#12150E", stroke = 3 }: Glyph) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 4v16M4 12h16" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
    </Svg>
  );
}

export function CheckGlyph({ size = 12, color = "#12150E", stroke = 3 }: Glyph) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="m4.5 12.5 5 5 10-11" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** A filled triangle for a price's direction, so colour is never the only signal. */
export function TriangleGlyph({ size = 10, color, up }: { size?: number; color: string; up: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 10 10">
      <Path d={up ? "M5 1.5 9.5 8.5h-9z" : "M5 8.5.5 1.5h9z"} fill={color} />
    </Svg>
  );
}

/** Reel badge on a feed card: this post moves. */
export function ReelBadgeGlyph({ size = 14, color = "#FFFFFF" }: Glyph) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={3} width={18} height={18} rx={5} stroke={color} strokeWidth={2} />
      <Path d="M3 8.5h18M8 3l3 5.5M14 3l3 5.5" stroke={color} strokeWidth={2} />
      <Path d="m10 12 5 3-5 3z" fill={color} />
    </Svg>
  );
}

export function SparkGlyph({ size = 14, color = "#12150E" }: Glyph) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={4} fill={color} />
      <Path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  );
}
