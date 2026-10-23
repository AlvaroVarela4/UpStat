-- Tokens de terceros. RLS sin políticas: solo service_role (Edge Functions) accede.
create table integrations (
  provider        text primary key check (provider in ('strava', 'apple_health', 'playtomic')),
  user_id         uuid not null references auth.users on delete cascade,
  access_token    text,
  refresh_token   text,
  expires_at      timestamptz,
  last_sync_at    timestamptz,
  backfill_cursor text
);
alter table integrations enable row level security;

create table activities (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users on delete cascade,
  source      text not null check (source in ('strava', 'apple_health', 'playtomic')),
  source_id   text not null,
  sport_type  text not null,
  start_at    timestamptz not null,
  duration_s  integer,
  distance_m  real,
  elevation_m real,
  avg_hr      smallint,
  max_hr      smallint,
  calories    real,
  merged_into bigint references activities on delete set null,
  raw         jsonb,
  unique (source, source_id)
);
create index on activities (user_id, start_at desc);
alter table activities enable row level security;

-- Escrituras solo desde Edge Functions (service_role ignora RLS).
create policy "owner reads" on activities
  for select to authenticated using (user_id = (select auth.uid()));
