#!/usr/bin/env python3
"""
intake.py — collect and VERIFY every credential the NFT-gated Discord needs.

  python3 ~/discord-nft-gate/intake.py            interactive; re-run any time, Enter keeps a saved value
  python3 ~/discord-nft-gate/intake.py --check    no prompts; re-validate everything on disk, secrets masked
  python3 ~/discord-nft-gate/intake.py --show     masked summary only, no network calls

Writes
  ~/discord-nft-gate/.env              secrets, file mode 600, stays on this Mac, git-ignored
  ~/discord-nft-gate/gate.config.json  non-secret settings (the file Claude reads)

This never asks for a Discord password, a seed phrase, or a wallet private key.
Every value is checked live (Discord API / your RPC) before it is saved.
"""
import base64, getpass, json, os, re, sys, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
CFG_PATH = ROOT / "gate.config.json"
DISCORD_API = "https://discord.com/api/v10"
UA = "DiscordBot (discord-nft-gate-intake, 0.1)"
TIMEOUT = 25

# Permissions the one-time server build needs (NOT Administrator). Dropped to Manage Roles after.
PERMS = {
    "KICK_MEMBERS": 1 << 1,
    "MANAGE_CHANNELS": 1 << 4,
    "MANAGE_GUILD": 1 << 5,
    "VIEW_AUDIT_LOG": 1 << 7,
    "VIEW_CHANNEL": 1 << 10,
    "SEND_MESSAGES": 1 << 11,
    "MANAGE_MESSAGES": 1 << 13,
    "EMBED_LINKS": 1 << 14,
    "READ_MESSAGE_HISTORY": 1 << 16,
    "MANAGE_ROLES": 1 << 28,
    "MODERATE_MEMBERS": 1 << 40,
}
BUILD_PERMS = sum(PERMS.values())
ADMINISTRATOR = 1 << 3
FLAG_MEMBERS_INTENT = (1 << 14) | (1 << 15)

EVM_CHAIN_IDS = {"mainnet": 1, "sepolia": 11155111}
SOL_GENESIS = {
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG": "devnet",
}
SOL_PROGRAMS = {
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "Metaplex (legacy) collection mint",
    "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d": "Metaplex Core collection",
}

# ---------------------------------------------------------------- console
def _c(code, s):
    return f"\033[{code}m{s}\033[0m" if sys.stdout.isatty() else s

def ok(s):   print(_c("32", "  ✔ ") + s)
def warn(s): print(_c("33", "  ⚠ ") + s)
def bad(s):  print(_c("31", "  ✘ ") + s)
def info(s): print(_c("2", "    " + s))
def head(s): print("\n" + _c("1;36", s))

def mask(s):
    if not s:
        return "(not set)"
    return "••••" + s[-4:] if len(s) > 8 else "••••"

# ---------------------------------------------------------------- files
def _unescape(s):
    out, i = [], 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s):
            out.append(s[i + 1]); i += 2
        else:
            out.append(s[i]); i += 1
    return "".join(out)

def load_env():
    d = {}
    if not ENV_PATH.exists():
        return d
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] == '"':
            v = _unescape(v[1:-1])
        d[k.strip()] = v
    return d

def save_env(d):
    lines = ["# discord-nft-gate secrets — written by intake.py (mode 600). Never commit, never paste in chat."]
    for k, v in d.items():
        if v is None or v == "":
            continue
        esc = v.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'{k}="{esc}"')
    tmp = ROOT / ".env.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, ENV_PATH)
    os.chmod(ENV_PATH, 0o600)

def load_cfg():
    if CFG_PATH.exists():
        try:
            return json.loads(CFG_PATH.read_text())
        except ValueError:
            warn("gate.config.json was unreadable; starting fresh")
    return {}

def save_cfg(cfg):
    cfg.setdefault("intake", {})["version"] = 1
    cfg["intake"]["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    tmp = ROOT / "gate.config.tmp"
    tmp.write_text(json.dumps(cfg, indent=2) + "\n")
    os.replace(tmp, CFG_PATH)

# ---------------------------------------------------------------- http
def http(method, url, headers=None, body=None):
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    data = None
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        else:
            data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw, status = r.read(), r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"message": f"network error: {e}"}
    try:
        return status, (json.loads(raw) if raw else {})
    except ValueError:
        return status, {"message": raw[:200].decode(errors="replace")}

