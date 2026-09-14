// The gate itself: bind wallet ↔ Discord user, one seat per NFT, grant/revoke tier roles, scheduled re-check.
import { ownershipMap, tokensOf } from "./chain";
import { sql } from "./db";
import { discord, maskWallet } from "./discord";
import { env } from "./env";

export type VerifyResult = {
  wallet: string; tokens: string[]; roles: string[]; added: string[]; removed: string[]; inGuild: boolean; displaced: string[];
};
export type SweepSummary = {
  checked: number; changed: number; revokedAll: number; left: number; pruned: number; dmsOpen: number; pruneSkipped: string; errors: string[]; ms: number; supply: number;
};

export const DM_STEPS = [
  "Right-click the server icon (or tap the server name) → Privacy Settings",
  "Turn OFF “Direct Messages” (allow direct messages from server members)",
  "Come back and verify again",
];
export class DmsOpenError extends Error {
  code = "dms_open" as const;
  constructor() { super("Your DMs are open to members of this server. Close them, then verify again."); }
}
const dmWarning = () =>
  `⚠️ **Your DMs are open to members of the ${env.projectName} server.** That is exactly how scammers reach holders, so verification is paused until you close them:\n` +
  DM_STEPS.map((s, i) => `${i + 1}. ${s}`).join("\n") +
  `\n\nThis is the ONLY message this bot will ever send you. It will never send a link. Anyone else DMing you about ${env.projectName} is a scammer.`;

/** true = DMs closed (or check disabled/unavailable). Throws DmsOpenError when a probe DM was delivered. */
async function assertDmsClosed(uid: string, wallet: string | null, context: string) {
  if (!env.requireDmsClosed) return;
  const status = await discord.dmStatus(uid, dmWarning());
  if (status === "open") {
    await auditRow("blocked_dms_open", uid, wallet, { context });
    await discord.audit("🚫 DMs open", { user: `<@${uid}>`, context }, 0xe0b24a);
    throw new DmsOpenError();
  }
}

export const rolesForCount = (n: number) => env.tiers.filter((t) => t.role_id && n >= t.min).map((t) => t.role_id);
const managedRoleIds = () => env.tiers.map((t) => t.role_id).filter(Boolean);
/** True until provision.py has run and env_sync pushed real role ids. Nothing is granted or pruned before that. */
const tiersReady = () => env.tiers.length > 0 && env.tiers.every((t) => !!t.role_id);

async function auditRow(kind: string, uid: string | null, wallet: string | null, detail: Record<string, unknown>) {
  await sql`insert into audit (kind, discord_user_id, wallet, detail) values (${kind}, ${uid}, ${wallet}, ${sql.json(detail as never)})`;
}

/** Make the member's tier roles equal `want`. Touches ONLY roles listed in GATE_TIERS. Null = not in the server. */
export async function applyRoles(uid: string, want: string[], reason: string) {
  const member = await discord.getMember(uid);
  if (!member) return null;
  const managed = new Set(managedRoleIds());
  const cur = new Set(member.roles);
  const add = want.filter((r) => !cur.has(r));
  const remove = [...cur].filter((r) => managed.has(r) && !want.includes(r));
  for (const r of add) await discord.addRole(uid, r, reason);
  for (const r of remove) await discord.removeRole(uid, r, reason);
  return { add, remove, member };
}

