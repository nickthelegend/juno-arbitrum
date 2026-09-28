import "server-only";

import { and, count, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { junoFollows, junoPlans, junoWatchlist } from "@/lib/db/schema";
import { maybeAddress, normAddress } from "./address";
import { CallerError } from "./api";
import type { ChainId } from "./chains";

/**
 * The social graph and the savings shelf: who you follow, what you watch,
 * and what you committed to buy on a schedule. Chain-scoped throughout, and
 * every address is validated (and lowercased) here, at the one place every
 * caller passes through.
 */

/* ------------------------------------------------------------------ */
/* Follows                                                             */
/* ------------------------------------------------------------------ */

export async function follow(chainId: ChainId, followerInput: string, targetInput: string): Promise<void> {
  const follower = normAddress(followerInput, "follower");
  const target = normAddress(targetInput, "target");
  if (follower === target) throw new CallerError("A wallet cannot follow itself");
  await getDb()
    .insert(junoFollows)
    .values({ followerWallet: follower, targetWallet: target, chainId })
    .onConflictDoNothing();
}

export async function unfollow(chainId: ChainId, followerInput: string, targetInput: string): Promise<void> {
  const follower = normAddress(followerInput, "follower");
  const target = normAddress(targetInput, "target");
  await getDb()
    .delete(junoFollows)
    .where(
      and(eq(junoFollows.followerWallet, follower), eq(junoFollows.targetWallet, target), eq(junoFollows.chainId, chainId)),
    );
}

export async function following(chainId: ChainId, walletInput: string): Promise<string[]> {
  const wallet = normAddress(walletInput, "wallet");
  const rows = await getDb()
    .select({ target: junoFollows.targetWallet })
    .from(junoFollows)
    .where(and(eq(junoFollows.followerWallet, wallet), eq(junoFollows.chainId, chainId)))
    .orderBy(desc(junoFollows.createdAt));
  return rows.map((row) => row.target);
}

export async function followStats(
  chainId: ChainId,
  walletInput: string,
  viewerInput?: string | null,
): Promise<{ followers: number; following: number; viewerFollows: boolean | null }> {
  const wallet = normAddress(walletInput, "wallet");
  const viewer = maybeAddress(viewerInput);
  const db = getDb();
  const [followers, follows] = await Promise.all([
    db.select({ n: count() }).from(junoFollows).where(and(eq(junoFollows.targetWallet, wallet), eq(junoFollows.chainId, chainId))),
    db.select({ n: count() }).from(junoFollows).where(and(eq(junoFollows.followerWallet, wallet), eq(junoFollows.chainId, chainId))),
  ]);

  // Null, not false, when there is no viewer: "you do not follow them" and
  // "nobody is signed in" are different answers.
  let viewerFollows: boolean | null = null;
  if (viewer) {
    const [hit] = await db
      .select({ n: count() })
      .from(junoFollows)
      .where(
        and(eq(junoFollows.followerWallet, viewer), eq(junoFollows.targetWallet, wallet), eq(junoFollows.chainId, chainId)),
      );
    viewerFollows = (hit?.n ?? 0) > 0;
  }
  return { followers: followers[0]?.n ?? 0, following: follows[0]?.n ?? 0, viewerFollows };
}

export async function followerCounts(chainId: ChainId, wallets: string[]): Promise<Map<string, number>> {
  if (wallets.length === 0) return new Map();
  const rows = await getDb()
    .select({ target: junoFollows.targetWallet, n: count() })
    .from(junoFollows)
    .where(and(eq(junoFollows.chainId, chainId), inArray(junoFollows.targetWallet, wallets)))
    .groupBy(junoFollows.targetWallet);
  return new Map(rows.map((row) => [row.target, row.n]));
}

/* ------------------------------------------------------------------ */
/* Watchlist                                                           */
/* ------------------------------------------------------------------ */

export type WatchRow = {
  baseMint: string;
  token: string;
  alertPrice: number | null;
  alertSetAtPrice: number | null;
  createdAt: string;
};

export async function watch(
  chainId: ChainId,
  walletInput: string,
  tokenInput: string,
  alert?: { price: number; priceNow: number } | null,
): Promise<void> {
  const wallet = normAddress(walletInput, "wallet");
  const token = normAddress(tokenInput, "baseMint");
  if (alert && (!Number.isFinite(alert.price) || alert.price <= 0)) {
    throw new CallerError("An alert price must be greater than zero");
  }
  await getDb()
    .insert(junoWatchlist)
    .values({ wallet, token, chainId, alertPrice: alert?.price ?? null, alertSetAtPrice: alert?.priceNow ?? null })
    .onConflictDoUpdate({
      target: [junoWatchlist.wallet, junoWatchlist.token, junoWatchlist.chainId],
      set: { alertPrice: alert?.price ?? null, alertSetAtPrice: alert?.priceNow ?? null },
    });
}

export async function unwatch(chainId: ChainId, walletInput: string, tokenInput: string): Promise<void> {
  const wallet = normAddress(walletInput, "wallet");
  const token = normAddress(tokenInput, "baseMint");
  await getDb()
    .delete(junoWatchlist)
    .where(and(eq(junoWatchlist.wallet, wallet), eq(junoWatchlist.token, token), eq(junoWatchlist.chainId, chainId)));
}

export async function watchlist(chainId: ChainId, walletInput: string): Promise<WatchRow[]> {
  const wallet = normAddress(walletInput, "wallet");
  const rows = await getDb()
    .select()
    .from(junoWatchlist)
    .where(and(eq(junoWatchlist.wallet, wallet), eq(junoWatchlist.chainId, chainId)))
    .orderBy(desc(junoWatchlist.createdAt));
  return rows.map((row) => ({
    baseMint: row.token,
    token: row.token,
    alertPrice: row.alertPrice,
    alertSetAtPrice: row.alertSetAtPrice,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Which way an alert fired, derived from the price it was set against. */
export function crossed(row: Pick<WatchRow, "alertPrice" | "alertSetAtPrice">, priceNow: number): "up" | "down" | null {
  if (row.alertPrice === null || row.alertSetAtPrice === null) return null;
  if (!Number.isFinite(priceNow)) return null;
  const wantsUp = row.alertPrice > row.alertSetAtPrice;
  if (wantsUp && priceNow >= row.alertPrice) return "up";
  if (!wantsUp && priceNow <= row.alertPrice) return "down";
  return null;
}

/* ------------------------------------------------------------------ */
/* Recurring buys                                                      */
/* ------------------------------------------------------------------ */

export type PlanRow = {
  id: string;
  baseMint: string;
  token: string;
  amount: number;
  cadence: "daily" | "weekly" | "monthly";
  target: number | null;
  contributed: number;
  fills: number;
  lastFilledAt: string | null;
  nextDueAt: string;
  due: boolean;
  active: boolean;
  createdAt: string;
};

const CADENCE_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
} as const;

export async function createPlan(input: {
  chainId: ChainId;
  wallet: string;
  token: string;
  amount: number;
  cadence: "daily" | "weekly" | "monthly";
  target?: number | null;
}): Promise<string> {
  const wallet = normAddress(input.wallet, "wallet");
  const token = normAddress(input.token, "baseMint");
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new CallerError("A plan needs an amount greater than zero");
  if (input.target !== undefined && input.target !== null) {
    if (!Number.isFinite(input.target) || input.target <= 0) throw new CallerError("A target must be greater than zero");
    if (input.target < input.amount) throw new CallerError("A target must be at least one contribution");
  }
  const id = crypto.randomUUID().replace(/-/g, "");
  await getDb().insert(junoPlans).values({
    id,
    wallet,
    token,
    chainId: input.chainId,
    amount: input.amount,
    cadence: input.cadence,
    target: input.target ?? null,
  });
  return id;
}

function shapePlan(row: typeof junoPlans.$inferSelect, now: number): PlanRow {
  const since = row.lastFilledAt?.getTime() ?? null;
  const nextDue = since === null ? now : since + CADENCE_MS[row.cadence];
  return {
    id: row.id,
    baseMint: row.token,
    token: row.token,
    amount: row.amount,
    cadence: row.cadence,
    target: row.target,
    contributed: row.contributed,
    fills: row.fills,
    lastFilledAt: row.lastFilledAt?.toISOString() ?? null,
    nextDueAt: new Date(nextDue).toISOString(),
    due: row.active && nextDue <= now,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function plans(chainId: ChainId, walletInput: string): Promise<PlanRow[]> {
  const wallet = normAddress(walletInput, "wallet");
  const rows = await getDb()
    .select()
    .from(junoPlans)
    .where(and(eq(junoPlans.wallet, wallet), eq(junoPlans.chainId, chainId)))
    .orderBy(desc(junoPlans.createdAt));
  const now = Date.now();
  return rows.map((row) => shapePlan(row, now));
}

export async function setPlanActive(id: string, active: boolean): Promise<boolean> {
  const rows = await getDb().update(junoPlans).set({ active }).where(eq(junoPlans.id, id)).returning({ id: junoPlans.id });
  return rows.length > 0;
}

export async function deletePlan(id: string): Promise<boolean> {
  const rows = await getDb().delete(junoPlans).where(eq(junoPlans.id, id)).returning({ id: junoPlans.id });
  return rows.length > 0;
}

/** Record a contribution that actually confirmed. Never on build or send. */
export async function recordContribution(id: string, amount: number): Promise<PlanRow | null> {
  const db = getDb();
  const [row] = await db.select().from(junoPlans).where(eq(junoPlans.id, id)).limit(1);
  if (!row) return null;
  const [updated] = await db
    .update(junoPlans)
    .set({ contributed: row.contributed + amount, fills: row.fills + 1, lastFilledAt: new Date() })
    .where(eq(junoPlans.id, id))
    .returning();
  return shapePlan(updated, Date.now());
}
