// Step 2: the signature comes back. Everything is re-checked server-side before a single role moves.
import { NextResponse } from "next/server";
import { parseSiwe, verifySiwe } from "@/lib/chain";
import { sql } from "@/lib/db";
import { DM_STEPS, DmsOpenError, verifyAndBind } from "@/lib/gate";
import { limited } from "@/lib/ratelimit";
import { sameOrigin, sessionFrom } from "@/lib/session";

export const dynamic = "force-dynamic";
const err = (m: string, status = 400) => NextResponse.json({ error: m }, { status });

export async function POST(req: Request) {
  const block = (await limited(req, "verify_ip", 30, 600)) ?? (await limited(req, "verify_global", 120, 60, "global"));
  if (block) return block;
  if (!sameOrigin(req)) return err("bad origin", 403);
  const s = sessionFrom(req);
  if (!s) return err("not logged in", 401);
  const body = (await req.json().catch(() => ({}))) as { message?: string; signature?: string };
  if (typeof body.message !== "string" || typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature)) return err("bad payload");

  const parsed = parseSiwe(body.message);
  if (!parsed.nonce || !parsed.address) return err("unreadable message");

  // The nonce must be ours, unused, unexpired, issued to THIS Discord user for THIS wallet, and the text must be byte-identical.
  const [row] = await sql<{ wallet: string; message: string }[]>`
    update nonces set used_at = now()
    where nonce = ${parsed.nonce} and discord_user_id = ${s.uid} and used_at is null and expires_at > now()
    returning wallet, message`;
  if (!row) return err("challenge expired or already used; start again");
  if (row.message !== body.message || row.wallet !== parsed.address.toLowerCase()) return err("message was altered");

  const okSig = await verifySiwe({ message: body.message, signature: body.signature as `0x${string}`, nonce: parsed.nonce, address: parsed.address });
  if (!okSig) return err("signature did not verify", 401);

  let r;
  try {
    r = await verifyAndBind({ uid: s.uid, username: s.name, wallet: parsed.address });
  } catch (e) {
    if (e instanceof DmsOpenError) return NextResponse.json({ error: e.message, code: "dms_open", steps: DM_STEPS }, { status: 403 });
    throw e;
  }
  return NextResponse.json({
    ok: true, wallet: r.wallet, tokens: r.tokens, roles: r.roles.length, added: r.added.length, removed: r.removed.length, inGuild: r.inGuild,
  });
}
