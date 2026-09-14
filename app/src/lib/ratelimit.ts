// Fixed-window rate limits stored in Postgres, so every serverless instance shares one counter.
// Fail-open on a database error: if the DB is down, verification cannot work anyway, and we never want the limiter
// itself to be the outage.
import { NextResponse } from "next/server";
import { sql } from "./db";

export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

export async function hit(bucket: string, key: string, limit: number, windowSec: number): Promise<{ ok: boolean; retryAfter: number; count: number }> {
  try {
    const [row] = await sql<{ count: number; window_start: string }[]>`
      insert into ratelimit (bucket, key, window_start, count) values (${bucket}, ${key}, now(), 1)
      on conflict (bucket, key) do update set
        count = case when ratelimit.window_start < now() - make_interval(secs => ${windowSec}) then 1 else ratelimit.count + 1 end,
        window_start = case when ratelimit.window_start < now() - make_interval(secs => ${windowSec}) then now() else ratelimit.window_start end
      returning count, window_start`;
    if (row.count <= limit) return { ok: true, retryAfter: 0, count: row.count };
    const elapsed = (Date.now() - new Date(row.window_start).getTime()) / 1000;
    return { ok: false, retryAfter: Math.max(1, Math.ceil(windowSec - elapsed)), count: row.count };
  } catch (e) {
    console.error("ratelimit unavailable", (e as Error).message);
    return { ok: true, retryAfter: 0, count: 0 };
  }
}

/** Returns a 429 response when the caller is over the limit, otherwise null. */
export async function limited(req: Request, bucket: string, limit: number, windowSec: number, key?: string): Promise<NextResponse | null> {
  const r = await hit(bucket, key ?? clientIp(req), limit, windowSec);
  if (r.ok) return null;
  return NextResponse.json({ error: "too many requests; slow down" }, { status: 429, headers: { "Retry-After": String(r.retryAfter) } });
}

export const tooMany = (retryAfter: number) =>
  NextResponse.json({ error: "too many requests; slow down" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
