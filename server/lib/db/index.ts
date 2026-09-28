import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import { getPgPool } from "./pool";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let _db: Db | null = null;

export function getDb(): Db {
  _db ??= drizzle(getPgPool(), { schema });
  return _db;
}

export { schema };
