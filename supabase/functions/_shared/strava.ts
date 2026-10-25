import type { SupabaseContext } from "@supabase/server";

type AdminClient = SupabaseContext["supabaseAdmin"];

// Lo comparten `strava-sync` y `strava-webhook`: token vigente y mapeo a `activities`.

export type StravaActivity = {
  id: number;
  sport_type?: string;
  type: string;
  start_date: string;
  moving_time: number;
  distance: number;
  total_elevation_gain: number;
  average_heartrate?: number;
  max_heartrate?: number;
  calories?: number; // solo en el detalle (`GET /activities/{id}`), no en la lista
};

const round = (n?: number) => (n == null ? null : Math.round(n));

export const toActivityRow = (a: StravaActivity, userId: string) => ({
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
  calories: round(a.calories) ?? undefined, // undefined: la lista no pisa las kcal del detalle
  raw: a,
});

// Hay una sola fila `strava` en `integrations` (app de un usuario). Refresca el token si
// caduca en menos de 60 s. Lanza Error si no hay integración o Strava rechaza el refresh.
export async function getStravaToken(db: AdminClient) {
  const { data: integ, error } = await db.from("integrations")
    .select("user_id, access_token, refresh_token, expires_at, backfill_cursor")
    .eq("provider", "strava").maybeSingle();
  if (error) throw new Error(`integrations read failed: ${error.message}`);
  if (!integ) throw new Error("strava not connected");

  if (new Date(integ.expires_at).getTime() >= Date.now() + 60_000) {
    return { token: integ.access_token as string, userId: integ.user_id as string, cursor: integ.backfill_cursor as string | null };
  }

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: Deno.env.get("STRAVA_CLIENT_ID")!,
      client_secret: Deno.env.get("STRAVA_CLIENT_SECRET")!,
      grant_type: "refresh_token",
      refresh_token: integ.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  const t = await res.json();
  const { error: saveError } = await db.from("integrations").update({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(t.expires_at * 1000).toISOString(),
  }).eq("provider", "strava");
  if (saveError) throw new Error(`token save failed: ${saveError.message}`);
  return { token: t.access_token as string, userId: integ.user_id as string, cursor: integ.backfill_cursor as string | null };
}
