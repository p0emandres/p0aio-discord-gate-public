import { NextResponse } from "next/server";
import { issue, type PowScope } from "@/lib/pow";
import { limited } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const block = await limited(req, "pow_ip", 30, 60);
  if (block) return block;
  const body = (await req.json().catch(() => ({}))) as { scope?: string };
  const scope = body.scope === "login" || body.scope === "nonce" ? (body.scope as PowScope) : null;
  if (!scope) return NextResponse.json({ error: "bad scope" }, { status: 400 });
  return NextResponse.json(await issue(scope));
}
