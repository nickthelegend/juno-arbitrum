/**
 * Create the Mongo collections' indexes in MONGODB_DB (default `juno_arb`)
 * and list them. Idempotent.
 */
import { MongoClient } from "mongodb";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  const name = process.env.MONGODB_DB || "juno_arb";
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const database = client.db(name);

  await Promise.all([
    database.collection("comments").createIndex({ token: 1, chainId: 1, createdAt: -1 }, { name: "comments_token" }),
    database.collection("comments").createIndex({ chainId: 1, txHash: 1 }, { name: "comments_tx", sparse: true }),
    database.collection("likes").createIndex({ token: 1, chainId: 1, wallet: 1 }, { unique: true, name: "likes_unique" }),
    database.collection("profiles").createIndex({ chainId: 1, wallet: 1 }, { unique: true, name: "profiles_wallet" }),
    database.collection("profiles").createIndex({ chainId: 1, nameKey: 1 }, { unique: true, name: "profiles_name" }),
    database.collection("faucet_claims").createIndex({ chainId: 1, wallet: 1, at: -1 }, { name: "faucet_wallet" }),
    database.collection("faucet_claims").createIndex({ chainId: 1, ip: 1, at: -1 }, { name: "faucet_ip" }),
    database
      .collection("faucet_claims")
      .createIndex({ at: 1 }, { expireAfterSeconds: 2 * 24 * 60 * 60, name: "faucet_ttl" }),
  ]);

  console.log(`indexes in ${name}:`);
  for (const collection of ["comments", "likes", "profiles", "faucet_claims"]) {
    const indexes = await database.collection(collection).indexes();
    for (const index of indexes) {
      console.log(`  ${collection}.${index.name} ${JSON.stringify(index.key)}${index.unique ? " unique" : ""}${index.expireAfterSeconds ? ` ttl=${index.expireAfterSeconds}s` : ""}`);
    }
  }
  await client.close();
}

main().catch((error) => {
  console.error("mongo-indexes failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
