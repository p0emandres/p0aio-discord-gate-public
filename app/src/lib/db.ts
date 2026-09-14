import postgres from "postgres";
import { env } from "./env";

type Sql = ReturnType<typeof postgres>;

declare global {
  // eslint-disable-next-line no-var
  var __gateSql: Sql | undefined;
}

function make(): Sql {
  const url = env.databaseUrl;
  const local = /localhost|127\.0\.0\.1/.test(url);
  return postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,               // safe behind transaction poolers (Supabase/pgbouncer/Neon pooler)
    ssl: local ? false : "require",
  });
}

const real = (): Sql => (globalThis.__gateSql ??= make());

// Lazy: the connection is created on first query, not at import time (so `next build` needs no DATABASE_URL).
export const sql: Sql = new Proxy(function () {} as unknown as Sql, {
  apply: (_t, _self, args: unknown[]) => (real() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_t, prop) => {
    const s = real() as unknown as Record<PropertyKey, unknown>;
    const v = s[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
  },
});
