import { useEventListener } from "expo";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useVideoPlayer, VideoView } from "expo-video";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type ViewToken,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { CoinArt, Identicon } from "../../components/art";
import { CommentsSheet } from "../../components/CommentsSheet";
import { HeartBurst } from "../../components/HeartBurst";
import { Handle } from "../../components/Handle";
import {
  CheckGlyph,
  HeartGlyph,
  PauseGlyph,
  PlusGlyph,
  ReplyBubble,
  SendGlyph,
  SoundGlyph,
} from "../../components/icons";
import { Tappable } from "../../components/Press";
import { QuickTrade } from "../../components/QuickTrade";
import { juno, type Coin } from "../../lib/api";
import { count, invalidateMarkets, loadMarkets, progressLabel } from "../../lib/markets";
import { useReducedMotion, nativeDriver } from "../../lib/motion";
import { shareCoin, useFollow, useLike, useViewerOnce } from "../../lib/social";
import { money, useApi } from "../../lib/useApi";
import { useTabBarHeight } from "../../lib/tabbar";
import { theme } from "../../theme";

/**
 * Reels: every video is a coin, one per screen.
 *
 * Shaped like the reels people already know — full-bleed video, the rail on
 * the right, who and what on the left — because the gestures are muscle
 * memory and Juno should not have to teach them. Tap for sound, double tap to
 * like, hold to pause, swipe for the next one.
 *
 * What is different is the dock under the caption. On any other app the thing
 * at the bottom of a reel is a song. Here it is the reel's market: its ticker,
 * its price, how far its curve is from graduating into a DAMM v2 pool, and a
 * Buy that opens the same trade sheet as the coin screen — so taking a
 * position in a video costs no more than liking it.
 *
 * ## Only the neighbours hold a player
 *
 * A video player per reel is memory and a decoder per reel. The one on screen
 * and the one either side get players, so the next swipe starts instantly; the
 * rest are their poster frame until they come close.
 */

/** Double tap window. Long enough for a relaxed thumb, short enough that a single tap still feels immediate. */
const DOUBLE_MS = 260;

