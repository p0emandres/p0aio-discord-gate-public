#!/usr/bin/env python3
"""
provision.py — build / repair the Discord server from server.toml. Idempotent. Never deletes.

  python3 provision.py --dry-run          show the plan, change nothing
  python3 provision.py                    apply (roles → positions → @everyone → channels → AutoMod → guild → pins)
  python3 provision.py --drop-privileges  after the build: shrink the bot's own role to [bot].runtime_permissions
  python3 provision.py --status           print what the server looks like right now

Reads  .env (DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_APP_ID), gate.config.json, server.toml
Writes server.state.json — every ID the verifier needs (roles, tiers, audit channel).
"""
import json, os, sys, time, tomllib, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API = "https://discord.com/api/v10"
UA = "DiscordBot (discord-nft-gate-provision, 0.1)"
MARK = "gate · managed"      # footer marker on bot-owned pinned messages

P = {  # Discord permission bits
    "CREATE_INSTANT_INVITE": 1 << 0, "KICK_MEMBERS": 1 << 1, "BAN_MEMBERS": 1 << 2, "ADMINISTRATOR": 1 << 3,
    "MANAGE_CHANNELS": 1 << 4, "MANAGE_GUILD": 1 << 5, "ADD_REACTIONS": 1 << 6, "VIEW_AUDIT_LOG": 1 << 7,
    "PRIORITY_SPEAKER": 1 << 8, "STREAM": 1 << 9, "VIEW_CHANNEL": 1 << 10, "SEND_MESSAGES": 1 << 11,
    "SEND_TTS_MESSAGES": 1 << 12, "MANAGE_MESSAGES": 1 << 13, "EMBED_LINKS": 1 << 14, "ATTACH_FILES": 1 << 15,
    "READ_MESSAGE_HISTORY": 1 << 16, "MENTION_EVERYONE": 1 << 17, "USE_EXTERNAL_EMOJIS": 1 << 18,
    "VIEW_GUILD_INSIGHTS": 1 << 19, "CONNECT": 1 << 20, "SPEAK": 1 << 21, "MUTE_MEMBERS": 1 << 22,
    "DEAFEN_MEMBERS": 1 << 23, "MOVE_MEMBERS": 1 << 24, "USE_VAD": 1 << 25, "CHANGE_NICKNAME": 1 << 26,
    "MANAGE_NICKNAMES": 1 << 27, "MANAGE_ROLES": 1 << 28, "MANAGE_WEBHOOKS": 1 << 29,
    "MANAGE_GUILD_EXPRESSIONS": 1 << 30, "USE_APPLICATION_COMMANDS": 1 << 31, "REQUEST_TO_SPEAK": 1 << 32,
    "MANAGE_EVENTS": 1 << 33, "MANAGE_THREADS": 1 << 34, "CREATE_PUBLIC_THREADS": 1 << 35,
    "CREATE_PRIVATE_THREADS": 1 << 36, "USE_EXTERNAL_STICKERS": 1 << 37, "SEND_MESSAGES_IN_THREADS": 1 << 38,
    "USE_EMBEDDED_ACTIVITIES": 1 << 39, "MODERATE_MEMBERS": 1 << 40, "USE_SOUNDBOARD": 1 << 42,
    "CREATE_GUILD_EXPRESSIONS": 1 << 43, "CREATE_EVENTS": 1 << 44, "USE_EXTERNAL_SOUNDS": 1 << 45,
    "SEND_VOICE_MESSAGES": 1 << 46, "SEND_POLLS": 1 << 49, "USE_EXTERNAL_APPS": 1 << 50, "PIN_MESSAGES": 1 << 51,
}
CHANNEL_TYPES = {"text": 0, "voice": 2, "category": 4}

DRY = False
CHANGES = []

def c(code, s): return f"\033[{code}m{s}\033[0m" if sys.stdout.isatty() else s
def ok(s):   print(c("32", "  ✔ ") + s)
def warn(s): print(c("33", "  ⚠ ") + s)
def bad(s):  print(c("31", "  ✘ ") + s)
def plan(s):
    CHANGES.append(s)
    print(c("36", "  → ") + s)
def head(s): print("\n" + c("1;36", s))
def same(s): print(c("2", "  = " + s))

