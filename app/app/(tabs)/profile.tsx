import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Platform, RefreshControl, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import styled from "styled-components/native";

import { AreaChart, RANGES, withinRange, type Range } from "../../components/AreaChart";
import { CoinArt, Identicon } from "../../components/art";
import { Tappable } from "../../components/Press";
import { WalletCard } from "../../components/WalletCard";
import { Handle } from "../../components/Handle";
import {
  Body,
  Button,
  Caption,
  Card,
  Col,
  Delta,
  DeltaBadge,
  Display,
  Entry,
  Heading,
  Label,
  Ledger,
  Mono,
  Pill,
  Placeholder,
  Progress,
  Row,
  Segmented,
  Skeleton,
  Stat,
  Tabs,
} from "../../components/kit";
import { juno, type Plan, type WatchItem } from "../../lib/api";
import { useLinkedState } from "../../lib/linked";
import { money, tokens, useApi } from "../../lib/useApi";
import { PRIVY_ENABLED } from "../../lib/privy";
import { useWallet } from "../../lib/wallet";
import { theme } from "../../theme";

type Tab = "holdings" | "watching" | "plans" | "activity" | "about";

const TABS = [
  { id: "holdings" as const, label: "Holdings" },
  { id: "watching" as const, label: "Watching" },
  { id: "plans" as const, label: "Plans" },
  { id: "activity" as const, label: "Activity" },
  { id: "about" as const, label: "About" },
];

/**
 * Profile and portfolio.
 *
 * Holdings come from chain. Cost does not exist on-chain, so it is derived from
 * this wallet's own decoded trades — which means a position acquired any other
 * way has a balance but no cost, and shows a dash rather than a fabricated
 * zero. A zero cost would imply the whole holding is profit.
 *
 * The value chart is reconstructed the same way: every balance change is a
 * trade, every price is the trade that set it. A point per trade rather than
 * per interval, because no price was observed in between and smoothing across
 * that gap would draw a line through numbers nobody paid.
 */
