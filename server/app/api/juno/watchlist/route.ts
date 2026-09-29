import { normAddress } from "@/lib/juno/address";
import { CallerError, junoHandler, junoJson, junoOptions, readJson, requireNumber } from "@/lib/juno/api";
import { hydrateCurves } from "@/lib/juno/chain";
import { chainIdFromUrl, deployment, resolveChainId } from "@/lib/juno/chains";
import { getCurve, getCurves } from "@/lib/juno/registry";
import { requireSession } from "@/lib/juno/session";
import { crossed, unwatch, watch, watchlist } from "@/lib/juno/social-graph";
import type { Coin } from "@/lib/juno/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** Coins a wallet is watching, priced, with any alert resolved. `GET ?wallet=`. */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    const wallet = normAddress(url.searchParams.get("wallet"), "wallet");
    const rows = await watchlist(chainId, wallet);
    if (rows.length === 0) return junoJson({ wallet, items: [], missing: 0 });

    const curves = deployment(chainId) ? await getCurves(rows.map((row) => row.token), chainId) : [];
    const { coins, missing } = curves.length
      ? await hydrateCurves(curves)
      : { coins: [] as Coin[], missing: rows.length };
    const priced = new Map(coins.map((coin) => [coin.address, coin]));

    return junoJson({
      wallet,
      missing,
      items: rows.map((row) => {
        const coin = priced.get(row.token) ?? null;
        return {
          baseMint: row.token,
          token: row.token,
          watchedAt: row.createdAt,
          alertPrice: row.alertPrice,
          alertCrossed: coin ? crossed(row, coin.priceUsd) : null,
          coin: coin
            ? {
                address: coin.address,
                name: coin.name,
                symbol: coin.symbol,
                priceUsd: coin.priceUsd,
                marketCap: coin.marketCap,
                currency: coin.marketCapCurrency,
                changePct: coin.marketCapChangePct,
                progress: coin.curve.progress,
                graduated: coin.curve.graduated,
                media: coin.media,
              }
            : null,
        };
      }),
    });
  });
}

/** `POST { chainId, wallet, baseMint|token, watch?: boolean, alertPrice?, priceNow? }`. */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const chainId = resolveChainId(body.chainId);
    const wallet = normAddress(body.wallet, "wallet");
    requireSession(request, wallet);
    const token = normAddress(body.baseMint ?? body.token, "baseMint");

    if (body.watch === false) {
      await unwatch(chainId, wallet, token);
      return junoJson({ baseMint: token, token, watching: false });
    }
    if (!(await getCurve(token, chainId))) throw new CallerError("Coin not found", 404);

    let alert: { price: number; priceNow: number } | null = null;
    if (body.alertPrice !== undefined && body.alertPrice !== null) {
      alert = { price: requireNumber(body.alertPrice, "alertPrice"), priceNow: requireNumber(body.priceNow, "priceNow") };
    }
    await watch(chainId, wallet, token, alert);
    return junoJson({ baseMint: token, token, watching: true, alertPrice: alert?.price ?? null });
  });
}
