# CLAUDE.md — Dashboard personal de deporte y salud

## Qué es este proyecto
App web personal (un solo usuario: Álvaro) que unifica en un único frontal:
- **Strava**: actividades (correr, bici, etc.)
- **Playtomic**: partidos de pádel (resultados, compañeros, nivel)
- **Apple Health**: métricas diarias de salud (pasos, sueño, FC en reposo, VFC, calorías) y entrenos del Apple Watch

Uso personal, no multiusuario. Idioma de la UI: español. Zona horaria: Europe/Madrid.

## Stack
- **Frontend**: Vite + React + TypeScript
- **Backend**: Supabase (plan gratuito): Postgres, Auth, RLS, Edge Functions (Deno) y `pg_cron`
- **Node.js**: solo para scripts locales puntuales (p. ej. carga del histórico desde `export.xml`). No hay servidor Node en producción salvo que se decida explícitamente.
- La lógica de servidor va en **Supabase Edge Functions**, no en el frontend. Los secretos (tokens de Strava, credenciales de Playtomic) nunca se exponen al cliente.

## Integraciones (decisiones tomadas)

### Strava → API v3 oficial (NO el MCP)
- El MCP de Strava sirve para que Claude consulte datos, pero no para la sincronización del backend.
- OAuth 2.0: el callback lo gestiona una Edge Function (`strava-oauth`). Guardar `access_token`, `refresh_token` y `expires_at` en la tabla `integrations`. Refrescar el token antes de cada llamada si ha caducado.
- Para actividades nuevas, usar el **webhook** (Edge Function `strava-webhook`) en vez de hacer polling. Al recibir un evento, pedir `GET /activities/{id}` y hacer upsert.
- **Límites de peticiones** bajos (del orden de 100–200 cada 15 min y 1.000–2.000 al día). Los backfills del histórico se hacen paginados, con pausas, y reanudables (guardando un cursor).
- Las condiciones de la API de Strava son restrictivas: los datos son de uso personal, no se comparten con terceros ni se usan para entrenar modelos.

### Apple Health → envío desde el iPhone
- No existe API web; los datos solo salen del iPhone.
- Vía principal: **app Health Auto Export** (iOS), que hace POST de JSON a la Edge Function `health-ingest`, protegida con un token secreto en la cabecera.
- Alternativa: Atajos de iOS con una automatización diaria que hace POST al mismo endpoint.
- Histórico: script Node local que parsea `export.xml` en streaming (es enorme, nunca cargarlo entero en memoria) y sube **agregados diarios**.

### Playtomic → integración frágil y opcional
- **No tiene API pública.** Se puede usar la API interna no oficial (login con mi usuario y token), pero puede romperse en cualquier momento y probablemente va contra sus condiciones de uso. Usarla solo con mi cuenta y con poca frecuencia (1 vez al día como máximo).
- Toda la app debe funcionar aunque Playtomic falle: aislar esta integración en su propio módulo/Edge Function (`playtomic-sync`) y tratar sus errores sin romper nada más.
- Fallback: tabla `padel_matches` editable a mano desde el frontal. Los partidos registrados como entreno de pádel en el Apple Watch llegan por Apple Health.

## Restricciones del plan gratuito de Supabase
- **Base de datos de 500 MB**: NO guardar las muestras brutas de alta frecuencia de Apple Health (FC minuto a minuto, etc.). Guardar agregados diarios o por entreno.
- **El proyecto se pausa tras ~7 días sin actividad**: mantener un job diario de `pg_cron` (sync) para que haya actividad.
- Vigilar el tamaño de las tablas `raw_*`; purgarlas o compactarlas si crecen.

## Modelo de datos (orientativo)
- `integrations`: proveedor, tokens, `expires_at`, `last_sync_at`, cursor de backfill
- `raw_strava_activities`, `raw_health_payloads`, `raw_playtomic`: respuesta original (`jsonb`) + `source_id` + `fetched_at`. Sirven para reprocesar si cambia el modelo.
- `activities` (tabla unificada): `id`, `source` (`strava`|`apple_health`|`playtomic`), `source_id`, `sport_type`, `start_at` (timestamptz), `duration_s`, `distance_m`, `avg_hr`, `max_hr`, `calories`, `elevation_m`, `merged_into` (nullable)
- `daily_health`: `date`, `steps`, `active_kcal`, `resting_hr`, `hrv_ms`, `sleep_min`, `vo2max`, … (una fila por día)
- `padel_matches`: `played_at`, `club`, `partner`, `opponents`, `result`, `won`, `level_before`, `level_after`, `activity_id` (enlace a su entreno, si existe)
- Upserts siempre idempotentes con `unique (source, source_id)`.
- RLS activado en todas las tablas; política de acceso solo para mi `auth.uid()`.

## Deduplicación (importante)
Un entreno del Apple Watch suele acabar **también en Strava**. Al unificar:
- Considerar duplicados los entrenos con el mismo tipo de deporte y horas solapadas (inicio ±2–3 min y duración parecida).
- Prioridad de la fuente: Strava para GPS/distancia; Apple Health para FC y calorías si son más completas.
- Marcar el duplicado con `merged_into` en lugar de borrarlo.

## Convenciones
- TypeScript estricto en el frontend y en las Edge Functions.
- Fechas en `timestamptz` (UTC) en la base de datos; convertir a Europe/Madrid solo en la UI.
- Unidades en SI (metros, segundos, kcal); formatear en la UI.
- Secretos en los secrets de Supabase o en `.env.local` (nunca en el repo). Solo la `anon key` llega al frontend.
- Cada integración en su propia Edge Function, con logs claros y sin que un fallo afecte a las demás.

## Orden de trabajo / roadmap
1. Proyecto Supabase: esquema SQL, RLS y migraciones
2. Strava: OAuth, backfill del histórico, webhook
3. Apple Health: endpoint `health-ingest` + configuración de Health Auto Export; script de carga de `export.xml`
4. Frontend Vite: dashboard (resumen semanal, actividades, tendencias de salud)
5. Deduplicación entre Strava y Apple Health
6. Playtomic: sync no oficial + entrada manual de partidos

## Comandos
<!-- Rellenar cuando exista el proyecto -->
- `npm run dev`: frontend local
- `supabase start` / `supabase db push`: base de datos local y migraciones
- `supabase functions deploy <nombre>`: desplegar una Edge Function