def bits(names):
    out = 0
    for n in names:
        if n not in P:
            sys.exit(f"unknown permission name in server.toml: {n}")
        out |= P[n]
    return out

def names(b):
    b = int(b)
    return [n for n, v in P.items() if b & v]

# ---------------------------------------------------------------- env / http
def load_env():
    d = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] == '"':
            v = v[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        d[k.strip()] = v
    return d

class Discord:
    def __init__(self, token):
        self.token = token
    def req(self, method, path, body=None, reason=None):
        for attempt in range(6):
            h = {"User-Agent": UA, "Authorization": f"Bot {self.token}", "Accept": "application/json"}
            if reason:
                h["X-Audit-Log-Reason"] = urllib.parse.quote(reason)
            data = None
            if body is not None:
                data = json.dumps(body).encode(); h["Content-Type"] = "application/json"
            r = urllib.request.Request(API + path, data=data, headers=h, method=method)
            try:
                with urllib.request.urlopen(r, timeout=30) as resp:
                    raw, st = resp.read(), resp.status
            except urllib.error.HTTPError as e:
                raw, st = e.read(), e.code
            try:
                js = json.loads(raw) if raw else {}
            except ValueError:
                js = {"message": raw[:200].decode(errors="replace")}
            if st == 429:
                wait = float(js.get("retry_after", 1.0)) + 0.2
                warn(f"rate limited on {method} {path}; waiting {wait:.1f}s")
                time.sleep(wait); continue
            if st >= 500 and attempt < 3:
                time.sleep(1.5 * (attempt + 1)); continue
            return st, js
        return 0, {"message": "gave up after retries"}
    def get(self, path):                     return self.req("GET", path)
    def post(self, path, body, reason=None): return self.req("POST", path, body, reason)
    def patch(self, path, body, reason=None):return self.req("PATCH", path, body, reason)
    def put(self, path, body=None, reason=None): return self.req("PUT", path, body, reason)

import urllib.parse  # noqa: E402  (used in req)

def must(st, js, what):
    if st not in (200, 201, 204):
        bad(f"{what}: HTTP {st}: {js.get('message', js)}" + (f" · errors={json.dumps(js.get('errors'))[:400]}" if js.get("errors") else ""))
        return False
    return True

# ---------------------------------------------------------------- steps
def step_preflight(d, env, cfg, roles, bot_member):
    head("Pre-flight")
    st, app = d.get("/oauth2/applications/@me")
    if st == 200:
        if app.get("bot_public"):
            warn("PUBLIC BOT is still ON in the Developer Portal → Bot. Turn it off.")
        flags = app.get("flags", 0) or 0
        if not flags & ((1 << 14) | (1 << 15)):
            warn("SERVER MEMBERS INTENT is OFF → the sweeper cannot list members (no auto-prune, no bulk re-check). "
                 "Developer Portal → Bot → Privileged Gateway Intents.")
    bot_role = next((r for r in roles if (r.get("tags") or {}).get("bot_id") == env["DISCORD_APP_ID"]), None)
    if not bot_role:
        sys.exit("could not find the bot's managed role in this server — is the bot invited?")
    bot_pos = bot_role["position"]
    have = int(bot_role["permissions"])
    # Discord lets a bot grant only permissions it holds itself, so the build set is the UNION of everything in server.toml.
    need_bits = bits(["MANAGE_ROLES", "MANAGE_CHANNELS", "MANAGE_GUILD", "VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY",
                      "MODERATE_MEMBERS", "KICK_MEMBERS", "EMBED_LINKS", "MANAGE_MESSAGES", "VIEW_AUDIT_LOG"])
    for r in cfg["roles"]:
        need_bits |= bits(r.get("permissions", []))
    for spec in cfg["categories"] + cfg["channels"]:
        for ow in (spec.get("overwrites") or {}).values():
            need_bits |= bits(ow.get("allow", [])) | bits(ow.get("deny", []))
    missing = [] if have & P["ADMINISTRATOR"] else [n for n, b in P.items() if need_bits & b and not have & b]
    if missing and "--ignore-missing" in sys.argv:
        warn("proceeding without " + ", ".join(missing) + " (--ignore-missing): steps that need them will warn")
        missing = []
    if missing:
        bad("the bot cannot hand out permissions it does not hold. Missing: " + ", ".join(missing))
        url = (f"https://discord.com/oauth2/authorize?client_id={env['DISCORD_APP_ID']}&scope=bot%20applications.commands"
               f"&permissions={have | need_bits}&guild_id={env['DISCORD_GUILD_ID']}&disable_guild_select=true")
        print(c("1", f"\n  FIX (owner, 10 seconds): open this link, approve, then re-run. It only ADDS the listed permissions to the bot's role\n"
                     f"  for the build; `provision.py --drop-privileges` removes them again afterwards.\n  {url}\n"))
        sys.exit(1)
    ok(f"bot role “{bot_role['name']}” position {bot_pos}, holds every permission the build hands out")
    # hierarchy: every role we manage must sit BELOW the bot role
    wanted = {r["name"] for r in cfg["roles"]}
    above = [r for r in roles if r["name"] in wanted and r["position"] >= bot_pos and r["id"] != bot_role["id"]]
    if above:
        bad("these roles sit at or above the bot's role, so the bot cannot edit or assign them: "
            + ", ".join(f"{r['name']} (pos {r['position']})" for r in above))
        print(c("1", "\n  FIX (10 seconds, owner only): Discord → Server Settings → Roles → drag the bot to the TOP of the list "
                    "(just under your own role), Save, then re-run this script.\n"))
        sys.exit(1)
    ok("role hierarchy is fine: bot role is above every role it manages")
    return bot_role

def step_roles(d, env, cfg, roles):
    head("Roles")
    gid = env["DISCORD_GUILD_ID"]
    by_name = {r["name"]: r for r in roles}
    ids = {}
    for spec in cfg["roles"]:
        want = {
            "name": spec["name"],
            "permissions": str(bits(spec.get("permissions", []))),
            "color": int(spec.get("color", "000000"), 16),
            "hoist": bool(spec.get("hoist", False)),
            "mentionable": bool(spec.get("mentionable", False)),
        }
        cur = by_name.get(spec["name"])
        if cur:
            diff = {k: v for k, v in want.items() if k != "name" and (str(cur.get(k)) != str(v))}
            if diff:
                plan(f"update role {spec['name']}: " + ", ".join(f"{k}→{('+'.join(names(v)) or 'none') if k == 'permissions' else v}" for k, v in diff.items()))
                if not DRY:
                    st, js = d.patch(f"/guilds/{gid}/roles/{cur['id']}", want, "provision: role sync")
                    must(st, js, f"update role {spec['name']}")
            else:
                same(f"role {spec['name']}")
            ids[spec["name"]] = cur["id"]
        else:
            plan(f"create role {spec['name']} ({'+'.join(names(want['permissions'])) or 'no perms'})")
            if not DRY:
                st, js = d.post(f"/guilds/{gid}/roles", want, "provision: create role")
                if must(st, js, f"create role {spec['name']}"):
                    ids[spec["name"]] = js["id"]
            else:
                ids[spec["name"]] = f"<new:{spec['name']}>"
    return ids

def step_positions(d, env, cfg, roles, role_ids, bot_role):
    head("Role order")
    gid = env["DISCORD_GUILD_ID"]
    # desired, top→bottom, all strictly below the bot role: Team, tiers (highest tier first), then the rest in config order
    tiers = sorted([r for r in cfg["roles"] if "tier" in r], key=lambda r: -r["tier"])
    order = [r["name"] for r in cfg["roles"] if r["name"] == "Team"] + [r["name"] for r in tiers] + \
            [r["name"] for r in cfg["roles"] if r["name"] != "Team" and "tier" not in r]
    order = [n for n in order if n in role_ids and not str(role_ids[n]).startswith("<new")]
    pos = bot_role["position"] - 1
    payload, changed = [], False
    cur_pos = {r["id"]: r["position"] for r in roles}
    for n in order:
        payload.append({"id": role_ids[n], "position": max(pos, 1)})
        if cur_pos.get(role_ids[n]) != max(pos, 1):
            changed = True
        pos -= 1
    if not changed:
        same("role order already " + " > ".join(order)); return
    plan("set role order: " + bot_role["name"] + " > " + " > ".join(order))
    if not DRY and payload:
        st, js = d.patch(f"/guilds/{gid}/roles", payload, "provision: role order")
        must(st, js, "role positions")

def step_everyone(d, env, cfg, roles):
    head("@everyone")
    gid = env["DISCORD_GUILD_ID"]
    ev = next(r for r in roles if r["id"] == gid)
    want = str(bits(cfg["everyone"]["permissions"]))
    if ev["permissions"] == want:
        same("@everyone permissions"); return
    plan(f"@everyone permissions: {'+'.join(names(ev['permissions'])) or 'none'} → {'+'.join(names(want)) or 'none'}")
    if not DRY:
        st, js = d.patch(f"/guilds/{gid}/roles/{gid}", {"permissions": want}, "provision: lock @everyone")
        must(st, js, "@everyone")

# Discord only lets a bot set overwrite bits it effectively holds in the PARENT (or the guild for categories), and it may
# never grant itself MANAGE_ROLES via overwrite. So during the build the bot's own overwrite carries every bit any
# overwrite in server.toml mentions (that it holds at guild level). --drop-privileges shrinks it back to the config.
BUILD_HELD = 0   # set in main(): the bot role's guild-level permission bits

def all_overwrite_bits(cfg):
    b = P["VIEW_CHANNEL"]
    for spec in cfg["categories"] + cfg["channels"]:
        for ow in (spec.get("overwrites") or {}).values():
            b |= bits(ow.get("allow", [])) | bits(ow.get("deny", []))
    return b & ~P["MANAGE_ROLES"]

def resolve_overwrites(ow_spec, role_ids, gid, bot_role_id, build=True, cfg=None):
    out = []
    ow_spec = dict(ow_spec or {})
    if build:
        b = dict(ow_spec.get("bot") or {})
        extra = all_overwrite_bits(cfg) & BUILD_HELD if cfg else P["VIEW_CHANNEL"]
        held = (bits(b.get("allow", [])) | extra) & (BUILD_HELD or ~0)   # never ask for a bit the bot doesn't hold yet
        b["allow"] = sorted(names(held))
        ow_spec["bot"] = b
    for target, spec in ow_spec.items():
        if target == "@everyone":
            tid = gid
        elif target == "bot":
            tid = bot_role_id
        elif target in role_ids and not str(role_ids[target]).startswith("<new"):
            tid = role_ids[target]
        elif target in role_ids:
            tid = f"<new:{target}>"   # dry run: role not created yet
        else:
            sys.exit(f"overwrite target '{target}' is not a role in server.toml")
        out.append({"id": str(tid), "type": 0, "allow": str(bits(spec.get("allow", []))), "deny": str(bits(spec.get("deny", []))) })
    return sorted(out, key=lambda o: o["id"])

def norm_ow(lst):
    return sorted([{"id": str(o["id"]), "type": int(o["type"]), "allow": str(o["allow"]), "deny": str(o["deny"])} for o in (lst or [])
                   if not (str(o["allow"]) == "0" and str(o["deny"]) == "0")], key=lambda o: o["id"])

def find_channel(chans, spec, ctype):
    for key in ("name", "match"):
        n = spec.get(key)
        if n:
            hit = next((ch for ch in chans if ch["type"] == ctype and ch["name"] == n), None)
            if hit:
                return hit
    return None

def step_channels(d, env, cfg, chans, role_ids, bot_role_id):
    head("Categories + channels")
    gid = env["DISCORD_GUILD_ID"]
    cat_ids, cat_ow, chan_ids = {}, {}, {}
    for spec in cfg["categories"]:
        ow = resolve_overwrites(spec.get("overwrites"), role_ids, gid, bot_role_id, cfg=cfg)
        cat_ow[spec["name"]] = ow
        cur = find_channel(chans, spec, 4)
        if cur:
            diff = []
            if cur["name"] != spec["name"]:
                diff.append(f"rename {cur['name']}→{spec['name']}")
            if norm_ow(cur.get("permission_overwrites")) != norm_ow(ow):
                diff.append("overwrites")
            if diff:
                plan(f"update category {spec['name']}: " + ", ".join(diff))
                if not DRY:
                    st, js = d.patch(f"/channels/{cur['id']}", {"name": spec["name"], "permission_overwrites": ow}, "provision: category sync")
                    if st == 403 and js.get("code") == 50001:
                        bad(f"category {spec['name']}: the bot cannot SEE it. In Discord: Edit Category → Permissions → add role "
                            f"the bot with View Channel ✓, then re-run.")
                    else:
                        must(st, js, f"category {spec['name']}")
            else:
                same(f"category {spec['name']}")
            cat_ids[spec["name"]] = cur["id"]
        else:
            plan(f"create category {spec['name']}")
            if not DRY:
                st, js = d.post(f"/guilds/{gid}/channels", {"name": spec["name"], "type": 4, "permission_overwrites": ow}, "provision: create category")
                if must(st, js, f"create category {spec['name']}"):
                    cat_ids[spec["name"]] = js["id"]
            else:
                cat_ids[spec["name"]] = f"<new:{spec['name']}>"

    for spec in cfg["channels"]:
        ctype = CHANNEL_TYPES[spec.get("type", "text")]
        ow = resolve_overwrites(spec["overwrites"], role_ids, gid, bot_role_id, cfg=cfg) if "overwrites" in spec else cat_ow[spec["category"]]
        parent = cat_ids[spec["category"]]
        body = {"name": spec["name"], "parent_id": parent, "permission_overwrites": ow}
        if ctype == 0:
            body["topic"] = spec.get("topic", "")
            body["rate_limit_per_user"] = int(spec.get("slowmode", 0))
            body["nsfw"] = False
        cur = find_channel(chans, spec, ctype)
        if cur:
            diff = []
            if cur["name"] != spec["name"]: diff.append(f"rename {cur['name']}→{spec['name']}")
            if str(cur.get("parent_id")) != str(parent): diff.append(f"move to {spec['category']}")
            if ctype == 0 and (cur.get("topic") or "") != body["topic"]: diff.append("topic")
            if ctype == 0 and int(cur.get("rate_limit_per_user") or 0) != body["rate_limit_per_user"]: diff.append(f"slowmode {body['rate_limit_per_user']}s")
            if norm_ow(cur.get("permission_overwrites")) != norm_ow(ow): diff.append("overwrites")
            if diff:
                plan(f"update #{spec['name']}: " + ", ".join(diff))
                if not DRY:
                    st, js = d.patch(f"/channels/{cur['id']}", body, "provision: channel sync")
                    if st == 403 and js.get("code") == 50001:
                        bad(f"#{spec['name']}: the bot cannot SEE this channel. In Discord: Edit Channel → Permissions → add role "
                            f"the bot with View Channel ✓ (or “Sync permissions” with its category), then re-run.")
                    else:
                        must(st, js, f"channel {spec['name']}")
            else:
                same(f"#{spec['name']}")
            chan_ids[spec["name"]] = cur["id"]
        else:
            plan(f"create #{spec['name']} in {spec['category']}")
            if not DRY:
                st, js = d.post(f"/guilds/{gid}/channels", {**body, "type": ctype}, "provision: create channel")
                if must(st, js, f"create channel {spec['name']}"):
                    chan_ids[spec["name"]] = js["id"]
            else:
                chan_ids[spec["name"]] = f"<new:{spec['name']}>"

    managed = {spec["name"] for spec in cfg["channels"]} | {spec.get("match") for spec in cfg["channels"]} | \
              {spec["name"] for spec in cfg["categories"]} | {spec.get("match") for spec in cfg["categories"]}
    extra = [ch["name"] for ch in chans if ch["name"] not in managed]
    if extra:
        warn("not in server.toml, left untouched: " + ", ".join(extra))
    return cat_ids, chan_ids

def automod_specs(cfg, role_ids, chan_ids, bot_role_id):
    a = cfg["automod"]
    exempt_roles = [str(bot_role_id if n == "bot" else role_ids[n]) for n in a["exempt_roles"]]
    exempt_channels = [str(chan_ids[n]) for n in a["exempt_channels"] if n in chan_ids]
    alert = {"type": 2, "metadata": {"channel_id": str(chan_ids[a["alert_channel"]])}}
    block = lambda msg: {"type": 1, "metadata": {"custom_message": msg}}
    common = {"enabled": True, "exempt_roles": exempt_roles, "exempt_channels": exempt_channels}
    return [
        {"name": "Links: allowlist only", "event_type": 1, "trigger_type": 1,
         "trigger_metadata": {"regex_patterns": [r"(?i)\bhttps?://\S+", r"(?i)\bwww\.\S+\.\S+"], "allow_list": a["link_allowlist"]},
         "actions": [block("Links are off in this server except a few trusted sites. Ask the Team in 🎫-support."), alert], **common},
        {"name": "Invites", "event_type": 1, "trigger_type": 1,
         "trigger_metadata": {"regex_patterns": [r"(?i)discord(app)?\.(gg|com/invite)/\S+", r"(?i)dsc\.gg/\S+"]},
         "actions": [block("No server invites here."), alert], **common},
        {"name": "Scam phrases", "event_type": 1, "trigger_type": 1,
         "trigger_metadata": {"keyword_filter": a["scam_keywords"]},
         "actions": [block("That message looks like a wallet scam and was blocked."), alert,
                     {"type": 3, "metadata": {"duration_seconds": int(a["timeout_seconds"])}}], **common},
        {"name": "Spam", "event_type": 1, "trigger_type": 3, "trigger_metadata": {},
         "actions": [block("Slow down."), alert], **common},
        {"name": "Mention spam", "event_type": 1, "trigger_type": 5,
         "trigger_metadata": {"mention_total_limit": int(a["mention_limit"]), "mention_raid_protection_enabled": True},
         "actions": [block("Too many mentions."), alert, {"type": 3, "metadata": {"duration_seconds": int(a["timeout_seconds"])}}], **common},
    ]   # NOTE: member-profile (impersonation) rules cannot be created by bots — Discord refuses with Missing Access. Owner sets it in AutoMod UI.

def step_automod(d, env, cfg, role_ids, chan_ids, bot_role_id):
    head("AutoMod")
    gid = env["DISCORD_GUILD_ID"]
    if any(str(v).startswith("<new") for v in chan_ids.values()):
        plan("AutoMod rules will be created once the channels exist (dry run)"); return {}
    st, existing = d.get(f"/guilds/{gid}/auto-moderation/rules")
    existing = {r["name"]: r for r in existing} if isinstance(existing, list) else {}
    ids = {}
    for spec in automod_specs(cfg, role_ids, chan_ids, bot_role_id):
        cur = existing.get(spec["name"])
        if cur:
            plan(f"sync AutoMod rule “{spec['name']}”")
            if not DRY:
                body = {k: v for k, v in spec.items() if k not in ("trigger_type", "event_type")}
                st, js = d.patch(f"/guilds/{gid}/auto-moderation/rules/{cur['id']}", body, "provision: automod sync")
                must(st, js, f"automod {spec['name']}")
            ids[spec["name"]] = cur["id"]
        else:
            plan(f"create AutoMod rule “{spec['name']}”")
            if not DRY:
                st, js = d.post(f"/guilds/{gid}/auto-moderation/rules", spec, "provision: automod create")
                if must(st, js, f"automod {spec['name']}"):
                    ids[spec["name"]] = js["id"]
    return ids

def step_guild(d, env, cfg, guild):
    head("Server settings")
    gid = env["DISCORD_GUILD_ID"]
    want = {k: int(v) for k, v in cfg["guild"].items() if k in ("verification_level", "explicit_content_filter", "default_message_notifications")}
    diff = {k: v for k, v in want.items() if guild.get(k) != v}
    if not diff:
        same("verification level / content filter / notifications"); return
    plan("server settings: " + ", ".join(f"{k} {guild.get(k)}→{v}" for k, v in diff.items()))
    if not DRY:
        st, js = d.patch(f"/guilds/{gid}", diff, "provision: safety settings")
        must(st, js, "guild settings")
    if guild.get("mfa_level") != 1:
        warn("2FA for moderator actions is OFF. Only the owner can enable it: Server Settings → Safety Setup → "
             "“Require 2FA for moderator actions”.")

def step_messages(d, env, cfg, gate, chan_ids):
    head("Pinned messages")
    verify_url = f"https://{gate['hosting']['verify_domain']}"
    for key, spec in cfg.get("messages", {}).items():
        cid = chan_ids.get(spec["channel"])
        if not cid or str(cid).startswith("<new"):
            plan(f"pin “{spec['title']}” in #{spec['channel']} (after channel exists)"); continue
        embed = {"title": spec["title"], "description": spec["body"].strip().replace("{verify_url}", verify_url),
                 "color": 0x5BE0C8, "footer": {"text": MARK}}
        st, recent = d.get(f"/channels/{cid}/messages?limit=50")
        items = recent if isinstance(recent, list) else []
        mine = next((m for m in items if (m.get("author") or {}).get("id") == env["DISCORD_APP_ID"]
                     and any((e.get("footer") or {}).get("text") == MARK and e.get("title") == spec["title"] for e in m.get("embeds", []))), None)
        def pin(mid):
            st2, js2 = d.put(f"/channels/{cid}/messages/pins/{mid}", None, "provision: pin")
            if st2 not in (200, 204):
                st2, js2 = d.put(f"/channels/{cid}/pins/{mid}", None, "provision: pin")
            if st2 in (200, 204):
                ok(f"pinned “{spec['title']}” in #{spec['channel']}")
            else:
                warn(f"could not pin “{spec['title']}” in #{spec['channel']} (HTTP {st2}: {js2.get('message')}). Pin it by hand: hover the message → ⋯ → Pin.")
        if mine:
            cur = mine["embeds"][0]
            if cur.get("description") != embed["description"]:
                plan(f"edit “{spec['title']}” in #{spec['channel']}")
                if not DRY:
                    st, js = d.patch(f"/channels/{cid}/messages/{mine['id']}", {"embeds": [embed]})
                    must(st, js, "edit message")
            else:
                same(f"“{spec['title']}” in #{spec['channel']}")
            if not mine.get("pinned"):
                plan(f"pin “{spec['title']}” in #{spec['channel']}")
                if not DRY:
                    pin(mine["id"])
            continue
        plan(f"post + pin “{spec['title']}” in #{spec['channel']}")
        if not DRY:
            st, js = d.post(f"/channels/{cid}/messages", {"embeds": [embed]})
            if must(st, js, "post message"):
                pin(js["id"])

def step_drop(d, env, cfg, bot_role):
    head("Drop privileges")
    gid = env["DISCORD_GUILD_ID"]
    # 1) channel overwrites: back to exactly what server.toml lists for "bot" (no VIEW/MANAGE_ROLES extras)
    st, chans = d.get(f"/guilds/{gid}/channels")
    specs = {s_["name"]: s_ for s_ in cfg["categories"] + cfg["channels"]}
    cat_ow = {s_["name"]: s_.get("overwrites") for s_ in cfg["categories"]}
    for ch in chans:
        spec = specs.get(ch["name"])
        if not spec:
            continue
        ow_spec = spec.get("overwrites") if "overwrites" in spec else cat_ow.get(spec.get("category"))
        want_bot = bits(((ow_spec or {}).get("bot") or {}).get("allow", []))
        cur = next((o for o in ch.get("permission_overwrites", []) if o["id"] == bot_role["id"]), None)
        cur_bits = int(cur["allow"]) if cur else 0
        if cur_bits == want_bot:
            continue
        plan(f"#{ch['name']}: bot overwrite → {'+'.join(names(want_bot)) or 'none'}")
        if not DRY:
            if want_bot:
                st, js = d.put(f"/channels/{ch['id']}/permissions/{bot_role['id']}", {"type": 0, "allow": str(want_bot), "deny": "0"}, "provision: drop privileges")
            else:
                st, js = d.req("DELETE", f"/channels/{ch['id']}/permissions/{bot_role['id']}", None, "provision: drop privileges")
            must(st, js, f"bot overwrite in #{ch['name']}")
    # 2) the role itself
    want = str(bits(cfg["bot"]["runtime_permissions"]))
    if bot_role["permissions"] == want:
        same("bot role already at runtime permissions"); return
    plan(f"bot role permissions → {'+'.join(names(want))}")
    if DRY:
        return
    st, js = d.patch(f"/guilds/{gid}/roles/{bot_role['id']}", {"permissions": want}, "provision: drop privileges")
    if st == 200:
        ok("done. To provision again later, re-authorize the bot with the invite link from intake.py.")
    else:
        bad(f"Discord refused (HTTP {st}: {js.get('message')}). A bot may not edit its own top role.")
        print(c("1", "  Do it by hand (30 seconds): Server Settings → Roles → your-bot → Permissions → keep ONLY: "
                    + ", ".join(cfg["bot"]["runtime_permissions"]).replace("_", " ").title() + "\n"))

# ---------------------------------------------------------------- main
def main(argv):
    global DRY
    DRY = "--dry-run" in argv
    env = load_env()
    cfg = tomllib.load(open(ROOT / "server.toml", "rb"))
    gate = json.load(open(ROOT / "gate.config.json"))
    d = Discord(env["DISCORD_BOT_TOKEN"])
    gid = env["DISCORD_GUILD_ID"]
    st, guild = d.get(f"/guilds/{gid}")
    if st != 200:
        sys.exit(f"cannot read guild: {guild}")
    st, roles = d.get(f"/guilds/{gid}/roles")
    st, chans = d.get(f"/guilds/{gid}/channels")
    st, bot_member = d.get(f"/guilds/{gid}/members/{env['DISCORD_APP_ID']}")
    print(c("1", f"\n{'DRY RUN — ' if DRY else ''}provisioning “{guild['name']}” ({gid})"))

    if "--status" in argv:
        for r in sorted(roles, key=lambda r: -r["position"]):
            print(f"  role pos={r['position']:<2} {r['name']:<14} {'+'.join(names(r['permissions'])) or '-'}")
        for ch in sorted(chans, key=lambda ch: (ch.get("parent_id") or "", ch.get("position", 0))):
            print(f"  chan type={ch['type']} {ch['name']:<20} parent={ch.get('parent_id')} overwrites={len(ch.get('permission_overwrites', []))}")
        return 0

    if "--messages-only" in argv:   # edit/pin the bot's own posts; needs no build permissions
        chan_ids = {ch["name"]: ch["id"] for ch in chans}
        step_messages(d, env, cfg, gate, chan_ids)
        return 0
    bot_role = step_preflight(d, env, cfg, roles, bot_member)
    global BUILD_HELD
    BUILD_HELD = int(bot_role["permissions"])
    if "--drop-privileges" in argv:
        step_drop(d, env, cfg, bot_role); return 0

    role_ids = step_roles(d, env, cfg, roles)
    if not DRY:
        st, roles = d.get(f"/guilds/{gid}/roles")
    step_positions(d, env, cfg, roles, role_ids, bot_role)
    step_everyone(d, env, cfg, roles)
    cat_ids, chan_ids = step_channels(d, env, cfg, chans, role_ids, bot_role["id"])
    automod_ids = step_automod(d, env, cfg, role_ids, chan_ids, bot_role["id"])
    step_guild(d, env, cfg, guild)
    step_messages(d, env, cfg, gate, chan_ids)

    tiers = [{"role": r["name"], "min": int(r["tier"]), "role_id": role_ids.get(r["name"])} for r in cfg["roles"] if "tier" in r]
    state = {
        "guild_id": gid, "guild_name": guild["name"], "bot_role_id": bot_role["id"],
        "roles": role_ids, "tiers": tiers, "categories": cat_ids, "channels": chan_ids, "automod": automod_ids,
        "audit_channel_id": chan_ids.get(next((s["name"] for s in cfg["channels"] if s.get("role") == "audit"), "")),
        "verify_channel_id": chan_ids.get(next((s["name"] for s in cfg["channels"] if s.get("role") == "verify"), "verify")),
        "landing_channel_id": chan_ids.get(next((s["name"] for s in cfg["channels"] if s.get("role") == "landing"), "")),
        "team_role_id": role_ids.get("Team"),
        "applied_at": None if DRY else datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dry_run": DRY,
    }
    (ROOT / "server.state.json").write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")
    head("Done" if not DRY else "Plan")
    print(f"  {len(CHANGES)} change(s){' would be applied' if DRY else ' applied'}; state → server.state.json")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
