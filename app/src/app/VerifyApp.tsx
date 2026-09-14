"use client";
import { useCallback, useEffect, useState } from "react";
import { solve } from "@/lib/sha256";

type Me = {
  project: string; domain: string; chainId: number; guildId: string; landingChannelId: string | null; tiers: { role: string; min: number }[];
  user: { id: string; name: string; exp: number } | null;
  binding: { wallet: string; tokens: number; verifiedAt: string; lastCheckedAt: string | null } | null;
};
type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
type WalletOpt = { uuid: string; name: string; icon?: string; provider: Eip1193 };
type Result = { ok: true; wallet: string; tokens: string[]; roles: number; added: number; removed: number; inGuild: boolean };

async function proveWork(scope: "login" | "nonce", onStatus: (s: string) => void) {
  onStatus("checking your browser…");
  const r = await fetch("/api/pow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope }) });
  const j = (await r.json()) as { challenge?: string; bits?: number; error?: string };
  if (!r.ok || !j.challenge || !j.bits) throw new Error(j.error || "browser check unavailable");
  const counter = await solve(j.challenge, j.bits);
  onStatus("");
  return { challenge: j.challenge, counter };
}

const toHex = (s: string) => "0x" + Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join("");

export default function VerifyApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [wallets, setWallets] = useState<WalletOpt[]>([]);
  const [picked, setPicked] = useState<WalletOpt | null>(null);
  const [address, setAddress] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [steps, setSteps] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [host, setHost] = useState<string>("");

  const load = useCallback(async () => {
    const r = await fetch("/api/me", { cache: "no-store" });
    setMe((await r.json()) as Me);
  }, []);

  useEffect(() => {
    setHost(location.host);
    const q = new URLSearchParams(location.search);
    if (q.get("error")) setError(`Discord login failed (${q.get("error")}). Try again.`);
    load();
    // EIP-6963: every installed wallet announces itself; fall back to the legacy window.ethereum.
    const found = new Map<string, WalletOpt>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<{ info: { uuid: string; name: string; icon: string }; provider: Eip1193 }>).detail;
      if (!found.has(d.info.uuid)) { found.set(d.info.uuid, { uuid: d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider }); setWallets([...found.values()]); }
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const t = setTimeout(() => {
      const w = window as unknown as { ethereum?: Eip1193 };
      if (found.size === 0 && w.ethereum) setWallets([{ uuid: "legacy", name: "Browser wallet", provider: w.ethereum }]);
    }, 400);
    return () => { window.removeEventListener("eip6963:announceProvider", onAnnounce); clearTimeout(t); };
  }, [load]);

  // discord:// opens the installed desktop or mobile app; the https link is the fallback for people without it.
  const path = me?.guildId ? `channels/${me.guildId}${me.landingChannelId ? `/${me.landingChannelId}` : ""}` : "";
  const appUrl = path ? `discord://-/${path}` : "discord://-/";
  const webUrl = path ? `https://discord.com/${path}` : "https://discord.com/app";
  const login = async () => {
    setError(""); setBusy("login");
    try {
      const pow = await proveWork("login", setNote);
      window.location.href = `/api/auth/discord?c=${encodeURIComponent(pow.challenge)}&n=${pow.counter}`;
    } catch (e) { setError((e as Error).message || "could not start login"); setBusy(""); }
  };

  const connect = async (w: WalletOpt) => {
    setError(""); setBusy("connect");
    try {
      const accts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!accts?.[0]) throw new Error("no account returned");
      setPicked(w); setAddress(accts[0]);
    } catch (e) { setError((e as Error).message || "wallet refused"); }
    finally { setBusy(""); }
  };

  const verify = async () => {
    if (!picked || !address) return;
    setError(""); setBusy("verify"); setResult(null);
    try {
      const pow = await proveWork("nonce", setNote);
      const n = await fetch("/api/verify/nonce", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, pow }) });
      const nj = (await n.json()) as { message?: string; error?: string };
      if (!n.ok || !nj.message) throw new Error(nj.error || "could not start");
      const signature = (await picked.provider.request({ method: "personal_sign", params: [toHex(nj.message), address] })) as string;
      const v = await fetch("/api/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: nj.message, signature }) });
      const vj = (await v.json()) as Result & { error?: string; code?: string; steps?: string[] };
      if (!v.ok) { setSteps(vj.code === "dms_open" ? vj.steps ?? [] : []); throw new Error(vj.error || "verification failed"); }
      setSteps([]); setResult(vj);
      await load();
      if (vj.tokens.length && vj.inGuild) setTimeout(() => { window.location.href = appUrl; }, 700);
    } catch (e) { setError((e as Error).message || "failed"); }
    finally { setBusy(""); }
  };

  const logout = async () => { await fetch("/api/auth/logout", { method: "POST" }); setPicked(null); setAddress(""); setResult(null); await load(); };

  const expected = me?.domain;
  const domainOk = !expected || host === expected || host.startsWith("localhost");
  const step1 = !!me?.user, step2 = step1 && !!address, step3 = !!result;

  return (
    <>
      <header className="brand">
        <span className="eyebrow">▸ Holder Verification</span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="wordmark" src="/NFT-wordmark.webp" alt={`${me?.project ?? "NFT"} logo`} />
        <h1>verify</h1>
      </header>
      <p className="sub">Prove you hold one. Signing is free and moves nothing.</p>

      <div className={`domain ${domainOk ? "" : "bad"}`}>
        <span>{domainOk ? "🔒" : "🚨"}</span>
        <span>You are on <b>{host || "…"}</b>{expected && !domainOk ? <> — the real page is <b>{expected}</b>. Close this tab.</> : ". Only ever sign here."}</span>
      </div>

      <div className={`card step ${step1 ? "done" : "active"}`}>
        <span className="num">1</span>
        <div style={{ flex: 1 }}>
          <h2>Log in with Discord</h2>
          <div className="body">
            {me?.user ? <>Logged in as <span className="mono">{me.user.name}</span> · <button className="link" onClick={logout}>log out</button></>
              : <div className="row"><button className="primary" disabled={busy !== ""} onClick={login}>{busy === "login" ? (note || "Opening Discord…") : "Log in with Discord"}</button></div>}

          </div>
        </div>
      </div>

      <div className={`card step ${step2 ? "done" : step1 ? "active" : ""}`}>
        <span className="num">2</span>
        <div style={{ flex: 1 }}>
          <h2>Connect the wallet that holds it</h2>
          <div className="body">
            {!step1 ? "After login." : address ? <>Connected <span className="mono">{address.slice(0, 6)}…{address.slice(-4)}</span> via {picked?.name} · <button className="link" onClick={() => { setAddress(""); setPicked(null); }}>change</button></>
              : wallets.length ? (
                <div className="wallets">
                  {wallets.map((w) => <button key={w.uuid} disabled={busy !== ""} onClick={() => connect(w)}>{w.icon && <img src={w.icon} alt="" />}{w.name}</button>)}
                </div>
              ) : <span className="warn">No wallet extension found. Open this page inside your wallet&apos;s browser, or install one.</span>}
          </div>
        </div>
      </div>

      <div className={`card step ${step3 ? "done" : step2 ? "active" : ""}`}>
        <span className="num">3</span>
        <div style={{ flex: 1 }}>
          <h2>Sign the message</h2>
          <div className="body">
            {!step2 && !result ? "Your wallet will show a plain-text message. It is not a transaction." : null}
            {step2 && !result && <div className="row"><button className="primary" disabled={busy !== ""} onClick={verify}>{busy === "verify" ? (note || "Waiting for your wallet…") : "Sign & verify"}</button></div>}
            {result && (
              <div>
                {result.tokens.length
                  ? <p className="ok">✅ {result.tokens.length} {me?.project} found ({result.tokens.join(", ")}). {result.inGuild ? (result.added ? `${result.added} role(s) granted.` : "Roles confirmed.") : "Join the Discord to receive your roles."}</p>
                  : <p className="warn">That wallet holds no {me?.project}. Nothing was granted{result.removed ? `; ${result.removed} old role(s) removed` : ""}.</p>}
                {result.tokens.length > 0 && result.inGuild && (
                  <p style={{ marginTop: 8 }}>Opening Discord… <a href={webUrl} className="mono" style={{ fontSize: 12 }}>didn&apos;t open? use the browser</a></p>
                )}
              </div>
            )}
            {error && <p className="bad">{error}</p>}
            {steps.length > 0 && <ol className="steps">{steps.map((st) => <li key={st}>{st}</li>)}</ol>}
          </div>
        </div>
      </div>

      <div className="foot">
        <p>⚠️ Verification requires your DMs from this server to be OFF. The only DM this bot ever sends is a warning that they are open. It never sends links, and nobody from the team will ever DM you.</p>
        <p>Roles are re-checked automatically. Sell or move your {me?.project} and they are removed.</p>
        {me?.tiers && me.tiers.length > 1 && <p>Tiers: {me.tiers.map((t) => `${t.role} at ${t.min}+`).join(" · ")}</p>}
      </div>
    </>
  );
}
