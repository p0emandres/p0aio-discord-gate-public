// Who owns what, straight from the chain. The client is never trusted for any of this.
import { createPublicClient, http } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { env } from "./env";

const chain = () => (env.chainId === 11155111 ? sepolia : mainnet);
let _client: ReturnType<typeof createPublicClient> | undefined;
export const client = () => (_client ??= createPublicClient({ chain: chain(), transport: http(env.rpcUrl) }));

/** tokenId → owner (lowercase). Whole collection in one Alchemy NFT-API call; cached briefly. */
let cache: { at: number; map: Map<string, string> } | undefined;
export async function ownershipMap(force = false): Promise<Map<string, string>> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.map;
  const m = env.rpcUrl.match(/^https:\/\/([a-z0-9-]+)\.g\.alchemy\.com\/v2\/([^/?#]+)/);
  if (!m) throw new Error("RPC_URL must be an Alchemy endpoint (the holder lookup uses Alchemy's NFT API)");
  const [, net, key] = m;
  const base = process.env.ALCHEMY_NFT_BASE || `https://${net}.g.alchemy.com/nft/v3/${key}`; // override only for local tests
  const map = new Map<string, string>();
  let pageKey: string | undefined;
  for (let i = 0; i < 100; i++) {
    const u = new URL(`${base}/getOwnersForContract`);
    u.searchParams.set("contractAddress", env.collection);
    u.searchParams.set("withTokenBalances", "true");
    if (pageKey) u.searchParams.set("pageKey", pageKey);
    const res = await fetch(u, { cache: "no-store" });
    if (!res.ok) throw new Error(`Alchemy getOwnersForContract HTTP ${res.status}`);
    const j = (await res.json()) as { owners: { ownerAddress: string; tokenBalances: { tokenId: string; balance: string }[] }[]; pageKey?: string };
    for (const o of j.owners ?? []) {
      const owner = o.ownerAddress.toLowerCase();
      for (const tb of o.tokenBalances ?? []) {
        if (BigInt(tb.balance || "1") > 0n) map.set(BigInt(tb.tokenId).toString(), owner);
      }
    }
    pageKey = j.pageKey;
    if (!pageKey) break;
  }
  cache = { at: Date.now(), map };
  return map;
}

export async function tokensOf(wallet: string, force = false): Promise<string[]> {
  const w = wallet.toLowerCase();
  const map = await ownershipMap(force);
  return [...map].filter(([, o]) => o === w).map(([t]) => t).sort((a, b) => Number(a) - Number(b));
}

export const NONCE_TTL_MS = 5 * 60_000;

export function buildSiwe(p: { address: `0x${string}`; uid: string; name: string; nonce: string }): string {
  return createSiweMessage({
    address: p.address,
    chainId: env.chainId,
    domain: env.verifyDomain,
    uri: env.origin,
    nonce: p.nonce,
    version: "1",
    statement: `Prove you hold ${env.projectName} for Discord user ${p.name} (${p.uid}). Signing is free and moves nothing.`,
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + NONCE_TTL_MS),
  });
}

export function parseSiwe(message: string) {
  return parseSiweMessage(message);
}

/** Full EIP-4361 check: domain, nonce, expiry, chain, address AND the signature (EOA or smart-account). */
export async function verifySiwe(p: { message: string; signature: `0x${string}`; nonce: string; address: `0x${string}` }): Promise<boolean> {
  try {
    return await client().verifySiweMessage({
      message: p.message,
      signature: p.signature,
      domain: env.verifyDomain,
      nonce: p.nonce,
      address: p.address,
      time: new Date(),
    });
  } catch {
    return false;
  }
}
