import { useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { Identicon } from "./art";
import { HeartBurst } from "./HeartBurst";
import { Handle } from "./Handle";
import { useHandle } from "../lib/names";
import { HeartGlyph, PlayGlyph, ReelBadgeGlyph, ReplyBubble, ShareGlyph, TriangleGlyph } from "./icons";
import { Tappable } from "./Press";
import { juno, type Coin } from "../lib/api";
import { count, progressLabel } from "../lib/markets";
import { useFollow, useLike } from "../lib/social";
import { money, since } from "../lib/useApi";
import { theme } from "../theme";

/**
 * One post in the feed — which is one market.
 *
 * The post is the picture, full width, the way people already read a feed.
 * Under it sits one row that is both social and financial: what it is worth,
 * the heart, the replies, share, and Buy. On Juno those are the same gesture
 * at different strengths, and putting them on one line is the product's whole
 * argument in a single row of glyphs.
 *
 * "Bought by" names real wallets from decoded swaps, never a follower count
 * dressed up as buyers. When nobody has bought, it says so and invites the
 * first — an empty market is a fact, not an embarrassment to hide.
 */
export type Buyers = { wallets: string[]; handles: string[] };

export function FeedCard({
  coin,
  caption,
  buyers,
  onOpen,
  onBuy,
  onComments,
  onShare,
  onPlay,
  onOpenCreator,
  extraComments = 0,
}: {
  coin: Coin;
  /** What the creator wrote about it, when they posted about it. Falls back to the launch description. */
  caption: string | null;
  buyers: Buyers | null;
  onOpen: () => void;
  onBuy: () => void;
  onComments: () => void;
  onShare: () => void;
  onPlay: () => void;
  onOpenCreator: () => void;
  extraComments?: number;
}) {
  const like = useLike(coin);
  const follow = useFollow(coin.creator.wallet);
  const handle = useHandle(coin.creator.wallet);
  const [bursts, setBursts] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const lastTap = useRef(0);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reel = coin.format === "reel" && coin.media.kind === "video";
  const art = juno.still(coin.media);
  const change = coin.marketCapChangePct;
  const tone = change === null ? theme.colors.text : change >= 0 ? theme.colors.pos : theme.colors.neg;
  const comments = (coin.commentCount ?? 0) + extraComments;
  const pct = coin.curve.progress * 100;

  // Double tap likes; a single tap opens — after the double-tap window, so the
  // first half of a double tap does not navigate away from the heart.
  const onMediaPress = (event: GestureResponderEvent) => {
    const now = Date.now();
    const { locationX, locationY } = event.nativeEvent;
    if (now - lastTap.current < 260) {
      if (openTimer.current) clearTimeout(openTimer.current);
      openTimer.current = null;
      lastTap.current = 0;
      setBursts((all) => [...all, { id: now, x: locationX, y: locationY }]);
      like.like();
      return;
    }
    lastTap.current = now;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      if (reel) onPlay();
      else onOpen();
    }, 260);
  };

  return (
    <View style={styles.card}>
      {/* Who */}
      <View style={styles.head}>
        <Pressable onPress={onOpenCreator} hitSlop={6} style={styles.who} accessibilityRole="button">
          <View style={styles.avatar}>
            <Identicon seed={coin.creator.wallet} size={38} />
          </View>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.handle} numberOfLines={1}>
              {handle}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {since(coin.createdAt)} · {coin.curvePreset} curve
            </Text>
          </View>
        </Pressable>
        <View style={{ flex: 1 }} />
        {follow.self || follow.following === null ? null : (
          <Tappable
            onPress={follow.toggle}
            to={0.94}
            accessibilityRole="button"
            accessibilityLabel={follow.following ? `Unfollow ${handle}` : `Follow ${handle}`}
          >
            <View style={[styles.follow, follow.following ? styles.followOn : null]}>
              <Text style={[styles.followText, follow.following ? styles.followTextOn : null]}>
                {follow.following ? "Following" : "Follow"}
              </Text>
            </View>
          </Tappable>
        )}
      </View>

      {/* The post */}
      <Pressable onPress={onMediaPress} accessibilityRole="imagebutton" accessibilityLabel={coin.name}>
        <View style={[styles.media, { aspectRatio: reel ? 4 / 5 : 1 }]}>
          {art ? (
            <Image source={{ uri: art }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : (
            <ArtCover seed={coin.address} symbol={coin.symbol} name={coin.name} />
          )}
          {reel ? (
            <>
              <View style={styles.reelBadge}>
                <ReelBadgeGlyph size={13} />
                <Text style={styles.reelBadgeText}>Reel</Text>
              </View>
              <View pointerEvents="none" style={styles.playWrap}>
                <View style={styles.play}>
                  <PlayGlyph size={26} />
                </View>
              </View>
            </>
          ) : null}
          {bursts.map((burst) => (
            <HeartBurst
              key={burst.id}
              x={burst.x}
              y={burst.y}
              onDone={() => setBursts((all) => all.filter((b) => b.id !== burst.id))}
            />
          ))}
        </View>
      </Pressable>

      {/* Worth, heart, replies, share — and Buy */}
      <View style={styles.actions}>
        <Tappable onPress={onOpen} to={0.94} accessibilityRole="button" accessibilityLabel="Market cap">
          <View style={styles.worth}>
            {change === null ? null : <TriangleGlyph up={change >= 0} color={tone} size={11} />}
            <Text style={[styles.worthText, { color: tone }]}>
              {money(coin.marketCap, coin.marketCapCurrency)}
            </Text>
          </View>
        </Tappable>

        <Tappable onPress={like.toggle} to={0.86} accessibilityRole="button" accessibilityLabel={like.liked ? "Unlike" : "Like"}>
          <View style={styles.action}>
            <HeartGlyph
              size={23}
              filled={like.liked}
              color={like.liked ? theme.colors.heart : theme.colors.text}
              stroke={1.9}
            />
            {like.likes ? <Text style={styles.actionText}>{count(like.likes)}</Text> : null}
          </View>
        </Tappable>

        <Tappable onPress={onComments} to={0.86} accessibilityRole="button" accessibilityLabel="Comments">
          <View style={styles.action}>
            <ReplyBubble size={22} color={theme.colors.text} stroke={1.9} />
            {comments > 0 ? <Text style={styles.actionText}>{count(comments)}</Text> : null}
          </View>
        </Tappable>

        <Tappable onPress={onShare} to={0.86} accessibilityRole="button" accessibilityLabel="Share">
          <View style={styles.action}>
            <ShareGlyph size={22} />
          </View>
        </Tappable>

        <View style={{ flex: 1 }} />

        {coin.curve.graduated ? (
          <View style={styles.graduated}>
            <Text style={styles.graduatedText}>On DAMM v2</Text>
          </View>
        ) : (
          <Tappable onPress={onBuy} to={0.94}>
            <View style={styles.buy} accessibilityRole="button" accessibilityLabel={`Buy $${coin.symbol}`}>
              <Text style={styles.buyText}>Buy</Text>
            </View>
          </Tappable>
        )}
      </View>

      {/* Who is in */}
      <View style={styles.buyers}>
        {/* "No buyers yet" only when the curve itself says so. Buyers are read
            from the recent feed, so an older coin can have none in the window
            and still have sold out — the line claimed "no buyers" over a coin
            that had graduated. Unknown shows nothing. */}
        {buyers && buyers.wallets.length > 0 ? (
          <>
            <View style={styles.stack}>
              {buyers.wallets.slice(0, 3).map((wallet, i) => (
                <View key={wallet} style={[styles.stackItem, { marginLeft: i === 0 ? 0 : -8, zIndex: 3 - i }]}>
                  <Identicon seed={wallet} size={20} />
                </View>
              ))}
            </View>
            <Text style={styles.buyersText} numberOfLines={1}>
              Bought by <Text style={styles.strong}><Handle wallet={buyers.wallets[0]} /></Text>
              {buyers.wallets.length > 1 ? (
                <>
                  {" "}and{" "}
                  <Text style={styles.strong}>
                    {buyers.wallets.length - 1} {buyers.wallets.length === 2 ? "other" : "others"}
                  </Text>
                </>
              ) : null}
            </Text>
          </>
        ) : buyers && coin.curve.progress === 0 && !coin.curve.graduated ? (
          <Text style={styles.buyersText}>No buyers yet — be the first in.</Text>
        ) : null}
      </View>

      {/* What it is */}
      <Pressable onPress={onOpen}>
        <Text style={styles.title} numberOfLines={2}>
          {coin.name} <Text style={styles.ticker}>${coin.symbol}</Text>
        </Text>
        {caption ? (
          <Text style={styles.caption} numberOfLines={3}>
            {caption}
          </Text>
        ) : null}
      </Pressable>

      {/* How far from becoming a permanent pool */}
      <View style={styles.curve}>
        <View style={styles.track}>
          <View
            style={[
              styles.fill,
              {
                width: `${coin.curve.graduated ? 100 : pct > 0 ? Math.max(2, Math.min(100, pct)) : 0}%`,
              },
            ]}
          />
        </View>
        <Text style={styles.curveText}>
          {coin.curve.graduated
            ? "Graduated"
            : `${progressLabel(pct)} to graduation`}
        </Text>
      </View>
    </View>
  );
}