export default function ReelsScreen() {
  const router = useRouter();
  const { start } = useLocalSearchParams<{ start?: string }>();
  /*
   * The container's size, not the window's: on web the app sits in a
   * phone-width frame narrower than the window. It starts as the window's
   * size, capped to that frame, and is corrected by the first layout — so the
   * feed does not sit on "Loading" waiting for a measurement that a
   * backgrounded browser tab may never deliver.
   */
  const window_ = useWindowDimensions();
  const [page, setPage] = useState(() => ({
    width: Platform.OS === "web" ? Math.min(window_.width, 480) : window_.width,
    height: window_.height,
  }));
  const pageH = page.height;
  const width = page.width;

  const once = useViewerOnce();
  const reels = useApi(async () => {
    if (!once.ready) return null;
    const { posts } = await loadMarkets(once.viewer());
    return posts.filter((coin) => coin.format === "reel" && coin.media.kind === "video");
  }, [once.ready]);

  const list = useMemo(() => reels.data ?? [], [reels.data]);
  const startIndex = Math.max(0, start ? list.findIndex((coin) => coin.address === start) : 0);

  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => setActiveIndex(startIndex), [startIndex]);

  // One mute switch for the whole feed: unmuting one reel means you want sound,
  // not that you want to unmute every reel one by one.
  const [muted, setMuted] = useState(true);
  const [trade, setTrade] = useState<{ coin: Coin; side: "buy" | "sell" } | null>(null);
  const [talking, setTalking] = useState<Coin | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** Comments posted from this screen, so the rail's count moves without a refetch. */
  const [extraComments, setExtraComments] = useState<Record<string, number>>({});

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 1600);
  }, []);

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const first = viewableItems[0];
    if (first?.index !== null && first?.index !== undefined) setActiveIndex(first.index);
  }).current;

  const insets = useSafeAreaInsets();
  const TAB_H = useTabBarHeight().height;
  const sheetOpen = trade !== null || talking !== null;

  // Light status bar while Reels is on screen. The app's is dark for its
  // light pages, and over full-bleed night video the clock and signal simply
  // disappeared. Tabs stay mounted, so this follows focus, not mounting.
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  return (
    <View style={styles.screen} onLayout={(event) =>
        setPage({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })
      }>
      {focused ? <StatusBar style="light" /> : null}
      {reels.loading || reels.data === null || pageH === 0 ? (
        <NightState busy title="Loading reels" />
      ) : reels.error ? (
        <NightState
          title="Could not load reels"
          detail={reels.error}
          action={{ label: "Try again", onPress: reels.refresh }}
        />
      ) : list.length === 0 ? (
        <NightState
          title="No reels yet"
          detail="A reel is a vertical video with its own market. Post one and it lands here."
        />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(coin) => coin.address}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          snapToInterval={pageH}
          snapToAlignment="start"
          decelerationRate="fast"
          initialScrollIndex={startIndex}
          getItemLayout={(_, index) => ({ length: pageH, offset: pageH * index, index })}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          windowSize={3}
          renderItem={({ item, index }) => (
            <Reel
              coin={item}
              width={width}
              height={pageH}
              active={index === activeIndex}
              near={Math.abs(index - activeIndex) <= 1}
              paused={sheetOpen}
              muted={muted}
              onToggleMute={() => setMuted((on) => !on)}
              extraComments={extraComments[item.address] ?? 0}
              onTrade={(side) => setTrade({ coin: item, side })}
              onComments={() => setTalking(item)}
              onShare={async () => {
                const outcome = await shareCoin(item);
                if (outcome === "copied") flash("Link copied");
                if (outcome === "failed") flash("Could not share");
              }}
              onOpenCoin={() => router.push(`/coin/${item.address}`)}
              onOpenCreator={() => router.push(`/trader/${item.creator.wallet}` as never)}
            />
          )}
        />
      )}

      {/* The header floats over the video rather than pushing it down: the
          reel is the screen, and chrome is laid over it like glass. */}
      <View pointerEvents="box-none" style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.headerTitle}>Reels</Text>
        <View style={styles.livePill}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>Every reel is a coin</Text>
        </View>
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => setMuted((on) => !on)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={muted ? "Turn sound on" : "Turn sound off"}
          style={styles.headerButton}
        >
          <SoundGlyph muted={muted} size={20} />
        </Pressable>
      </View>

      {toast ? (
        <View pointerEvents="none" style={[styles.toast, { top: insets.top + 56 }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      {trade ? (
        <QuickTrade
          coin={trade.coin}
          side={trade.side}
          onClose={() => setTrade(null)}
          onDone={() => {
            setTrade(null);
            invalidateMarkets();
            reels.refresh();
          }}
        />
      ) : null}

      <CommentsSheet
        visible={talking !== null}
        onClose={() => setTalking(null)}
        target={{ kind: "coin", mint: talking?.address ?? "", symbol: talking?.symbol ?? "" }}
        onPosted={() => {
          if (!talking) return;
          setExtraComments((all) => ({ ...all, [talking.address]: (all[talking.address] ?? 0) + 1 }));
        }}
        bottomInset={TAB_H}
      />
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* One reel                                                            */
/* ------------------------------------------------------------------ */

function Reel({
  coin,
  width,
  height,
  active,
  near,
  paused,
  muted,
  onToggleMute,
  extraComments,
  onTrade,
  onComments,
  onShare,
  onOpenCoin,
  onOpenCreator,
}: {
  coin: Coin;
  width: number;
  height: number;
  active: boolean;
  near: boolean;
  paused: boolean;
  muted: boolean;
  onToggleMute: () => void;
  extraComments: number;
  onTrade: (side: "buy" | "sell") => void;
  onComments: () => void;
  onShare: () => void;
  onOpenCoin: () => void;
  onOpenCreator: () => void;
}) {
  const uri = juno.media(coin.media.url);
  const poster = juno.still(coin.media);
  const like = useLike(coin);
  const [held, setHeld] = useState(false);
  const [bursts, setBursts] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [soundFlash, setSoundFlash] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const lastTap = useRef(0);
  const singleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (singleTimer.current) clearTimeout(singleTimer.current);
  }, []);

  /*
   * Tap, double tap and hold on one surface.
   *
   * A single tap has to wait out the double-tap window before it acts, or the
   * first half of every double tap would also toggle the sound. 260ms is below
   * the point where the wait reads as lag.
   */
  const onSurfacePress = (event: GestureResponderEvent) => {
    const now = Date.now();
    const { locationX, locationY } = event.nativeEvent;
    if (now - lastTap.current < DOUBLE_MS) {
      if (singleTimer.current) clearTimeout(singleTimer.current);
      singleTimer.current = null;
      lastTap.current = 0;
      setBursts((all) => [...all, { id: now, x: locationX, y: locationY }]);
      like.like();
      return;
    }
    lastTap.current = now;
    singleTimer.current = setTimeout(() => {
      singleTimer.current = null;
      onToggleMute();
      setSoundFlash(Date.now());
    }, DOUBLE_MS);
  };

  const TAB_H = useTabBarHeight().height;
  const bottom = TAB_H + 12;
  const comments = (coin.commentCount ?? 0) + extraComments;
  const pct = coin.curve.progress * 100;

  return (
    <View style={{ width, height, backgroundColor: theme.colors.night, overflow: "hidden" }}>
      {near && uri ? (
        <ReelVideo
          width={width}
          height={height}
          uri={uri}
          poster={poster}
          playing={active && !paused && !held}
          muted={muted}
          progressBottom={TAB_H}
        />
      ) : poster ? (
        <Image source={{ uri: poster }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : null}

      <Shade height={height} />

      {/* The gesture surface, under every control. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onSurfacePress}
        onLongPress={() => setHeld(true)}
        onPressOut={() => setHeld(false)}
        delayLongPress={220}
        accessibilityLabel={`${coin.name}. Tap for sound, double tap to like.`}
      />

      {held ? (
        <View pointerEvents="none" style={styles.center}>
          <View style={styles.centerBadge}>
            <PauseGlyph size={30} />
          </View>
        </View>
      ) : null}
      {soundFlash ? <SoundFlash key={soundFlash} muted={muted} /> : null}

      {bursts.map((burst) => (
        <HeartBurst
          key={burst.id}
          x={burst.x}
          y={burst.y}
          onDone={() => setBursts((all) => all.filter((b) => b.id !== burst.id))}
        />
      ))}

      {/* Right rail */}
      <View pointerEvents="box-none" style={[styles.rail, { bottom: bottom + 92 }]}>
        <CreatorBadge wallet={coin.creator.wallet} onOpen={onOpenCreator} />

        <RailButton
          label={like.likes ? count(like.likes) : "Like"}
          accessibilityLabel={like.liked ? "Unlike" : "Like"}
          onPress={like.toggle}
        >
          <LikePop liked={like.liked} />
        </RailButton>

        <RailButton
          label={comments > 0 ? count(comments) : "Say"}
          accessibilityLabel="Comments"
          onPress={onComments}
        >
          <ReplyBubble size={30} />
        </RailButton>

        <RailButton label="Share" accessibilityLabel="Share" onPress={onShare}>
          <SendGlyph size={28} />
        </RailButton>

        <CoinDisc coin={coin} spinning={active && !paused && !held} onPress={() => onTrade("buy")} />
      </View>

      {/* Who, and what they said */}
      <View pointerEvents="box-none" style={[styles.info, { bottom: bottom + 92 }]}>
        <View style={styles.byline}>
          <Pressable onPress={onOpenCreator} hitSlop={6} style={styles.bylineWho}>
            <View style={styles.bylineAvatar}>
              <Identicon seed={coin.creator.wallet} size={30} />
            </View>
            <Text style={styles.handle} numberOfLines={1}>
              <Handle wallet={coin.creator.wallet} />
            </Text>
          </Pressable>
          <FollowChip wallet={coin.creator.wallet} />
        </View>

        <Pressable onPress={() => setExpanded((on) => !on)}>
          <Text style={styles.caption} numberOfLines={expanded ? 6 : 2}>
            <Text style={styles.captionTitle}>{coin.name}</Text>
            {coin.description ? `  ${coin.description}` : ""}
          </Text>
        </Pressable>

        <View style={styles.chips}>
          <Pressable onPress={onOpenCoin} style={styles.chip}>
            <Text style={styles.chipStrong}>${coin.symbol}</Text>
            <Text style={styles.chipText}>{money(coin.priceUsd, coin.marketCapCurrency, { compact: false })}</Text>
          </Pressable>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{coin.curvePreset} curve</Text>
          </View>
        </View>
      </View>

      {/* The market, docked */}
      <View style={[styles.dock, { bottom }]}>
        {/* Curve progress as the dock's top edge: the reel's distance from
            becoming a permanent pool, always in view. */}
        <View style={styles.dockTrack}>
          <View
            style={[
              styles.dockFill,
              { width: `${coin.curve.graduated ? 100 : Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}%` },
            ]}
          />
        </View>
        <Pressable onPress={onOpenCoin} style={styles.dockWhat} accessibilityRole="button">
          <CoinArt uri={poster} seed={coin.address} size={40} radius={12} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.dockTitle} numberOfLines={1}>
              {money(coin.marketCap, coin.marketCapCurrency)} <Text style={styles.dockMuted}>mkt cap</Text>
            </Text>
            <Text style={styles.dockMuted} numberOfLines={1}>
              {coin.curve.graduated
                ? "Graduated · trading on DAMM v2"
                : `${progressLabel(pct)} to graduation`}
            </Text>
          </View>
        </Pressable>
        {coin.curve.graduated ? null : (
          <>
            <Tappable onPress={() => onTrade("sell")} to={0.94}>
              <View style={styles.sell} accessibilityRole="button" accessibilityLabel={`Sell $${coin.symbol}`}>
                <Text style={styles.sellText}>Sell</Text>
              </View>
            </Tappable>
            <Tappable onPress={() => onTrade("buy")} to={0.94}>
              <View style={styles.buy} accessibilityRole="button" accessibilityLabel={`Buy $${coin.symbol}`}>
                <Text style={styles.buyText}>Buy</Text>
              </View>
            </Tappable>
          </>
        )}
      </View>
    </View>
  );
}

/**
 * The video, and the playback line along the bottom.
 *
 * Progress is an `Animated.Value` fed by the player's time events, never React
 * state: four re-renders a second of a whole reel to move a two-pixel line
 * would be the most expensive thing on the screen.
 */
function ReelVideo({
  width,
  height,
  uri,
  poster,
  playing,
  muted,
  progressBottom,
}: {
  width: number;
  height: number;
  uri: string;
  poster: string | null;
  playing: boolean;
  muted: boolean;
  progressBottom: number;
}) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.timeUpdateEventInterval = 0.25;
  });
  const progress = useRef(new Animated.Value(0)).current;
  const cover = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    player.muted = muted;
  }, [muted, player]);

  /*
   * Whether this reel should be playing, held in a ref as well as acted on.
   *
   * `play()` on a player whose source has not loaded yet is dropped, not
   * queued — the first reel sat on its poster for exactly that reason. So the
   * intent is kept, and applied again the moment the player says it is ready.
   */
  const wantPlay = useRef(playing);
  wantPlay.current = playing;

  useEffect(() => {
    if (playing) player.play();
    else player.pause();
  }, [playing, player]);

  useEventListener(player, "statusChange", ({ status }) => {
    if (status === "readyToPlay" && wantPlay.current && !player.playing) player.play();
  });

  useEventListener(player, "timeUpdate", ({ currentTime }) => {
    const duration = player.duration;
    if (!(duration > 0)) return;
    Animated.timing(progress, {
      toValue: Math.min(1, currentTime / duration),
      duration: 250,
      easing: Easing.linear,
      useNativeDriver: nativeDriver,
    }).start();
  });

  // The poster lifts off once real frames are moving, so a slow network shows
  // the reel's first frame rather than a black rectangle.
  useEventListener(player, "playingChange", ({ isPlaying }) => {
    if (isPlaying) {
      Animated.timing(cover, { toValue: 0, duration: 220, useNativeDriver: nativeDriver }).start();
    }
  });

  return (
    <>
      {/* Sized explicitly, not `absoluteFill`: on web the <video> otherwise
          takes its intrinsic width and pushes the reel sideways. */}
      <VideoView
        player={player}
        style={{ position: "absolute", top: 0, left: 0, width, height }}
        contentFit="cover"
        nativeControls={false}
        allowsPictureInPicture={false}
      />
      {poster ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Animated.Image
            source={{ uri: poster }}
            style={[StyleSheet.absoluteFill, { opacity: cover }]}
            resizeMode="cover"
          />
        </View>
      ) : null}
      <View pointerEvents="none" style={[styles.playTrack, { bottom: progressBottom }]}>
        {/* Scaled from its left edge, so the transform stays on the native driver. */}
        <Animated.View
          style={[styles.playFill, styles.playInk, { transformOrigin: "left", transform: [{ scaleX: progress }] }]}
        />
      </View>
    </>
  );
}

