import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { getStravaToken, type StravaActivity, toActivityRow } from "../_shared/strava.ts";

// Importa actividades de Strava posteriores a `backfill_cursor` (epoch del último start_date importado).
// Sirve para el backfill y para la sincronización incremental. Cada llamada hace como máximo
// MAX_PAGES peticiones; el cliente repite hasta `done` para respetar el límite de Strava.
// Auth: usuario (botón de la UI) o secret key (`pg_cron` diario, ver migración strava_sync_cron).
const MAX_PAGES = 5;
const PER_PAGE = 200;

export default {
  fetch: withSupabase({ auth: ["user", "secret"] }, async (_req, ctx) => {
    const db = ctx.supabaseAdmin;

    let strava;
    try {
      strava = await getStravaToken(db);
    } catch (e) {
      const msg = (e as Error).message;
      return fail(msg, e, msg === "strava not connected" ? 404 : 502);
    }
    const { token, userId } = strava;

    let cursor = Number(strava.cursor ?? 0);
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
          batch.map((a) => toActivityRow(a, userId)),
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