/**
 * Cover art for a post that launched without media.
 *
 * Drawn from the mint, so it is the same image everywhere this coin appears
 * and nothing is invented: a gradient in two of the app's series colours, the
 * seeded figure, and the ticker set large.
 */
function ArtCover({ seed, symbol, name }: { seed: string; symbol: string; name: string }) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const pick = (shift: number) => Math.abs(h >> shift);
  const palettes = [
    ["#1B2A6B", "#2E5BFF", "#D6FF3D"],
    ["#0B3B2C", "#0E9F6E", "#D6FF3D"],
    ["#3A1D00", "#C77700", "#FFE3A3"],
    ["#271247", "#8B5CF6", "#FF2D6F"],
    ["#12150E", "#2A3326", "#D6FF3D"],
  ];
  const [deep, mid, pop] = palettes[pick(0) % palettes.length];

  return (
    <View style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice">
        <Defs>
          <LinearGradient id={`g${seed.slice(0, 6)}`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={mid} />
            <Stop offset="1" stopColor={deep} />
          </LinearGradient>
        </Defs>
        <Rect width={100} height={100} fill={`url(#g${seed.slice(0, 6)})`} />
        <Circle cx={30 + (pick(4) % 30)} cy={34 + (pick(10) % 20)} r={28} fill={pop} opacity={0.18} />
        <Circle cx={70 - (pick(14) % 20)} cy={66 - (pick(18) % 16)} r={20} fill={pop} opacity={0.32} />
        <Circle cx={70 - (pick(14) % 20)} cy={66 - (pick(18) % 16)} r={8} fill={pop} />
      </Svg>
      <View style={styles.coverText}>
        <Text style={[styles.coverSymbol, { color: pop }]} numberOfLines={1} adjustsFontSizeToFit>
          ${symbol}
        </Text>
        <Text style={styles.coverName} numberOfLines={2}>
          {name}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    paddingBottom: 18,
    marginBottom: 10,
  },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
  who: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.line,
  },
  handle: { fontSize: 15, fontWeight: "800", color: theme.colors.text, letterSpacing: -0.2 },
  meta: { fontSize: 12, color: theme.colors.muted, marginTop: 1 },
  follow: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: theme.colors.ink,
  },
  followOn: { backgroundColor: theme.colors.surfaceAlt, borderWidth: 1, borderColor: theme.colors.line },
  followText: { fontSize: 13, fontWeight: "700", color: theme.colors.onInk },
  followTextOn: { color: theme.colors.muted },

  media: { width: "100%", backgroundColor: theme.colors.surfaceAlt, overflow: "hidden" },
  reelBadge: {
    position: "absolute",
    top: 12,
    left: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  reelBadgeText: { fontSize: 12, fontWeight: "700", color: "#FFFFFF" },
  playWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  play: {
    width: 64,
    height: 64,
    borderRadius: 32,
    paddingLeft: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.42)",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.7)",
  },

  actions: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 14, paddingTop: 12 },
  worth: { flexDirection: "row", alignItems: "center", gap: 5 },
  worthText: { fontSize: 17, fontWeight: "800", letterSpacing: -0.3, fontVariant: ["tabular-nums"] },
  action: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 32 },
  actionText: { fontSize: 14, fontWeight: "700", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  buy: {
    height: 40,
    paddingHorizontal: 26,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.lime,
  },
  buyText: { fontSize: 15, fontWeight: "800", color: theme.colors.onLime },
  graduated: {
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceAlt,
  },
  graduatedText: { fontSize: 13, fontWeight: "700", color: theme.colors.muted },

  buyers: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingTop: 12 },
  stack: { flexDirection: "row" },
  stackItem: {
    width: 22,
    height: 22,
    borderRadius: 11,
    overflow: "hidden",
    borderWidth: 1.5,
    borderColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  buyersText: { fontSize: 13, color: theme.colors.muted, flexShrink: 1 },
  strong: { fontWeight: "800", color: theme.colors.text },

  title: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "800",
    color: theme.colors.text,
    paddingHorizontal: 14,
    paddingTop: 8,
    letterSpacing: -0.2,
  },
  ticker: { fontWeight: "700", color: theme.colors.muted },
  caption: { fontSize: 14, lineHeight: 20, color: theme.colors.text, paddingHorizontal: 14, paddingTop: 3 },

  curve: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingTop: 12 },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: theme.colors.line, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.pos },
  curveText: { fontSize: 12, fontWeight: "600", color: theme.colors.muted, fontVariant: ["tabular-nums"] },

  coverText: { position: "absolute", left: 20, right: 20, bottom: 20, gap: 4 },
  coverSymbol: { fontSize: 54, fontWeight: "900", letterSpacing: -2 },
  coverName: { fontSize: 17, fontWeight: "700", color: "rgba(255,255,255,0.92)" },
});
