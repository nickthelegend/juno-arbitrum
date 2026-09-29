import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Linking, Platform, RefreshControl, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Path, Rect } from "react-native-svg";
import styled from "styled-components/native";

import { CoinGlyph, Identicon } from "../../components/art";
import { CommentsSheet } from "../../components/CommentsSheet";
import { DepthChart } from "../../components/DepthChart";
import { Handle } from "../../components/Handle";
import { PriceLine } from "../../components/PriceLine";
import { Tappable } from "../../components/Press";
import {
  AlertSheet,
  PlanSheet,
  SaveCard,
  WatchToggle,
  type SavedState,
} from "../../components/Save";
import { TradeSheet } from "../../components/TradeSheet";
import {
  Body,
  Button,
  Caption,
  Card,
  ChevronLeft,
  Col,
  ExternalGlyph,
  Label,
  Mono,
  Pill,
  Placeholder,
  Row,
  Skeleton,
  Stat,
  Title,
} from "../../components/kit";
import { ApiError, juno, type NavReference, type Plan } from "../../lib/api";
import {
  describeTxError,
  displayAddress,
  explorer,
  FEED_NOTE,
  FEED_SOURCE,
  NETWORK_NAME,
  sameAddress,
  shortAddress,
  uniswapPoolUrl,
  validAddress,
} from "../../lib/chain";
import { age, money, since, tokens, useApi } from "../../lib/useApi";
import { shareCoin } from "../../lib/social";
import { useWallet } from "../../lib/wallet";
import { theme } from "../../theme";

/**
 * One coin: what it is, what it costs, and how to trade it.
 *
 * ## Why the chart is the whole top of the screen
 *
 * Every other arrangement of this page buried the price in a card among other
 * cards, which is a claim that the price is one fact of several. It is not —
 * it is the reason anyone opened the screen. So it is edge to edge, with no
 * container around it, and everything else is arranged underneath in the order
 * the questions actually get asked: *what is this*, *how big is it*, *who else
 * is here*, *what are the details*.
 *
 * ## Why the rest is tabbed rather than stacked
 *
 * Activity, holders, comments and metadata are four answers to four different
 * questions, and only one is wanted at a time. Stacked, they made the page
 * thousands of points long and pushed the buy button off the bottom of it;
 * tabbed, the action bar is always in reach and the page never changes height
 * when a slow read lands.
 *
 * ## The band card and the savings card
 *
 * A stock tracker's band card — the Chainlink price, the curve's price, how far
 * apart they are, the band the contract enforces and whether the market is
 * open — sits right under the price, because on a tracker that *is* the price
 * story. The savings card lives under **Details**. The watch toggle stays in
 * the nav bar, where it is one tap from anywhere on the page.
 *
 * ## After the curve
 *
 * When the curve sells its last token anyone can graduate it: the contract
 * moves the tokens and the quote it raised into a Uniswap v3 pool. The page
 * offers that button when the curve is full, and once graduated it links out
 * to the pool instead of offering a buy.
 */

const TABS = [
  { id: "activity" as const, label: "Activity" },
  { id: "holders" as const, label: "Holders" },
  { id: "comments" as const, label: "Comments" },
  { id: "details" as const, label: "Details" },
];

type Tab = (typeof TABS)[number]["id"];