export default function ProfileScreen() {
  const wallet = useWallet();
  const router = useRouter();
  /* Addressable, for the same reason the market list's segment is: a link, a
     share and a demo all want to land on a view rather than on a tap. */
  const [tab, setTab] = useLinkedState<Tab>(
    "tab",
    TABS.map((option) => option.id),
    "holdings",
  );

  /*
   * Watchlist and plans are fetched only while their tab is open.
   *
   * Both price their coins against the chain, and paying for two more pool
   * walks every time someone opens their profile to look at holdings would
   * make the common case slower to serve the uncommon one.
   */
  const watching = useApi(
    () =>
      tab === "watching" && wallet.address
        ? juno.watchlist(wallet.address)
        : Promise.resolve(null),
    [tab, wallet.address],
  );
  const savings = useApi(
    () =>
      tab === "plans" && wallet.address ? juno.plans(wallet.address) : Promise.resolve(null),
    [tab, wallet.address],
  );
  const [range, setRange] = useState<Range>("ALL");

  const portfolio = useApi(
    async () => (wallet.address ? juno.portfolio(wallet.address) : null),
    [wallet.address],
  );

  const data = portfolio.data;
  const currency = data?.currency === "mixed" ? "USD" : (data?.currency ?? "USD");

  /*
   * P&L, or null when there is nothing to stand behind.
   *
   * `totalPnl` is already null when a holding has no recorded cost. The case
   * it does not cover is a partial walk that found no positions at all: the
   * sum over an empty list is zero, and zero here reads as "you are flat"
   * rather than "we did not finish looking".
   */
  const pnl =
    !data || data.totalPnl === null || (data.partial && data.positions.length === 0)
      ? null
      : data.totalPnl;

  const series = useMemo(
    () => withinRange(data?.history ?? [], range),
    [data?.history, range],
  );

  const volumes = useMemo(() => {
    if (!data) return [];
    const byTime = new Map<string, number>();
    for (const position of data.positions) {
      for (const trade of position.trades) {
        byTime.set(trade.t, (byTime.get(trade.t) ?? 0) + trade.base * trade.price);
      }
    }
    return series.map((point) => byTime.get(point.t) ?? 0);
  }, [data, series]);

  if (!wallet.ready) {
    return (
      <Page edges={["top"]}>
        <Padded>
          <Skeleton h={160} round={26} />
        </Padded>
      </Page>
    );
  }

  if (!wallet.address) {
    return (
      <Page edges={["top"]}>
        <Placeholder
          title="No wallet yet"
          detail={
            PRIVY_ENABLED
              ? "Sign in with your email. Privy creates a Solana wallet for you, with no seed phrase."
              : "Create one to trade and to launch your own coins. No sign-up."
          }
          action={
            // Not `.then(portfolio.refresh)`: that refresh was captured before
            // the wallet existed, re-ran the read with no address, and its
            // null landed last — "Holdings could not be read" on a wallet
            // created a second ago. The address change re-reads on its own.
            <Button
              label={PRIVY_ENABLED ? "Continue with email" : "Create wallet"}
              onPress={() => void wallet.connect().catch(() => undefined)}
            />
          }
        />
      </Page>
    );
  }


  return (
    <Page edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 130, gap: 14 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={portfolio.refreshing}
            onRefresh={portfolio.refresh}
            tintColor={theme.colors.muted}
          />
        }
      >
        {/* Identity, as in the profile reference: avatar, handle, address. */}
        <Identity>
          <Identicon seed={wallet.address} size={72} />
          <Heading>
            <Handle wallet={wallet.address} />
          </Heading>
          <Caption>{wallet.mode === "local" ? "Device key · devnet" : "Privy wallet · devnet"}</Caption>
        </Identity>

        <WalletCard address={wallet.address} />

        {/*
          One statement, not two cards.

          This was the hero-metric template: a three-up stat card, then a second
          identical card with a big number and a badge. Two containers of the
          same shape saying one thing, with the supporting figures *above* the
          figure they support.

          It is one sheet now, and it reads in the order someone asks the
          questions: what is it worth, how has it moved, what is it made of.
          The three figures sit under the value they belong to, ruled off — the
          same ledger the rest of the app is set in.

          Three states, not two. `data` undefined is a read that failed.
          `data.partial` with nothing found is a read that did not finish
          looking, and "0 Positions, 0 Trades, $0" beside a badge admitting some
          history could not be read is the screen contradicting itself. Only a
          complete read of an empty wallet earns a zero.
        */}
        <Ledger>
          <Entry $first>
            <Centered>
              <Caption>Portfolio</Caption>
              {portfolio.loading ? (
                <Skeleton h={42} w="60%" />
              ) : (
                // A wallet holding nothing really is worth $0 and should say
                // so. A wallet whose pools could not all be read is not, and
                // must not — the server nulls `totalValue` in exactly that case.
                <Display>
                  {data && data.totalValue !== null
                    ? money(data.totalValue, currency, { compact: false })
                    : "—"}
                </Display>
              )}
              <DeltaBadge pct={data?.totalPnlPct ?? null} />
            </Centered>

            <RangeRow>
              <Segmented items={RANGES} value={range} onChange={setRange} />
            </RangeRow>

            <AreaChart
              points={series}
              bars={volumes}
              format={(v) => money(v, currency, { compact: true })}
              emptyLabel={
                data?.partial
                  ? "Some pools would not load — history unknown."
                  : undefined
              }
            />
          </Entry>

          <Entry>
            <Row>
              <Stat value={counted(data?.positions.length, data?.partial)} label="Positions" />
              <Stat
                value={pnl === null ? "—" : money(pnl, currency)}
                // Zero is neither a gain nor a loss, and it was rendering green.
                tone={pnl === null || pnl === 0 ? undefined : pnl > 0 ? "pos" : "neg"}
                label="P&L"
              />
              <Stat value={counted(data?.history.length, data?.partial)} label="Trades" />
            </Row>
          </Entry>
        </Ledger>

        {data?.partial ? (
          <Pill
            label={
              data.positions.length === 0
                ? "Some pools could not be read — holdings unknown"
                : "Some pools could not be read — this may not be everything"
            }
            tone="neg"
          />
        ) : null}

        <Tabs items={TABS} value={tab} onChange={setTab} />

        {tab === "holdings" ? (
          portfolio.loading ? (
            <Card>
              <Skeleton h={16} w="70%" />
            </Card>
          ) : portfolio.error ? (
            <Card>
              <Body style={{ color: theme.colors.neg }}>{portfolio.error}</Body>
            </Card>
          ) : !data ? (
            <Card>
              <Body muted>Holdings could not be read.</Body>
            </Card>
          ) : data.positions.length === 0 ? (
            <Card>
              <Body muted>
                {data.partial
                  ? "Some pools would not load, so whether this wallet holds anything is unknown. Pull to retry."
                  : "Nothing held yet. Buy a coin from the Trade tab and it shows up here."}
              </Body>
            </Card>
          ) : (
            data!.positions.map((position) => (
              // A holding opens its coin, as a watched coin and a plan do.
              <Tappable
                key={position.baseMint}
                onPress={() => router.push(`/coin/${position.baseMint}` as never)}
                to={0.985}
              >
              <Card>
                <Row gap={12}>
                  <Identicon seed={position.baseMint} size={38} />
                  <Col gap={3} style={{ flex: 1 }}>
                    <Label style={{ fontWeight: "700" }} numberOfLines={1}>
                      {position.name}
                    </Label>
                    <Caption>
                      {tokens(position.balance)} ${position.symbol}
                    </Caption>
                  </Col>
                  <Col gap={3} style={{ alignItems: "flex-end" }}>
                    <Mono>{money(position.value, position.currency)}</Mono>
                    <Delta pct={position.unrealisedPnlPct} />
                  </Col>
                </Row>
                <Caption style={{ marginTop: 8 }}>
                  {position.averageCost === null
                    ? "No recorded cost for this holding"
                    : `Avg cost ${money(position.averageCost, position.currency, { compact: false })}`}
                </Caption>
              </Card>
              </Tappable>
            ))
          )
        ) : tab === "watching" ? (
          <WatchingTab
            state={watching}
            onOpen={(mint) => router.push(`/coin/${mint}`)}
          />
        ) : tab === "plans" ? (
          <PlansTab state={savings} onOpen={(mint) => router.push(`/coin/${mint}`)} />
        ) : tab === "activity" ? (
          (data?.positions ?? []).flatMap((p) =>
            p.trades.map((t) => ({ ...t, name: p.name, symbol: p.symbol, currency: p.currency })),
          ).length === 0 ? (
            <Card>
              <Body muted>No trades yet.</Body>
            </Card>
          ) : (
            (data?.positions ?? [])
              .flatMap((p) =>
                p.trades.map((t) => ({ ...t, name: p.name, symbol: p.symbol, currency: p.currency })),
              )
              .sort((a, b) => Date.parse(b.t) - Date.parse(a.t))
              .slice(0, 20)
              .map((trade, i) => (
                <Card key={`${trade.t}-${i}`}>
                  <Row gap={10}>
                    <Side $buy={trade.side === "buy"}>{trade.side}</Side>
                    <Label numberOfLines={1} style={{ flex: 1 }}>
                      {trade.name}
                    </Label>
                    <Mono muted>{tokens(trade.base)}</Mono>
                  </Row>
                  <Caption style={{ marginTop: 6 }}>
                    at {money(trade.price, trade.currency, { compact: false })} ·{" "}
                    {new Date(trade.t).toLocaleString()}
                  </Caption>
                </Card>
              ))
          )
        ) : (
          <Card>
            <Body muted>
              {Platform.OS === "web"
                ? "This wallet lives in this browser's storage and signs here. It is a devnet key and is not recoverable — clearing site data deletes it, and Juno never sees it."
                : "This wallet lives in the device keychain and signs on-device. It is a devnet key and is not recoverable — Juno never sees it."}
            </Body>
          </Card>
        )}
      </ScrollView>
    </Page>
  );
}


