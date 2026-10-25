-- Agregados diarios de Apple Health (Health Auto Export → health-ingest). Una fila por día local.
create table daily_health (
  user_id     uuid not null references auth.users on delete cascade,
  date        date not null,
  steps       integer,
  active_kcal real,
  resting_hr  smallint,
  hrv_ms      real,
  sleep_min   integer,
  vo2max      real,
  primary key (user_id, date)
);
alter table daily_health enable row level security;

-- Escrituras solo desde Edge Functions (service_role ignora RLS).
create policy "owner reads" on daily_health
  for select to authenticated using (user_id = (select auth.uid()));
