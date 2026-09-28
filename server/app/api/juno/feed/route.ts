import { maybeAddress } from "@/lib/juno/address";
import { activityFromSwap } from "@/lib/juno/activity";
import { junoError, junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { hydrateCurves } from "@/lib/juno/chain";
import { chainIdFromUrl, deployment, explorer } from "@/lib/juno/chains";
import { identicon } from "@/lib/juno/identicon";
import { shortAddress } from "@/lib/juno/format";
import { mediaKind, mediaSrc } from "@/lib/juno/media";
import { listPosts, replyCounts } from "@/lib/juno/posts";
import { getCurves } from "@/lib/juno/registry";
import { notesForTxHashes } from "@/lib/juno/social";
import { following } from "@/lib/juno/social-graph";
import { toSwaps } from "@/lib/juno/swaps";
import { recentTrades } from "@/lib/juno/trades";
import type { Coin } from "@/lib/juno/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * The social feed: real trades (from the indexer) and creator posts, newest
 * first. `?following=0x…` narrows it to wallets that one follows.
 *
 * Works before the contracts are deployed too — it is then posts only, with
 * `deployed: false`.
 */
export async function GET(request: Request) {
  return junoRead(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 40) || 40, 80);
    const deployed = deployment(chainId) !== null;

    const viewerParam = url.searchParams.get("following");
    let allowed: Set<string> | null = null;
    if (viewerParam !== null) {
      const viewer = maybeAddress(viewerParam);
      if (!viewer) return junoError("`following` needs a wallet address");
      allowed = new Set(await following(chainId, viewer));
    }

    const [trades, posts] = await Promise.all([
      deployed ? recentTrades(chainId, limit * 2) : Promise.resolve([]),
      listPosts(chainId, { limit }),
    ]);

    const mentioned = [
      ...new Set([
        ...trades.map((trade) => trade.curve),
        ...posts.map((post) => post.token).filter((token): token is string => !!token),
      ]),
    ];
    const rows = deployed ? await getCurves(mentioned, chainId) : [];
    const byCurve = new Map(rows.map((row) => [row.curve, row]));
    const byToken = new Map(rows.map((row) => [row.token, row]));
    const { coins } = deployed ? await hydrateCurves(rows) : { coins: [] as Coin[] };
    const live = new Map(coins.map((coin) => [coin.address, coin]));

    const notes = await notesForTxHashes(
      trades.map((trade) => trade.txHash),
      chainId,
    ).catch(() => new Map<string, { body: string }>());

    type Item = Record<string, unknown> & { timestamp: string };
    const items: Item[] = [];

    for (const trade of trades) {
      if (allowed && !allowed.has(trade.trader)) continue;
      const row = byCurve.get(trade.curve);
      if (!row || !row.listed) continue;
      const coin = live.get(row.token);
      const rate = coin?.quoteUsdRate ?? 1;
      const [swap] = toSwaps([trade], row.quoteDecimals);
      const activity = activityFromSwap(swap, rate);
      items.push({
        kind: "trade",
        id: activity.id,
        timestamp: activity.timestamp,
        side: activity.side,
        amount: activity.amount,
        valueUsd: activity.valueUsd,
        price: activity.amount > 0 ? activity.valueUsd / activity.amount : 0,
        priceNow: coin?.priceUsd ?? null,
        currency: coin?.marketCapCurrency ?? "USD",
        txHash: trade.txHash,
        logIndex: trade.logIndex,
        blockNumber: trade.blockNumber,
        txUrl: explorer.tx(chainId, trade.txHash),
        note: notes.get(trade.txHash)?.body ?? null,
        actor: { wallet: trade.trader, ...activity.actor },
        coin: {
          address: row.token,
          name: row.name,
          symbol: row.symbol,
          mediaUrl: mediaSrc(row.mediaUrl),
          mediaKind: mediaKind(row.mediaMime),
          posterUrl: mediaSrc(row.posterUrl),
        },
      });
    }

    const counts = await replyCounts(posts.map((post) => post.id)).catch(() => new Map<string, number>());
    for (const post of posts) {
      if (allowed && !allowed.has(post.authorWallet)) continue;
      const row = post.token ? byToken.get(post.token) : undefined;
      const coin = row ? live.get(row.token) : undefined;
      items.push({
        kind: "post",
        id: post.id,
        timestamp: post.createdAt.toISOString(),
        body: post.body,
        author: {
          wallet: post.authorWallet,
          handle: shortAddress(post.authorWallet, 6, 4),
          avatarUrl: identicon(post.authorWallet),
        },
        mediaUrl: mediaSrc(post.mediaUrl),
        mediaKind: post.mediaMime ? mediaKind(post.mediaMime) : null,
        replyCount: counts.get(post.id) ?? 0,
        coin: row
          ? {
              address: row.token,
              name: row.name,
              symbol: row.symbol,
              priceUsd: coin?.priceUsd ?? null,
              currency: coin?.marketCapCurrency ?? "USD",
              changePct: coin?.marketCapChangePct ?? null,
              progress: coin?.curve.progress ?? null,
              graduated: coin?.curve.graduated ?? false,
              holders: coin?.holders ?? null,
            }
          : null,
      });
    }

    items.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return junoJson({
      chainId,
      deployed,
      items: items.slice(0, limit),
      scope: allowed ? "following" : "everyone",
      followingCount: allowed ? allowed.size : null,
      tradesPartial: false,
    });
  });
}
