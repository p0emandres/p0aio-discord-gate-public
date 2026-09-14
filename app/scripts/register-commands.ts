// Registers the slash commands on the home server (guild-scoped = instant). Re-run whenever commands change.
import { loadLocalEnv } from "./_env";
import { env } from "../src/lib/env";

loadLocalEnv();
const MANAGE_GUILD = "32";
const commands = [
  { name: "verify", description: "Get the one and only verification link", contexts: [0] },
  { name: "status", description: "Show your linked wallet and holder status", contexts: [0] },
  { name: "unlink", description: "Unlink your wallet and drop holder roles", contexts: [0] },
  {
    name: "gate", description: "Team tools for the holder gate", default_member_permissions: MANAGE_GUILD, contexts: [0],
    options: [
      { type: 1, name: "sweep", description: "Re-check every linked wallet now" },
      { type: 1, name: "revoke", description: "Unlink a member and remove their holder roles", options: [{ type: 6, name: "user", description: "Member", required: true }] },
      { type: 1, name: "lookup", description: "Find a binding by member or wallet", options: [
        { type: 6, name: "user", description: "Member" }, { type: 3, name: "wallet", description: "0x address" } ] },
      { type: 1, name: "stats", description: "Gate statistics" },
    ],
  },
];

async function main() {
  const res = await fetch(`https://discord.com/api/v10/applications/${env.appId}/guilds/${env.guildId}/commands`, {
    method: "PUT", headers: { Authorization: `Bot ${env.botToken}`, "Content-Type": "application/json", "User-Agent": "DiscordBot (discord-nft-gate, 0.1)" },
    body: JSON.stringify(commands),
  });
  const j = (await res.json()) as { name: string }[] | { message: string };
  if (!res.ok) { console.error("failed:", res.status, j); process.exit(1); }
  console.log("registered:", (j as { name: string }[]).map((c) => c.name).join(", "));
}
main().catch((e) => { console.error(e); process.exit(1); });
