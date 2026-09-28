import { normAddress } from "@/lib/juno/address";
import { CallerError, junoHandler, junoJson, junoOptions, readJson, retryWhenBusy } from "@/lib/juno/api";
import { requireDeployment, resolveChainId } from "@/lib/juno/chains";
import { getCurve } from "@/lib/juno/registry";
import { buildSwap } from "@/lib/juno/tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * Build a buy or a sell.
 * `POST { chainId, curve, trader, side, amountIn?, amountOut?, slippageBps? }`
 * (`curve` may also be the token, as `curve`, `token` or `mint`; `trader` may be `owner`).
 *
 * The curve is looked up in Juno's own index rather than trusted from the
 * caller, so this server never builds a transaction against an arbitrary
 * contract.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const chainId = resolveChainId(body.chainId);
    requireDeployment(chainId);
    const address = normAddress(body.curve ?? body.token ?? body.mint, "curve");
    const trader = normAddress(body.trader ?? body.owner, "trader");
    const side = body.side;
    if (side !== "buy" && side !== "sell") throw new CallerError('"side" must be "buy" or "sell"');
    if (side === "sell" && body.amountOut !== undefined) throw new CallerError("Exact-out is for buys only");
    if (body.amountIn === undefined && body.amountOut === undefined) throw new CallerError('"amountIn" is required');

    const row = await getCurve(address, chainId);
    if (!row) throw new CallerError("Coin not found", 404);

    const build = await retryWhenBusy(() =>
      buildSwap({
        chainId,
        row,
        trader,
        side,
        amountIn: body.amountIn,
        amountOut: body.amountOut,
        slippageBps: body.slippageBps,
      }),
    );
    return junoJson(build);
  });
}
