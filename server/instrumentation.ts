/**
 * Optional in-process indexer poll for a long-running server (Railway):
 * with `JUNO_INDEX_INTERVAL_MS` set (e.g. 30000), the app chain is indexed on
 * that interval, so no external cron is needed. Off by default; a failed pass
 * is logged and the next one tries again.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const interval = Number(process.env.JUNO_INDEX_INTERVAL_MS);
  if (!Number.isFinite(interval) || interval < 5_000) return;

  const { appChainId, deployment } = await import("./lib/juno/chains");
  const { runIndexer } = await import("./lib/juno/indexer");
  const chainId = appChainId();
  if (!deployment(chainId)) {
    console.log(`[juno indexer] not deployed on ${chainId}; polling off`);
    return;
  }
  const tick = async () => {
    try {
      const report = await runIndexer(chainId);
      if (report.newRows > 0) {
        console.log(`[juno indexer] ${chainId} to ${report.to}: ${report.newRows} new rows, lag ${report.lag}`);
      }
    } catch (error) {
      console.warn("[juno indexer]", error instanceof Error ? error.message : error);
    }
  };
  setInterval(tick, interval);
  void tick();
  console.log(`[juno indexer] polling chain ${chainId} every ${interval} ms`);
}
