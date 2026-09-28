/**
 * Create the `juno_arb` database next to whichever database DATABASE_URL
 * names, if it does not exist yet. Connects to the server's default database
 * (`postgres`, falling back to `neondb`) because a database cannot be created
 * from inside itself. Prints no credentials.
 */
import { Client } from "pg";

async function main() {
  const target = new URL(process.env.DATABASE_URL ?? "");
  const name = target.pathname.replace(/^\//, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Refusing odd database name "${name}"`);

  let lastError: unknown;
  for (const admin of ["postgres", "neondb"]) {
    const url = new URL(target.toString());
    url.pathname = `/${admin}`;
    url.searchParams.delete("sslmode");
    const client = new Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
      if (rowCount) {
        console.log(`database ${name} already exists on ${target.hostname}`);
      } else {
        await client.query(`create database ${name}`);
        console.log(`created database ${name} on ${target.hostname}`);
      }
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
    }
  }
  throw lastError;
}

main().catch((error) => {
  console.error("create-db failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
