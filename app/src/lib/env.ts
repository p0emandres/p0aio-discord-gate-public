// Every secret and setting the verifier needs. Lazy getters so `next build` doesn't need a full env.
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}
function opt(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export type Tier = { role_id: string; min: number; role: string };

export const env = {
  get botToken() { return req("DISCORD_BOT_TOKEN"); },
  get appId() { return req("DISCORD_APP_ID"); },
  get publicKey() { return req("DISCORD_PUBLIC_KEY"); },
  get clientSecret() { return req("DISCORD_CLIENT_SECRET"); },
  get guildId() { return req("DISCORD_GUILD_ID"); },
  get rpcUrl() { return req("RPC_URL"); },
  get collection() { return req("COLLECTION_ADDRESS").toLowerCase() as `0x${string}`; },
  get chainId() { return Number(opt("CHAIN_ID", "1")); },
  get databaseUrl() { return req("DATABASE_URL"); },
  get sessionSecret() {
    const s = req("SESSION_SECRET");
    if (s.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    return s;
  },
  get cronSecret() { return req("CRON_SECRET"); },
  get verifyDomain() { return req("VERIFY_DOMAIN").toLowerCase(); },
  /** Absolute origin of this deployment. Production = https://<VERIFY_DOMAIN>; local dev overrides. */
  get origin() { return opt("PUBLIC_ORIGIN", `https://${this.verifyDomain}`); },
  get tiers(): Tier[] {
    const t = JSON.parse(req("GATE_TIERS")) as Tier[];
    if (!Array.isArray(t) || !t.length) throw new Error("GATE_TIERS must be a non-empty JSON array");
    return t.slice().sort((a, b) => a.min - b.min);
  },
  get auditChannelId() { return opt("AUDIT_CHANNEL_ID", ""); },
  /** Public confirmation is posted here after a successful verification. */
  get verifyChannelId() { return opt("VERIFY_CHANNEL_ID", ""); },
  /** Where a fresh holder is sent (deep link + mention in the confirmation). */
  get landingChannelId() { return opt("LANDING_CHANNEL_ID", ""); },
  get teamRoleId() { return opt("TEAM_ROLE_ID", ""); },
  get pruneDays() { return Number(opt("PRUNE_DAYS", "0")); },
  get sweepHours() { return Number(opt("SWEEP_HOURS", "6")); },
  get projectName() { return opt("PROJECT_NAME", "NFT"); },
  /** Verification requires "Allow direct messages from server members" to be OFF for this server. */
  get requireDmsClosed() { return opt("REQUIRE_DMS_CLOSED", "true") !== "false"; },
  /** /verify refuses Discord accounts younger than this many days (0 = off). Throwaway raid accounts are hours old. */
  get minAccountAgeDays() { return Number(opt("MIN_ACCOUNT_AGE_DAYS", "0")); },
  /** TEST ONLY. When "1", no role changes, no channel posts, no DM probes ever reach Discord. Reads still work. */
  get dryRoles() { return opt("GATE_DRY_ROLES", "0") === "1"; },
};
