import { normAddress } from "@/lib/juno/address";
import { CallerError, junoError, junoHandler, junoJson, junoOptions, readJson, requireNumber, requireString } from "@/lib/juno/api";
import { hydrateCurves } from "@/lib/juno/chain";
import { chainIdFromUrl, deployment, resolveChainId } from "@/lib/juno/chains";
import { getCurve, getCurves } from "@/lib/juno/registry";
import { createPlan, deletePlan, plans, recordContribution, setPlanActive } from "@/lib/juno/social-graph";
import type { Coin } from "@/lib/juno/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * Recurring buys. A plan stores the intent and says when it is due; each buy
 * is the same server-built, device-signed transaction as any other, and
 * `contributed` moves only when one confirms.
 */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    const wallet = normAddress(url.searchParams.get("wallet"), "wallet");
    const rows = await plans(chainId, wallet);
    if (rows.length === 0) return junoJson({ wallet, plans: [], missing: 0 });

    const curves = deployment(chainId) ? await getCurves(rows.map((row) => row.token), chainId) : [];
    const { coins, missing } = curves.length ? await hydrateCurves(curves) : { coins: [] as Coin[], missing: rows.length };
    const priced = new Map(coins.map((coin) => [coin.address, coin]));

    return junoJson({
      wallet,
      missing,
      plans: rows.map((row) => {
        const coin = priced.get(row.token) ?? null;
        return {
          ...row,
          coin: coin
            ? {
                address: coin.address,
                name: coin.name,
                symbol: coin.symbol,
                priceUsd: coin.priceUsd,
                currency: coin.marketCapCurrency,
                // `amount`, `target` and `contributed` are quote units (ETH or USDC).
                quoteSymbol: coin.quote.symbol,
                quoteUsdRate: coin.quoteUsdRate ?? null,
                media: coin.media,
              }
            : null,
        };
      }),
    });
  });
}

/** `POST { chainId, wallet, baseMint|token, amount, cadence, target? }`. */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const chainId = resolveChainId(body.chainId);
    const wallet = normAddress(body.wallet, "wallet");
    const token = normAddress(body.baseMint ?? body.token, "baseMint");
    const amount = requireNumber(body.amount, "amount");
    const cadence = requireString(body.cadence, "cadence");
    if (cadence !== "daily" && cadence !== "weekly" && cadence !== "monthly") {
      throw new CallerError(`Unknown cadence "${cadence}". One of: daily, weekly, monthly`);
    }
    if (!(await getCurve(token, chainId))) throw new CallerError("Coin not found", 404);
    const id = await createPlan({
      chainId,
      wallet,
      token,
      amount,
      cadence,
      target: body.target === undefined || body.target === null ? null : requireNumber(body.target, "target"),
    });
    return junoJson({ id }, { status: 201 });
  });
}

/** `PATCH { id, active }` to pause or resume, or `{ id, contributed }` to record a confirmed fill. */
export async function PATCH(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const id = requireString(body.id, "id");
    if (body.contributed !== undefined) {
      const amount = requireNumber(body.contributed, "contributed");
      if (amount <= 0) return junoError("A contribution must be greater than zero");
      const row = await recordContribution(id, amount);
      if (!row) return junoError("Plan not found", 404);
      return junoJson({ plan: row });
    }
    if (typeof body.active === "boolean") {
      if (!(await setPlanActive(id, body.active))) return junoError("Plan not found", 404);
      return junoJson({ id, active: body.active });
    }
    return junoError("Nothing to change: send `active` or `contributed`");
  });
}

/** `DELETE ?id=`. */
export async function DELETE(request: Request) {
  return junoHandler(async () => {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!id) return junoError("An id is required");
    if (!(await deletePlan(id))) return junoError("Plan not found", 404);
    return junoJson({ id, deleted: true });
  });
}
