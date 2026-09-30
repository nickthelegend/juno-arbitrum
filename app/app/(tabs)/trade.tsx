import { Image as ExpoImage } from "expo-image";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import styled from "styled-components/native";

import {
  Button,
  Caption,
  Col,
  Entry,
  Label,
  Ledger,
  Mono,
  Pill,
  Placeholder,
  Row,
  Segmented,
  Skeleton,
  Title,
} from "../../components/kit";
import { CoinArt, Identicon } from "../../components/art";
import { Handle } from "../../components/Handle";
import { Tappable } from "../../components/Press";
import { QuickTrade } from "../../components/QuickTrade";
import { juno, type Coin, type StockReference, type Trader } from "../../lib/api";
import { explorer, FEED_NOTE, FEED_SOURCE } from "../../lib/chain";
import { useLinkedState } from "../../lib/linked";
import { count, invalidateMarkets, loadMarkets, progressLabel } from "../../lib/markets";
import { age, insideBand, money, useApi } from "../../lib/useApi";
import { useViewerOnce } from "../../lib/social";
import { theme } from "../../theme";

type Sort = "stocks" | "memes" | "traders";

const SORTS = [
  { id: "stocks" as const, label: "Stocks" },
  { id: "memes" as const, label: "Memes" },
  { id: "traders" as const, label: "Traders" },
];

/**
 * Trade: the markets as lists.
 *
 * **Stocks** lead: each Chainlink reference (TSLA, NVDA, AAPL) with its price,
 * how old that price is and whether the market is open, and under it the
 * Juno trackers held to it. A tracker's curve contract reads the same feed on
 * every buy and reverts one that would leave the band, or any buy at all once
 * the price is stale — so "Market closed" here is the contract's rule, not a
 * label. **Memes** are the posts, as a list rather than a feed, for someone who
 * wants to compare curves instead of scrolling pictures. **Traders** ranks the
 * people.
 *
 * Every Trade button opens the same sheet the coin screen uses, over this
 * screen — quoting against the live curve is the same act wherever it starts.
 */
