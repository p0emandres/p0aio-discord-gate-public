// Proof-of-work gate: the browser must burn a little CPU before it may start a login or ask for a signing challenge.
// A human's phone spends a fraction of a second; a flood costs the attacker a CPU-second per attempt. Difficulty rises
// on its own when the global counters show a flood. Solutions are signed, scoped, short-lived and single-use.
import { createHash } from "node:crypto";
import { sql } from "./db";
import { leadingZeroBits } from "./sha256";
import { hit } from "./ratelimit";
import { randomToken, sign, verify as verifyToken } from "./session";

export type PowScope = "login" | "nonce";
export const POW_TTL = 90;                 // seconds a challenge stays valid
export const POW_BASE_BITS = Number(process.env.POW_BASE_BITS || "16");   // ~65k hashes on average

type Challenge = { salt: string; bits: number; scope: PowScope; exp: number };

/** Difficulty for a new challenge, escalating with the last minute's global demand. */
export async function currentBits(): Promise<number> {
  const load = await hit("pow_global", "global", 1_000_000, 60);
  const c = load.count;
  return Math.min(22, POW_BASE_BITS + (c > 60 ? 2 : 0) + (c > 200 ? 2 : 0) + (c > 600 ? 2 : 0));
}

export async function issue(scope: PowScope): Promise<{ challenge: string; bits: number; expiresIn: number }> {
  const bits = await currentBits();
  return { challenge: sign({ salt: randomToken(12), bits, scope }, POW_TTL), bits, expiresIn: POW_TTL };
}

export function checkSolution(challenge: string, counter: string | number, bits: number): boolean {
  if (!/^\d{1,12}$/.test(String(counter))) return false;
  const digest = createHash("sha256").update(`${challenge}:${counter}`).digest();
  return leadingZeroBits(new Uint8Array(digest)) >= bits;
}

/** Full check: signature + expiry + scope + work + single use. Returns a reason string on failure, null when fine. */
export async function verifyPow(challenge: string | undefined, counter: string | number | undefined, scope: PowScope): Promise<string | null> {
  if (!challenge || counter === undefined) return "browser check missing";
  const c = verifyToken<Challenge>(challenge);
  if (!c || c.scope !== scope) return "browser check expired";
  if (!checkSolution(challenge, counter, c.bits)) return "browser check failed";
  const spent = await sql`insert into pow_spent (salt, expires_at) values (${c.salt}, ${new Date(c.exp * 1000)}) on conflict (salt) do nothing returning salt`;
  if (!spent.length) return "browser check already used";
  return null;
}
