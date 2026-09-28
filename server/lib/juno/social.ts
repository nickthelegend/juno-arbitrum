import "server-only";

import { MongoClient, type Collection, type Db } from "mongodb";

/**
 * Social state: comments and likes, in Mongo.
 *
 * Deliberately not Postgres: append-heavy, per-coin and schema-loose, and a
 * comment outage can never take market data down with it. Nothing here is
 * authoritative about money; trades live on-chain.
 *
 * Documents are keyed by the lowercase token address and a numeric `chainId`.
 */

declare global {
  // eslint-disable-next-line no-var
  var __junoMongo: MongoClient | undefined;
}

function client(): MongoClient {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  globalThis.__junoMongo ??= new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 8_000,
  });
  return globalThis.__junoMongo;
}

export async function db(): Promise<Db> {
  const c = client();
  await c.connect();
  return c.db(process.env.MONGODB_DB || "juno_arb");
}

let indexesReady: Promise<void> | null = null;

/**
 * Every unique index the app relies on. Idempotent: Mongo ignores a create
 * for an index that already exists. Run once per process, and by
 * `npm run mongo:indexes`.
 */
export async function ensureIndexes(): Promise<string[]> {
  const database = await db();
  const created = await Promise.all([
    database.collection("comments").createIndex({ token: 1, chainId: 1, createdAt: -1 }, { name: "comments_token" }),
    database.collection("comments").createIndex({ chainId: 1, txHash: 1 }, { name: "comments_tx", sparse: true }),
    database
      .collection("likes")
      .createIndex({ token: 1, chainId: 1, wallet: 1 }, { unique: true, name: "likes_unique" }),
    database.collection("profiles").createIndex({ chainId: 1, wallet: 1 }, { unique: true, name: "profiles_wallet" }),
    database.collection("profiles").createIndex({ chainId: 1, nameKey: 1 }, { unique: true, name: "profiles_name" }),
    database.collection("faucet_claims").createIndex({ chainId: 1, wallet: 1, at: -1 }, { name: "faucet_wallet" }),
    database.collection("faucet_claims").createIndex({ chainId: 1, ip: 1, at: -1 }, { name: "faucet_ip" }),
    // Rows older than two days can never affect a 24h window.
    database.collection("faucet_claims").createIndex({ at: 1 }, { expireAfterSeconds: 2 * 24 * 60 * 60, name: "faucet_ttl" }),
  ]);
  return created;
}

async function ready(): Promise<Db> {
  indexesReady ??= ensureIndexes()
    .then(() => undefined)
    .catch((error) => {
      indexesReady = null;
      console.warn("[juno mongo] index creation failed:", error instanceof Error ? error.message : error);
    });
  await indexesReady;
  return db();
}

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

export type JunoComment = {
  id: string;
  token: string;
  chainId: number;
  wallet: string;
  body: string;
  side?: "buy" | "sell";
  /** The trade's transaction, so the comment is verifiable. */
  txHash?: string;
  createdAt: string;
};

type CommentDoc = Omit<JunoComment, "id" | "createdAt"> & { createdAt: Date };

async function comments(): Promise<Collection<CommentDoc>> {
  return (await ready()).collection<CommentDoc>("comments");
}

export const MAX_COMMENT = 280;

function shapeComment(doc: CommentDoc & { _id: { toString(): string } }): JunoComment {
  return {
    id: doc._id.toString(),
    token: doc.token,
    chainId: doc.chainId,
    wallet: doc.wallet,
    body: doc.body,
    side: doc.side,
    txHash: doc.txHash,
    createdAt: doc.createdAt.toISOString(),
  };
}

export async function listComments(token: string, chainId: number, limit = 50): Promise<JunoComment[]> {
  const docs = await (await comments()).find({ token, chainId }).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map(shapeComment);
}

/** Notes attached to specific trades, keyed by tx hash — one query for a whole feed page. */
export async function notesForTxHashes(txHashes: string[], chainId: number): Promise<Map<string, JunoComment>> {
  if (txHashes.length === 0) return new Map();
  const docs = await (await comments())
    .find({ chainId, txHash: { $in: txHashes } })
    .sort({ createdAt: 1 })
    .toArray();
  return new Map(docs.map((doc) => [doc.txHash!, shapeComment(doc)]));
}

export async function addComment(input: {
  token: string;
  chainId: number;
  wallet: string;
  body: string;
  side?: "buy" | "sell";
  txHash?: string;
}): Promise<JunoComment> {
  const body = input.body.trim().slice(0, MAX_COMMENT);
  if (!body) throw new Error("Comment is empty");
  const doc: CommentDoc = {
    token: input.token,
    chainId: input.chainId,
    wallet: input.wallet,
    body,
    side: input.side,
    txHash: input.txHash,
    createdAt: new Date(),
  };
  const result = await (await comments()).insertOne(doc);
  return shapeComment({ ...doc, _id: result.insertedId });
}

/* ------------------------------------------------------------------ */
/* Likes                                                               */
/* ------------------------------------------------------------------ */

/** One wallet liking one coin, unique on the triple: a like is a fact, not a counter. */
type LikeDoc = { token: string; chainId: number; wallet: string; createdAt: Date };

async function likes(): Promise<Collection<LikeDoc>> {
  return (await ready()).collection<LikeDoc>("likes");
}

export async function setLike(input: {
  token: string;
  chainId: number;
  wallet: string;
  like: boolean;
}): Promise<{ likes: number; liked: boolean }> {
  const collection = await likes();
  const key = { token: input.token, chainId: input.chainId, wallet: input.wallet };
  if (input.like) {
    await collection.updateOne(key, { $setOnInsert: { ...key, createdAt: new Date() } }, { upsert: true });
  } else {
    await collection.deleteOne(key);
  }
  return {
    likes: await collection.countDocuments({ token: input.token, chainId: input.chainId }),
    liked: input.like,
  };
}

export type SocialCounts = { likes: number; comments: number; viewerLiked: boolean | null };

/** Likes and comments for many coins in two aggregate reads. `viewerLiked` is null without a viewer. */
export async function socialCounts(
  tokens: string[],
  chainId: number,
  viewer?: string | null,
): Promise<Map<string, SocialCounts>> {
  const out = new Map<string, SocialCounts>();
  for (const token of tokens) out.set(token, { likes: 0, comments: 0, viewerLiked: viewer ? false : null });
  if (tokens.length === 0) return out;

  const match = { token: { $in: tokens }, chainId };
  const [likeRows, commentRows, mine] = await Promise.all([
    (await likes())
      .aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: "$token", n: { $sum: 1 } } }])
      .toArray(),
    (await comments())
      .aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: "$token", n: { $sum: 1 } } }])
      .toArray(),
    viewer
      ? (await likes()).find({ ...match, wallet: viewer }, { projection: { token: 1 } }).toArray()
      : Promise.resolve([] as Array<{ token: string }>),
  ]);

  for (const row of likeRows) out.get(row._id)!.likes = row.n;
  for (const row of commentRows) out.get(row._id)!.comments = row.n;
  for (const row of mine) out.get(row.token)!.viewerLiked = true;
  return out;
}