/** Top and bottom scrims, so white type reads on any frame. */
function Shade({ height }: { height: number }) {
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height={height}>
      <Defs>
        <LinearGradient id="top" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#000" stopOpacity={0.55} />
          <Stop offset="1" stopColor="#000" stopOpacity={0} />
        </LinearGradient>
        <LinearGradient id="bottom" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#000" stopOpacity={0} />
          <Stop offset="0.55" stopColor="#000" stopOpacity={0.45} />
          <Stop offset="1" stopColor="#000" stopOpacity={0.9} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height={140} fill="url(#top)" />
      <Rect x="0" y={height * 0.45} width="100%" height={height * 0.55} fill="url(#bottom)" />
    </Svg>
  );
}

function RailButton({
  children,
  label,
  accessibilityLabel,
  onPress,
}: {
  children: React.ReactNode;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Tappable onPress={onPress} to={0.86} hitSlop={6} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      <View style={styles.railButton}>
        {children}
        <Text style={styles.railLabel}>{label}</Text>
      </View>
    </Tappable>
  );
}

/** The heart, with a pop when it fills. The count beside it is the server's. */
function LikePop({ liked }: { liked: boolean }) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!liked || reduced) return;
    scale.setValue(0.6);
    Animated.spring(scale, { toValue: 1, tension: 260, friction: 7, useNativeDriver: nativeDriver }).start();
  }, [liked, reduced, scale]);

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <HeartGlyph size={31} filled={liked} color={liked ? theme.colors.heart : "#FFFFFF"} />
    </Animated.View>
  );
}

