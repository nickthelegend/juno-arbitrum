import { junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { chainIdFromUrl, requireDeployment } from "@/lib/juno/chains";
import { loadPortfolio } from "@/lib/juno/portfolio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** What a wallet holds across Juno curves, with cost basis and P&L. */
export async function GET(request: Request, { params }: { params: Promise<{ wallet: string }> }) {
  return junoRead(async () => {
    const { wallet } = await params;
    const chainId = chainIdFromUrl(new URL(request.url));
    requireDeployment(chainId);
    return junoJson(await loadPortfolio(chainId, wallet));
  });
}
