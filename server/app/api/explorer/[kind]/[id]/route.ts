import { erc20Abi, formatEther, formatUnits, isAddress, isHash } from "viem";

import { junoError, junoHandler, junoJson } from "@/lib/juno/api";
import { LOCAL, isSupportedChain, publicClient } from "@/lib/juno/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A read-only explorer for the local Nitro dev node, which has no Arbiscan:
 * `/api/explorer/tx/{hash}`, `/address/{address}`, `/token/{address}` answer
 * with what the node itself says. The local chain's explorer links point here.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  return junoHandler(async () => {
    if (!isSupportedChain(LOCAL)) return junoError("No local chain on this server", 404);
    const { kind, id } = await params;
    const client = publicClient(LOCAL);
    if (kind === "tx") {
      if (!isHash(id)) return junoError("Not a transaction hash");
      const [tx, receipt] = await Promise.all([client.getTransaction({ hash: id }), client.getTransactionReceipt({ hash: id })]);
      return junoJson({
        chainId: LOCAL,
        hash: id,
        status: receipt.status,
        block: Number(receipt.blockNumber),
        from: tx.from,
        to: tx.to,
        contractAddress: receipt.contractAddress,
        valueEth: formatEther(tx.value),
        gasUsed: receipt.gasUsed.toString(),
        logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })),
      });
    }
    if (kind === "address" || kind === "token") {
      if (!isAddress(id)) return junoError("Not an address");
      const [balance, code, nonce] = await Promise.all([
        client.getBalance({ address: id }),
        client.getCode({ address: id }),
        client.getTransactionCount({ address: id }),
      ]);
      const body: Record<string, unknown> = { chainId: LOCAL, address: id, balanceEth: formatEther(balance), nonce, codeBytes: code ? (code.length - 2) / 2 : 0 };
      if (kind === "token" && code) {
        const [name, symbol, decimals, supply] = await Promise.all(
          (["name", "symbol", "decimals", "totalSupply"] as const).map((functionName) =>
            client.readContract({ address: id, abi: erc20Abi, functionName }).catch(() => null),
          ),
        );
        Object.assign(body, { name, symbol, decimals, totalSupply: supply === null ? null : formatUnits(supply as bigint, Number(decimals ?? 18)) });
      }
      return junoJson(body);
    }
    return junoError("Unknown kind: tx, address or token", 404);
  });
}