export default function CoinScreen() {
  const { address: rawAddress } = useLocalSearchParams<{ address: string }>();
  // The server keys every coin by its lowercase token address.
  const mint = (rawAddress ?? "").toLowerCase();
  const router = useRouter();
  const [sheet, setSheet] = useState<"buy" | "sell" | null>(null);
  const [savingsSheet, setSavingsSheet] = useState<"alert" | "plan" | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("activity");
  const [copied, setCopied] = useState(false);
  /**
   * The plan this buy is a contribution to, if any.
   *
   * Held while the trade sheet is open so the fill can be recorded against the
   * right row — and cleared when the sheet closes, so an ordinary buy made
   * straight afterwards is not silently counted towards a savings goal.
   */
  const [contributing, setContributing] = useState<Omit<Plan, "coin"> | null>(null);

  const wallet = useWallet();
  // A link that is not an address is answered here, as the server would
  // answer it (400 → "No such coin"), without asking the server.
  const wellFormed = validAddress(mint);
  const notAnAddress = () => Promise.reject(new ApiError("That is not an address.", 400));
  const detail = useApi(() => (wellFormed ? juno.coin(mint) : notAnAddress()), [mint]);
  const coin = detail.data?.coin;

  // Only for the count on the tab — the sheet reads its own list when opened,
  // because a list fetched on mount is stale by the time anyone looks at it.
  const comments = useApi(() => (wellFormed ? juno.comments(mint) : notAnAddress()), [mint]);

  /*
   * What this wallet holds: the coin, for the sell side; ETH and USDC, for the
   * buy side and for gas. One read, re-read after each trade.
   */
  const [tradeRevision, setTradeRevision] = useState(0);
  const balances = useApi(
    async () => (wallet.address ? juno.balances(wallet.address, mint) : null),
    [wallet.address, mint, tradeRevision],
  );
  const holding = balances.data?.token ?? null;
  const spendsUsdc = coin?.quote.symbol === "USDC";
  const quoteBalance = balances.data ? (spendsUsdc ? balances.data.usdc : balances.data.eth) : null;

  /*
   * Watching, alerts and plans for this wallet on this coin.
   *
   * Postgres only — no chain reads — because this decides what a button says
   * and the list endpoints that answer the same questions each hydrate every
   * pool to do it. Held in local state as well as fetched, so a toggle shows
   * immediately instead of after a round trip.
   */
  const savedRead = useApi(
    async () => (wallet.address ? juno.saved(wallet.address, mint) : null),
    [wallet.address, mint],
  );
  const [savedLocal, setSavedLocal] = useState<SavedState | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  useEffect(() => {
    if (!savedRead.data) return;
    setSavedLocal({
      watching: savedRead.data.watching,
      alertPrice: savedRead.data.alertPrice,
      alertSetAtPrice: savedRead.data.alertSetAtPrice,
      plans: savedRead.data.plans,
    });
  }, [savedRead.data]);

  // "Copied" is a state that has to expire on its own: nothing else on the
  // screen changes to clear it.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const art = coin ? juno.still(coin.media) : null;
  const ticks = useMemo(
    () => (coin?.priceHistory ?? []).map((point) => ({ t: point.t, price: point.price })),
    [coin?.priceHistory],
  );
  const commentCount = comments.data?.comments.length ?? null;

  return (
    <Page edges={["top"]}>
      <Nav>
        <Back onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
          <ChevronLeft />
        </Back>
        <NavGrow />
        <WatchToggle
          saved={savedLocal}
          wallet={wallet.address}
          baseMint={mint}
          onChange={setSavedLocal}
        />
      </Nav>

      {detail.loading ? (
        /* Shaped like the screen it precedes — a chart, an identity row, a
           stats band — rather than one big block over an empty screen. A coin
           read can take fifteen seconds against the public endpoint, which is
           a long time to look at nothing. */
        <Loading>
          <Skeleton h={40} w="52%" />
          <Skeleton h={210} round={18} style={{ marginTop: 18 }} />
          <Row gap={12} style={{ marginTop: 22 }}>
            <Skeleton h={34} w={34} round={17} />
            <Skeleton h={14} w="40%" />
          </Row>
          <Skeleton h={26} w="80%" style={{ marginTop: 14 }} />
          <Skeleton h={64} round={16} style={{ marginTop: 18 }} />
        </Loading>
      ) : detail.errorStatus === 404 || detail.errorStatus === 400 ? (
        // Not a failure to retry: there is no such coin on this chain.
        <Placeholder
          title="No such coin"
          detail="Nothing on Juno has this address. It may be on another network, or the link is wrong."
          action={<Button label="Back to the feed" onPress={() => router.replace("/(tabs)/social" as never)} />}
        />
      ) : detail.error || !coin ? (
        <Placeholder
          title="Could not load this coin"
          detail={detail.error ?? undefined}
          action={<Button label="Try again" onPress={detail.refresh} />}
        />
      ) : (
        <>
          <ScrollView
            contentContainerStyle={{ width: "100%", paddingBottom: 150 }}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={detail.refreshing}
                onRefresh={() => {
                  detail.refresh();
                  comments.refresh();
                }}
                tintColor={theme.colors.muted}
              />
            }
          >
            {/* The post itself, first, when there is one. A market that is
                a photo or a reel was shown as a price chart with the picture
                nowhere on the page — the thing people are buying into, missing
                from the screen where they buy it. Trackers have no media and
                open on their chart. */}
            {art && !coin.nav && coin.reference == null ? (
              <Padded>
                <Tappable
                  onPress={() =>
                    coin.media.kind === "video"
                      ? router.push(`/(tabs)/reels?start=${coin.address}` as never)
                      : undefined
                  }
                  to={coin.media.kind === "video" ? 0.98 : 1}
                  accessibilityRole={coin.media.kind === "video" ? "button" : "image"}
                  accessibilityLabel={coin.media.kind === "video" ? `Play ${coin.name}` : coin.name}
                >
                  <Hero
                    source={{ uri: art }}
                    resizeMode="cover"
                    style={{
                      aspectRatio:
                        coin.media.width && coin.media.height
                          ? Math.max(0.8, Math.min(1.25, coin.media.width / coin.media.height))
                          : 1,
                    }}
                  />
                  {coin.media.kind === "video" ? (
                    <PlayOver pointerEvents="none">
                      <PlayDisc>
                        <Svg width={26} height={26} viewBox="0 0 24 24">
                          <Path d="M7 4.5v15l12.5-7.5z" fill="#FFFFFF" />
                        </Svg>
                      </PlayDisc>
                    </PlayOver>
                  ) : null}
                </Tappable>
              </Padded>
            ) : null}

            <PriceLine
              ticks={ticks}
              livePrice={coin.priceUsd}
              partial={coin.priceHistoryPartial === true}
              format={(value) => price(value, coin.marketCapCurrency)}
            />

            <Padded>
              {/* Who made it, how many hold it, and a way to pass it on. */}
              <Row gap={10} align="center">
                <Tappable
                  onPress={() => router.push(`/trader/${coin.creator.wallet}` as never)}
                  to={0.95}
                >
                  <Row gap={8} align="center">
                    {art ? <Thumb source={{ uri: art }} /> : <CoinGlyph size={30} seed={coin.address} />}
                    <Label style={{ fontWeight: "700" }} numberOfLines={1}>
                      <Handle wallet={coin.creator.wallet} />
                    </Label>
                  </Row>
                </Tappable>
                <NavGrow />
                <Caption numberOfLines={1}>
                  {/* The largest-accounts read is one the public RPC refuses
                      outright, so this said "— holders" on nearly every coin.
                      When it does, the decoded trades answer instead: wallets
                      whose fills still net positive, counted from a complete
                      read only — a partial one would undercount. */}
                  {(() => {
                    const crowd = detail.data?.crowd;
                    const n =
                      coin.holders ?? (crowd && !crowd.partial ? crowd.holdersStill : null);
                    return n === null ? "— holders" : `${n} ${n === 1 ? "holder" : "holders"}`;
                  })()}
                </Caption>
                <Tappable
                  onPress={async () => {
                    const outcome = await shareCoin(coin);
                    // "Copied" on the chip below is the one confirmation this
                    // screen already has; a copied link reuses it.
                    if (outcome === "copied") setCopied(true);
                  }}
                  to={0.86}
                >
                  <IconTap hitSlop={8} accessibilityRole="button" accessibilityLabel="Share">
                    <ShareGlyph />
                  </IconTap>
                </Tappable>
              </Row>

              <Title style={{ marginTop: 12 }}>{coin.name}</Title>
              {coin.description ? (
                <Body muted style={{ marginTop: 6 }}>
                  {coin.description}
                </Body>
              ) : null}

              <Row gap={8} style={{ marginTop: 12 }}>
                <Chip>
                  <ChipMark>$</ChipMark>
                  <ChipText numberOfLines={1}>{coin.symbol}</ChipText>
                </Chip>
                <Tappable
                  onPress={async () => {
                    await Clipboard.setStringAsync(coin.address);
                    setCopied(true);
                  }}
                  to={0.95}
                >
                  <Chip accessibilityRole="button" accessibilityLabel="Copy the coin address">
                    <CopyGlyph />
                    <ChipText>{copied ? "Copied" : "Copy address"}</ChipText>
                  </Chip>
                </Tappable>
              </Row>

              {/* Three figures, ruled apart rather than boxed — the band is one
                  reading of size, not three separate cards. */}
              <Band>
                <Cell>
                  <CellValue>{money(coin.marketCap, coin.marketCapCurrency)}</CellValue>
                  <Caption numberOfLines={1}>Market cap</Caption>
                </Cell>
                <Divider />
                <Cell>
                  <CellValue>
                    {coin.totalVolume === null ? "—" : money(coin.totalVolume, coin.marketCapCurrency)}
                  </CellValue>
                  <Caption numberOfLines={1}>Total volume</Caption>
                </Cell>
                <Divider />
                <Cell>
                  <CellValue>
                    {money(coin.creatorRewards, coin.marketCapCurrency, { compact: false })}
                  </CellValue>
                  <Caption numberOfLines={1}>Creator rewards</Caption>
                </Cell>
              </Band>

              {/* A tracker's band: the stock, the curve, and the rule between them. */}
              {coin.nav ? <NavBand nav={coin.nav} feed={coin.reference?.feed ?? null} /> : null}

              {/* The creator's own payday, on their own coin. The contract
                  checks it too; the button is simply not shown to anyone else. */}
              {wallet.address && sameAddress(wallet.address, coin.creator.wallet) ? (
                <ClaimFees
                  curve={coin.pool}
                  creator={wallet.address}
                  rewards={coin.creatorRewards}
                  currency={coin.marketCapCurrency}
                  onClaimed={() => {
                    setTradeRevision((n) => n + 1);
                    detail.refresh();
                  }}
                />
              ) : null}

              {/* Raised against threshold, with both ends labelled. A bar with
                  no numbers on it is a mood. */}
              {!coin.curve.graduated && coin.curve.progress >= 1 ? (
                <Graduate
                  curve={coin.pool}
                  onGraduated={() => {
                    setTradeRevision((n) => n + 1);
                    detail.refresh();
                  }}
                />
              ) : !coin.curve.graduated ? (
                <RaisedRow>
                  <End>{money(coin.curve.raisedUsd, coin.marketCapCurrency)}</End>
                  <Track>
                    {/* A floor of 1.5% so a curve 0.02% of the way along still
                        reads as started — but only above zero, where drawing
                        anything would claim a raise nobody made. */}
                    {coin.curve.progress > 0 ? (
                      <FillBar
                        style={{
                          width: `${Math.min(100, Math.max(1.5, coin.curve.progress * 100))}%`,
                        }}
                      />
                    ) : null}
                  </Track>
                  <End>{money(coin.curve.thresholdUsd, coin.marketCapCurrency)}</End>
                </RaisedRow>
              ) : (
                <Row gap={8} style={{ marginTop: 16 }}>
                  <Pill label="Graduated" tone="pos" />
                  {coin.graduatedPool ? (
                    <Tappable onPress={() => void Linking.openURL(uniswapPoolUrl(coin.graduatedPool!, coin.chainId))}>
                      <Row gap={6} align="center">
                        <LinkText>Trading on Uniswap</LinkText>
                        <ExternalGlyph />
                      </Row>
                    </Tappable>
                  ) : (
                    <Caption style={{ flex: 1 }}>Trading on Uniswap.</Caption>
                  )}
                </Row>
              )}

              <TabBar>
                {TABS.map((option) => (
                  <TabTap
                    key={option.id}
                    onPress={() =>
                      option.id === "comments" ? setCommentsOpen(true) : setTab(option.id)
                    }
                    accessibilityRole="button"
                    accessibilityState={{ selected: tab === option.id }}
                  >
                    <TabLabel $on={tab === option.id}>
                      {option.label}
                      {option.id === "comments" && commentCount !== null && commentCount > 0
                        ? ` ${commentCount}`
                        : ""}
                    </TabLabel>
                    <TabRule $on={tab === option.id} />
                  </TabTap>
                ))}
              </TabBar>

              {tab === "activity" ? (
                <ActivityTab
                  rows={detail.data!.activity}
                  partial={detail.data!.activityPartial}
                  currency={coin.marketCapCurrency}
                  onOpenTrader={(target) => router.push(`/trader/${target}` as never)}
                />
              ) : tab === "holders" ? (
                <HoldersTab
                  rows={detail.data!.holders}
                  unreadable={detail.data!.holdersUnreadable}
                  onOpenTrader={(target) => router.push(`/trader/${target}` as never)}
                />
              ) : (
                <DetailsTab
                  coin={coin}
                  launchTxHash={detail.data!.launchTxHash ?? null}
                  saveCard={
                    <SaveCard
                      coin={coin}
                      saved={savedLocal}
                      wallet={wallet.address}
                      error={savedError}
                      onEditAlert={() => setSavingsSheet("alert")}
                      onNewPlan={() => setSavingsSheet("plan")}
                      onContribute={(plan) => {
                        setContributing(plan);
                        setSheet("buy");
                      }}
                      onTogglePlan={(plan) => void togglePlan(plan)}
                    />
                  }
                />
              )}
            </Padded>
          </ScrollView>

          {/* Say something, or take a position. The two things this screen is
              for, always within reach of a thumb. */}
          <Actions>
            {/* The glyph alone. The word beside it was the one label on a bar
                whose other half says Buy, and it read as a second primary
                action competing with the one that matters. */}
            <Tappable onPress={() => setCommentsOpen(true)} to={0.94}>
              <PostTap accessibilityRole="button" accessibilityLabel="Comment on this coin">
                <PostGlyph />
              </PostTap>
            </Tappable>
            {coin.curve.graduated ? (
              coin.graduatedPool ? (
                <Button
                  label="Trading on Uniswap ↗"
                  variant="ink"
                  tall
                  onPress={() => void Linking.openURL(uniswapPoolUrl(coin.graduatedPool!, coin.chainId))}
                  style={{ flex: 1 }}
                />
              ) : (
                <GraduatedNote>This market moved to Uniswap.</GraduatedNote>
              )
            ) : coin.curve.progress >= 1 ? (
              // Every token on the curve has sold; a buy would revert
              // `SoldOut`. The graduate card above is the next step.
              <GraduatedNote>Curve is full — graduating.</GraduatedNote>
            ) : (
              <Button
                // A tracker whose stock price is stale takes sells only; the
                // contract refuses buys, so the button does not offer one.
                label={coin.nav?.marketOpen === false ? "Sell · market closed" : "Buy"}
                variant="lime"
                tall
                onPress={() => setSheet(coin.nav?.marketOpen === false ? "sell" : "buy")}
                style={{ flex: 1 }}
              />
            )}
          </Actions>

          {sheet ? (
            <TradeSheet
              coin={coin}
              side={sheet}
              holding={holding}
              quoteBalance={quoteBalance}
              feeBalance={balances.data?.eth ?? null}
              initialAmount={sheet === "buy" && contributing ? String(contributing.amount) : ""}
              onFilled={(spent) => void recordFill(spent)}
              onCommented={() => comments.refresh()}
              onClose={() => {
                setSheet(null);
                setContributing(null);
              }}
              onDone={() => {
                setSheet(null);
                setContributing(null);
                setTradeRevision((n) => n + 1);
                detail.refresh();
              }}
            />
          ) : null}

          <CommentsSheet
            visible={commentsOpen}
            onClose={() => setCommentsOpen(false)}
            target={{ kind: "coin", mint, symbol: coin.symbol }}
            onPosted={() => comments.refresh()}
          />

          <AlertSheet
            visible={savingsSheet === "alert"}
            onClose={() => setSavingsSheet(null)}
            coin={coin}
            wallet={wallet.address}
            saved={savedLocal}
            onSaved={setSavedLocal}
          />
          <PlanSheet
            visible={savingsSheet === "plan"}
            onClose={() => setSavingsSheet(null)}
            coin={coin}
            wallet={wallet.address}
            saved={savedLocal}
            onSaved={setSavedLocal}
          />
        </>
      )}
    </Page>
  );

  /** Pause or resume, optimistically, rolling back if the write is refused. */
  async function togglePlan(plan: Omit<Plan, "coin">) {
    if (!savedLocal) return;
    const next = !plan.active;
    setSavedError(null);
    setSavedLocal({
      ...savedLocal,
      plans: savedLocal.plans.map((row) =>
        row.id === plan.id ? { ...row, active: next, due: next && row.due } : row,
      ),
    });
    try {
      await juno.setPlanActive(plan.id, next);
    } catch (caught) {
      setSavedLocal(savedLocal);
      setSavedError(caught instanceof Error ? caught.message : "That could not be saved");
    }
  }

  /**
   * A buy confirmed on chain; if it was a contribution, write it down.
   *
   * Not optimistic, and deliberately so. Everything else on this card can be
   * rolled back on a failed write; a contribution total is the one figure that
   * is supposed to mean *this actually happened*, so it moves only once the
   * server has agreed, and the row it returns is what replaces the local one.
   */
  async function recordFill(spent: number) {
    const plan = contributing;
    if (!plan || spent <= 0) return;
    setSavedError(null);
    try {
      const { plan: fresh } = await juno.recordContribution(plan.id, spent);
      setSavedLocal((current) =>
        current === null
          ? current
          : {
              ...current,
              plans: current.plans.map((row) => (row.id === fresh.id ? { ...row, ...fresh } : row)),
            },
      );
    } catch (caught) {
      // The swap landed either way — this only failed to be *recorded*, and
      // saying so is better than a progress bar that quietly did not move.
      setSavedError(
        caught instanceof Error
          ? `The buy went through, but it was not recorded against your plan: ${caught.message}`
          : "The buy went through, but it was not recorded against your plan.",
      );
    }
  }
}


