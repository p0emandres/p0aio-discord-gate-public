-- Verifier state. Applied by `npm run migrate` (idempotent).
create table if not exists bindings (
  discord_user_id   text primary key,
  wallet            text not null unique,          -- lowercase 0x address
  discord_username  text,
  verified_at       timestamptz not null default now(),
  last_checked_at   timestamptz,
  token_count       integer not null default 0,
  roles             jsonb not null default '[]'    -- tier role ids the gate currently grants this user
);

-- One seat per NFT: a token can back exactly one Discord account at a time. Newest valid claim wins.
create table if not exists seats (
  token_id          text primary key,
  discord_user_id   text not null references bindings(discord_user_id) on delete cascade,
  wallet            text not null,
  claimed_at        timestamptz not null default now()
);
create index if not exists seats_user on seats(discord_user_id);

-- Single-use, short-lived sign-in challenges bound to a Discord user AND a wallet.
create table if not exists nonces (
  nonce             text primary key,
  discord_user_id   text not null,
  wallet            text not null,
  message           text not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  used_at           timestamptz
);
create index if not exists nonces_user_created on nonces(discord_user_id, created_at);

create table if not exists audit (
  id                bigserial primary key,
  at                timestamptz not null default now(),
  kind              text not null,
  discord_user_id   text,
  wallet            text,
  detail            jsonb not null default '{}'
);
create index if not exists audit_at on audit(at desc);

-- Added 2026-09-14: when we last warned a member that their server DMs are open (sweep throttles to once a day).
alter table bindings add column if not exists dm_warned_at timestamptz;