/** The creator's mark, with a follow plus that turns into a tick. */
function CreatorBadge({ wallet, onOpen }: { wallet: string; onOpen: () => void }) {
  const follow = useFollow(wallet);
  return (
    <View style={styles.creator}>
      <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel="Open creator">
        <View style={styles.creatorRing}>
          <Identicon seed={wallet} size={42} />
        </View>
      </Pressable>
      {follow.self || follow.following === null ? null : (
        <Pressable
          onPress={follow.toggle}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={follow.following ? "Unfollow" : "Follow"}
          style={[styles.creatorPlus, follow.following ? styles.creatorPlusOn : null]}
        >
          {follow.following ? <CheckGlyph size={10} color="#FFFFFF" /> : <PlusGlyph size={10} />}
        </Pressable>
      )}
    </View>
  );
}

function FollowChip({ wallet }: { wallet: string }) {
  const follow = useFollow(wallet);
  if (follow.self || follow.following === null) return null;
  return (
    <Pressable
      onPress={follow.toggle}
      hitSlop={6}
      accessibilityRole="button"
      style={[styles.follow, follow.following ? styles.followOn : null]}
    >
      <Text style={styles.followText}>{follow.following ? "Following" : "Follow"}</Text>
    </Pressable>
  );
}

/**
 * The coin, as the disc a song would be on any other reels app.
 *
 * It spins while the reel plays and stops when it does — a small, live sign
 * that this video *is* the market. Tapping it opens the buy sheet.
 */
