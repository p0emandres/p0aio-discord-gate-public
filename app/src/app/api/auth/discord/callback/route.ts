import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { clearCookie, readCookie, SESSION_COOKIE, SESSION_TTL, setCookie, sign, STATE_COOKIE, verify } from "@/lib/session";

export const dynamic = "force-dynamic";

const fail = (why: string) => NextResponse.redirect(`${env.origin}/?error=${encodeURIComponent(why)}`);

export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const saved = verify<{ state: string; exp: number }>(readCookie(req, STATE_COOKIE));
  if (!code || !state || !saved || saved.state !== state) return fail("login_state");

  const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.appId, client_secret: env.clientSecret, grant_type: "authorization_code",
      code, redirect_uri: `${env.origin}/api/auth/discord/callback`,
    }),
  });
  if (!tokenRes.ok) return fail("login_exchange");
  const tok = (await tokenRes.json()) as { access_token: string };
  const meRes = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!meRes.ok) return fail("login_identity");
  const me = (await meRes.json()) as { id: string; username: string; global_name?: string | null };
  // We only ever needed the identity; drop the OAuth token immediately.
  await fetch("https://discord.com/api/v10/oauth2/token/revoke", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.appId, client_secret: env.clientSecret, token: tok.access_token }),
  }).catch(() => {});

  const res = NextResponse.redirect(`${env.origin}/`);
  setCookie(res, SESSION_COOKIE, sign({ uid: me.id, name: me.global_name || me.username }, SESSION_TTL), SESSION_TTL);
  clearCookie(res, STATE_COOKIE);
  return res;
}
