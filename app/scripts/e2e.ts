// End-to-end exercise of the verify service against a LOCAL server + throwaway DB. Read-only against Discord.
//   BASE=http://localhost:3999 KEYFILE=/path/test-ed25519.json npx tsx scripts/e2e.ts
import { readFileSync } from "node:fs";
import { sign as edSign } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { loadLocalEnv } from "./_env";
import { env } from "../src/lib/env";
import { sign, SESSION_COOKIE, SESSION_TTL } from "../src/lib/session";

loadLocalEnv();
const BASE = process.env.BASE || "http://localhost:3999";
const key = JSON.parse(readFileSync(process.env.KEYFILE!, "utf8")) as { pub: string; priv: string };
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✔" : "✘"} ${name}${detail ? " — " + detail : ""}`); };
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> });

async function interaction(payload: object, signed = true) {
  const body = JSON.stringify(payload), ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-signature-timestamp": ts };
  if (signed) headers["x-signature-ed25519"] = edSign(null, Buffer.from(ts + body), key.priv).toString("hex");
  return j(await fetch(`${BASE}/api/discord/interactions`, { method: "POST", headers, body }));
}
const member = (uid: string, roles: string[] = [], perms = "0") => ({ user: { id: uid, username: "tester" }, roles, permissions: perms });

