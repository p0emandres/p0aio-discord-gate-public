import { NextResponse } from "next/server";
import { unlink } from "@/lib/gate";
import { sameOrigin, sessionFrom } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const s = sessionFrom(req);
  if (!s) return NextResponse.json({ error: "not logged in" }, { status: 401 });
  const r = await unlink(s.uid, "user unlinked on the verify page");
  return NextResponse.json({ ok: true, ...r });
}
