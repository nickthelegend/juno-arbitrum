import "server-only";

import { CallerError } from "./api";
import { publicClient, type ChainId } from "./chains";
import { verifyNameClaim, type NameClaim } from "./names";
import { db, ensureIndexes } from "./social";

/**
 * Names for wallets, stored in Mongo and unique case-insensitively per chain.
 * The claim itself is checked in `names.ts`.
 */
type ProfileDoc = { wallet: string; chainId: number; name: string; nameKey: string; updatedAt: Date };

let indexed: Promise<unknown> | null = null;

async function profiles() {
  indexed ??= ensureIndexes().catch(() => (indexed = null));
  await indexed;
  return (await db()).collection<ProfileDoc>("profiles");
}

export async function namesFor(wallets: string[], chainId: ChainId): Promise<Record<string, string>> {
  if (wallets.length === 0) return {};
  const rows = await (await profiles())
    .find({ chainId, wallet: { $in: wallets } }, { projection: { wallet: 1, name: 1 } })
    .toArray();
  return Object.fromEntries(rows.map((row) => [row.wallet, row.name]));
}

export async function claimName(chainId: ChainId, claim: NameClaim): Promise<{ wallet: string; name: string }> {
  const verified = await verifyNameClaim(claim, {
    // Smart-account wallets sign with ERC-1271; the chain can check those.
    fallbackVerify: (input) => publicClient(chainId).verifyMessage(input),
  });
  const collection = await profiles();
  try {
    await collection.updateOne(
      { chainId, wallet: verified.wallet },
      { $set: { name: verified.name, nameKey: verified.nameKey, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new CallerError("That name is taken.");
    throw error;
  }
  return { wallet: verified.wallet, name: verified.name };
}