/**
 * Coins this wallet is keeping an eye on, and whether an alert has fired.
 *
 * The rows come from Postgres and are always complete; the prices come from the
 * chain and may not be. A coin that could not be priced keeps its row and says
 * so rather than disappearing from a list the person themselves built.
 */
function WatchingTab({
  state,
  onOpen,
}: {
  state: ReturnType<typeof useApi<{ items: WatchItem[]; missing: number } | null>>;
  onOpen: (mint: string) => void;
}) {
  if (state.loading) {
    return (
      <Ledger>
        {[0, 1].map((i) => (
          <Entry key={i} $first={i === 0}>
            <Row gap={12}>
              <Skeleton h={40} w={40} round={14} />
              <Skeleton h={14} w="45%" />
            </Row>
          </Entry>
        ))}
      </Ledger>
    );
  }
  if (state.error) {
    return (
      <Placeholder
        title="Could not load your watchlist"
        detail={state.error}
        action={<Button label="Try again" onPress={state.refresh} />}
      />
    );
  }

  const items = state.data?.items ?? [];
  if (items.length === 0) {
    return (
      <Card>
        <Body muted>
          Nothing watched yet. Star a coin from its page and it appears here with
          whatever alert you set on it.
        </Body>
      </Card>
    );
  }

  return (
    <Ledger>
      {items.map((item, index) => (
        <Tappable key={item.baseMint} onPress={() => onOpen(item.baseMint)} to={0.985}>
          <Entry $first={index === 0}>
            <Row gap={12}>
              <CoinArt
                uri={item.coin ? juno.still(item.coin.media) : null}
                seed={item.baseMint}
                size={40}
                radius={14}
              />
              <Col gap={2} style={{ flex: 1 }}>
                <Label style={{ fontWeight: "700" }} numberOfLines={1}>
                  {item.coin?.name ?? "Could not be priced"}
                </Label>
                <Caption>
                  {item.coin ? `$${item.coin.symbol}` : "The RPC would not serve this pool"}
                </Caption>
              </Col>
              <Col gap={2} style={{ alignItems: "flex-end" }}>
                <Mono>
                  {item.coin ? money(item.coin.priceUsd, item.coin.currency, { compact: false }) : "—"}
                </Mono>
                <Delta pct={item.coin?.changePct ?? null} />
              </Col>
            </Row>

            {item.alertPrice !== null ? (
              <Row gap={6} style={{ marginTop: 10 }}>
                {/* Fired, not yet, or unknown — three states, because an alert
                    cannot be judged against a price nobody read. */}
                <Pill
                  label={
                    item.alertCrossed === null
                      ? `Alert at ${money(item.alertPrice, "USD", { compact: false })}`
                      : item.alertCrossed === "up"
                        ? `Crossed above ${money(item.alertPrice, "USD", { compact: false })}`
                        : `Fell below ${money(item.alertPrice, "USD", { compact: false })}`
                  }
                  tone={item.alertCrossed === "up" ? "pos" : item.alertCrossed === "down" ? "neg" : "neutral"}
                />
              </Row>
            ) : null}
          </Entry>
        </Tappable>
      ))}
    </Ledger>
  );
}