export default function TradeScreen() {
  const router = useRouter();
  // Addressable, so a deep link or a demo can land on a specific list.
  const [sort, setSort] = useLinkedState<Sort>(
    "sort",
    SORTS.map((option) => option.id),
    "stocks",
  );
  const onTraders = sort === "traders";
  const onStocks = sort === "stocks";

  // Read with the same viewer as the feed and the reels, so all three share one walk.
  const once = useViewerOnce();
  const markets = useApi(
    () => (sort !== "memes" || !once.ready ? Promise.resolve(null) : loadMarkets(once.viewer())),
    [sort, once.ready],
  );
  const stocks = useApi(() => (onStocks ? juno.stocks() : Promise.resolve(null)), [onStocks]);
  const board = useApi(() => (onTraders ? juno.leaderboard(25) : Promise.resolve(null)), [onTraders]);
  const [trade, setTrade] = useState<{ coin: Coin; side: "buy" | "sell" } | null>(null);

  const refresh = () => {
    invalidateMarkets();
    markets.refresh();
    stocks.refresh();
  };

  const refreshControl = (
    <RefreshControl
      refreshing={markets.refreshing || stocks.refreshing}
      onRefresh={refresh}
      tintColor={theme.colors.muted}
    />
  );

  const loadingCards = (
    <Loading>
      {[0, 1].map((i) => (
        <Skeleton key={i} h={220} round={theme.radius.lg} />
      ))}
    </Loading>
  );

  return (
    <Page edges={["top"]}>
      <Header>
        <Title>Trade</Title>
        <Segmented items={SORTS} value={sort} onChange={setSort} />
      </Header>

      {onTraders ? (
        <TraderBoard board={board} onOpen={(wallet) => router.push(`/trader/${wallet}` as never)} />
      ) : onStocks ? (
        stocks.error && !stocks.loading ? (
          <Placeholder
            title="Could not load the stocks"
            detail={stocks.error}
            action={<Button label="Try again" onPress={stocks.refresh} />}
          />
        ) : stocks.loading || stocks.data === null ? (
          loadingCards
        ) : (
          <ScrollView
            contentContainerStyle={{ width: "100%", paddingHorizontal: 16, paddingBottom: 130, gap: 14 }}
            showsVerticalScrollIndicator={false}
            refreshControl={refreshControl}
          >
            <Intro />
            {(stocks.data ?? []).length === 0 ? (
              <Placeholder
                title="No stock trackers yet"
                detail="Trackers held to a Chainlink stock price land here once they are launched."
              />
            ) : (
              (stocks.data ?? []).map((reference) => (
                <StockCard
                  key={reference.symbol}
                  reference={reference}
                  onTrade={(coin, side) => setTrade({ coin, side })}
                  onOpen={(address) => router.push(`/coin/${address}`)}
                />
              ))
            )}
            <Caption style={{ paddingHorizontal: 4 }}>
              Prices are Chainlink&apos;s, read on-chain. A tracker is a Juno curve held to the
              stock&apos;s price, not a share.{FEED_NOTE ? ` ${FEED_NOTE}` : ""}
            </Caption>
          </ScrollView>
        )
      ) : markets.loading || markets.data === null ? (
        markets.error ? (
          <Placeholder
            title="Could not load the market"
            detail={markets.error}
            action={<Button label="Try again" onPress={markets.refresh} />}
          />
        ) : (
          <Loading>
            <Ledger>
              {[0, 1, 2, 3].map((i) => (
                <Entry key={i} $first={i === 0}>
                  <Row gap={12}>
                    <Skeleton h={44} w={44} round={14} />
                    <Col gap={8} style={{ flex: 1 }}>
                      <Skeleton h={14} w="55%" />
                      <Skeleton h={11} w="35%" />
                    </Col>
                    <Skeleton h={36} w={72} round={12} />
                  </Row>
                </Entry>
              ))}
            </Ledger>
          </Loading>
        )
      ) : markets.error ? (
        <Placeholder
          title="Could not load the market"
          detail={markets.error}
          action={<Button label="Try again" onPress={markets.refresh} />}
        />
      ) : (
        <ScrollView
          contentContainerStyle={{ width: "100%", paddingHorizontal: 16, paddingBottom: 130 }}
          showsVerticalScrollIndicator={false}
          refreshControl={refreshControl}
        >
          {(markets.data?.missing ?? 0) > 0 ? (
            <Footnote>
              {markets.data!.missing} more {markets.data!.missing === 1 ? "market is" : "markets are"}{" "}
              listed but could not be priced just now. Pull to retry.
            </Footnote>
          ) : null}
          {markets.data!.posts.length === 0 ? (
            <Placeholder title="No memes yet" detail="Post something with +." />
          ) : (
            <View style={{ gap: 14 }}>
              <Intro
                pill="Launched on Arbitrum"
                title="Every post is a market."
                body="Posts and reels launched as coins. Early buyers ride the curve; creators earn the fees."
              />
              {markets.data!.posts.map((coin) => (
                <MarketCard
                  key={coin.address}
                  coin={coin}
                  onOpen={() => router.push(`/coin/${coin.address}`)}
                  onTrade={() => setTrade({ coin, side: "buy" })}
                />
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {trade ? (
        <QuickTrade
          coin={trade.coin}
          side={trade.side}
          onClose={() => setTrade(null)}
          onDone={() => {
            setTrade(null);
            invalidateMarkets();
            markets.refresh();
            stocks.refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

/** What this list is, once, in the app's one dark panel. */
function Intro({
  pill = "Held to Chainlink",
  title = "Listed names, on a curve.",
  body = "Each tracker is a Juno bonding curve priced in USDC. Its contract reads the stock's Chainlink price on every buy and refuses one that would leave the band.",
}: {
  pill?: string;
  title?: string;
  body?: string;
}) {
  return (
    <View style={styles.intro}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <LinearGradient id="introGlow" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={theme.colors.lime} stopOpacity={0.22} />
            <Stop offset="0.6" stopColor={theme.colors.lime} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#introGlow)" />
      </Svg>
      <View style={styles.introPill}>
        <View style={styles.introDot} />
        <Text style={styles.introPillText}>{pill}</Text>
      </View>
      <Text style={styles.introTitle}>{title}</Text>
      <Text style={styles.introBody}>{body}</Text>
    </View>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <View style={{ flex: 1, gap: 3 }}>
      <Text
        style={[styles.statValue, tone ? { color: tone === "pos" ? theme.colors.pos : theme.colors.neg } : null]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/** The company behind a listed ticker, for when the reference comes back without a name. */
const LISTED: Record<string, { name: string; venue: string }> = {
  AAPL: { name: "Apple", venue: "Nasdaq" },
  MSFT: { name: "Microsoft", venue: "Nasdaq" },
  NVDA: { name: "NVIDIA", venue: "Nasdaq" },
  TSLA: { name: "Tesla", venue: "Nasdaq" },
  AMZN: { name: "Amazon", venue: "Nasdaq" },
  GOOGL: { name: "Alphabet", venue: "Nasdaq" },
  META: { name: "Meta", venue: "Nasdaq" },
};

/**
 * The company's own logo, so a listed name reads as that company at a glance.
 *
 * Loaded from a public stock-logo endpoint by ticker. Should it fail — an
 * unknown ticker, no network — the tile falls back to the ticker in type, so
 * the card never shows a broken image.
 */
function StockLogo({ ticker }: { ticker: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={styles.tickerTile}>
        {/* Sized by length rather than `adjustsFontSizeToFit`, which web ignores. */}
        <Text style={[styles.tickerTileText, { fontSize: ticker.length > 3 ? 12 : 15 }]} numberOfLines={1}>
          {ticker.slice(0, 4)}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.logoTile}>
      <ExpoImage
        source={{ uri: `https://financialmodelingprep.com/image-stock/${encodeURIComponent(ticker)}.png` }}
        style={{ width: 34, height: 34 }}
        contentFit="contain"
        accessibilityLabel={`${LISTED[ticker]?.name ?? ticker} logo`}
        onError={() => setFailed(true)}
      />
    </View>
  );
}

/**
 * One stock and the trackers held to it.
 *
 * The stock half is Chainlink's, read on-chain: the price, how old it is, and
 * whether the market is open (a fresh price) or closed (stale, so the
 * trackers take sells only). The tracker half is Juno's: each curve, its price
 * against the stock, and the band its contract enforces.
 */
function StockCard({
  reference,
  onTrade,
  onOpen,
}: {
  reference: StockReference;
  onTrade: (coin: Coin, side: "buy" | "sell") => void;
  onOpen: (address: string) => void;
}) {
  const listed = LISTED[reference.symbol];
  const open = reference.marketOpen;

  return (
    <View style={styles.company}>
      <View style={styles.companyHead}>
        <StockLogo ticker={reference.symbol} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.companyName} numberOfLines={1}>
            {reference.name || listed?.name || reference.symbol}
          </Text>
          <Text
            style={styles.companySector}
            numberOfLines={1}
            onPress={() => void Linking.openURL(explorer("address", reference.feed))}
          >
            {listed?.venue ?? "Listed"} · {reference.symbol} · {FEED_SOURCE} feed ↗
          </Text>
        </View>
        <View style={[styles.preBadge, open ? styles.badgeInk : styles.badgeClosed]}>
          <Text style={[styles.preBadgeText, open ? styles.badgeInkText : styles.badgeClosedText]}>
            {open ? "OPEN" : "CLOSED"}
          </Text>
        </View>
      </View>

      <View style={styles.stats}>
        <Stat
          label={`${FEED_SOURCE} price`}
          value={reference.price === null ? "—" : money(reference.price, "USD", { compact: false })}
        />
        <View style={styles.statRule} />
        <Stat label="Updated" value={reference.ageSeconds === null ? "—" : `${age(reference.ageSeconds)} ago`} />
        <View style={styles.statRule} />
        <Stat label="Market" value={open ? "Open" : "Sells only"} tone={open ? "pos" : "neg"} />
      </View>

      {!open ? (
        <Text style={styles.closed}>Market closed · sells only. The price is stale, so the curve refuses buys.</Text>
      ) : null}

      {reference.trackers.length === 0 ? (
        <Text style={styles.noMarket}>No Juno tracker on {reference.symbol} yet.</Text>
      ) : (
        reference.trackers.map((coin) => {
          const pct = coin.curve.progress * 100;
          const nav = coin.nav ?? null;
          const deviation = nav?.deviationPct ?? null;
          const band = nav ? nav.bandBps / 100 : null;
          const inside = deviation === null || band === null ? null : insideBand(deviation, band);
          return (
            <Tappable key={coin.address} onPress={() => onOpen(coin.address)} to={0.985}>
              <View style={styles.market}>
                <CoinArt uri={juno.still(coin.media)} seed={coin.address} size={40} radius={12} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={styles.marketName} numberOfLines={1}>
                    ${coin.symbol} <Text style={styles.marketPreset}>{coin.curvePreset}</Text>
                  </Text>
                  {nav ? (
                    <Text
                      style={[
                        styles.marketMeta,
                        inside === null
                          ? null
                          : { color: inside ? theme.colors.pos : theme.colors.neg, fontWeight: "700" },
                      ]}
                      numberOfLines={2}
                    >
                      Curve {money(nav.curvePrice, "USD", { compact: false })}
                      {deviation === null ? "" : ` · ${deviation >= 0 ? "+" : ""}${deviation.toFixed(2)}% vs stock`}
                      {band === null ? "" : ` · ±${band}% band`}
                    </Text>
                  ) : null}
                  <Text style={styles.marketMeta} numberOfLines={1}>
                    {money(coin.marketCap, coin.marketCapCurrency)} cap ·{" "}
                    {coin.curve.graduated ? "graduated" : `${progressLabel(pct)} to graduation`}
                  </Text>
                </View>
                {coin.curve.graduated ? (
                  <Pill label="On Uniswap" />
                ) : (
                  <Tappable onPress={() => onTrade(coin, open ? "buy" : "sell")} to={0.94}>
                    <View
                      style={styles.tradeButton}
                      accessibilityRole="button"
                      accessibilityLabel={`Trade $${coin.symbol}`}
                    >
                      <Text style={styles.tradeText}>{open ? "Trade" : "Sell"}</Text>
                    </View>
                  </Tappable>
                )}
              </View>
            </Tappable>
          );
        })
      )}
    </View>
  );
}

/**
 * One post or reel, as a card.
 *
 * Leads with the post: its art, who made it, and the social numbers that are
 * the only fundamentals a meme has. Ends on the curve and the Trade button.
 */
function MarketCard({
  coin,
  onOpen,
  onTrade,
}: {
  coin: Coin;
  onOpen: () => void;
  onTrade: () => void;
}) {
  const pct = coin.curve.progress * 100;

  return (
    <Tappable onPress={onOpen} to={0.985}>
      <View style={styles.company}>
        <View style={styles.companyHead}>
          <CoinArt uri={juno.still(coin.media)} seed={coin.address} size={48} radius={14} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.companyName} numberOfLines={1}>
              {coin.name}
            </Text>
            <Text style={styles.companySector} numberOfLines={1}>
              by <Handle wallet={coin.creator.wallet} /> · {coin.format === "reel" ? "reel" : "post"}
            </Text>
          </View>
          <View style={[styles.preBadge, styles.badgeHeart]}>
            <Text style={[styles.preBadgeText, styles.badgeHeartText]}>
              {coin.format === "reel" ? "REEL" : "MEME"}
            </Text>
          </View>
        </View>

        <View style={styles.stats}>
          <Stat label="Market cap" value={money(coin.marketCap, coin.marketCapCurrency)} />
          <View style={styles.statRule} />
          <Stat label="Likes" value={coin.likes === undefined ? "—" : count(coin.likes) || "0"} />
          <View style={styles.statRule} />
          <Stat label="Replies" value={coin.commentCount === undefined ? "—" : count(coin.commentCount) || "0"} />
        </View>

        <View style={styles.market}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={styles.marketName} numberOfLines={1}>
              ${coin.symbol} <Text style={styles.marketPreset}>{coin.curvePreset}</Text>
            </Text>
            <View style={styles.rowCurve}>
              <View style={styles.rowTrack}>
                <View
                  style={[
                    styles.rowFill,
                    { width: `${coin.curve.graduated ? 100 : pct > 0 ? Math.max(2, Math.min(100, pct)) : 0}%` },
                  ]}
                />
              </View>
              <Text style={styles.marketMeta}>
                {coin.curve.graduated ? "Graduated" : progressLabel(pct)}
              </Text>
            </View>
          </View>
          {coin.curve.graduated ? (
            <Pill label="On Uniswap" />
          ) : (
            <Tappable onPress={onTrade} to={0.94}>
              <View style={styles.tradeButton} accessibilityRole="button" accessibilityLabel={`Trade $${coin.symbol}`}>
                <Text style={styles.tradeText}>Trade</Text>
              </View>
            </Tappable>
          )}
        </View>
      </View>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  intro: {
    borderRadius: theme.radius.lg,
    padding: 18,
    gap: 8,
    backgroundColor: theme.colors.ink,
    overflow: "hidden",
  },
  introPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(214,255,61,0.14)",
  },
  introDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.lime },
  introPillText: { fontSize: 11, fontWeight: "700", color: theme.colors.lime },
  introTitle: { fontSize: 24, lineHeight: 28, fontWeight: "900", letterSpacing: -0.8, color: theme.colors.onInk },
  introBody: { fontSize: 14, lineHeight: 20, color: "rgba(243,247,238,0.72)" },

  company: {
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: 16,
    gap: 14,
    ...theme.shadow.card,
  },
  companyHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  companyName: { fontSize: 20, fontWeight: "900", letterSpacing: -0.5, color: theme.colors.text },
  companySector: { fontSize: 12, color: theme.colors.muted },
  preBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: theme.colors.limeSoft,
  },
  preBadgeText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.6, color: theme.colors.onLime },
  badgeInk: { backgroundColor: theme.colors.ink },
  badgeInkText: { color: theme.colors.lime },
  badgeHeart: { backgroundColor: "rgba(255,45,111,0.12)" },
  badgeClosed: { backgroundColor: theme.colors.surfaceAlt },
  badgeClosedText: { color: theme.colors.neg },
  closed: { fontSize: 12, lineHeight: 17, fontWeight: "600", color: theme.colors.neg },
  badgeHeartText: { color: theme.colors.heart },

  stats: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  statRule: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: theme.colors.lineStrong, marginHorizontal: 10 },
  statValue: { fontSize: 17, fontWeight: "800", letterSpacing: -0.3, color: theme.colors.text, fontVariant: ["tabular-nums"] },
  statLabel: { fontSize: 11, fontWeight: "600", color: theme.colors.muted },

  market: { flexDirection: "row", alignItems: "center", gap: 12 },
  marketName: { fontSize: 15, fontWeight: "800", color: theme.colors.text },
  marketPreset: { fontSize: 12, fontWeight: "600", color: theme.colors.muted },
  marketMeta: { fontSize: 12, color: theme.colors.muted, fontVariant: ["tabular-nums"] },
  noMarket: { fontSize: 13, color: theme.colors.muted },

  tradeButton: {
    height: 38,
    paddingHorizontal: 18,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.lime,
  },
  tradeText: { fontSize: 14, fontWeight: "800", color: theme.colors.onLime },

  tickerTile: {
    width: 48,
    height: 48,
    borderRadius: 14,
    padding: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.ink,
  },
  logoTile: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.line,
  },
  tickerTileText: { fontSize: 13, fontWeight: "900", color: theme.colors.lime, letterSpacing: -0.2 },

  rowCurve: { flexDirection: "row", alignItems: "center", gap: 10 },
  rowTrack: { flex: 1, height: 4, borderRadius: 2, backgroundColor: theme.colors.line, overflow: "hidden" },
  rowFill: { height: 4, borderRadius: 2, backgroundColor: theme.colors.pos },
});

const Footnote = styled.Text`
  margin-bottom: ${(p) => p.theme.space(3)}px;
  padding-horizontal: ${(p) => p.theme.space(2)}px;
  font-size: ${(p) => p.theme.type.caption.size}px;
  line-height: ${(p) => p.theme.type.caption.height}px;
  color: ${(p) => p.theme.colors.muted};
`;

/**
 * Traders, ranked by profit they have taken.
 *
 * Ranked on **realised** only. A wallet that bought and never sold has taken no
 * risk off the table, and ranking on paper gains would order the board by who
 * bought earliest rather than who traded well. The open position is shown
 * beside the rank so the picture is complete, and it never decides the order.
 *
 * `—` on a win rate is not a zero. It means no sell had a cost inside the read
 * window to compare against, which is unmeasured rather than bad.
 */
function TraderBoard({
  board,
  onOpen,
}: {
  board: ReturnType<typeof useApi<{ partial: boolean; poolsRead: number; traders: Trader[] } | null>>;
  onOpen: (wallet: string) => void;
}) {
  if (board.loading) {
    return (
      <Loading>
        <Ledger>
          {[0, 1, 2, 3].map((i) => (
            <Entry key={i} $first={i === 0}>
              <Row gap={12}>
                <Skeleton h={26} w={26} round={13} />
                <Skeleton h={14} w="40%" />
                <Col style={{ flex: 1 }} />
                <Skeleton h={16} w={64} />
              </Row>
            </Entry>
          ))}
        </Ledger>
      </Loading>
    );
  }

  if (board.error) {
    return (
      <Placeholder
        title="Could not rank traders"
        detail={board.error}
        action={<Button label="Try again" onPress={board.refresh} />}
      />
    );
  }

  const traders = board.data?.traders ?? [];

  return (
    <ScrollView
      contentContainerStyle={{ width: "100%", paddingHorizontal: 16, paddingBottom: 130 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={board.refreshing}
          onRefresh={board.refresh}
          tintColor={theme.colors.muted}
        />
      }
    >
      {/* A rank built from a short read is short. Saying so costs one line and
          is the difference between a board and a claim. */}
      {board.data?.partial ? (
        <Footnote>
          Ranked from {board.data.poolsRead}{" "}
          {board.data.poolsRead === 1 ? "curve" : "curves"} — some histories would not
          load, so this is not every trade there is. Pull to retry.
        </Footnote>
      ) : null}

      {traders.length === 0 ? (
        <Placeholder
          title={board.data?.partial ? "Could not read the trades" : "Nobody has traded yet"}
          detail={
            board.data?.partial
              ? "No trade history could be read just now. Pull to retry."
              : "The board fills in as soon as the first trade lands."
          }
        />
      ) : (
        <Ledger>
          {traders.map((trader, index) => (
            <Tappable key={trader.wallet} onPress={() => onOpen(trader.wallet)} to={0.985}>
              <Entry $first={index === 0}>
                <Row gap={12}>
                  <Rank>{index + 1}</Rank>
                  <Identicon seed={trader.wallet} size={28} />
                  <Col gap={2} style={{ flex: 1 }}>
                    <Row gap={6}>
                      <Label style={{ fontWeight: "700" }} numberOfLines={1}>
                        <Handle wallet={trader.wallet} />
                      </Label>
                      {trader.isCreator ? <Pill label="Creator" tone="lime" /> : null}
                    </Row>
                    <Caption>
                      {trader.trades} {trader.trades === 1 ? "fill" : "fills"} ·{" "}
                      {trader.coins} {trader.coins === 1 ? "coin" : "coins"}
                      {trader.followers > 0
                        ? ` · ${trader.followers} ${trader.followers === 1 ? "follower" : "followers"}`
                        : ""}
                    </Caption>
                  </Col>
                  <Col gap={2} style={{ alignItems: "flex-end" }}>
                    <Mono
                      style={{
                        color:
                          trader.realised > 0
                            ? theme.colors.pos
                            : trader.realised < 0
                              ? theme.colors.neg
                              : theme.colors.text,
                      }}
                    >
                      {trader.realised > 0 ? "+" : ""}
                      {money(trader.realised, "USD")}
                    </Mono>
                    <Caption>taken</Caption>
                  </Col>
                </Row>

                <Row gap={16} style={{ marginTop: 12 }}>
                  <Col gap={2} style={{ flex: 1 }}>
                    <Mono muted>
                      {trader.unrealised === null ? "—" : money(trader.unrealised, "USD")}
                    </Mono>
                    <Caption>Open</Caption>
                  </Col>
                  <Col gap={2} style={{ flex: 1 }}>
                    <Mono muted>{money(trader.holding, "USD")}</Mono>
                    <Caption>Holding</Caption>
                  </Col>
                  <Col gap={2} style={{ flex: 1 }}>
                    <Mono muted>
                      {trader.winRate === null ? "—" : `${Math.round(trader.winRate * 100)}%`}
                    </Mono>
                    <Caption>Win rate</Caption>
                  </Col>
                </Row>
              </Entry>
            </Tappable>
          ))}
        </Ledger>
      )}
    </ScrollView>
  );
}

const Rank = styled.Text`
  width: 18px;
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.faint};
`;

const Page = styled(SafeAreaView)`
  flex: 1;
  background-color: ${(p) => p.theme.colors.bg};
`;

const Header = styled.View`
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-bottom: ${(p) => p.theme.space(3)}px;
  gap: ${(p) => p.theme.space(3)}px;
`;

const Loading = styled.View`
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  gap: ${(p) => p.theme.space(3)}px;
`;



