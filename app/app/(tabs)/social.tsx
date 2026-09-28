import { useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";

import { CoinArt } from "../../components/art";
import { CommentsSheet } from "../../components/CommentsSheet";
import { FeedCard, type Buyers } from "../../components/FeedCard";
import { Button, Placeholder, Skeleton } from "../../components/kit";
import { JunoMark } from "../../components/logo";
import { Tappable } from "../../components/Press";
import { QuickTrade } from "../../components/QuickTrade";
import { juno, type Coin } from "../../lib/api";
import { invalidateMarkets, loadMarkets } from "../../lib/markets";
import { useFeedRevision } from "../../lib/refresh";
import { shareCoin, useViewerOnce } from "../../lib/social";
import { useApi } from "../../lib/useApi";
import { useWallet } from "../../lib/wallet";
import { useTabBarHeight } from "../../lib/tabbar";
import { theme } from "../../theme";

/**
 * The feed: posts, and every post is a market.
 *
 * One stream, not three. It used to be a switch between trades, posts and
 * both, which asked the reader to decide what kind of thing they wanted
 * before showing them anything — and made the trade ledger, the least
 * social thing in the app, the default view of a social app. Now each entry
 * is a post someone launched on a Dynamic Bonding Curve, shown as the post,
 * with its market folded into the row beneath it.
 *
 * Trades did not disappear; they became evidence. The swap record is what
 * "Bought by" is read from, and what a creator wrote about their coin becomes
 * its caption. Pre-IPO trackers and stock issuances are markets rather than
 * posts, so they live on the Trade tab.
 *
 * The strip at the top is the reels, as rings — the way into the full-screen
 * player, landing on the one you tapped.
 */

type Scope = "everyone" | "following";

export default function SocialScreen() {
  const router = useRouter();
  const wallet = useWallet();
  const revision = useFeedRevision();
  const tabBar = useTabBarHeight();
  const [scope, setScope] = useState<Scope>("everyone");

  const once = useViewerOnce();
  const markets = useApi(
    () => {
      if (!once.ready) return Promise.resolve(null);
      // A revision bump means this device just posted: the shared read predates it.
      if (revision > 0) invalidateMarkets();
      return loadMarkets(once.viewer());
    },
    [revision, once.ready],
  );
  /*
   * The swap and post record, for "Bought by" and captions. Separate from the
   * markets and allowed to fail: the posts are the feed, this only annotates
   * them, and it is the slower of the two reads.
   */
  const record = useApi(() => juno.feed(60).catch(() => null), [revision]);
  const follows = useApi(
    () =>
      scope === "following" && wallet.address
        ? juno.followStats(wallet.address).then((stats) => new Set(stats.followingList))
        : Promise.resolve(null),
    [scope, wallet.address],
  );

  const [trade, setTrade] = useState<Coin | null>(null);
  const [talking, setTalking] = useState<Coin | null>(null);
  const [extraComments, setExtraComments] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<string | null>(null);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 1600);
  }, []);

  const posts = useMemo(() => {
    const all = [...(markets.data?.posts ?? [])].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    if (scope !== "following") return all;
    const set = follows.data;
    return set ? all.filter((coin) => set.has(coin.creator.wallet)) : [];
  }, [markets.data?.posts, scope, follows.data]);

  const reels = useMemo(
    () => (markets.data?.posts ?? []).filter((coin) => coin.format === "reel" && coin.media.kind === "video"),
    [markets.data?.posts],
  );

  /** Buyers per coin, newest first, one entry per wallet. */
  const buyers = useMemo(() => {
    const map = new Map<string, Buyers>();
    for (const item of record.data?.items ?? []) {
      if (item.kind !== "trade" || item.side !== "buy") continue;
      const entry = map.get(item.coin.address) ?? { wallets: [], handles: [] };
      if (!entry.wallets.includes(item.actor.wallet)) {
        entry.wallets.push(item.actor.wallet);
        entry.handles.push(item.actor.handle);
      }
      map.set(item.coin.address, entry);
    }
    return map;
  }, [record.data?.items]);

  /** The newest thing each coin's creator wrote about it. */
  const captions = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of record.data?.items ?? []) {
      if (item.kind !== "post" || !item.coin || map.has(item.coin.address)) continue;
      map.set(item.coin.address, item.body);
    }
    return map;
  }, [record.data?.items]);

  const refresh = () => {
    invalidateMarkets();
    markets.refresh();
    record.refresh();
  };

  return (
    <SafeAreaView edges={["top"]} style={styles.page}>
      <View style={styles.header}>
        <JunoMark size={28} color={theme.colors.text} />
        <Text style={styles.wordmark}>juno</Text>
        <View style={{ flex: 1 }} />
        {/* Whose posts, not what kind. Absent without a wallet, because there
            is no following list to have. */}
        {wallet.address ? (
          <View style={styles.scope}>
            {(["everyone", "following"] as const).map((id) => (
              <Pressable
                key={id}
                onPress={() => setScope(id)}
                style={[styles.scopeItem, scope === id ? styles.scopeOn : null]}
                accessibilityRole="tab"
                accessibilityState={{ selected: scope === id }}
              >
                <Text style={[styles.scopeText, scope === id ? styles.scopeTextOn : null]}>
                  {id === "everyone" ? "For you" : "Following"}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      {markets.loading || markets.data === null ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 130 }}>
          <View style={styles.rings}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={{ alignItems: "center", gap: 6 }}>
                <Skeleton h={66} w={66} round={33} />
                <Skeleton h={10} w={46} />
              </View>
            ))}
          </View>
          {[0, 1].map((i) => (
            <View key={i} style={styles.skeletonCard}>
              <View style={{ flexDirection: "row", gap: 10, alignItems: "center", padding: 14 }}>
                <Skeleton h={40} w={40} round={20} />
                <View style={{ gap: 6, flex: 1 }}>
                  <Skeleton h={13} w="40%" />
                  <Skeleton h={10} w="28%" />
                </View>
              </View>
              <Skeleton h={340} round={0} />
              <View style={{ padding: 14, gap: 8 }}>
                <Skeleton h={14} w="70%" />
                <Skeleton h={12} w="45%" />
              </View>
            </View>
          ))}
        </ScrollView>
      ) : markets.error ? (
        <Placeholder
          title="Could not load the feed"
          detail={markets.error}
          action={<Button label="Try again" onPress={refresh} />}
        />
      ) : (
        <ScrollView
          contentContainerStyle={{ width: "100%", paddingBottom: 130 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={markets.refreshing}
              onRefresh={refresh}
              tintColor={theme.colors.muted}
            />
          }
        >
          {reels.length > 0 && scope === "everyone" ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.ringStrip}
              contentContainerStyle={styles.rings}
            >
              {reels.map((coin) => (
                <ReelRing
                  key={coin.address}
                  coin={coin}
                  onPress={() => router.push(`/(tabs)/reels?start=${coin.address}` as never)}
                />
              ))}
            </ScrollView>
          ) : null}

          {(markets.data?.missing ?? 0) > 0 ? (
            <Text style={styles.footnote}>
              {/* Markets, not posts: an unpriced row cannot be sorted into a
                  post or a stock, so the count covers both. */}
              {markets.data!.missing} more {markets.data!.missing === 1 ? "market is" : "markets are"}{" "}
              live but could not be priced — the RPC is rate-limiting. Pull to retry.
            </Text>
          ) : null}

          {posts.length === 0 ? (
            scope === "following" ? (
              <Placeholder
                title={follows.loading ? "Reading who you follow" : "Nothing from people you follow"}
                detail={
                  follows.loading
                    ? undefined
                    : "Follow a creator from any post and their launches land here."
                }
                busy={follows.loading}
                action={
                  follows.loading ? undefined : (
                    <Button label="Show everyone" variant="quiet" onPress={() => setScope("everyone")} />
                  )
                }
              />
            ) : (
              <Placeholder
                title="No posts yet"
                detail="Every post here is a market. Tap + to launch the first one."
              />
            )
          ) : (
            posts.map((coin) => (
              <FeedCard
                key={coin.address}
                coin={coin}
                caption={captions.get(coin.address) ?? coin.description ?? null}
                // Unknown while the record loads — "No buyers yet" would be a
                // claim made before reading.
                buyers={record.loading ? null : (buyers.get(coin.address) ?? { wallets: [], handles: [] })}
                extraComments={extraComments[coin.address] ?? 0}
                onOpen={() => router.push(`/coin/${coin.address}`)}
                onBuy={() => setTrade(coin)}
                onComments={() => setTalking(coin)}
                onShare={async () => {
                  const outcome = await shareCoin(coin);
                  if (outcome === "copied") flash("Link copied");
                  if (outcome === "failed") flash("Could not share");
                }}
                onPlay={() => router.push(`/(tabs)/reels?start=${coin.address}` as never)}
                onOpenCreator={() => router.push(`/trader/${coin.creator.wallet}` as never)}
              />
            ))
          )}
        </ScrollView>
      )}

      {toast ? (
        <View pointerEvents="none" style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      {trade ? (
        <QuickTrade
          coin={trade}
          side="buy"
          onClose={() => setTrade(null)}
          onDone={() => {
            setTrade(null);
            refresh();
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
        /* Clear of the tab bar, which the navigator paints over this sheet. */
        bottomInset={tabBar.height - 10}
      />
    </SafeAreaView>
  );
}

/** A reel as a ring: its poster inside the lime-to-pink gradient people read as "new video". */
function ReelRing({ coin, onPress }: { coin: Coin; onPress: () => void }) {
  const poster = juno.still(coin.media);
  const id = `ring${coin.address.slice(0, 6)}`;
  return (
    <Tappable onPress={onPress} to={0.92} accessibilityRole="button" accessibilityLabel={`Play ${coin.name}`}>
      <View style={styles.ring}>
        <View style={styles.ringOuter}>
          <Svg width={70} height={70} style={StyleSheet.absoluteFill}>
            <Defs>
              <LinearGradient id={id} x1="0" y1="1" x2="1" y2="0">
                <Stop offset="0" stopColor={theme.colors.lime} />
                <Stop offset="1" stopColor={theme.colors.heart} />
              </LinearGradient>
            </Defs>
            <Circle cx={35} cy={35} r={33.5} stroke={`url(#${id})`} strokeWidth={3} fill="none" />
          </Svg>
          <View style={styles.ringInner}>
            {poster ? (
              <Image source={{ uri: poster }} style={{ width: 60, height: 60 }} resizeMode="cover" />
            ) : (
              <CoinArt uri={null} seed={coin.address} size={60} radius={30} />
            )}
          </View>
        </View>
        <Text style={styles.ringLabel} numberOfLines={1}>
          ${coin.symbol}
        </Text>
      </View>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.colors.surfaceAlt },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.line,
  },
  wordmark: { fontSize: 26, fontWeight: "900", letterSpacing: -1.2, color: theme.colors.text },
  scope: {
    flexDirection: "row",
    padding: 3,
    borderRadius: 999,
    backgroundColor: theme.colors.surfaceAlt,
  },
  scopeItem: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  scopeOn: { backgroundColor: theme.colors.ink },
  scopeText: { fontSize: 13, fontWeight: "700", color: theme.colors.muted },
  scopeTextOn: { color: theme.colors.onInk },

  ringStrip: { flexGrow: 0, backgroundColor: theme.colors.surface, marginBottom: 10 },
  rings: {
    flexDirection: "row",
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: theme.colors.surface,
  },
  ring: { alignItems: "center", gap: 6, width: 72 },
  ringOuter: { width: 70, height: 70, alignItems: "center", justifyContent: "center" },
  ringInner: { width: 60, height: 60, borderRadius: 30, overflow: "hidden", backgroundColor: theme.colors.ink },
  ringLabel: { fontSize: 12, fontWeight: "700", color: theme.colors.text },

  skeletonCard: { backgroundColor: theme.colors.surface, marginBottom: 10 },
  footnote: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.muted,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  toast: {
    position: "absolute",
    top: 70,
    alignSelf: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: theme.colors.ink,
  },
  toastText: { fontSize: 13, fontWeight: "700", color: theme.colors.onInk },
});