/**
 * Recurring buys.
 *
 * Deliberately not a bot: executing a swap for someone needs a delegate this
 * project does not have, so a plan says what it is for and when it is due and
 * the buy is the same device-signed transaction as any other. `contributed`
 * only moves after a swap confirms, so the bar is a record of transactions
 * rather than of intentions.
 */
function PlansTab({
  state,
  onOpen,
}: {
  state: ReturnType<typeof useApi<{ plans: Plan[]; missing: number } | null>>;
  onOpen: (mint: string) => void;
}) {
  if (state.loading) {
    return (
      <Ledger>
        <Entry $first>
          <Skeleton h={14} w="50%" />
          <Skeleton h={10} w="100%" style={{ marginTop: 14 }} />
        </Entry>
      </Ledger>
    );
  }
  if (state.error) {
    return (
      <Placeholder
        title="Could not load your plans"
        detail={state.error}
        action={<Button label="Try again" onPress={state.refresh} />}
      />
    );
  }

  const rows = state.data?.plans ?? [];
  if (rows.length === 0) {
    return (
      <Card>
        <Body muted>
          No recurring buys yet. Set one from a coin&rsquo;s page to put the same
          amount in every week — it tells you when it is due and you sign each one.
        </Body>
      </Card>
    );
  }

  return (
    <Ledger>
      {rows.map((plan, index) => {
        const pct =
          plan.target && plan.target > 0
            ? Math.max(0, Math.min(1, plan.contributed / plan.target))
            : null;
        return (
          <Tappable key={plan.id} onPress={() => onOpen(plan.baseMint)} to={0.985}>
            <Entry $first={index === 0}>
              <Row gap={10}>
                <Col gap={2} style={{ flex: 1 }}>
                  <Label style={{ fontWeight: "700" }} numberOfLines={1}>
                    {plan.coin?.name ?? "Could not be priced"}
                  </Label>
                  <Caption>
                    {planAmount(plan, plan.amount)} {plan.cadence}
                    {plan.fills > 0 ? ` · ${plan.fills} ${plan.fills === 1 ? "fill" : "fills"}` : ""}
                  </Caption>
                </Col>
                <Pill
                  label={!plan.active ? "Paused" : plan.due ? "Due now" : "Scheduled"}
                  tone={!plan.active ? "neutral" : plan.due ? "lime" : "neutral"}
                />
              </Row>

              {pct !== null ? (
                <Col gap={6} style={{ marginTop: 12 }}>
                  <Progress pct={pct * 100} />
                  <Caption>
                    {planAmount(plan, plan.contributed)} of {planAmount(plan, plan.target!)}{" "}
                    contributed
                  </Caption>
                </Col>
              ) : (
                <Caption style={{ marginTop: 10 }}>
                  {planAmount(plan, plan.contributed)} contributed so far
                </Caption>
              )}
            </Entry>
          </Tappable>
        );
      })}
    </Ledger>
  );
}

