import { Pool, type PoolConfig } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __junoPgPool: Pool | undefined;
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

function sslConfig(url: string): PoolConfig["ssl"] {
  if (process.env.DATABASE_SSL === "disable") return undefined;
  if (process.env.DATABASE_SSL === "require") return { rejectUnauthorized: false };
  const normalized = url.toLowerCase();
  if (
    normalized.includes("sslmode=require") ||
    normalized.includes("neon.tech") ||
    normalized.includes("supabase.")
  ) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

/**
 * `sslmode` is redundant once `ssl` is passed explicitly, and pg warns that
 * its aliases change meaning in v9. Dropping it keeps the policy in
 * `sslConfig`.
 */
function stripSslMode(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("sslmode");
    parsed.searchParams.delete("channel_binding");
    return parsed.toString();
  } catch {
    return url;
  }
}

export function getPgPool(): Pool {
  if (!globalThis.__junoPgPool) {
    const raw = databaseUrl();
    globalThis.__junoPgPool = new Pool({
      connectionString: stripSslMode(raw),
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      ssl: sslConfig(raw),
    });
  }
  return globalThis.__junoPgPool;
}
