import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Importa actividades de Strava posteriores a `backfill_cursor` (epoch del último start_date importado).
// Sirve para el backfill y para la sincronización incremental. Cada llamada hace como máximo
// MAX_PAGES peticiones; el cliente repite hasta `done` para respetar el límite de Strava.
const MAX_PAGES = 5;
const PER_PAGE = 200;

type StravaActivity = {
  id: number;
  sport_type?: string;
  type: string;
  start_date: string;
  moving_time: number;
  distance: number;
  total_elevation_gain: number;
  average_heartrate?: number;
  max_heartrate?: number;
};

const round = (n?: number) => (n == null ? null : Math.round(n));

export default {
  fetch: withSupabase({ auth: "user" }, async (_req, ctx) => {
    const db = ctx.supabaseAdmin;
    const userId = ctx.userClaims!.id;

    const { data: integ, error } = await db.from("integrations")
      .select("access_token, refresh_token, expires_at, backfill_cursor")
      .eq("provider", "strava").eq("user_id", userId).maybeSingle();
    if (error) return fail("integrations read failed", error, 500);
    if (!integ) return Response.json({ error: "strava not connected" }, { status: 404 });

    let token = integ.access_token;
    if (new Date(integ.expires_at).getTime() < Date.now() + 60_000) {
      const res = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: Deno.env.get("STRAVA_CLIENT_ID")!,
          client_secret: Deno.env.get("STRAVA_CLIENT_SECRET")!,
          grant_type: "refresh_token",
          refresh_token: integ.refresh_token,
        }),
      });
      if (!res.ok) return fail("token refresh failed", await res.text(), 502);
      const t = await res.json();
      token = t.access_token;
      const { error } = await db.from("integrations").update({
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: new Date(t.expires_at * 1000).toISOString(),
      }).eq("provider", "strava");
      if (error) return fail("token save failed", error, 500);
    }

    let cursor = Number(integ.backfill_cursor ?? 0);
    let imported = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${cursor}&per_page=${PER_PAGE}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status === 429) return Response.json({ imported, done: false, rateLimited: true });
      if (!res.ok) return fail("activities fetch failed", await res.text(), 502);
      const batch: StravaActivity[] = await res.json();

      // Con `after`, Strava devuelve orden ascendente; el cursor depende de ello.
      if (batch.some((a, i) => i > 0 && a.start_date < batch[i - 1].start_date)) {
        return fail("unexpected activity order", batch.map((a) => a.start_date), 500);
      }

      if (batch.length) {
        const { error } = await db.from("activities").upsert(
          batch.map((a) => ({
            user_id: userId,
            source: "strava",
            source_id: String(a.id),
            sport_type: a.sport_type ?? a.type,
            start_at: a.start_date,
            duration_s: a.moving_time,
            distance_m: a.distance,
            elevation_m: a.total_elevation_gain,
            avg_hr: round(a.average_heartrate),
            max_hr: round(a.max_heartrate),
            raw: a,
          })),
          { onConflict: "source,source_id" },
        );
        if (error) return fail("activities upsert failed", error, 500);
        imported += batch.length;
        cursor = Date.parse(batch[batch.length - 1].start_date) / 1000;
      }

      const done = batch.length < PER_PAGE;
      const { error } = await db.from("integrations").update({
        backfill_cursor: String(cursor),
        ...(done && { last_sync_at: new Date().toISOString() }),
      }).eq("provider", "strava");
      if (error) return fail("cursor save failed", error, 500);
      if (done) return Response.json({ imported, done: true });
    }
    return Response.json({ imported, done: false });
  }),
};

function fail(msg: string, detail: unknown, status: number) {
  console.error(msg, detail);
  return Response.json({ error: msg }, { status });
}
