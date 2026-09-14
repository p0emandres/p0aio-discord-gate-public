// Proves the one-seat-per-NFT rules against a throwaway DB and a mock ownership source. No Discord writes
// (the fake user ids are not members, so role calls are skipped).
//   DATABASE_URL=postgres://... npx tsx scripts/seat-test.ts
import { createServer } from "node:http";

process.env.ALCHEMY_NFT_BASE = "http://127.0.0.1:3998/nft";
process.env.GATE_TIERS = JSON.stringify([{ role: "holder", min: 1, role_id: "111" }, { role: "whale", min: 3, role_id: "333" }]);
process.env.AUDIT_CHANNEL_ID = "";
process.env.PRUNE_DAYS = "0";

const A = "0x000000000000000000000000000000000000aaaa", B = "0x000000000000000000000000000000000000bbbb", C = "0x000000000000000000000000000000000000cccc";
let owners: Record<string, string> = { "1": A, "2": A, "3": A, "4": B };   // tokenId → owner
const server = createServer((req, res) => {
  const byOwner = new Map<string, string[]>();
  for (const [t, o] of Object.entries(owners)) byOwner.set(o, [...(byOwner.get(o) ?? []), t]);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ owners: [...byOwner].map(([ownerAddress, ts]) => ({ ownerAddress, tokenBalances: ts.map((tokenId) => ({ tokenId, balance: "1" })) })) }));
});

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✔" : "✘"} ${name}${detail ? " — " + detail : ""}`); };

async function main() {
  const { loadLocalEnv } = await import("./_env"); loadLocalEnv();
  await new Promise<void>((r) => server.listen(3998, r));
  const { sql } = await import("../src/lib/db");
  const { verifyAndBind, sweep, unlink, reevaluate } = await import("../src/lib/gate");
  await sql`delete from bindings`; await sql`delete from audit`;
  const seats = async (uid: string) => (await sql<{ token_id: string }[]>`select token_id from seats where discord_user_id = ${uid} order by token_id::int`).map((r) => r.token_id);
  const binding = async (uid: string) => (await sql<{ wallet: string; token_count: number; roles: string[] }[]>`select wallet, token_count, roles from bindings where discord_user_id = ${uid}`)[0];

  let r = await verifyAndBind({ uid: "X", username: "x", wallet: A });
  check("X verifies wallet A → 3 seats, whale tier", r.tokens.join() === "1,2,3" && (await binding("X")).roles.join() === "111,333" && !r.inGuild);
  r = await verifyAndBind({ uid: "Y", username: "y", wallet: B });
  check("Y verifies wallet B → seat 4, holder tier", (await seats("Y")).join() === "4" && (await binding("Y")).roles.join() === "111");

  r = await verifyAndBind({ uid: "Z", username: "z", wallet: A });
  check("Z verifies the SAME wallet A → newest claim wins, X displaced", r.displaced.join() === "X" && (await seats("Z")).join() === "1,2,3" && !(await binding("X")));

  owners = { "1": A, "2": B, "3": A, "4": B };            // token 2 sold from A to B
  let s = await sweep();
  check("sweep: token 2 moved A→B → seat follows, counts update", (await seats("Z")).join() === "1,3" && (await seats("Y")).join() === "2,4" && (await binding("Z")).token_count === 2 && (await binding("Y")).token_count === 2, JSON.stringify(s));
  check("sweep: Z drops from whale to holder", (await binding("Z")).roles.join() === "111");

  owners = { "1": A, "2": B, "3": A, "4": C };            // token 4 sold to an unbound wallet
  s = await sweep();
  check("sweep: token 4 → unbound wallet C → seat freed", (await seats("Y")).join() === "2" && (await sql`select 1 from seats where token_id = '4'`).length === 0);

  owners = { "1": C, "2": C, "3": C, "4": C };            // Z sold everything
  s = await sweep();
  check("sweep: Z sold everything → 0 seats, no roles, binding kept", (await seats("Z")).length === 0 && (await binding("Z")).roles.length === 0 && (await binding("Z")).token_count === 0);

  r = await verifyAndBind({ uid: "W", username: "w", wallet: C });
  check("W verifies wallet C → takes all 4 seats, nobody displaced (seats were free)", (await seats("W")).join() === "1,2,3,4" && r.displaced.length === 0);

  const u = await unlink("W", "test");
  check("unlink W → binding + seats gone", u.hadBinding && (await sql`select 1 from seats where discord_user_id = 'W'`).length === 0);
  const rv = await reevaluate("nobody", "test");
  check("reevaluate unknown user → no roles, no crash", rv.tokens === 0 && rv.roles.length === 0);

  const kinds = (await sql<{ kind: string; n: number }[]>`select kind, count(*)::int n from audit group by kind order by kind`).map((k) => `${k.kind}:${k.n}`).join(" ");
  console.log("audit rows:", kinds);
  await sql`delete from bindings`; await sql`delete from audit`;
  await sql.end(); server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