/**
 * A plan figure in the unit it is actually denominated in.
 *
 * Amounts, targets and contributions are quote-token units, because that is
 * what the swap is signed for. Rendering 5 SOL as "$5.00" — which this screen
 * did — is wrong by whatever SOL costs. The dollar figure follows in
 * parentheses only when a feed gave us a rate; without one it is simply absent
 * rather than assumed to be one-to-one.
 */
function planAmount(plan: Plan, value: number): string {
  const symbol = plan.coin?.quoteSymbol;
  if (!symbol) return tokens(value);
  const unit = `${tokens(value)} ${symbol}`;
  const rate = plan.coin?.quoteUsdRate ?? null;
  if (rate === null || value === 0) return unit;
  return `${unit} (${money(value * rate, "USD", { compact: false })})`;
}

const Page = styled(SafeAreaView)`
  flex: 1;
  background-color: ${(p) => p.theme.colors.bg};
`;

const Padded = styled.View`
  padding: ${(p) => p.theme.space(4)}px;
`;

const Identity = styled.View`
  align-items: center;
  gap: 6px;
  padding-top: ${(p) => p.theme.space(2)}px;
`;

const Centered = styled.View`
  align-items: center;
  gap: ${(p) => p.theme.space(1)}px;
`;

const RangeRow = styled.View`
  align-items: center;
  margin-vertical: ${(p) => p.theme.space(3)}px;
`;

const Side = styled.Text<{ $buy: boolean }>`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  text-transform: capitalize;
  width: 38px;
  color: ${(p) => (p.$buy ? p.theme.colors.pos : p.theme.colors.neg)};
`;

/**
 * A count, or a dash when nobody finished counting.
 *
 * Undefined is a read that failed outright. Zero from a *partial* read is the
 * subtler case and the one that shipped: the walk stopped early and found
 * nothing, which is not the same as there being nothing. A non-zero count from
 * a partial read is still a real count of real positions — a floor, and the
 * badge under this row says so.
 */
function counted(value: number | undefined, partial: boolean | undefined): string {
  if (value === undefined) return "—";
  if (value === 0 && partial) return "—";
  return String(value);
}
