// Vercel Cron hits this on the schedule in vercel.json, carrying CRON_SECRET. Nobody else can trigger it.
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { sweep } from "@/lib/gate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const got = req.headers.get("authorization") || "";
  const want = `Bearer ${env.cronSecret}`;
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  return NextResponse.json(await sweep());
}