/** Called only after a valid SIWE signature proved `wallet` belongs to the person logged in as `uid`. */
export async function verifyAndBind(p: { uid: string; username: string; wallet: string }): Promise<VerifyResult> {
  const wallet = p.wallet.toLowerCase();
  await assertDmsClosed(p.uid, wallet, "verify");
  const tokens = await tokensOf(wallet, true);
  const displaced = new Set<string>();

  await sql.begin(async (tx) => {
    // The same wallet on a different Discord account → the newest valid claim wins.
    const others = await tx<{ discord_user_id: string }[]>`select discord_user_id from bindings where wallet = ${wallet} and discord_user_id <> ${p.uid}`;
    for (const o of others) {
      displaced.add(o.discord_user_id);
      await tx`delete from bindings where discord_user_id = ${o.discord_user_id}`; // seats cascade
    }
    await tx`insert into bindings (discord_user_id, wallet, discord_username, verified_at, last_checked_at, token_count)
             values (${p.uid}, ${wallet}, ${p.username}, now(), now(), ${tokens.length})
             on conflict (discord_user_id) do update
               set wallet = excluded.wallet, discord_username = excluded.discord_username,
                   verified_at = now(), last_checked_at = now(), token_count = excluded.token_count`;
    await tx`delete from seats where discord_user_id = ${p.uid} and (wallet <> ${wallet} or not (token_id = any(${tokens})))`;
    for (const t of tokens) {
      const prev = await tx<{ discord_user_id: string }[]>`select discord_user_id from seats where token_id = ${t} and discord_user_id <> ${p.uid}`;
      for (const q of prev) displaced.add(q.discord_user_id);
      await tx`insert into seats (token_id, discord_user_id, wallet) values (${t}, ${p.uid}, ${wallet})
               on conflict (token_id) do update set discord_user_id = excluded.discord_user_id, wallet = excluded.wallet, claimed_at = now()`;
    }
  });

  const want = rolesForCount(tokens.length);
  const applied = await applyRoles(p.uid, want, `verified ${maskWallet(wallet)} · ${tokens.length} token(s)`);
  await sql`update bindings set roles = ${sql.json(want as never)}, dm_warned_at = null where discord_user_id = ${p.uid}`;
  await auditRow(tokens.length ? "verified" : "verified_no_tokens", p.uid, wallet,
    { tokens, add: applied?.add ?? [], remove: applied?.remove ?? [], displaced: [...displaced], inGuild: !!applied });
  await discord.audit(tokens.length ? "✅ verified" : "⚠️ verified · holds nothing", {
    user: `<@${p.uid}>`, wallet: maskWallet(wallet), tokens: tokens.join(", ") || "none",
    displaced: [...displaced].map((d) => `<@${d}>`).join(" ") || undefined,
  }, tokens.length ? 0x5be0c8 : 0xe0b24a);

  // Public confirmation in #verify so the member (and everyone watching) sees the flow complete.
  if (tokens.length && applied && env.verifyChannelId) {
    const where = env.landingChannelId ? ` Head to <#${env.landingChannelId}>.` : "";
    const line = applied.add.length
      ? `✅ <@${p.uid}> is verified — **${tokens.length}** ${env.projectName} · roles granted. Welcome in.${where}`
      : `✅ <@${p.uid}> re-verified — **${tokens.length}** ${env.projectName} · roles confirmed.`;
    const r = await discord.send(env.verifyChannelId, { content: line, allowed_mentions: { users: [p.uid] } });
    if (r.status !== 200) {
      console.error("verify-channel confirmation failed", r.status, JSON.stringify(r.data).slice(0, 200));
      await auditRow("confirm_failed", p.uid, wallet, { status: r.status, data: r.data });
    }
  }
  for (const d of displaced) await reevaluate(d, "seat taken by a newer verification");
  return { wallet, tokens, roles: want, added: applied?.add ?? [], removed: applied?.remove ?? [], inGuild: !!applied, displaced: [...displaced] };
}

/** Recompute one user's roles from the seats they still hold (none if unbound). */
export async function reevaluate(uid: string, reason: string) {
  const [b] = await sql<{ wallet: string }[]>`select wallet from bindings where discord_user_id = ${uid}`;
  const seats = b ? await sql<{ token_id: string }[]>`select token_id from seats where discord_user_id = ${uid}` : [];
  const n = seats.length;
  const want = b ? rolesForCount(n) : [];
  const applied = await applyRoles(uid, want, reason);
  if (b) await sql`update bindings set token_count = ${n}, roles = ${sql.json(want as never)}, last_checked_at = now() where discord_user_id = ${uid}`;
  if (applied && (applied.add.length || applied.remove.length)) {
    await auditRow("roles_changed", uid, b?.wallet ?? null, { reason, add: applied.add, remove: applied.remove, tokens: n });
    const revoked = applied.remove.length > 0 && applied.add.length === 0;
    await discord.audit(revoked ? "⛔ roles revoked" : "🔁 roles updated",
      { user: `<@${uid}>`, reason, tokens: n, added: applied.add.length, removed: applied.remove.length }, revoked ? 0xe05b5b : 0x5be0c8);
  }
  return { tokens: n, roles: want, applied };
}

export async function unlink(uid: string, reason: string) {
  const [b] = await sql<{ wallet: string }[]>`delete from bindings where discord_user_id = ${uid} returning wallet`;
  const applied = await applyRoles(uid, [], reason);
  await auditRow("unlinked", uid, b?.wallet ?? null, { reason, removed: applied?.remove ?? [] });
  await discord.audit("🔓 unlinked", { user: `<@${uid}>`, wallet: b ? maskWallet(b.wallet) : "(none)", reason }, 0xe0b24a);
  return { hadBinding: !!b, removed: applied?.remove ?? [] };
}

