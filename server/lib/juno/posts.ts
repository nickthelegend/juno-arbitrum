import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { junoPosts } from "@/lib/db/schema";
import { CallerError } from "./api";
import type { ChainId } from "./chains";

/**
 * Creator posts — the half of the social feed that is not a trade. A post may
 * reference a coin or stand alone; a reply is a post with a parent.
 */

export type JunoPostRow = typeof junoPosts.$inferSelect;

export type NewPost = {
  chainId: ChainId;
  authorWallet: string;
  body: string;
  token?: string | null;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  parentId?: string | null;
};

export const MAX_POST_LENGTH = 500;

export async function createPost(input: NewPost): Promise<JunoPostRow> {
  const body = input.body.trim();
  if (body.length === 0) throw new CallerError("A post needs a body");
  if (body.length > MAX_POST_LENGTH) throw new CallerError(`A post must be ${MAX_POST_LENGTH} characters or fewer`);
  if (input.parentId) {
    const parent = await getPost(input.parentId);
    if (!parent) throw new CallerError("The post you are replying to does not exist", 404);
  }

  const [row] = await getDb()
    .insert(junoPosts)
    .values({
      id: randomUUID().replace(/-/g, "").slice(0, 32),
      authorWallet: input.authorWallet,
      chainId: input.chainId,
      body,
      token: input.token ?? null,
      mediaUrl: input.mediaUrl ?? null,
      mediaMime: input.mediaMime ?? null,
      parentId: input.parentId ?? null,
    })
    .returning();
  return row;
}

/** Newest first; paginated by timestamp so inserts at the head do not shift pages. */
export async function listPosts(
  chainId: ChainId,
  options: { limit?: number; before?: Date; authorWallet?: string; token?: string; parentId?: string } = {},
): Promise<JunoPostRow[]> {
  const filters = [eq(junoPosts.chainId, chainId)];
  filters.push(options.parentId ? eq(junoPosts.parentId, options.parentId) : isNull(junoPosts.parentId));
  if (options.before && Number.isFinite(options.before.getTime())) filters.push(lt(junoPosts.createdAt, options.before));
  if (options.authorWallet) filters.push(eq(junoPosts.authorWallet, options.authorWallet));
  if (options.token) filters.push(eq(junoPosts.token, options.token));

  return getDb()
    .select()
    .from(junoPosts)
    .where(and(...filters))
    .orderBy(options.parentId ? asc(junoPosts.createdAt) : desc(junoPosts.createdAt))
    .limit(Math.min(options.limit ?? 30, 100));
}

export async function replyCounts(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ parentId: junoPosts.parentId, count: count() })
    .from(junoPosts)
    .where(inArray(junoPosts.parentId, ids))
    .groupBy(junoPosts.parentId);
  return new Map(rows.map((row) => [row.parentId ?? "", Number(row.count)]));
}

export async function getPost(id: string): Promise<JunoPostRow | null> {
  const [row] = await getDb().select().from(junoPosts).where(eq(junoPosts.id, id)).limit(1);
  return row ?? null;
}
