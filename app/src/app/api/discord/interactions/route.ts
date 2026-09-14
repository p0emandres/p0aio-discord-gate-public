// Discord → us. Every request is Ed25519-signed by Discord; nothing else gets past the first line.
import { after, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { discord, maskWallet, verifyInteraction } from "@/lib/discord";
import { env } from "@/lib/env";
import { lookup, sweep, stats, unlink, type SweepSummary } from "@/lib/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EPHEMERAL = 64;
const reply = (content: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ type: 4, data: { content, flags: EPHEMERAL, ...extra } });

type Opt = { name: string; value?: string | number | boolean; options?: Opt[] };
type Interaction = {
  type: number; token: string; guild_id?: string;
  member?: { user: { id: string; username: string }; roles: string[]; permissions: string };
  data?: { name: string; options?: Opt[] };
};

function fmtSweep(s: SweepSummary) {
  return `🧹 sweep done in ${s.ms} ms · checked ${s.checked} · changed ${s.changed} · fully revoked ${s.revokedAll} · left server ${s.left} · pruned ${s.pruned}` +
    (s.pruneSkipped ? `\n⚠️ prune skipped: ${s.pruneSkipped}` : "") + (s.errors.length ? `\n❌ ${s.errors.length} error(s): ${s.errors.slice(0, 3).join(" | ")}` : "");
}

export async function POST(req: Request) {
  const body = await req.text();
  if (!verifyInteraction(req.headers.get("x-signature-ed25519"), req.headers.get("x-signature-timestamp"), body)) {
    return new NextResponse("invalid request signature", { status: 401 });
  }
  const i = JSON.parse(body) as Interaction;
  if (i.type === 1) return NextResponse.json({ type: 1 });
  if (i.type !== 2 || !i.data || !i.member) return reply("Unsupported interaction.");
  if (i.guild_id !== env.guildId) return reply("This bot only works inside its home server.");

  const uid = i.member.user.id;
  const who = i.member.user.username;
  const isTeam = (env.teamRoleId && i.member.roles.includes(env.teamRoleId)) || (BigInt(i.member.permissions || "0") & (1n << 5n)) !== 0n;

  try {
    switch (i.data.name) {
      case "verify":
        return reply(
          `**Verify at ${env.origin}** — that is the only link, ever.\nLog in with Discord, connect the wallet holding your ${env.projectName}, sign the free message. Roles land in seconds.\n\n🔒 **First, close your DMs for this server:** right-click the server icon → Privacy Settings → Direct Messages OFF. Verification checks it.\n⚠️ The only DM this bot ever sends is a warning that your DMs are open. It never sends links. Anyone else DMing you is a scammer.`,
          { components: [{ type: 1, components: [{ type: 2, style: 5, label: `Open ${env.verifyDomain}`, url: env.origin }] }] },
        );
      case "status": {
        const [b] = await sql<{ wallet: string; token_count: number; verified_at: string; last_checked_at: string | null }[]>`
          select wallet, token_count, verified_at, last_checked_at from bindings where discord_user_id = ${uid}`;
        if (!b) return reply("You have not verified yet. Run `/verify`.");
        const t = (d: string | null) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>` : "never");
        return reply(`Wallet **${maskWallet(b.wallet)}** · **${b.token_count}** ${env.projectName} · verified ${t(b.verified_at)} · last re-check ${t(b.last_checked_at)}`);
      }
      case "unlink": {
        const r = await unlink(uid, "user ran /unlink");
        return reply(r.hadBinding ? "Unlinked. Your holder roles were removed. Run `/verify` any time to link again." : "Nothing was linked.");
      }
      case "gate": {
        if (!isTeam) return reply("Team only.");
        const sub = i.data.options?.[0];
        const o = Object.fromEntries((sub?.options ?? []).map((x) => [x.name, x.value])) as Record<string, string>;
        switch (sub?.name) {
          case "sweep":
            after(async () => {
              try { await discord.editOriginal(i.token, { content: fmtSweep(await sweep()) }); }
              catch (e) { await discord.editOriginal(i.token, { content: `sweep failed: ${(e as Error).message}` }); }
            });
            return NextResponse.json({ type: 5, data: { flags: EPHEMERAL } });
          case "revoke": {
            const r = await unlink(o.user, `revoked by ${who}`);
            return reply(r.hadBinding ? `Revoked <@${o.user}> (removed ${r.removed.length} role(s)).` : `<@${o.user}> had no binding` + (r.removed.length ? `; removed ${r.removed.length} stray role(s).` : "."));
          }
          case "lookup": {
            const r = await lookup({ uid: o.user, wallet: o.wallet });
            if (!r) return reply("No binding found.");
            return reply(`<@${r.discord_user_id}> ↔ \`${r.wallet}\` · ${r.seats.length} seat(s): ${r.seats.join(", ") || "none"} · verified <t:${Math.floor(new Date(r.verified_at as string).getTime() / 1000)}:R>`);
          }
          case "stats": {
            const s = await stats();
            const last = s.lastSweep ? `<t:${Math.floor(new Date(s.lastSweep.at).getTime() / 1000)}:R>` : "never";
            return reply(`Bindings **${s.bindings}** · with roles **${s.holders_with_roles}** · seats **${s.seats}** / supply **${s.supply}** held by **${s.wallets}** wallets · last sweep ${last}`);
          }
        }
        return reply("Unknown subcommand.");
      }
    }
    return reply("Unknown command.");
  } catch (e) {
    console.error("interaction error", e);
    return reply("Something went wrong on our side. The Team has been notified.");
  }
}
