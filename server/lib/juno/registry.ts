import "server-only";

import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { junoCurves } from "@/lib/db/schema";
import type { ChainId } from "./chains";

/**
 * The index of curves Juno launched, as the indexer recorded them from
 * `Launched` events. Identity and provenance only; every number that moves
 * is read from the curve contract at request time.
 */

export type CurveRow = typeof junoCurves.$inferSelect;
export type NewCurveRow = typeof junoCurves.$inferInsert;

export async function listCurves(
  chainId: ChainId,
  limit = 60,
  options: { listedOnly?: boolean; trackers?: boolean } = {},
): Promise<CurveRow[]> {
  const filters = [eq(junoCurves.chainId, chainId)];
  if (options.listedOnly) filters.push(eq(junoCurves.listed, true));
  if (options.trackers === true) filters.push(isNotNull(junoCurves.feed));
  return getDb()
    .select()
    .from(junoCurves)
    .where(and(...filters))
    .orderBy(desc(junoCurves.createdAt))
    .limit(limit);
}

export async function listCurvesByCreator(chainId: ChainId, creator: string): Promise<CurveRow[]> {
  return getDb()
    .select()
    .from(junoCurves)
    .where(and(eq(junoCurves.chainId, chainId), eq(junoCurves.creator, creator.toLowerCase())))
    .orderBy(desc(junoCurves.createdAt));
}

/** By token or by curve address — the app may hold either. */
export async function getCurve(address: string, chainId?: ChainId): Promise<CurveRow | null> {
  const key = address.toLowerCase();
  const match = or(eq(junoCurves.token, key), eq(junoCurves.curve, key));
  const [row] = await getDb()
    .select()
    .from(junoCurves)
    .where(chainId === undefined ? match : and(match, eq(junoCurves.chainId, chainId)))
    .limit(1);
  return row ?? null;
}

export async function getCurves(addresses: string[], chainId: ChainId): Promise<CurveRow[]> {
  if (addresses.length === 0) return [];
  const keys = [...new Set(addresses.map((a) => a.toLowerCase()))];
  return getDb()
    .select()
    .from(junoCurves)
    .where(and(eq(junoCurves.chainId, chainId), or(inArray(junoCurves.token, keys), inArray(junoCurves.curve, keys))));
}

/** Every curve address on a chain, for the indexer's log filter. */
export async function knownCurves(chainId: ChainId): Promise<Map<string, CurveRow>> {
  const rows = await getDb().select().from(junoCurves).where(eq(junoCurves.chainId, chainId));
  return new Map(rows.map((row) => [row.curve, row]));
}

export async function countCurves(chainId: ChainId): Promise<number> {
  const rows = await getDb()
    .select({ token: junoCurves.token })
    .from(junoCurves)
    .where(eq(junoCurves.chainId, chainId));
  return rows.length;
}
