# Operations

| need | do |
|---|---|
| see a member's binding | `/gate lookup user:@name` or `wallet:0x…` in your bot-commands channel |
| re-check everyone now | `/gate sweep` (or `cd app && npm run sweep` from a machine with `.env.local`) |
| remove someone from the gate | `/gate revoke user:@name` — unlinks and strips holder roles |
| numbers | `/gate stats` |
| a holder changes wallet | they run `/unlink`, then `/verify` again |
| "I lost my role" after a sweep | check the audit log: sold/moved (expected) or "DMs open" → they close server DMs and `/verify` again |
| change a tier / add a role / rename a channel | edit `server.toml` → `python3 provision.py` → `python3 env_sync.py --vercel` → redeploy |
| edit the pinned posts only | edit `[messages]` in `server.toml` → `python3 provision.py --messages-only` |
| change the re-check interval | `app/vercel.json` cron (daily on Hobby) and/or the interval in your launchd/cron trigger |
| turn the closed-DMs rule off | `REQUIRE_DMS_CLOSED=false` in the env, redeploy |

## If something goes wrong

- **Raid / mass join:** Server Settings → Invites → Pause invites. AutoMod keeps blocking links and mention spam.
- **Bot token leaked:** Developer Portal → Bot → Reset Token → `python3 intake.py` (bot step) → `python3 env_sync.py --vercel` → redeploy.
- **Client secret leaked:** same, OAuth2 → Reset Secret.
- **Log everyone out of the verify page:** rotate `SESSION_SECRET` in `.env` → `env_sync.py --vercel` → redeploy. Sessions last 15 minutes anyway.
- **Verify page down:** roles already granted stay; nothing is revoked without a successful chain read.
- **"Server Members Intent is off" in the sweep summary:** Developer Portal → Bot → Privileged Gateway Intents.
- **Provisioning again after dropping privileges:** re-authorize the bot with the link pre-flight prints; drop again afterwards.

## What the sweep does, in order

1. Reads the whole collection's ownership in one call.
2. For every linked wallet: seats follow the chain, roles follow the seats. Sold → revoked. Moved to another linked wallet → the seat moves.
3. If the closed-DMs rule is on: probes anyone holding roles (once a day at most); open DMs → roles parked until they close them and verify again.
4. Removes members with no holder role who joined more than `PRUNE_DAYS` ago (never the owner, never bots, never the Team).
5. Posts a summary to the audit-log channel and writes a row to the `audit` table.
