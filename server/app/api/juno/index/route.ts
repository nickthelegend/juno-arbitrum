import { CallerError, junoHandler, junoJson, junoOptions } from "@/lib/juno/api";
import { chainIdFromUrl, requireDeployment } from "@/lib/juno/chains";
import { indexStatus, runIndexer } from "@/lib/juno/indexer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const OPTIONS = junoOptions;

/** `GET ?chainId=` — cursor, chain head and lag. Indexes nothing. */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const chainId = chainIdFromUrl(new URL(request.url));
    requireDeployment(chainId);
    return junoJson(await indexStatus(chainId));
  });
}

/**
 * `POST ?chainId=[&batches=]` — read new `Launched`, `Trade`, claim and
 * graduation logs into Postgres. Idempotent; safe for a cron every 30 s.
 * When `JUNO_INDEX_SECRET` is set, send it as `x-juno-index-secret`.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const secret = process.env.JUNO_INDEX_SECRET;
    if (secret && request.headers.get("x-juno-index-secret") !== secret) {
      throw new CallerError("Not allowed", 401);
    }
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    requireDeployment(chainId);
    const batches = Number(url.searchParams.get("batches"));
    const report = await runIndexer(chainId, {
      maxBatches: Number.isInteger(batches) && batches > 0 ? Math.min(batches, 400) : undefined,
    });
    return junoJson(report);
  });
}