def dget(token, path):
    return http("GET", DISCORD_API + path, {"Authorization": f"Bot {token}"})

def rpc(url, method, params):
    st, r = http("POST", url, None, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if st != 200:
        raise RuntimeError(f"HTTP {st}: {str(r)[:160]}")
    if isinstance(r, dict) and "error" in r:
        raise RuntimeError(str(r["error"])[:160])
    return r.get("result") if isinstance(r, dict) else r

# ---------------------------------------------------------------- checks (shared by intake + --check)
def check_bot_token(token):
    st, me = dget(token, "/users/@me")
    if st != 200:
        return False, f"Discord rejected the token (HTTP {st}: {me.get('message', me)})", {}
    if not me.get("bot"):
        return False, "that token belongs to a USER account, not a bot — use Developer Portal → Bot → Reset Token", {}
    st, app = dget(token, "/oauth2/applications/@me")
    if st != 200:
        return False, f"could not read the application (HTTP {st}: {app.get('message', app)})", {}
    flags = app.get("flags", 0) or 0
    extra = {
        "bot_username": me.get("username"),
        "bot_user_id": me.get("id"),
        "app_id": app.get("id"),
        "app_name": app.get("name"),
        "public_key": app.get("verify_key"),
        "app_owner_id": (app.get("owner") or {}).get("id"),
        "bot_public": bool(app.get("bot_public")),
        "code_grant_required": bool(app.get("bot_require_code_grant")),
        "members_intent": bool(flags & FLAG_MEMBERS_INTENT),
    }
    return True, f"bot @{me.get('username')} on application “{app.get('name')}” (app id {app.get('id')})", extra

def portal_warnings(extra):
    if extra.get("bot_public"):
        warn("PUBLIC BOT is ON (Developer Portal → Bot). Turn it OFF so nobody else can add this bot to their server.")
    if not extra.get("members_intent"):
        warn("SERVER MEMBERS INTENT is OFF (Developer Portal → Bot → Privileged Gateway Intents). "
             "The re-check sweeper needs it to list members and revoke roles. Turn it on, then run --check.")
    if extra.get("code_grant_required"):
        warn("'Requires OAuth2 Code Grant' is ON. Turn it OFF or the invite link will not work.")

def check_guild(token, guild_id):
    st, g = dget(token, f"/guilds/{guild_id}?with_counts=true")
    if st == 200:
        extra = {"guild_name": g.get("name"), "guild_owner_id": g.get("owner_id"),
                 "member_count": g.get("approximate_member_count")}
        return True, f"server “{g.get('name')}” · ~{g.get('approximate_member_count', '?')} members", extra
    if st in (403, 404):
        return False, "the bot is not in that server yet (or the server ID is wrong)", {"not_member": True}
    return False, f"HTTP {st}: {g.get('message', g)}", {}

def check_bot_perms(token, guild_id):
    """Returns (missing_permission_names, has_admin) or (None, None) if unknown."""
    st, gs = dget(token, "/users/@me/guilds")
    if st != 200 or not isinstance(gs, list):
        return None, None
    for g in gs:
        if str(g.get("id")) == str(guild_id):
            have = int(g.get("permissions", "0"))
            if have & ADMINISTRATOR:
                return [], True
            return [n for n, b in PERMS.items() if not have & b], False
    return None, None

def check_client_secret(app_id, secret):
    auth = base64.b64encode(f"{app_id}:{secret}".encode()).decode()
    st, r = http("POST", DISCORD_API + "/oauth2/token",
                 {"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"},
                 "grant_type=client_credentials&scope=identify")
    if st == 200 and isinstance(r, dict) and r.get("access_token"):
        return True, "client secret accepted by Discord", {}
    msg = r.get("error_description") or r.get("error") or r.get("message") or r if isinstance(r, dict) else r
    return False, f"Discord rejected it (HTTP {st}: {msg})", {}

def build_rpc_url(chain, network, key_or_url):
    if key_or_url.lower().startswith("http"):
        return key_or_url
    if chain == "ethereum":
        return f"https://{ {'mainnet': 'eth-mainnet', 'sepolia': 'eth-sepolia'}[network] }.g.alchemy.com/v2/{key_or_url}"
    return f"https://{ {'mainnet': 'mainnet', 'devnet': 'devnet'}[network] }.helius-rpc.com/?api-key={key_or_url}"

def check_rpc(chain, network, url):
    try:
        if chain == "ethereum":
            cid = int(rpc(url, "eth_chainId", []), 16)
            want = EVM_CHAIN_IDS[network]
            if cid != want:
                return False, f"that RPC serves chain id {cid}; {network} is chain id {want}", {}
            blk = int(rpc(url, "eth_blockNumber", []), 16)
            return True, f"Ethereum {network} · latest block {blk:,}", {}
        v = rpc(url, "getVersion", []) or {}
        gh = rpc(url, "getGenesisHash", [])
        got = SOL_GENESIS.get(gh, "unknown cluster")
        if got != network:
            return False, f"that RPC serves Solana {got}; you chose {network}", {}
        return True, f"Solana {network} · core {v.get('solana-core', '?')}", {}
    except Exception as e:
        return False, f"RPC call failed: {e}", {}

def _abi_str(hexres):
    if not hexres or hexres == "0x":
        return ""
    b = bytes.fromhex(hexres[2:])
    if len(b) >= 64:
        off = int.from_bytes(b[:32], "big")
        ln = int.from_bytes(b[off:off + 32], "big")
        return b[off + 32:off + 32 + ln].decode("utf-8", "replace")
    return b.rstrip(b"\x00").decode("utf-8", "replace")

def check_evm_collection(url, addr):
    try:
        code = rpc(url, "eth_getCode", [addr, "latest"])
    except Exception as e:
        return False, f"RPC call failed: {e}", {}
    if code in (None, "0x"):
        return False, "no contract lives at that address on this network", {}
    def call(data):
        return rpc(url, "eth_call", [{"to": addr, "data": data}, "latest"])
    name = symbol = ""
    supply = is721 = None
    try: name = _abi_str(call("0x06fdde03"))
    except Exception: pass
    try: symbol = _abi_str(call("0x95d89b41"))
    except Exception: pass
    try: supply = int(call("0x18160ddd"), 16)
    except Exception: pass
    try: is721 = int(call("0x01ffc9a7" + "80ac58cd" + "00" * 28), 16) == 1
    except Exception: pass
    extra = {"name": name, "symbol": symbol, "supply": supply,
             "standard": "ERC-721" if is721 else ("NOT ERC-721?" if is721 is False else "unknown")}
    det = (f"“{name or '?'}” ({symbol or '?'}) · supply {supply if supply is not None else '?'} · "
           f"ERC-721 {'confirmed' if is721 else ('NOT confirmed' if is721 is False else 'unknown')}")
    return True, det, extra

def check_sol_collection(url, addr):
    try:
        acct = rpc(url, "getAccountInfo", [addr, {"encoding": "base64"}])
    except Exception as e:
        return False, f"RPC call failed: {e}", {}
    val = (acct or {}).get("value")
    if not val:
        return False, "no account lives at that address on this network", {}
    owner = val.get("owner", "")
    standard = SOL_PROGRAMS.get(owner, f"owned by program {owner[:10]}…")
    name, total, das = "", None, True
    try:
        a = rpc(url, "getAsset", {"id": addr}) or {}
        name = ((a.get("content") or {}).get("metadata") or {}).get("name", "")
    except Exception:
        das = False
    if das:
        try:
            total = 0
            for page in range(1, 21):
                r = rpc(url, "getAssetsByGroup",
                        {"groupKey": "collection", "groupValue": addr, "page": page, "limit": 1000}) or {}
                n = len(r.get("items") or [])
                total += n
                if n < 1000:
                    break
            else:
                total = f"{total}+"
        except Exception:
            total = None
    extra = {"name": name, "symbol": "", "supply": total, "standard": standard, "das": das}
    det = f"“{name or '?'}” · {standard} · assets in collection {total if total is not None else '?'}"
    if not das:
        det += " · DAS API unavailable on this RPC (holder lookups need Helius)"
    return True, det, extra

def check_collection(chain, url, addr):
    return check_evm_collection(url, addr) if chain == "ethereum" else check_sol_collection(url, addr)

def invite_url(app_id, guild_id):
    return (f"https://discord.com/oauth2/authorize?client_id={app_id}&scope=bot%20applications.commands"
            f"&permissions={BUILD_PERMS}&guild_id={guild_id}&disable_guild_select=true")

# ---------------------------------------------------------------- validators
def v_snowflake(v): return None if re.fullmatch(r"\d{17,20}", v) else "should be a 17–20 digit number"
def v_token(v):     return None if re.fullmatch(r"[\w-]+\.[\w-]+\.[\w-]+", v) else "doesn't look like a bot token (three dot-separated parts)"
def v_evm(v):       return None if re.fullmatch(r"0x[0-9a-fA-F]{40}", v) else "should be 0x followed by 40 hex characters"
def v_sol(v):       return None if re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", v) else "should be a base58 address, 32–44 characters"
def v_domain(v):    return None if re.fullmatch(r"(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", v.lower()) else "should be a hostname like verify.example.xyz (no https://, no path)"
def v_dburl(v):     return None if re.match(r"postgres(ql)?://", v) else "should start with postgres:// or postgresql://"
def v_key(v):       return None if (len(v) >= 8 and " " not in v) else "too short to be an API key or URL"

def parse_tiers(s):
    tiers, names = [], set()
    for part in s.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" not in part:
            return None, f"'{part}' should look like RoleName:MinCount"
        n, m = part.rsplit(":", 1)
        n, m = n.strip(), m.strip()
        if not n or "@" in n or len(n) > 100:
            return None, f"bad role name '{n}'"
        if not m.isdigit() or int(m) < 1:
            return None, f"min count for {n} must be a whole number ≥ 1"
        if n.lower() in names:
            return None, f"duplicate role {n}"
        names.add(n.lower())
        tiers.append({"role": n, "min": int(m)})
    if not tiers:
        return None, "give at least one tier, e.g. Holder:1"
    tiers.sort(key=lambda t: t["min"])
    return tiers, None

# ---------------------------------------------------------------- prompts
def ask(label, default=None, help_=None, validator=None, secret=False, required=True):
    if help_:
        for line in help_.splitlines():
            info(line)
    while True:
        shown = mask(default) if secret else default
        prompt = f"  {label}" + (f" [{shown}]" if default else "") + ": "
        try:
            val = getpass.getpass(prompt) if secret else input(prompt)
        except EOFError:
            val = ""
        val = val.strip()
        if not val and default:
            return default
        if not val:
            if not required:
                return ""
            bad("required"); continue
        if validator:
            err = validator(val)
            if err:
                bad(err); continue
        return val

def choose(label, options, default):
    shown = "/".join(o.upper() if o == default else o for o in options)
    while True:
        try:
            v = input(f"  {label} ({shown}): ").strip().lower()
        except EOFError:
            v = ""
        v = v or default
        if v in options:
            return v
        bad(f"pick one of: {', '.join(options)}")

def yes(label, default=True):
    while True:
        try:
            v = input(f"  {label} ({'Y/n' if default else 'y/N'}): ").strip().lower()
        except EOFError:
            v = ""
        if not v:
            return default
        if v in ("y", "yes"): return True
        if v in ("n", "no"): return False

def pause(msg):
    try:
        input(_c("1", f"  ↵ {msg}"))
    except EOFError:
        pass

# ---------------------------------------------------------------- summary
def summary(env, cfg):
    d, col, h, p = cfg.get("discord", {}), cfg.get("collection", {}), cfg.get("hosting", {}), cfg.get("policy", {})
    head("Summary (secrets masked)")
    rows = [
        ("project", cfg.get("project")),
        ("chain / network", f"{cfg.get('chain')} / {cfg.get('network')}"),
        ("collection", f"{col.get('address')}  →  {col.get('name') or '?'} · {col.get('standard') or '?'} · supply {col.get('supply') if col.get('supply') is not None else '?'}"),
        ("RPC_URL", mask(env.get("RPC_URL"))),
        ("DISCORD_BOT_TOKEN", f"{mask(env.get('DISCORD_BOT_TOKEN'))}  (bot @{d.get('bot_username')})"),
        ("app id / public key", f"{d.get('app_id')} / {(d.get('public_key') or '')[:12]}…"),
        ("server", f"{d.get('guild_id')}  →  {d.get('guild_name') or '?'}"),
        ("DISCORD_CLIENT_SECRET", mask(env.get("DISCORD_CLIENT_SECRET"))),
        ("hosting / verify domain", f"{h.get('provider')} / {h.get('verify_domain')}"),
        ("DATABASE_URL", mask(env.get("DATABASE_URL"))),
        ("re-check every", f"{p.get('sweep_hours')} h"),
        ("prune unverified after", f"{p.get('prune_days')} days" if p.get("prune_days") else "never"),
        ("tiers", ", ".join(f"{t['role']}≥{t['min']}" for t in p.get("tiers", []))),
    ]
    for k, v in rows:
        print(f"  {k:<24} {str(v).replace('None', '—')}")
    print()
    info(f"secrets → {ENV_PATH}   (mode {oct(ENV_PATH.stat().st_mode & 0o777) if ENV_PATH.exists() else 'missing'})")
    info(f"config  → {CFG_PATH}")

# ---------------------------------------------------------------- --check
def run_check(env, cfg):
    head("Re-validating everything on disk")
    results = []
    def rec(name, okk, detail):
        (ok if okk else bad)(f"{name}: {detail}")
        results.append((name, okk, detail))

    if ENV_PATH.exists():
        mode = ENV_PATH.stat().st_mode & 0o777
        rec(".env permissions", mode == 0o600, oct(mode) + (" (should be 0o600 — run: chmod 600 ~/discord-nft-gate/.env)" if mode != 0o600 else ""))
    else:
        rec(".env", False, "missing — run intake.py")

    chain, net = cfg.get("chain"), cfg.get("network")
    if env.get("RPC_URL") and chain:
        okk, det, _ = check_rpc(chain, net, env["RPC_URL"])
        rec("RPC", okk, det)
        addr = (cfg.get("collection") or {}).get("address")
        if okk and addr:
            okk2, det2, extra = check_collection(chain, env["RPC_URL"], addr)
            rec("collection", okk2, det2)
            if okk2:
                cfg["collection"].update({k: extra.get(k) for k in ("name", "symbol", "supply", "standard")})
    else:
        rec("RPC", False, "not set")

    tok = env.get("DISCORD_BOT_TOKEN")
    if tok:
        okk, det, extra = check_bot_token(tok)
        rec("bot token", okk, det)
        if okk:
            portal_warnings(extra)
            cfg.setdefault("discord", {}).update(extra)
            gid = cfg["discord"].get("guild_id")
            if gid:
                okg, detg, gx = check_guild(tok, gid)
                rec("server", okg, detg)
                if okg:
                    cfg["discord"].update(gx)
                    missing, admin = check_bot_perms(tok, gid)
                    if admin:
                        warn("bot currently has ADMINISTRATOR in the server; fine for the build, it gets dropped afterwards")
                    elif missing:
                        rec("bot permissions", False, "missing " + ", ".join(missing) + f"\n      re-invite: {invite_url(extra['app_id'], gid)}")
                    elif missing == []:
                        rec("bot permissions", True, "has everything the build needs")
                else:
                    info(f"invite: {invite_url(extra['app_id'], gid)}")
            if env.get("DISCORD_CLIENT_SECRET"):
                oks, dets, _ = check_client_secret(extra["app_id"], env["DISCORD_CLIENT_SECRET"])
                rec("client secret", oks, dets)
            else:
                warn("client secret not set — verify page will fall back to one-time links instead of Discord login")
    else:
        rec("bot token", False, "not set")

    cfg.setdefault("intake", {})["last_check"] = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "results": [{"name": n, "ok": o, "detail": d} for n, o, d in results],
    }
    save_cfg(cfg)
    failed = [n for n, o, _ in results if not o]
    print()
    if failed:
        bad(f"{len(failed)} item(s) need attention: {', '.join(failed)}")
        return 1
    ok("everything checks out")
    return 0

