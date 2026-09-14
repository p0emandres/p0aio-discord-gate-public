import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { verifyPow } from "@/lib/pow";
import { limited } from "@/lib/ratelimit";
import { randomToken, setCookie, sign, STATE_COOKIE, STATE_TTL } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const block = await limited(req, "oauth_start", 20, 600);
  if (block) return block;
  const q = new URL(req.url).searchParams;
  const why = await verifyPow(q.get("c") || undefined, q.get("n") || undefined, "login");
  if (why) return NextResponse.redirect(`${env.origin}/?error=${encodeURIComponent(why)}`);
  const state = randomToken(16);
  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", env.appId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", `${env.origin}/api/auth/discord/callback`);
  u.searchParams.set("scope", "identify");
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "none");
  const res = NextResponse.redirect(u);
  setCookie(res, STATE_COOKIE, sign({ state }, STATE_TTL), STATE_TTL);
  return res;
}
