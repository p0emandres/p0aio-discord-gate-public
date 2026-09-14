// HMAC-signed, expiring tokens for the login session and the OAuth state. No server-side session store needed.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "./env";

export const SESSION_COOKIE = "gate_sess";
export const STATE_COOKIE = "gate_oauth";
export const SESSION_TTL = 15 * 60;   // seconds a login stays valid
export const STATE_TTL = 10 * 60;

export type Session = { uid: string; name: string; exp: number };

const b64u = (b: Buffer) => b.toString("base64url");
const mac = (body: string) => b64u(createHmac("sha256", env.sessionSecret).update(body).digest());

export function sign(payload: Record<string, unknown>, ttlSec: number): string {
  const body = b64u(Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })));
  return `${body}.${mac(body)}`;
}

export function verify<T extends { exp: number }>(token: string | undefined | null): T | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const body = token.slice(0, i), got = token.slice(i + 1), want = mac(body);
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    return p.exp > Math.floor(Date.now() / 1000) ? p : null;
  } catch {
    return null;
  }
}

export const randomToken = (bytes = 16) => randomBytes(bytes).toString("hex");

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return undefined;
}

export function sessionFrom(req: Request): Session | null {
  return verify<Session>(readCookie(req, SESSION_COOKIE));
}

export function setCookie(res: NextResponse, name: string, value: string, maxAge: number) {
  res.cookies.set(name, value, {
    httpOnly: true,
    secure: env.origin.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}

export function clearCookie(res: NextResponse, name: string) {
  res.cookies.set(name, "", { httpOnly: true, path: "/", maxAge: 0 });
}

/** CSRF guard for state-changing calls: the browser must say it came from our own origin. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === env.origin;
  const site = req.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}