/** Scheduled re-check: seats follow the chain, roles follow the seats, unverified members age out. */
export async function sweep(): Promise<SweepSummary> {
  const t0 = Date.now();
  const map = await ownershipMap(true);
  const bindings = await sql<{ discord_user_id: string; wallet: string; roles: string[]; dm_warned_at: string | null }[]>`
    select discord_user_id, wallet, roles, dm_warned_at from bindings order by verified_at`;
  const s: SweepSummary = { checked: 0, changed: 0, revokedAll: 0, left: 0, pruned: 0, dmsOpen: 0, pruneSkipped: "", errors: [], ms: 0, supply: map.size };

  for (const b of bindings) {
    s.checked++;
    try {
      // Re-opened DMs after verifying? Roles come off until they close them and verify again. One warning per day.
      const warnedRecently = b.dm_warned_at && Date.now() - new Date(b.dm_warned_at).getTime() < 86_400_000;
      if (env.requireDmsClosed && b.roles.length && !warnedRecently && tiersReady()) {
        if ((await discord.dmStatus(b.discord_user_id, dmWarning())) === "open") {
          const applied = await applyRoles(b.discord_user_id, [], "server DMs are open; close them and verify again");
          await sql`update bindings set roles = '[]', dm_warned_at = now() where discord_user_id = ${b.discord_user_id}`;
          await auditRow("revoked_dms_open", b.discord_user_id, b.wallet, { removed: applied?.remove ?? [] });
          await discord.audit("⛔ roles revoked · DMs open", { user: `<@${b.discord_user_id}>`, removed: applied?.remove.length ?? 0 }, 0xe05b5b);
          s.dmsOpen++;
          continue;
        }
      }
      if (b.dm_warned_at && !b.roles.length) { continue; }   // still parked until they re-verify
      const owned = [...map].filter(([, o]) => o === b.wallet).map(([t]) => t);
      await sql.begin(async (tx) => {
        await tx`delete from seats where discord_user_id = ${b.discord_user_id} and not (token_id = any(${owned}))`;
        for (const t of owned) {
          await tx`insert into seats (token_id, discord_user_id, wallet) values (${t}, ${b.discord_user_id}, ${b.wallet})
                   on conflict (token_id) do update set discord_user_id = excluded.discord_user_id, wallet = excluded.wallet, claimed_at = now()
                   where seats.wallet <> excluded.wallet`;
        }
      });
      const r = await reevaluate(b.discord_user_id, "scheduled re-check");
      if (!r.applied) { s.left++; continue; }
      if (r.applied.add.length || r.applied.remove.length) s.changed++;
      if (r.applied.remove.length && !r.roles.length) s.revokedAll++;
    } catch (e) {
      s.errors.push(`${b.discord_user_id}: ${(e as Error).message}`);
    }
  }

  if (env.pruneDays > 0 && !tiersReady()) {
    s.pruneSkipped = "tier role ids not configured yet (run provision.py, then env_sync.py --vercel and redeploy)";
  } else if (env.pruneDays > 0) {
    const members = await discord.listMembers();
    if (!members) {
      s.pruneSkipped = "Server Members Intent is off in the Developer Portal";
    } else {
      const managed = new Set(managedRoleIds());
      const cutoff = Date.now() - env.pruneDays * 86_400_000;
      for (const m of members) {
        if (m.user.bot) continue;
        if (m.roles.some((r) => managed.has(r) || (env.teamRoleId && r === env.teamRoleId))) continue;
        if (new Date(m.joined_at).getTime() > cutoff) continue;
        if (await discord.kick(m.user.id, `unverified for ${env.pruneDays}+ day(s)`)) {
          s.pruned++;
          await auditRow("pruned", m.user.id, null, { joined_at: m.joined_at, username: m.user.username });
        }
      }
    }
  }

  await sql`delete from ratelimit where window_start < now() - interval '1 hour'`;
  await sql`delete from nonces where created_at < now() - interval '1 day'`;
  s.ms = Date.now() - t0;
  await auditRow("sweep", null, null, s as never);
  await discord.audit("🧹 sweep", {
    checked: s.checked, changed: s.changed, "revoked all": s.revokedAll, "left server": s.left, pruned: s.pruned, "DMs open": s.dmsOpen,
    supply: s.supply, errors: s.errors.length, note: s.pruneSkipped || undefined, took: `${s.ms} ms`,
  }, s.errors.length ? 0xe05b5b : 0x8fa3b0);
  return s;
}

export async function lookup(q: { uid?: string; wallet?: string }) {
  type Binding = { discord_user_id: string; wallet: string; discord_username: string | null; verified_at: string; last_checked_at: string | null; token_count: number; roles: string[] };
  const rows = q.uid
    ? await sql<Binding[]>`select * from bindings where discord_user_id = ${q.uid}`
    : q.wallet ? await sql<Binding[]>`select * from bindings where wallet = ${q.wallet.toLowerCase()}` : [];
  const b = rows[0];
  if (!b) return null;
  const seats = await sql<{ token_id: string }[]>`select token_id from seats where discord_user_id = ${b.discord_user_id} order by token_id::numeric`;
  return { ...b, seats: seats.map((r) => r.token_id) };
}

export async function stats() {
  const [c] = await sql<{ bindings: number; seats: number; holders_with_roles: number }[]>`
    select (select count(*) from bindings)::int as bindings,
           (select count(*) from seats)::int as seats,
           (select count(*) from bindings where jsonb_array_length(roles) > 0)::int as holders_with_roles`;
  const [last] = await sql<{ at: string; detail: SweepSummary }[]>`select at, detail from audit where kind = 'sweep' order by at desc limit 1`;
  const map = await ownershipMap();
  return { ...c, supply: map.size, wallets: new Set(map.values()).size, lastSweep: last ?? null };
}
