# discord-nft-gate

Self-hosted NFT-holder gating for a Discord server. No third-party verification bot, no custody, no
transactions. Built for the p0aio community and published so holders can read exactly what the verify
page does.

**What a holder experiences:** close server DMs → `/verify` → one link → log in with Discord → connect a
wallet → sign a free message → roles appear → straight back into the Discord app.

**What the server operator gets:** a script that collects and live-checks every credential, a script that
builds (and repairs) the whole Discord server from one config file, a small Next.js service that verifies
wallets and manages roles, a scheduled re-check that revokes on sale, and an audit log of everything.

## Security model, in one screen

| threat | answer |
|---|---|
| fake verify links / drainer sites | one fixed domain, pinned in the server; the page shows which host you are on and refuses to be framed |
| "sign this" that is really a transaction | the only thing ever signed is an EIP-4361 (Sign-In-With-Ethereum) text message bound to the domain, a single-use nonce, the Discord user and the wallet, valid 5 minutes |
| replay / edited messages / another key | rejected server-side; the nonce is consumed atomically and the stored text must match byte-for-byte |
| one NFT verifying many accounts | one seat per token; the newest valid claim wins and the previous account loses its roles |
| selling and keeping the role | a sweep re-reads the chain (Alchemy NFT API) and strips roles; the cron is the floor, a local trigger can run it more often |
| scammers DMing holders | verification requires "allow DMs from server members" to be OFF for the server; the bot checks by trying, and the delivered probe is itself the only DM it will ever send |
| forged bot traffic | every Discord interaction is Ed25519-verified; commands from other servers are refused; team commands need the Team role or Manage Server |
| a leaked bot token | the bot runs with seven permissions (no Administrator, no Manage Server); build-time extras are dropped after provisioning |
| the browser lying | nothing from the client is trusted: identity comes from Discord OAuth, the wallet from the signature, holdings from the chain |
| floods / scripted abuse | shared rate limits in Postgres: per IP on login start/callback/challenge/verify/status, per user on challenges and slash commands, a global ceiling on chain-touching calls; optional minimum Discord account age for `/verify` |
| CSRF / session theft | same-origin checks on every state change, HMAC-signed 15-minute session cookie, `httpOnly`/`secure`/`sameSite`, strict CSP + HSTS |

Secrets live in `.env` (mode 600) and your host's env store. Nothing sensitive is in any file this repo asks you to commit.

## Layout

```
intake.py              collect + verify credentials → .env (secrets) + gate.config.json (not secret)
server.example.toml    desired state of the Discord server → copy to server.toml
provision.py           build / repair the server from server.toml (idempotent, never deletes)
env_sync.py            assemble the app's env from the files above (--local, --vercel, --pull-db)
sweep_trigger.sh       optional: call the sweep endpoint from a machine you control
launchd/               optional macOS schedule for the trigger
app/                   the verify service (Next.js): verify page, Discord interactions, cron sweep
docs/OPERATIONS.md     day-to-day runbook
```

## Requirements

- Python 3.11+ (stdlib only), Node 20+, a Postgres database (Neon/Supabase free tiers work)
- A Discord application with a bot, an Alchemy API key (Ethereum) — Solana intake exists but the holder lookup is Ethereum-only today
- A domain for the verify page; Vercel is the tested host (Hobby plan is enough: daily cron + the local trigger)

## Setup

1. `python3 intake.py` — answers are validated live: the bot token, the server (prints an invite link with the exact permission set), the RPC key, the collection contract, the OAuth client secret, your domain and policy (re-check hours, prune days, tiers). Discord Developer Portal: Public Bot **off**, Server Members Intent **on**, add `https://<domain>/api/auth/discord/callback` under OAuth2 → Redirects.
2. `cp server.example.toml server.toml` and edit it. Then `python3 provision.py --dry-run`, read the plan, `python3 provision.py`. Pre-flight tells you exactly what the owner has to click (drag the bot's role to the top; re-authorize if the bot lacks a permission it must hand out; give it View on any channel it cannot see).
3. Database: `vercel integration add neon` from `app/` (or paste any Postgres URL in the intake), then `python3 env_sync.py --pull-db`.
4. `python3 env_sync.py --vercel` pushes the env; `cd app && npm install && npm run migrate && npm run register-commands`; `vercel deploy --prod`. Set the Interactions Endpoint URL to `https://<domain>/api/discord/interactions` in the Developer Portal (it must be deployed first).
5. `python3 provision.py --drop-privileges`, then trim the bot's role by hand to the runtime set (Discord never lets a bot edit its own top role). Owner-only toggles: 2FA for moderators; a member-profile AutoMod rule for impersonation (bots cannot create those).

## Tests

```
cd app
DATABASE_URL=postgres://… npx tsx scripts/seat-test.ts               # one-seat-per-NFT rules against a mock chain
BASE=http://localhost:3999 KEYFILE=… npx tsx scripts/e2e.ts          # full HTTP flow against a local `next start`
```

## Discord rules you will hit (all handled, all documented in the scripts' messages)

- A bot can only hand out permissions it holds → pre-flight computes the union and prints a re-authorize link.
- Overwrite bits must be held in the parent category, and a bot may never grant itself Manage Roles via overwrite.
- A bot cannot edit a channel or category it cannot see, and there is no API workaround.
- Pinning needs the newer `PIN_MESSAGES` permission.
- Member-profile AutoMod rules are owner-only. Channel name/topic edits are rate-limited to 2 per 10 minutes.
- Vercel Hobby allows one cron per day, hence `sweep_trigger.sh`.

## License

MIT.
