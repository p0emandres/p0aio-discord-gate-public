// Step 1: the logged-in Discord user names a wallet; we hand back the exact SIWE text to sign.
import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { buildSiwe, NONCE_TTL_MS } from "@/lib/chain";
import { sql } from "@/lib/db";
import { discord } from "@/lib/discord";
import { limited } from "@/lib/ratelimit";
import { randomToken, sameOrigin, sessionFrom } from "@/lib/session";

export const dynamic = "force-dynamic";
const err = (m: string, status = 400) => NextResponse.json({ error: m }, { status });

export async function POST(req: Request) {
  const block = (await limited(req, "nonce_ip", 10, 600)) ?? (await limited(req, "nonce_global", 120, 60, "global"));
  if (block) return block;
  if (!sameOrigin(req)) return err("bad origin", 403);
  const s = sessionFrom(req);
  if (!s) return err("not logged in", 401);
  const body = (await req.json().catch(() => ({}))) as { address?: string };
  if (!body.address || !isAddress(body.address)) return err("invalid address");
  const address = getAddress(body.address);

  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from nonces where discord_user_id = ${s.uid} and created_at > now() - interval '10 minutes'`;
  if (n >= 5) return err("too many attempts; wait a few minutes", 429);
  if (!(await discord.getMember(s.uid))) return err("join the Discord server first, then come back", 403);

  const nonce = randomToken(16);
  const message = buildSiwe({ address, uid: s.uid, name: s.name, nonce });
  await sql`insert into nonces (nonce, discord_user_id, wallet, message, expires_at)
            values (${nonce}, ${s.uid}, ${address.toLowerCase()}, ${message}, ${new Date(Date.now() + NONCE_TTL_MS)})`;
  return NextResponse.json({ message });
}