function CoinDisc({ coin, spinning, onPress }: { coin: Coin; spinning: boolean; onPress: () => void }) {
  const reduced = useReducedMotion();
  const turn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!spinning || reduced) {
      turn.stopAnimation();
      return;
    }
    turn.setValue(0);
    const loop = Animated.loop(
      Animated.timing(turn, { toValue: 1, duration: 5200, easing: Easing.linear, useNativeDriver: nativeDriver }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, spinning, turn]);

  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <Tappable onPress={onPress} to={0.88} accessibilityRole="button" accessibilityLabel={`Buy $${coin.symbol}`}>
      <Animated.View style={[styles.disc, { transform: [{ rotate }] }]}>
        <View style={styles.discInner}>
          <CoinArt uri={juno.still(coin.media)} seed={coin.address} size={26} radius={13} />
        </View>
      </Animated.View>
    </Tappable>
  );
}

function SoundFlash({ muted }: { muted: boolean }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.timing(t, { toValue: 1, duration: 120, useNativeDriver: nativeDriver }),
      Animated.delay(450),
      Animated.timing(t, { toValue: 0, duration: 260, useNativeDriver: nativeDriver }),
    ]).start();
  }, [t]);
  return (
    <View pointerEvents="none" style={styles.center}>
      <Animated.View
        style={[
          styles.centerBadge,
          { opacity: t, transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }] },
        ]}
      >
        <SoundGlyph muted={muted} size={30} />
      </Animated.View>
    </View>
  );
}

