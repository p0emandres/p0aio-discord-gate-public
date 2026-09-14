import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadLocalEnv } from "./_env";
import { sql } from "../src/lib/db";

loadLocalEnv();
async function main() {
  const ddl = readFileSync(resolve(process.cwd(), "src/db/schema.sql"), "utf8");
  await sql.unsafe(ddl);
  const tables = await sql<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
  console.log("migrated:", tables.map((t) => t.table_name).join(", "));
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
