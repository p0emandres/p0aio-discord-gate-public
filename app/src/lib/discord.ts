// Thin Discord REST client (bot token) + interaction signature check. No gateway, no library.
import { createPublicKey, verify as edVerify } from "node:crypto";
import { env } from "./env";

const API = "https://discord.com/api/v10";
const UA = "DiscordBot (discord-nft-gate, 0.1)";

export type Member = { user: { id: string; username: string; bot?: boolean }; roles: string[]; joined_at: string };

async function rest<T = unknown>(method: string, path: string, body?: unknown, reason?: string): Promise<{ status: number; data: T }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const headers: Record<string, string> = { Authorization: `Bot ${env.botToken}`, "User-Agent": UA, Accept: "application/json" };
    if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    if (res.status === 429) {
      const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((r) => setTimeout(r, ((j.retry_after ?? 1) + 0.25) * 1000));
      continue;
    }
    const text = await res.text();
    let data: unknown = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
    if (res.status >= 500 && attempt < 2) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
    return { status: res.status, data: data as T };
  }
  return { status: 0, data: { message: "gave up" } as T };
}

export const discord = {
  async getMember(uid: string): Promise<Member | null> {
    const r = await rest<Member>("GET", `/guilds/${env.guildId}/members/${uid}`);
    return r.status === 200 ? r.data : null;
  },
  async addRole(uid: string, roleId: string, reason: string) {
    const r = await rest("PUT", `/guilds/${env.guildId}/members/${uid}/roles/${roleId}`, undefined, reason);
    if (r.status !== 204) throw new Error(`addRole ${roleId} → HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  },
  async removeRole(uid: string, roleId: string, reason: string) {
    const r = await rest("DELETE", `/guilds/${env.guildId}/members/${uid}/roles/${roleId}`, undefined, reason);
    if (r.status !== 204) throw new Error(`removeRole ${roleId} → HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  },
  async kick(uid: string, reason: string) {
    if (env.dryRoles) { console.warn("GATE_DRY_ROLES: not kicking", uid); return false; }
    const r = await rest("DELETE", `/guilds/${env.guildId}/members/${uid}`, undefined, reason);
    return r.status === 204;
  },
  /** Needs the Server Members privileged intent. Returns null (not []) when Discord refuses. */
  async listMembers(): Promise<Member[] | null> {
    const out: Member[] = [];
    let after = "0";
    for (let i = 0; i < 50; i++) {
      const r = await rest<Member[]>("GET", `/guilds/${env.guildId}/members?limit=1000&after=${after}`);
      if (r.status !== 200) return null;
      out.push(...r.data);
      if (r.data.length < 1000) break;
      after = r.data[r.data.length - 1].user.id;
    }
    return out;
  },
  async send(channelId: string, payload: unknown) {
    if (env.dryRoles) { console.warn("GATE_DRY_ROLES: not posting", channelId); return { status: 200, data: {} }; }
    return rest("POST", `/channels/${channelId}/messages`, payload);
  },
  async editOriginal(interactionToken: string, payload: unknown) {
    return rest("PATCH", `/webhooks/${env.appId}/${interactionToken}/messages/@original`, payload);
  },
  /**
   * The only way to learn whether a member accepts DMs from this server is to try. "closed" = Discord refused
   * (code 50007), which is what we want. "open" = the message was delivered, so a scammer could reach them too.
   */
  async dmStatus(uid: string, content: string): Promise<"open" | "closed" | "unknown"> {
    if (env.dryRoles) return "closed";
    const ch = await rest<{ id?: string; code?: number }>("POST", "/users/@me/channels", { recipient_id: uid });
    if (ch.status !== 200 || !ch.data.id) return "unknown";
    const msg = await rest<{ code?: number }>("POST", `/channels/${ch.data.id}/messages`, { content });
    if (msg.status === 200) return "open";
    if (msg.status === 403 && msg.data.code === 50007) return "closed";
    return "unknown";
  },
  /** Best-effort line in #audit-log. Never throws. */
  async audit(kind: string, fields: Record<string, string | number | undefined>, color = 0x5be0c8) {
    if (!env.auditChannelId || env.dryRoles) return;
    const embed = {
      title: kind,
      color,
      timestamp: new Date().toISOString(),
      fields: Object.entries(fields).filter(([, v]) => v !== undefined && v !== "").map(([name, value]) => ({ name, value: String(value), inline: true })),
    };
    await rest("POST", `/channels/${env.auditChannelId}/messages`, { embeds: [embed] }).catch(() => {});
  },
};

/** Ed25519 check Discord requires on every interaction. */
export function verifyInteraction(signature: string | null, timestamp: string | null, rawBody: string): boolean {
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(env.publicKey, "hex")]),
      format: "der",
      type: "spki",
    });
    return edVerify(null, Buffer.from(timestamp + rawBody), key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

export const maskWallet = (w: string) => (w ? `${w.slice(0, 6)}…${w.slice(-4)}` : "");
