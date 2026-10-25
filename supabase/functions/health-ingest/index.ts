import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Recibe el POST de Health Auto Export (formato JSON v2, agregación por días).
// https://help.healthyapps.dev/en/health-auto-export/export-format
// Auth: cabecera `x-ingest-token` igual al secret HEALTH_INGEST_TOKEN.
// Métricas → `daily_health` (una fila por día); entrenos → `activities` (source apple_health).

type Qty = { qty: number; units: string };
type Metric = { name: string; units: string; data: { date: string; qty?: number; totalSleep?: number }[] };
type Workout = {
  id: string;
  name: string;
  start: string;
  duration: number;
  distance?: Qty;
  elevationUp?: Qty;
  activeEnergyBurned?: Qty;
  heartRate?: { avg?: Qty; max?: Qty };
  avgHeartRate?: Qty;
  maxHeartRate?: Qty;
  route?: unknown;
};

// A unidades SI / kcal. Unidad desconocida: se deja tal cual.
const METERS: Record<string, number> = { m: 1, km: 1000, mi: 1609.344, ft: 0.3048 };
const meters = (q?: Qty) => (q ? q.qty * (METERS[q.units] ?? 1) : null);
const kcal = (q: number, units: string) => (units === "kJ" ? q / 4.184 : q);
const round = (n?: number | null) => (n == null ? null : Math.round(n));

const COLUMNS = {
  step_count: "steps",
  active_energy: "active_kcal",
  resting_heart_rate: "resting_hr",
  heart_rate_variability: "hrv_ms",
  vo2_max: "vo2max",
  sleep_analysis: "sleep_min",
} as const;

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    const token = Deno.env.get("HEALTH_INGEST_TOKEN");
    if (!token || req.headers.get("x-ingest-token") !== token) return new Response("forbidden", { status: 403 });

    const body = await req.json().catch(() => null);
    const metrics: Metric[] = body?.data?.metrics ?? [];
    const workouts: Workout[] = body?.data?.workouts ?? [];
    const db = ctx.supabaseAdmin;

    // App de un solo usuario y registro desactivado: el único usuario es el dueño.
    const { data: users, error: usersError } = await db.auth.admin.listUsers({ perPage: 2 });
    if (usersError || users.users.length !== 1) return fail("owner lookup failed", usersError ?? users.users.length, 500);
    const userId = users.users[0].id;

    // Filas completas: una exportación trae todas las métricas, así el upsert no deja columnas a medias.
    const days = new Map<string, Record<string, number | null | string>>();
    for (const m of metrics) {
      const col = COLUMNS[m.name as keyof typeof COLUMNS];
      if (!col) {
        console.log("ignored metric", m.name);
        continue;
      }
      for (const d of m.data) {
        const date = d.date.slice(0, 10); // "yyyy-MM-dd HH:mm:ss Z": día local del iPhone
        const row = days.get(date) ??
          { user_id: userId, date, ...Object.fromEntries(Object.values(COLUMNS).map((c) => [c, null])) };
        const v = col === "sleep_min" ? d.totalSleep && d.totalSleep * 60 : d.qty; // sueño: horas → min
        row[col] = v == null ? null
          : col === "active_kcal" ? kcal(v, m.units)
          : col === "hrv_ms" || col === "vo2max" ? v
          : Math.round(v);
        days.set(date, row);
      }
    }
    if (days.size) {
      const { error } = await db.from("daily_health").upsert([...days.values()], { onConflict: "user_id,date" });
      if (error) return fail("daily_health upsert failed", error, 500);
    }

    if (workouts.length) {
      const { error } = await db.from("activities").upsert(
        workouts.map(({ route: _route, ...w }) => ({ // sin la ruta GPS: ocupa mucho y no se usa
          user_id: userId,
          source: "apple_health",
          source_id: w.id,
          sport_type: w.name,
          start_at: w.start,
          duration_s: round(w.duration),
          distance_m: meters(w.distance),
          elevation_m: meters(w.elevationUp),
          avg_hr: round((w.heartRate?.avg ?? w.avgHeartRate)?.qty),
          max_hr: round((w.heartRate?.max ?? w.maxHeartRate)?.qty),
          calories: w.activeEnergyBurned ? kcal(w.activeEnergyBurned.qty, w.activeEnergyBurned.units) : null,
          raw: w,
        })),
        { onConflict: "source,source_id" },
      );
      if (error) return fail("activities upsert failed", error, 500);
    }

    console.log("ingested", { days: days.size, workouts: workouts.length });
    return Response.json({ days: days.size, workouts: workouts.length });
  }),
};

function fail(msg: string, detail: unknown, status: number) {
  console.error(msg, detail);
  return Response.json({ error: msg }, { status });
}