/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function ActivityTab({
  rows,
  partial,
  currency,
  onOpenTrader,
}: {
  rows: import("../../lib/api").Activity[];
  partial: boolean;
  currency: string;
  onOpenTrader: (wallet: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <Empty>
        {/* An empty list that was never successfully read is not an empty
            market. Saying "No trades yet" there is a claim the app did not
            earn. */}
        <Body muted>
          {partial
            ? "Trade history could not be read just now. Pull to retry."
            : "No trades yet."}
        </Body>
      </Empty>
    );
  }

  return (
    <>
      {rows.slice(0, 20).map((row) => (
        <Line key={row.id}>
          <Tappable onPress={() => onOpenTrader(row.wallet)} to={0.97}>
            <Row gap={8} align="center">
              <Identicon seed={row.wallet} size={26} />
              <Label numberOfLines={1} style={{ maxWidth: 96 }}>
                <Handle wallet={row.wallet} />
              </Label>
            </Row>
          </Tappable>
          <Verb $buy={row.side === "buy"}>{row.side === "buy" ? "Buy" : "Sell"}</Verb>
          <Mono style={{ flex: 1, textAlign: "right" }}>{tokens(row.amount)}</Mono>
          <Mono muted style={{ width: 66, textAlign: "right" }}>
            {money(row.valueUsd, currency)}
          </Mono>
          <Caption style={{ width: 34, textAlign: "right" }}>{since(row.timestamp)}</Caption>
        </Line>
      ))}
      {partial ? (
        <Caption style={{ marginTop: 12 }}>
          Some of this curve&rsquo;s history would not load — these are the fills that did.
        </Caption>
      ) : null}
    </>
  );
}

