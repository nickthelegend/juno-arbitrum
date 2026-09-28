import { junoJson } from "@/lib/juno/api";
import { getPgPool } from "@/lib/db/pool";
import { deployment, publicClient, SUPPORTED_CHAINS, usingPublicRpc, appChainId } from "@/lib/juno/chains";
import { FAUCET_FLOOR, faucetAccount } from "@/lib/juno/faucet";
import { readCursor } from "@/lib/juno/indexer";
import { db } from "@/lib/juno/social";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function timed<T>(run: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; error?: string }> {
  const started = Date.now();
  try {
    const value = await run();
    return { ok: true, ms: Date.now() - started, value };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

/** Database, Mongo, RPC per chain, indexer lag and faucet balance. 503 when a core dependency is down. */
export async function GET() {
  const [postgres, mongo, chains, faucet] = await Promise.all([
    timed(async () => (await getPgPool().query("select 1")).rowCount),
    timed(async () => (await db()).command({ ping: 1 }).then(() => true)),
    Promise.all(
      SUPPORTED_CHAINS.map(async (chainId) => {
        const head = await timed(async () => Number(await publicClient(chainId).getBlockNumber()));
        const cursor = deployment(chainId) ? await readCursor(chainId).catch(() => null) : null;
        return {
          chainId,
          rpc: { ok: head.ok, ms: head.ms, error: head.error, publicEndpoint: usingPublicRpc(chainId) },
          head: head.value ?? null,
          deployed: deployment(chainId) !== null,
          indexer: {
            lastBlock: cursor,
            lag: cursor !== null && head.value !== undefined ? Math.max(0, head.value - cursor) : null,
          },
        };
      }),
    ),
    timed(async () => {
      const account = faucetAccount();
      const balance = await publicClient(421614).getBalance({ address: account.address });
      return { address: account.address.toLowerCase(), balanceEth: Number(balance) / 1e18, funded: balance >= FAUCET_FLOOR };
    }),
  ]);

  const app = chains.find((chain) => chain.chainId === appChainId());
  const ok = postgres.ok && mongo.ok && !!app?.rpc.ok;
  return junoJson(
    {
      ok,
      appChainId: appChainId(),
      postgres: { ok: postgres.ok, ms: postgres.ms, error: postgres.error },
      mongo: { ok: mongo.ok, ms: mongo.ms, error: mongo.error },
      chains,
      // The faucet refuses to send below FAUCET_FLOOR, so an underfunded one is not ok.
      faucet: faucet.ok
        ? { ok: faucet.value!.funded, ...faucet.value, error: faucet.value!.funded ? undefined : `below ${Number(FAUCET_FLOOR) / 1e18} ETH; fund ${faucet.value!.address}` }
        : { ok: false, error: faucet.error },
    },
    { status: ok ? 200 : 503 },
  );
}
