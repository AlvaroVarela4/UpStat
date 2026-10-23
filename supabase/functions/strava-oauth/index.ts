import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

// Recibe el `code` que Strava devuelve al frontend, lo canjea con el client secret
// (solo vive aquí) y guarda los tokens en `integrations` para el usuario del JWT.
export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const { code } = await req.json().catch(() => ({}));
    if (typeof code !== "string" || !code) {
      return Response.json({ error: "missing code" }, { status: 400 });
    }

    const res = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: Deno.env.get("STRAVA_CLIENT_ID")!,
        client_secret: Deno.env.get("STRAVA_CLIENT_SECRET")!,
        code,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      console.error("strava token exchange failed", res.status, await res.text());
      return Response.json({ error: "strava rejected the code" }, { status: 502 });
    }
    const t = await res.json();

    const { error } = await ctx.supabaseAdmin.from("integrations").upsert({
      provider: "strava",
      user_id: ctx.userClaims!.id,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: new Date(t.expires_at * 1000).toISOString(),
    });
    if (error) {
      console.error("integrations upsert failed", error);
      return Response.json({ error: "db error" }, { status: 500 });
    }

    return Response.json({ athlete: t.athlete?.firstname ?? null });
  }),
};