function HoldersTab({
  rows,
  unreadable,
  onOpenTrader,
}: {
  rows: import("../../lib/api").Holder[];
  unreadable: boolean;
  onOpenTrader: (wallet: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <Empty>
        <Body muted>
          {unreadable
            ? "The holder list could not be read just now — which is not the same as nobody holding this."
            : "Nobody holds this yet."}
        </Body>
      </Empty>
    );
  }

  return (
    <>
      {rows.map((row) => (
        <Line key={row.wallet}>
          <Rank>{row.rank}</Rank>
          <Tappable onPress={() => onOpenTrader(row.wallet)} to={0.97}>
            <Row gap={8} align="center">
              <Identicon seed={row.wallet} size={26} />
              <Label numberOfLines={1} style={{ maxWidth: 96 }}>
                <Handle wallet={row.wallet} />
              </Label>
            </Row>
          </Tappable>
          <Mono style={{ flex: 1, textAlign: "right" }}>{tokens(row.balance)}</Mono>
          <Mono muted style={{ width: 56, textAlign: "right" }}>
            {(row.share * 100).toFixed(1)}%
          </Mono>
        </Line>
      ))}
      <Caption style={{ marginTop: 12 }}>
        The twenty largest holders, from the token&rsquo;s transfers.
      </Caption>
    </>
  );
}

