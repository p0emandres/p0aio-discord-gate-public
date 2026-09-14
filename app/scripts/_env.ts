// Local scripts read app/.env.local (written by ../env_sync.py --local). Vercel injects env in production.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadLocalEnv() {
  for (const f of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(resolve(process.cwd(), f), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2];
        if (v.length >= 2 && v[0] === "'" && v.at(-1) === "'") v = v.slice(1, -1);
        else if (v.length >= 2 && v[0] === '"' && v.at(-1) === '"') v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        if (!process.env[m[1]]) process.env[m[1]] = v;
      }
    } catch { /* file optional */ }
  }
}
