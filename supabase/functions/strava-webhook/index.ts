import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { getStravaToken, type StravaActivity, toActivityRow } from "../_shared/strava.ts";

// Webhook de Strava (https://developers.strava.com/docs/webhooks/).
// GET: validación de la suscripción con STRAVA_WEBHOOK_VERIFY_TOKEN.
// POST: evento de actividad. Strava exige respuesta en <2 s y reintenta hasta 3 veces si
// no recibe 200; el upsert es idempotente. Los eventos no van firmados: nunca nos fiamos
// del cuerpo, siempre se consulta a Strava con nuestro token antes de escribir o borrar.
type StravaEvent = {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
};

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.method === "GET") {
      const q = new URL(req.url).searchParams;
      if (q.get("hub.mode") !== "subscribe" || q.get("hub.verify_token") !== Deno.env.get("STRAVA_WEBHOOK_VERIFY_TOKEN")) {
        return new Response("forbidden", { status: 403 });
      }
      return Response.json({ "hub.challenge": q.get("hub.challenge") });
    }

    const event: StravaEvent = await req.json().catch(() => ({}));
    if (event.object_type !== "activity" || !Number.isSafeInteger(event.object_id)) {
      console.log("ignored event", event); // p. ej. athlete deauthorize
      return new Response("ok");
    }
    try {
      await handle(ctx.supabaseAdmin, event);
    } catch (e) {
      console.error("webhook failed", event, e);
      return new Response("error", { status: 500 });
    }
    return new Response("ok");
  }),
};

async function handle(db: Parameters<typeof getStravaToken>[0], event: StravaEvent) {
  const { token, userId } = await getStravaToken(db);
  const res = await fetch(`https://www.strava.com/api/v3/activities/${event.object_id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // Borrada en Strava (o evento falso de una actividad ajena): fuera de la tabla si estaba.
  if (res.status === 404) {
    const { error } = await db.from("activities").delete()
      .eq("source", "strava").eq("source_id", String(event.object_id));
    if (error) throw new Error(`activity delete failed: ${error.message}`);
    console.log("activity removed", event.object_id);
    return;
  }
  if (!res.ok) throw new Error(`activity fetch failed: ${res.status} ${await res.text()}`);

  const a: StravaActivity = await res.json();
  const { error } = await db.from("activities").upsert(toActivityRow(a, userId), { onConflict: "source,source_id" });
  if (error) throw new Error(`activity upsert failed: ${error.message}`);
  console.log("activity upserted", event.aspect_type, a.id);
}
