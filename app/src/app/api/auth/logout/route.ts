import { NextResponse } from "next/server";
import { clearCookie, sameOrigin, SESSION_COOKIE } from "@/lib/session";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const res = NextResponse.json({ ok: true });
  clearCookie(res, SESSION_COOKIE);
  return res;
}