async function main() {
  // Who to impersonate for the session: the guild owner (a real member; we only ever READ their membership).
  const g = await fetch(`https://discord.com/api/v10/guilds/${env.guildId}`, { headers: { Authorization: `Bot ${env.botToken}` } }).then((r) => r.json()) as { owner_id: string };
  const uid = process.env.TEST_UID || g.owner_id;
  const cookie = `${SESSION_COOKIE}=${sign({ uid, name: "e2e-tester" }, SESSION_TTL)}`;
  const H = { "Content-Type": "application/json", Origin: env.origin, Cookie: cookie };

  // --- interactions
  let r = await interaction({ type: 1 }, false);
  check("interaction without signature → 401", r.status === 401);
  r = await interaction({ type: 1 });
  check("signed PING → PONG", r.status === 200 && r.body.type === 1);
  r = await interaction({ type: 2, token: "t", guild_id: env.guildId, member: member("1"), data: { name: "verify" } });
  const d = r.body.data as { content?: string; flags?: number; components?: unknown[] };
  check("/verify → ephemeral link to our domain", r.body.type === 4 && d.flags === 64 && !!d.content?.includes(env.origin) && Array.isArray(d.components));
  r = await interaction({ type: 2, token: "t", guild_id: "999", member: member("1"), data: { name: "verify" } });
  check("command from another server refused", ((r.body.data as { content: string }).content || "").includes("home server"));
  r = await interaction({ type: 2, token: "t", guild_id: env.guildId, member: member("1"), data: { name: "gate", options: [{ name: "stats" }] } });
  check("/gate stats from non-team → Team only", ((r.body.data as { content: string }).content || "") === "Team only.");
  r = await interaction({ type: 2, token: "t", guild_id: env.guildId, member: member("1", [], "32"), data: { name: "gate", options: [{ name: "stats" }] } });
  check("/gate stats with Manage Server → stats", ((r.body.data as { content: string }).content || "").includes("Bindings"), (r.body.data as { content: string }).content);

  // --- verify flow guards
  r = await j(await fetch(`${BASE}/api/verify/nonce`, { method: "POST", headers: { "Content-Type": "application/json", Origin: env.origin }, body: JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }) }));
  check("nonce without login → 401", r.status === 401);
  r = await j(await fetch(`${BASE}/api/verify/nonce`, { method: "POST", headers: { ...H, Origin: "https://evil.example" }, body: JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }) }));
  check("nonce from foreign origin → 403", r.status === 403);
  r = await j(await fetch(`${BASE}/api/verify/nonce`, { method: "POST", headers: H, body: JSON.stringify({ address: "nope" }) }));
  check("nonce with bad address → 400", r.status === 400);

  // --- happy path with a fresh (empty) wallet
  const acct = privateKeyToAccount(generatePrivateKey());
  const nonce = async () => (await j(await fetch(`${BASE}/api/verify/nonce`, { method: "POST", headers: H, body: JSON.stringify({ address: acct.address }) }))).body.message as string | undefined;
  const msg = await nonce();
  check("nonce issued with our domain + statement", !!msg && msg.includes(env.verifyDomain) && msg.includes(uid), msg?.split("\n")[0]);
  let sig = await acct.signMessage({ message: msg! });
  r = await j(await fetch(`${BASE}/api/verify`, { method: "POST", headers: H, body: JSON.stringify({ message: msg, signature: sig }) }));
  check("valid signature → verified (0 tokens, in guild)", r.status === 200 && r.body.ok === true && (r.body.tokens as string[]).length === 0 && r.body.inGuild === true, JSON.stringify(r.body));
  r = await j(await fetch(`${BASE}/api/verify`, { method: "POST", headers: H, body: JSON.stringify({ message: msg, signature: sig }) }));
  check("replay of the same challenge → rejected", r.status === 400 && String(r.body.error).includes("already used"), String(r.body.error));

  const msg2 = await nonce();
  const tampered = msg2!.replace("Signing is free", "Signing is FREE");
  sig = await acct.signMessage({ message: tampered });
  r = await j(await fetch(`${BASE}/api/verify`, { method: "POST", headers: H, body: JSON.stringify({ message: tampered, signature: sig }) }));
  check("tampered message → rejected", r.status === 400 && String(r.body.error).includes("altered"), String(r.body.error));

  const msg3 = await nonce();
  const other = privateKeyToAccount(generatePrivateKey());
  sig = await other.signMessage({ message: msg3! });
  r = await j(await fetch(`${BASE}/api/verify`, { method: "POST", headers: H, body: JSON.stringify({ message: msg3, signature: sig }) }));
  check("signature from a different key → rejected", r.status === 401, String(r.body.error));

  // --- rate limit (5 per 10 min per user)
  let limited = false;
  for (let i = 0; i < 4; i++) { const rr = await fetch(`${BASE}/api/verify/nonce`, { method: "POST", headers: H, body: JSON.stringify({ address: acct.address }) }); if (rr.status === 429) { limited = true; break; } }
  check("nonce rate limit kicks in", limited);

  // --- me / sweep / unlink
  r = await j(await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } }));
  check("/api/me shows the binding", !!(r.body.binding as { wallet: string } | null)?.wallet, JSON.stringify(r.body.binding));
  r = await j(await fetch(`${BASE}/api/cron/sweep`, { headers: { Authorization: "Bearer wrong" } }));
  check("cron with wrong secret → 401", r.status === 401);
  r = await j(await fetch(`${BASE}/api/cron/sweep`, { headers: { Authorization: `Bearer ${env.cronSecret}` } }));
  check("cron sweep runs", r.status === 200 && (r.body.checked as number) >= 1, JSON.stringify(r.body));
  r = await j(await fetch(`${BASE}/api/verify/unlink`, { method: "POST", headers: H }));
  check("unlink removes the binding", r.status === 200 && r.body.hadBinding === true);
  r = await j(await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } }));
  check("/api/me binding gone", r.body.binding === null);

  // --- abuse limits
  let last = 0, retry = "";
  for (let i = 0; i < 21; i++) { const rr = await fetch(`${BASE}/api/auth/discord`, { redirect: "manual" }); last = rr.status; retry = rr.headers.get("retry-after") || ""; }
  check("21st login-start from one IP → 429 with Retry-After", last === 429 && retry !== "", `status ${last} retry-after ${retry}`);
  let cmdLast = "";
  for (let i = 0; i < 11; i++) { const rr = await interaction({ type: 2, token: "t", guild_id: env.guildId, member: member("777"), data: { name: "status" } }); cmdLast = (rr.body.data as { content: string })?.content || ""; }
  check("11th slash command from one user in a minute → slowed down", cmdLast.startsWith("Slow down"), cmdLast);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
