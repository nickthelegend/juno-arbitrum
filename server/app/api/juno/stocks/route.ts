import { junoError, junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { hydrateCurves } from "@/lib/juno/chain";
import { chainIdFromUrl, chainName, deployment, stockFeeds } from "@/lib/juno/chains";
import { stockReferences } from "@/lib/juno/chainlink";
import { listCurves } from "@/lib/juno/registry";
import type { Coin } from "@/lib/juno/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * The Chainlink stock references and the trackers held to each, as a plain
 * array: `[{ symbol, name, feed, price, updatedAt, ageSeconds, marketOpen,
 * trackers: Coin[] }]`.
 *
 * The references are live even before Juno is deployed on a chain (Arbitrum
 * One has real feeds); trackers need the factory.
 */
export async function GET(request: Request) {
  return junoRead(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    if (stockFeeds(chainId).length === 0) {
      return junoError(`Stock feeds are not deployed on this chain yet (${chainName(chainId)}, ${chainId}).`, 503, {
        chainId,
        deployed: false,
      });
    }

    const references = await stockReferences(chainId);
    let trackers: Coin[] = [];
    if (deployment(chainId)) {
      const rows = await listCurves(chainId, 100, { listedOnly: true, trackers: true });
      trackers = (await hydrateCurves(rows, { nav: true })).coins;
    }

    return junoJson(
      references.map((reference) => ({
        ...reference,
        trackers: trackers.filter((coin) => coin.reference?.feed === reference.feed),
      })),
    );
  });
}
