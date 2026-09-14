import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { maskWallet } from "@/lib/discord";
import { env } from "@/lib/env";
import { limited } from "@/lib/ratelimit";
import { sessionFrom } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const block = await limited(req, "me_ip", 60, 60);
  if (block) return block;
  const s = sessionFrom(req);
  const base = {
    project: env.projectName, domain: env.verifyDomain, chainId: env.chainId, guildId: env.guildId, landingChannelId: env.landingChannelId || null,
    dry: env.dryRoles,
    tiers: env.tiers.map((t) => ({ role: t.role, min: t.min })),
  };
  if (!s) return NextResponse.json({ ...base, user: null, binding: null });
  const [b] = await sql<{ wallet: string; token_count: number; verified_at: string; last_checked_at: string | null }[]>`
    select wallet, token_count, verified_at, last_checked_at from bindings where discord_user_id = ${s.uid}`;
  return NextResponse.json({
    ...base,
    user: { id: s.uid, name: s.name, exp: s.exp },
    binding: b ? { wallet: maskWallet(b.wallet), tokens: b.token_count, verifiedAt: b.verified_at, lastCheckedAt: b.last_checked_at } : null,
  });
}