# ---------------------------------------------------------------- interactive
def interactive(env, cfg):
    print(_c("1", "\nNFT-gated Discord — credential intake"))
    info("Secrets are hidden while you type and saved only to ~/discord-nft-gate/.env (mode 600).")
    info("Press Enter to keep a value shown in [brackets]. Ctrl-C stops; verified steps stay saved.")
    info("Have ready: Discord bot token, server ID, Alchemy or Helius key, the collection address.")

    # 1 · project
    head("1 · Project")
    cfg["project"] = ask("Project name", cfg.get("project"), "Short label, e.g. my-collection")

    # 2 · chain
    head("2 · Chain")
    cfg["chain"] = choose("Chain", ["ethereum", "solana"], cfg.get("chain") or "ethereum")
    nets = ["mainnet", "sepolia"] if cfg["chain"] == "ethereum" else ["mainnet", "devnet"]
    cfg["network"] = choose("Network", nets, cfg.get("network") if cfg.get("network") in nets else "mainnet")
    save_cfg(cfg)

    # 3 · RPC
    head("3 · RPC (how the bot reads the chain)")
    prov = "Alchemy (dashboard.alchemy.com → your app → API key)" if cfg["chain"] == "ethereum" \
        else "Helius (dashboard.helius.dev → API key). Helius is required: holder lookups use its DAS API."
    while True:
        raw = ask("API key or full RPC URL", env.get("RPC_URL"),
                  f"{prov}\nPaste just the key, or a full https:// URL.", v_key, secret=True)
        url = build_rpc_url(cfg["chain"], cfg["network"], raw)
        okk, det, _ = check_rpc(cfg["chain"], cfg["network"], url)
        (ok if okk else bad)(det)
        if okk:
            env["RPC_URL"] = url
            save_env(env)
            break
        if not yes("Try again?"):
            return 1

    # 4 · collection
    head("4 · Collection")
    val = v_evm if cfg["chain"] == "ethereum" else v_sol
    help_ = ("The ERC-721 contract address (0x…). Etherscan → your contract." if cfg["chain"] == "ethereum"
             else "The collection address: Metaplex Core collection, or the certified-collection mint for legacy NFTs.")
    while True:
        addr = ask("Collection address", (cfg.get("collection") or {}).get("address"), help_, val)
        okk, det, extra = check_collection(cfg["chain"], env["RPC_URL"], addr)
        (ok if okk else bad)(det)
        if okk and yes("Is that the right collection?"):
            cfg["collection"] = {"address": addr, **{k: extra.get(k) for k in ("name", "symbol", "supply", "standard")}}
            save_cfg(cfg)
            break
        if not okk and not yes("Try again?"):
            return 1

    # 5 · bot token
    head("5 · Discord bot")
    d = cfg.setdefault("discord", {})
    while True:
        tok = ask("Bot token", env.get("DISCORD_BOT_TOKEN"),
                  "discord.com/developers → your application → Bot → Reset Token → copy.\n"
                  "(Not the client secret, not the public key.)", v_token, secret=True)
        okk, det, extra = check_bot_token(tok)
        (ok if okk else bad)(det)
        if okk:
            env["DISCORD_BOT_TOKEN"] = tok
            env["DISCORD_APP_ID"] = extra["app_id"]
            env["DISCORD_PUBLIC_KEY"] = extra["public_key"] or ""
            d.update(extra)
            portal_warnings(extra)
            save_env(env); save_cfg(cfg)
            break
        if not yes("Try again?"):
            return 1

    # 6 · server
    head("6 · Discord server")
    while True:
        gid = ask("Server ID", d.get("guild_id"),
                  "Discord → User Settings → Advanced → Developer Mode ON, then right-click the server icon → Copy Server ID.",
                  v_snowflake)
        okk, det, gx = check_guild(tok, gid)
        if okk:
            ok(det)
            d["guild_id"] = gid
            d.update(gx)
            env["DISCORD_GUILD_ID"] = gid
            if gx.get("guild_owner_id") != d.get("app_owner_id"):
                warn("the Discord account that owns the bot application is not the server owner. That's fine, "
                     "but only the server OWNER can switch on the 2FA requirement for moderators.")
            missing, admin = check_bot_perms(tok, gid)
            if admin:
                warn("bot has ADMINISTRATOR here. The build will work; the provisioner drops it to Manage Roles afterwards.")
            elif missing:
                warn("bot is missing " + ", ".join(missing))
                print(f"\n  Re-authorize with this link (it only adds the listed permissions):\n  {invite_url(d['app_id'], gid)}\n")
                pause("press Enter after approving, or Enter to continue anyway")
                missing2, admin2 = check_bot_perms(tok, gid)
                (ok if not missing2 or admin2 else warn)("permissions " + ("look good now" if not missing2 or admin2 else "still missing: " + ", ".join(missing2 or [])))
            else:
                ok("bot has every permission the build needs")
            save_env(env); save_cfg(cfg)
            break
        bad(det)
        if gx.get("not_member"):
            print(f"\n  Add the bot to that server with this link (least-privilege build permissions, NOT Administrator):\n"
                  f"  {invite_url(d['app_id'], gid)}\n")
            pause("press Enter once the bot is in the server, and I'll check again")
            d["guild_id"] = gid
            continue
        if not yes("Try again?"):
            return 1

    # 7 · client secret
    head("7 · Discord login for the verify page (recommended)")
    while True:
        sec = ask("OAuth2 client secret", env.get("DISCORD_CLIENT_SECRET"),
                  "discord.com/developers → your application → OAuth2 → Client Secret → Reset Secret.\n"
                  "Lets the verify page confirm WHO is signing via Discord login. Enter to skip (one-time links instead).",
                  secret=True, required=False)
        if not sec:
            env.pop("DISCORD_CLIENT_SECRET", None)
            d["oauth_client_secret_set"] = False
            warn("skipped — the verify page will use signed one-time links instead of Discord login")
            break
        okk, det, _ = check_client_secret(d["app_id"], sec)
        (ok if okk else bad)(det)
        if okk:
            env["DISCORD_CLIENT_SECRET"] = sec
            d["oauth_client_secret_set"] = True
            break
        if not yes("Try again?"):
            return 1
    save_env(env); save_cfg(cfg)

    # 8 · hosting
    head("8 · Hosting")
    h = cfg.setdefault("hosting", {})
    h["provider"] = choose("Where the verify page + bot run", ["vercel", "other"], h.get("provider") or "vercel")
    h["verify_domain"] = ask("Verify page domain", h.get("verify_domain"),
                             "The ONE link holders will ever be told to trust, e.g. verify.example.xyz. Must be a domain you control.",
                             v_domain).lower()
    db = ask("DATABASE_URL", env.get("DATABASE_URL"),
             "Postgres connection string (Supabase / Neon). Enter to skip for now; Claude can provision one.",
             v_dburl, secret=True, required=False)
    if db:
        env["DATABASE_URL"] = db
    h["database_url_set"] = bool(db)
    save_env(env); save_cfg(cfg)

    # 9 · policy
    head("9 · Policy")
    p = cfg.setdefault("policy", {})
    p["sweep_hours"] = int(ask("Re-check holders every N hours", str(p.get("sweep_hours", 6)),
                               "Roles are stripped when the NFT is gone. 6 is a good default.",
                               lambda v: None if v.isdigit() and 1 <= int(v) <= 168 else "1–168"))
    p["prune_days"] = int(ask("Remove unverified members after N days (0 = never)", str(p.get("prune_days", 7)),
                              validator=lambda v: None if v.isdigit() and int(v) <= 90 else "0–90"))
    while True:
        cur = ", ".join(f"{t['role']}:{t['min']}" for t in p.get("tiers", [])) or "Holder:1"
        tiers, err = parse_tiers(ask("Tiers", cur, "RoleName:MinCount, comma-separated. e.g.  Holder:1, Whale:5"))
        if err:
            bad(err); continue
        p["tiers"] = tiers
        break
    p["one_seat_per_nft"] = True
    save_cfg(cfg)

    summary(env, cfg)
    head("Next")
    info("Tell Claude: “intake done”. It reads gate.config.json (no secrets) and the scripts load .env at runtime.")
    info("Change any value later by re-running this script; re-validate with:  python3 ~/discord-nft-gate/intake.py --check")
    return 0

# ---------------------------------------------------------------- main
def main(argv):
    env, cfg = load_env(), load_cfg()
    if "--show" in argv:
        summary(env, cfg); return 0
    if "--check" in argv:
        return run_check(env, cfg)
    try:
        return interactive(env, cfg)
    except KeyboardInterrupt:
        print()
        warn("stopped. Verified steps were saved; re-run to continue where you left off.")
        return 130

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
