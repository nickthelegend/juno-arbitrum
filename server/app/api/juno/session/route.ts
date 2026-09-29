import { junoHandler, junoJson, junoOptions, readJson } from "@/lib/juno/api";
import { resolveChainId } from "@/lib/juno/chains";
import { openSession, readSession } from "@/lib/juno/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `POST { chainId, wallet, issuedAt, signature }` → `{ token, wallet, expiresAt }`.
 * `signature` is an EIP-191 `personal_sign` over exactly
 * `Juno session\nWallet: ${lowercaseAddress}\nIssued: ${issuedAt}`, accepted
 * within 10 minutes of `issuedAt`. Social writes send the token as
 * `Authorization: Bearer <token>`.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const session = await openSession({
      chainId: resolveChainId(body.chainId),
      wallet: body.wallet,
      issuedAt: body.issuedAt,
      signature: body.signature,
    });
    return junoJson(session, { status: 201 });
  });
}

/** `GET` with a bearer token → the session it carries, or 401. */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const session = readSession(request);
    if (!session) return junoJson({ error: "No valid session", reason: "NoSession" }, { status: 401 });
    return junoJson(session);
  });
}
