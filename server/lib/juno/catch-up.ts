import { after } from "next/server";

import { deployment, type ChainId } from "./chains";
import { runIndexer } from "./indexer";

/**
 * Index on read, for serverless hosting (Vercel), where nothing runs between
 * requests. A feed or coin list schedules one indexer pass after its response
 * is sent, at most every 20 seconds per instance. Passes are idempotent, and
 * `tx/record` already writes a user's own trades the moment they land, so
 * this only catches trades made elsewhere. A GitHub Actions cron hits
 * /api/juno/index every five minutes as a backstop.
 */
const THROTTLE_MS = 20_000;
let last = 0;
let running = false;

export function catchUpAfter(chainId: ChainId): void {
  if (!deployment(chainId) || running || Date.now() - last < THROTTLE_MS) return;
  last = Date.now();
  after(async () => {
    running = true;
    try {
      await runIndexer(chainId);
    } catch (error) {
      console.warn("[juno catch-up]", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  });
}
