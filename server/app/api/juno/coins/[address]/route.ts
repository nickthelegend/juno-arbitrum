import { isAddr } from "@/lib/juno/address";
import { junoError, junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { curveActivity, curveSwaps, holderBook, hydrateCurve } from "@/lib/juno/chain";
import { chainIdFromUrl, explorer, requireDeployment, type ChainId } from "@/lib/juno/chains";
import { crowdFromSwaps } from "@/lib/juno/crowd";
import { readCursor } from "@/lib/juno/indexer";
import { getCurve } from "@/lib/juno/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * One coin, fully hydrated: price, curve, fee schedule, tracker band, chart
 * series, activity, holders and crowd. `[address]` is the token (or the curve).
 */
export async function GET(request: Request, { params }: { params: Promise<{ address: string }> }) {
  return junoRead(async () => {
    const { address } = await params;
    if (!isAddr(address)) return junoError("address is not an address");
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    requireDeployment(chainId);

    const row = await getCurve(address, chainId);
    if (!row) return junoError("Coin not found", 404);

    const coin = await hydrateCurve(row, { detailed: true });
    if (!coin) return junoError("The curve could not be read right now. Try again.", 503);

    const swaps = await curveSwaps(row);
    const rate = coin.quoteUsdRate ?? 1;
    const [book, cursor] = await Promise.all([
      holderBook(row, swaps).catch(() => null),
      readCursor(row.chainId as ChainId).catch(() => null),
    ]);
    if (book) coin.holders = book.holders.length;

    return junoJson({
      chainId,
      coin,
      activity: curveActivity(swaps, rate, 20),
      activityPartial: false,
      crowd: crowdFromSwaps(swaps, false, coin.priceQuote, rate),
      holdersSource: book?.source ?? null,
      holders: book?.holders ?? [],
      holdersUnreadable: book === null,
      launchTxHash: row.txHash,
      launchUrl: explorer.tx(row.chainId as ChainId, row.txHash),
      tokenUrl: explorer.token(row.chainId as ChainId, row.token),
      curveUrl: explorer.address(row.chainId as ChainId, row.curve),
      indexedThroughBlock: cursor,
    });
  });
}
