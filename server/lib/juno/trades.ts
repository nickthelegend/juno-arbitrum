import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { junoTrades } from "@/lib/db/schema";
import type { ChainId } from "./chains";
import type { TradeRecord } from "./swaps";

/** Trades recorded by the indexer, read back. Newest first everywhere. */

export type TradeRow = typeof junoTrades.$inferSelect;

export async function tradesForCurves(
  curves: string[],
  limit = 20_000,
): Promise<Map<string, TradeRecord[]>> {
  const out = new Map<string, TradeRecord[]>();
  if (curves.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(junoTrades)
    .where(inArray(junoTrades.curve, [...new Set(curves.map((c) => c.toLowerCase()))]))
    .orderBy(desc(junoTrades.blockNumber), desc(junoTrades.logIndex))
    .limit(limit);
  for (const row of rows) {
    const list = out.get(row.curve) ?? [];
    list.push(row);
    out.set(row.curve, list);
  }
  return out;
}

export async function tradesForCurve(curve: string, limit = 5_000): Promise<TradeRecord[]> {
  return (await tradesForCurves([curve], limit)).get(curve.toLowerCase()) ?? [];
}

export async function recentTrades(chainId: ChainId, limit = 80): Promise<TradeRow[]> {
  return getDb()
    .select()
    .from(junoTrades)
    .where(eq(junoTrades.chainId, chainId))
    .orderBy(desc(junoTrades.blockNumber), desc(junoTrades.logIndex))
    .limit(limit);
}

export async function tradesByTrader(chainId: ChainId, trader: string): Promise<TradeRow[]> {
  return getDb()
    .select()
    .from(junoTrades)
    .where(and(eq(junoTrades.chainId, chainId), eq(junoTrades.trader, trader.toLowerCase())))
    .orderBy(desc(junoTrades.blockNumber), desc(junoTrades.logIndex));
}