function NightState({
  title,
  detail,
  busy,
  action,
}: {
  title: string;
  detail?: string;
  busy?: boolean;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.state}>
      {busy ? <ActivityIndicator color={theme.colors.lime} /> : null}
      <Text style={styles.stateTitle}>{title}</Text>
      {detail ? <Text style={styles.stateDetail}>{detail}</Text> : null}
      {action ? (
        <Tappable onPress={action.onPress} to={0.95}>
          <View style={styles.buy}>
            <Text style={styles.buyText}>{action.label}</Text>
          </View>
        </Tappable>
      ) : null}
    </View>
  );
}

const FILL = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const;
const white = theme.colors.onNight;
const soft = theme.colors.onNightMuted;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.night },

  header: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  headerTitle: { fontSize: 24, fontWeight: "800", letterSpacing: -0.6, color: white },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(214,255,61,0.16)",
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.lime },
  liveText: { fontSize: 11, fontWeight: "700", color: theme.colors.lime, letterSpacing: 0.2 },
  headerButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.32)",
  },

  toast: {
    position: "absolute",
    alignSelf: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.94)",
  },
  toastText: { fontSize: 13, fontWeight: "700", color: theme.colors.ink },

  center: { ...FILL, alignItems: "center", justifyContent: "center" },
  centerBadge: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
  },

  rail: { position: "absolute", right: 8, alignItems: "center", gap: 18, width: 64 },
  railButton: { alignItems: "center", gap: 4, minWidth: 48 },
  railLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: white,
    fontVariant: ["tabular-nums"],
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowRadius: 6,
  },

  creator: { alignItems: "center", marginBottom: 6 },
  creatorRing: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: white,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: theme.colors.ink,
  },
  creatorPlus: {
    position: "absolute",
    bottom: -8,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.lime,
    borderWidth: 2,
    borderColor: theme.colors.night,
  },
  creatorPlusOn: { backgroundColor: theme.colors.heart },

  disc: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1B1E22",
    borderWidth: 7,
    borderColor: "#2A2E33",
  },
  discInner: {
    width: 28,
    height: 28,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.lime,
    alignItems: "center",
    justifyContent: "center",
  },

  info: { position: "absolute", left: 14, right: 84, gap: 10 },
  byline: { flexDirection: "row", alignItems: "center", gap: 10 },
  bylineWho: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  bylineAvatar: { width: 30, height: 30, borderRadius: 15, overflow: "hidden" },
  handle: { fontSize: 15, fontWeight: "800", color: white, flexShrink: 1 },
  follow: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.7)",
  },
  followOn: { borderColor: "rgba(255,255,255,0.3)", backgroundColor: "rgba(255,255,255,0.12)" },
  followText: { fontSize: 13, fontWeight: "700", color: white },
  caption: { fontSize: 14, lineHeight: 20, color: white },
  captionTitle: { fontWeight: "800" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.nightLine,
  },
  chipStrong: { fontSize: 12, fontWeight: "800", color: theme.colors.lime },
  chipText: { fontSize: 12, fontWeight: "600", color: soft, fontVariant: ["tabular-nums"] },

  dock: {
    position: "absolute",
    left: 10,
    right: 10,
    height: 72,
    borderRadius: 22,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.colors.nightRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.nightLine,
    overflow: "hidden",
  },
  dockTrack: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  dockFill: { height: 3, backgroundColor: theme.colors.lime },
  dockWhat: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  dockTitle: { fontSize: 15, fontWeight: "800", color: white, fontVariant: ["tabular-nums"] },
  dockMuted: { fontSize: 12, fontWeight: "600", color: soft },
  sell: {
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  sellText: { fontSize: 15, fontWeight: "800", color: white },
  buy: {
    height: 44,
    paddingHorizontal: 22,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.lime,
  },
  buyText: { fontSize: 15, fontWeight: "800", color: theme.colors.onLime },

  playTrack: { position: "absolute", left: 0, right: 0, height: 2, backgroundColor: "rgba(255,255,255,0.18)" },
  playFill: { ...FILL },
  playInk: { backgroundColor: white },

  state: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 32 },
  stateTitle: { fontSize: 17, fontWeight: "800", color: white, textAlign: "center" },
  stateDetail: { fontSize: 14, lineHeight: 20, color: soft, textAlign: "center", marginBottom: 8 },
});
