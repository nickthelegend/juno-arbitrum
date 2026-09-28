/**
 * Run the indexer from the command line: `npm run index -- [chainId] [--loop]`.
 * With `--loop` it keeps polling every 15 s. Uses the same code as
 * `POST /api/juno/index`.
 */
import { runIndexer } from "../lib/juno/indexer";
import { resolveChainId } from "../lib/juno/chains";

async function main() {
  const args = process.argv.slice(2);
  const chainId = resolveChainId(args.find((arg) => /^\d+$/.test(arg)));
  const loop = args.includes("--loop");
  do {
    const report = await runIndexer(chainId, { maxBatches: 200 });
    console.log(JSON.stringify(report));
    if (loop) await new Promise((resolve) => setTimeout(resolve, report.done ? 15_000 : 500));
  } while (loop);
  process.exit(0);
}

main().catch((error) => {
  console.error("indexer failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
