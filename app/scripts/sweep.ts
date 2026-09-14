// Run the scheduled re-check by hand from this Mac (same code the Vercel cron runs).
import { loadLocalEnv } from "./_env";
import { sweep } from "../src/lib/gate";
import { sql } from "../src/lib/db";

loadLocalEnv();
async function main() {
  console.log(JSON.stringify(await sweep(), null, 2));
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
