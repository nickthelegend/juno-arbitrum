/**
 * Take a coin off Juno's listings (feed, markets, stocks, leaderboard), or put
 * it back. The coin itself is untouched: it trades on-chain as before and its
 * page still opens by address. For test launches a visitor should not meet.
 *
 *   npx tsx --env-file=.env.local scripts/list-coin.ts --chain 421614 --unlist 0xtoken [0xtoken...]
 *   npx tsx --env-file=.env.local scripts/list-coin.ts --chain 421614 --list 0xtoken
 */
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../lib/db";
import { junoCurves } from "../lib/db/schema";

const args = process.argv.slice(2);
const chainId = Number(args[args.indexOf("--chain") + 1]);
const listed = args.includes("--list");
if (!Number.isFinite(chainId) || (!listed && !args.includes("--unlist"))) {
  throw new Error("usage: --chain <id> (--list | --unlist) <token...>");
}
const tokens = args
  .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
  .map((a) => a.toLowerCase());
if (tokens.length === 0) throw new Error("name at least one token address");

async function main() {
  const updated = await getDb()
    .update(junoCurves)
    .set({ listed })
    .where(
      and(eq(junoCurves.chainId, chainId), inArray(junoCurves.token, tokens)),
    )
    .returning({
      token: junoCurves.token,
      symbol: junoCurves.symbol,
      name: junoCurves.name,
    });
  for (const row of updated)
    console.log(
      `${listed ? "listed" : "unlisted"} ${row.symbol} (${row.name}) ${row.token}`,
    );
  if (updated.length !== tokens.length)
    console.log(
      `${tokens.length - updated.length} address(es) not found on chain ${chainId}`,
    );
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
