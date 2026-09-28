/**
 * Apply `drizzle/` migrations to DATABASE_URL, then list the tables so the
 * result is visible. Safe to re-run: drizzle records what it applied.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { getPgPool } from "../lib/db/pool";

async function main() {
  const pool = getPgPool();
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  const { rows } = await pool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
  );
  console.log(`migrations applied to ${new URL(process.env.DATABASE_URL!).pathname.slice(1)}; tables:`);
  for (const row of rows) console.log(`  ${row.table_name}`);
  await pool.end();
}

main().catch((error) => {
  console.error("migrate failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
