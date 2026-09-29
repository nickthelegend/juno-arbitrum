import { addressList } from "@/lib/juno/address";
import { junoHandler, junoJson, junoOptions, readJson, requireString } from "@/lib/juno/api";
import { chainIdFromUrl, resolveChainId } from "@/lib/juno/chains";
import { claimName, namesFor } from "@/lib/juno/profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** `GET ?wallets=a,b,c` — names for up to 100 wallets. Wallets without one are absent. */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const url = new URL(request.url);
    const wallets = addressList(url.searchParams.get("wallets"), "wallets", 100);
    return junoJson({ names: await namesFor(wallets, chainIdFromUrl(url)) });
  });
}

/**
 * `POST { chainId, wallet, name, issuedAt, signature }` — claim or change a
 * name. `signature` is an EIP-191 `personal_sign` (0x hex) over exactly
 * `Juno name: ${name}\nWallet: ${lowercaseAddress}\nIssued: ${issuedAt}`,
 * accepted within 10 minutes of `issuedAt`.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const result = await claimName(resolveChainId(body.chainId), {
      wallet: requireString(body.wallet, "wallet"),
      name: requireString(body.name, "name"),
      issuedAt: requireString(body.issuedAt, "issuedAt"),
      signature: requireString(body.signature, "signature"),
    });
    return junoJson(result);
  });
}
