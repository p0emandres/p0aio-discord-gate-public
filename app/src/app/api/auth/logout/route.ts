import { NextResponse } from "next/server";
import { limited } from "@/lib/ratelimit";
import { clearCookie, sameOrigin, SESSION_COOKIE } from "@/lib/session";

export async function POST(req: Request) {
  const block = await limited(req, "logout_ip", 20, 600);
  if (block) return block;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const res = NextResponse.json({ ok: true });
  clearCookie(res, SESSION_COOKIE);
  return res;
}
