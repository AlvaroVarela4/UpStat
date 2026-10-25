-- Sync diario de Strava: red de seguridad si se pierde algún evento del webhook y
-- actividad diaria para que el proyecto gratuito no se pause.
-- Requiere el secret key del proyecto en Vault (no va en el repo):
--   select vault.create_secret('sb_secret_...', 'strava_sync_key');
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'strava-sync-daily',
  '0 4 * * *', -- 04:00 UTC
  $$
  select net.http_post(
    url := 'https://jjcqmsoombbrzpeftgww.supabase.co/functions/v1/strava-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'strava_sync_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