function DetailsTab({
  coin,
  launchTxHash,
  saveCard,
}: {
  coin: import("../../lib/api").Coin;
  launchTxHash: string | null;
  saveCard: React.ReactNode;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(key: string, value: string) {
    await Clipboard.setStringAsync(displayAddress(value));
    setCopied(key);
  }

  return (
    <Col gap={0}>
      {saveCard ? <SaveSlot>{saveCard}</SaveSlot> : null}

      {coin.curve.graduated ? null : <DepthChart mint={coin.address} />}

      <Rows>
        <DetailRow
          label="Created"
          value={new Date(coin.createdAt).toLocaleString()}
          shaded={false}
        />
        <DetailRow
          label="Token"
          value={shortAddress(coin.address)}
          shaded
          copied={copied === "token"}
          onCopy={() => void copy("token", coin.address)}
        />
        <DetailRow label="Ticker" value={coin.symbol} shaded={false} copied={copied === "ticker"} onCopy={() => void copy("ticker", coin.symbol)} />
        <DetailRow label="Network" value={NETWORK_NAME} shaded />
        <DetailRow label="Quote" value={coin.quote.symbol} shaded={false} />
        <DetailRow label="Curve preset" value={coin.curvePreset} shaded />
        <DetailRow label="Format" value={coin.format === "reel" ? "Reel" : "Post"} shaded={false} />
        <DetailRow
          label="Curve contract"
          value={shortAddress(coin.pool)}
          shaded
          copied={copied === "curve"}
          onCopy={() => void copy("curve", coin.pool)}
        />
        {coin.graduatedPool ? (
          <DetailRow
            label="Uniswap pool"
            value={shortAddress(coin.graduatedPool)}
            shaded={false}
            copied={copied === "pool"}
            onCopy={() => void copy("pool", coin.graduatedPool!)}
          />
        ) : null}
      </Rows>

      <LinkTap onPress={() => Linking.openURL(explorer("token", coin.address, coin.chainId))}>
        <LinkText>The token on Arbiscan</LinkText>
        <ExternalGlyph />
      </LinkTap>
      <LinkTap onPress={() => Linking.openURL(explorer("address", coin.pool, coin.chainId))}>
        <LinkText>The curve contract on Arbiscan</LinkText>
        <ExternalGlyph />
      </LinkTap>
      {launchTxHash ? (
        <LinkTap onPress={() => Linking.openURL(explorer("tx", launchTxHash, coin.chainId))}>
          <LinkText>The transaction that launched it</LinkText>
          <ExternalGlyph />
        </LinkTap>
      ) : null}
    </Col>
  );
}

/**
 * Claim the trading fees this coin has paid its creator.
 *
 * Built on the server (`claimCreatorFees()` on the curve), sent from the
 * creator's wallet, and the receipt — hash and the second it landed — stays
 * on screen.
 */
function ClaimFees({
  curve,
  creator,
  rewards,
  currency,
  onClaimed,
}: {
  curve: string;
  creator: string;
  rewards: number;
  currency: string;
  onClaimed: () => void;
}) {
  const wallet = useWallet();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ hash: string; at: Date; amount: string } | null>(null);

  async function claim() {
    setState("busy");
    setError(null);
    try {
      const built = await juno.buildClaim({ curve, creator });
      const sent = await wallet.send(built.steps, { chainId: built.chainId });
      setReceipt({
        hash: sent.hashes[sent.hashes.length - 1]!,
        at: sent.confirmedAt,
        amount:
          built.quote.amount !== undefined
            ? money(built.quote.amount, built.quote.quoteSymbol ?? currency, { compact: false })
            : money(rewards, currency, { compact: false }),
      });
      setState("done");
      onClaimed();
    } catch (caught) {
      const failure = describeTxError(caught);
      setError(failure.cancelled ? null : failure.message || "The claim failed");
      setState("idle");
    }
  }

  if (receipt) {
    return (
      <ClaimBox>
        <Label style={{ fontWeight: "700" }}>Claimed {receipt.amount} in creator fees</Label>
        <Tappable onPress={() => void Linking.openURL(explorer("tx", receipt.hash))} to={0.97}>
          <ClaimReceipt>
            tx {receipt.hash.slice(0, 10)}…{receipt.hash.slice(-8)} ·{" "}
            {receipt.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · Arbiscan ↗
          </ClaimReceipt>
        </Tappable>
      </ClaimBox>
    );
  }
  if (!(rewards > 0)) return null;
  return (
    <ClaimBox>
      <Button
        label={
          state === "busy"
            ? "Claiming…"
            : `Claim ${money(rewards, currency, { compact: false })} in creator fees`
        }
        onPress={() => void claim()}
        loading={state === "busy"}
        style={{ alignSelf: "stretch" }}
      />
      {error ? <Caption style={{ color: theme.colors.neg, marginTop: 6 }}>{error}</Caption> : null}
    </ClaimBox>
  );
}

/**
 * The curve is full: move it to Uniswap.
 *
 * `graduate()` is permissionless once the curve has sold its last token, so
 * anyone on the page can send it. The server usually does it straight after
 * the filling buy; this button is for when it has not yet.
 */
function Graduate({ curve, onGraduated }: { curve: string; onGraduated: () => void }) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ hash: string; at: Date } | null>(null);

  async function graduate() {
    setBusy(true);
    setError(null);
    try {
      const caller = wallet.address ?? (await wallet.connect());
      const built = await juno.buildGraduate({ curve, caller });
      const sent = await wallet.send(built.steps, { chainId: built.chainId });
      setReceipt({ hash: sent.hashes[sent.hashes.length - 1]!, at: sent.confirmedAt });
      onGraduated();
    } catch (caught) {
      const failure = describeTxError(caught);
      setError(failure.cancelled ? null : failure.message || "Graduation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ClaimBox>
      <Label style={{ fontWeight: "700" }}>Curve is full — graduating to Uniswap.</Label>
      <Caption style={{ marginTop: 4 }}>
        Every token on the curve has sold. Graduating moves the rest of the supply and the raise into a
        Uniswap v3 pool, where trading continues.
      </Caption>
      {receipt ? (
        <Tappable onPress={() => void Linking.openURL(explorer("tx", receipt.hash))} to={0.97}>
          <ClaimReceipt>
            tx {receipt.hash.slice(0, 10)}…{receipt.hash.slice(-8)} ·{" "}
            {receipt.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · Arbiscan ↗
          </ClaimReceipt>
        </Tappable>
      ) : (
        <Button
          label={busy ? "Graduating…" : "Graduate to Uniswap"}
          onPress={() => void graduate()}
          loading={busy}
          style={{ alignSelf: "stretch", marginTop: 10 }}
        />
      )}
      {error ? <Caption style={{ color: theme.colors.neg, marginTop: 6 }}>{error}</Caption> : null}
    </ClaimBox>
  );
}

function DetailRow({
  label,
  value,
  shaded,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  shaded: boolean;
  onCopy?: () => void;
  copied?: boolean;
}) {
  const body = (
    <DetailBox $shaded={shaded}>
      <Label muted>{label}</Label>
      <Row gap={6} align="center">
        <DetailValue numberOfLines={1}>{copied ? "Copied" : value}</DetailValue>
        {onCopy ? <CopyGlyph /> : null}
      </Row>
    </DetailBox>
  );
  return onCopy ? (
    <Tappable onPress={onCopy} to={0.985} accessibilityRole="button" accessibilityLabel={`Copy ${label}`}>
      {body}
    </Tappable>
  ) : (
    body
  );
}

/**
 * A stock tracker's band card: the stock, the curve, and the rule between them.
 *
 * The curve contract reads this same Chainlink feed on every buy. A buy that
 * would leave the curve more than the band above the stock reverts
 * (`OutsideBand`); once the feed is older than its max age, every buy reverts
 * (`MarketClosed`) and the market takes sells only. This card is that rule,
 * shown before anyone runs into it.
 */
function NavBand({ nav, feed }: { nav: NavReference; feed: string | null }) {
  const band = nav.bandBps / 100;
  const deviation = nav.deviationPct;
  const inside = deviation === null ? null : Math.abs(deviation) <= band;

  return (
    <Card style={{ marginTop: 14 }}>
      <Row justify="space-between">
        <Label style={{ fontWeight: "700" }}>{nav.symbol} · {FEED_SOURCE}</Label>
        <Caption style={{ color: nav.marketOpen ? theme.colors.pos : theme.colors.neg, fontWeight: "700" }}>
          {nav.marketOpen ? "Market open" : "Market closed · sells only"}
        </Caption>
      </Row>

      <Row style={{ marginTop: 12 }}>
        <Stat value={money(nav.price, "USD", { compact: false })} label={`${nav.symbol} price`} />
        <Stat value={money(nav.curvePrice, "USD", { compact: false })} label="Curve price" />
        <Stat
          value={deviation === null ? "—" : `${deviation >= 0 ? "+" : ""}${deviation.toFixed(2)}%`}
          label="Deviation"
        />
      </Row>

      <Split />

      <Row justify="space-between" align="center">
        <Caption>Band</Caption>
        <Mono style={{ color: inside === null ? theme.colors.muted : inside ? theme.colors.pos : theme.colors.neg }}>
          ±{band}% {inside === null ? "" : inside ? "· inside" : "· outside"}
        </Mono>
      </Row>
      <Row justify="space-between" align="center" style={{ marginTop: 6 }}>
        <Caption>Price updated</Caption>
        <Mono muted>{age(nav.ageSeconds)} ago</Mono>
      </Row>

      <Caption style={{ marginTop: 10 }}>
        {nav.marketOpen
          ? `The curve contract checks ${nav.symbol}'s Chainlink price on every buy and refuses one that would take the curve more than ${band}% above it. Sells are never blocked.`
          : `${nav.symbol}'s Chainlink price is stale — the exchange is closed — so the contract refuses buys until it updates. You can still sell.`}
        {FEED_NOTE ? ` ${FEED_NOTE}` : ""}
      </Caption>

      {feed ? (
        <LinkTap onPress={() => Linking.openURL(explorer("address", feed))}>
          <LinkText>The {nav.symbol} feed on Arbiscan</LinkText>
          <ExternalGlyph />
        </LinkTap>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Glyphs                                                              */
/* ------------------------------------------------------------------ */

function ShareGlyph() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 15V3.8M12 3.8 8.3 7.5M12 3.8l3.7 3.7"
        stroke={theme.colors.text}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M5.5 12.6v5.9a1.6 1.6 0 0 0 1.6 1.6h9.8a1.6 1.6 0 0 0 1.6-1.6v-5.9"
        stroke={theme.colors.text}
        strokeWidth={1.9}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function CopyGlyph() {
  return (
    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
      <Rect x={8.6} y={8.6} width={11.4} height={11.4} rx={2.6} stroke={theme.colors.muted} strokeWidth={1.9} />
      <Path
        d="M15.4 5.6a2 2 0 0 0-2-1.6H6.6A2.6 2.6 0 0 0 4 6.6v6.8a2 2 0 0 0 1.6 2"
        stroke={theme.colors.muted}
        strokeWidth={1.9}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function PostGlyph() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20 12.4c0 3.9-3.6 7-8 7a9 9 0 0 1-2.4-.3L5 21l1.2-3.3A6.6 6.6 0 0 1 4 12.4c0-3.9 3.6-7 8-7s8 3.1 8 7z"
        stroke={theme.colors.text}
        strokeWidth={1.9}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Prices on a bonding curve start far below a cent, so a two-decimal format
 * would render most of this app's markets as "$0.00". Three significant
 * figures keeps the reading true at any magnitude.
 */
function price(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "—";
  // `money` already writes sub-cent prices the way traders do — 0.0₆242 —
  // where `toPrecision` printed "$2.42e-7" in the largest type on the screen.
  return money(value, currency, { compact: false });
}

const Page = styled(SafeAreaView)`
  flex: 1;
  background-color: ${(p) => p.theme.colors.bg};
`;

const Nav = styled.View`
  flex-direction: row;
  align-items: center;
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-bottom: ${(p) => p.theme.space(2)}px;
`;

const NavGrow = styled.View`
  flex: 1;
`;

const Back = styled.Pressable`
  width: 36px;
  height: 36px;
  border-radius: 18px;
  background-color: ${(p) => p.theme.colors.surface};
  align-items: center;
  justify-content: center;
`;

const Loading = styled.View`
  padding-horizontal: ${(p) => p.theme.space(4)}px;
`;

const Padded = styled.View`
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-top: ${(p) => p.theme.space(5)}px;
`;

const Hero = styled.Image`
  width: 100%;
  border-radius: ${(p) => p.theme.radius.lg}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
  margin-bottom: ${(p) => p.theme.space(3)}px;
`;

const PlayOver = styled.View`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: ${(p) => p.theme.space(3)}px;
  align-items: center;
  justify-content: center;
`;

const PlayDisc = styled.View`
  width: 64px;
  height: 64px;
  border-radius: 32px;
  padding-left: 4px;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.45);
  border-width: 1.5px;
  border-color: rgba(255, 255, 255, 0.7);
`;

const Thumb = styled.Image`
  width: 30px;
  height: 30px;
  border-radius: 10px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const IconTap = styled.View`
  padding: 4px;
`;

const Chip = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const ChipMark = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 800;
  color: ${(p) => p.theme.colors.muted};
`;

const ChipText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  letter-spacing: ${(p) => p.theme.type.label.tracking}px;
  color: ${(p) => p.theme.colors.text};
`;

const Band = styled.View`
  flex-direction: row;
  align-items: stretch;
  margin-top: ${(p) => p.theme.space(5)}px;
  padding-vertical: ${(p) => p.theme.space(3)}px;
  border-top-width: ${(p) => p.theme.hairline}px;
  border-bottom-width: ${(p) => p.theme.hairline}px;
  border-color: ${(p) => p.theme.colors.line};
`;

const Cell = styled.View`
  flex: 1;
  gap: 3px;
  padding-horizontal: 4px;
`;

const CellValue = styled.Text`
  font-size: ${(p) => p.theme.type.lead.size}px;
  font-weight: 800;
  font-variant: tabular-nums;
  letter-spacing: ${(p) => p.theme.type.lead.tracking}px;
  color: ${(p) => p.theme.colors.text};
`;

/** A hairline inside a card, where the sheet's own rules do not reach. */
const Split = styled.View`
  height: ${(p) => p.theme.hairline}px;
  background-color: ${(p) => p.theme.colors.line};
  margin-vertical: ${(p) => p.theme.space(4)}px;
`;

const Divider = styled.View`
  width: ${(p) => p.theme.hairline}px;
  background-color: ${(p) => p.theme.colors.line};
`;

const RaisedRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 10px;
  margin-top: ${(p) => p.theme.space(4)}px;
`;

const End = styled.Text`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.muted};
`;

const Track = styled.View`
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background-color: ${(p) => p.theme.colors.line};
  overflow: hidden;
`;

const FillBar = styled.View`
  height: 8px;
  background-color: ${(p) => p.theme.colors.pos};
`;

const TabBar = styled.View`
  flex-direction: row;
  gap: ${(p) => p.theme.space(5)}px;
  margin-top: ${(p) => p.theme.space(5)}px;
  border-bottom-width: ${(p) => p.theme.hairline}px;
  border-bottom-color: ${(p) => p.theme.colors.line};
`;

const TabTap = styled.Pressable`
  padding-bottom: 10px;
`;

const TabLabel = styled.Text<{ $on: boolean }>`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: ${(p) => (p.$on ? 800 : 600)};
  letter-spacing: ${(p) => p.theme.type.label.tracking}px;
  color: ${(p) => (p.$on ? p.theme.colors.text : p.theme.colors.muted)};
`;

const TabRule = styled.View<{ $on: boolean }>`
  height: 2px;
  margin-top: 8px;
  margin-bottom: -1px;
  background-color: ${(p) => (p.$on ? p.theme.colors.text : "transparent")};
`;

const Line = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding-vertical: ${(p) => p.theme.space(3)}px;
  border-bottom-width: ${(p) => p.theme.hairline}px;
  border-bottom-color: ${(p) => p.theme.colors.line};
`;

const Verb = styled.Text<{ $buy: boolean }>`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 800;
  width: 38px;
  color: ${(p) => (p.$buy ? p.theme.colors.pos : p.theme.colors.neg)};
`;

const Rank = styled.Text`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  width: 18px;
  color: ${(p) => p.theme.colors.faint};
`;

const Empty = styled.View`
  padding-vertical: ${(p) => p.theme.space(6)}px;
`;

const SaveSlot = styled.View`
  margin-top: ${(p) => p.theme.space(4)}px;
`;

const Rows = styled.View`
  margin-top: ${(p) => p.theme.space(4)}px;
  border-radius: ${(p) => p.theme.radius.md}px;
  overflow: hidden;
`;

const ClaimBox = styled.View`
  margin-top: 14px;
  padding: 12px;
  border-radius: 16px;
  background-color: ${(p) => p.theme.colors.surface};
`;

const ClaimReceipt = styled.Text`
  margin-top: 4px;
  font-size: 12px;
  font-family: ${Platform.OS === "ios" ? "Menlo" : "monospace"};
  color: ${(p) => p.theme.colors.muted};
`;

const DetailBox = styled.View<{ $shaded: boolean }>`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px ${(p) => p.theme.space(3)}px;
  background-color: ${(p) => (p.$shaded ? p.theme.colors.surfaceAlt : "transparent")};
`;

const DetailValue = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.text};
`;

const LinkTap = styled.Pressable`
  flex-direction: row;
  align-items: center;
  gap: 6px;
  margin-top: ${(p) => p.theme.space(4)}px;
`;

const LinkText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  color: ${(p) => p.theme.colors.focus};
`;

const Actions = styled.View`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  flex-direction: row;
  gap: ${(p) => p.theme.space(3)}px;
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-top: ${(p) => p.theme.space(3)}px;
  /* Clear of the home indicator. */
  padding-bottom: ${(p) => p.theme.space(7)}px;
  background-color: ${(p) => p.theme.colors.bg};
  border-top-width: ${(p) => p.theme.hairline}px;
  border-top-color: ${(p) => p.theme.colors.line};
`;

const PostTap = styled.View`
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 54px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const GraduatedNote = styled.Text`
  flex: 1.4;
  font-size: ${(p) => p.theme.type.label.size}px;
  color: ${(p) => p.theme.colors.muted};
  text-align: center;
  align-self: center;
`;
