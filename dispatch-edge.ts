import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

webpush.setVapidDetails(
  "mailto:admin@mewarhelpnots.edu",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!
);

Deno.serve(async () => {
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: pending } = await sb
    .from("notification_outbox")
    .select("*")
    .in("status", ["pending", "failed"])
    .lt("attempts", 5)
    .lte("next_retry_at", new Date().toISOString())
    .limit(20);

  for (const job of pending ?? []) {
    try {
      let query = sb.from("push_subscriptions").select("id, subscription_json, user_id");
      if (job.target_user_id) query = query.eq("user_id", job.target_user_id);
      else if (job.author_id) query = query.neq("user_id", job.author_id);

      const { data: subs } = await query;
      for (const s of subs ?? []) {
        try {
          await webpush.sendNotification(
            s.subscription_json,
            JSON.stringify({ title: job.title, body: job.body, url: "./" })
          );
        } catch (err: any) {
          if (err?.statusCode === 410 || err?.statusCode === 404) {
            await sb.from("push_subscriptions").delete().eq("id", s.id);
          }
        }
      }

      await sb.from("notification_outbox").update({
        status: "sent", sent_at: new Date().toISOString(), attempts: job.attempts + 1
      }).eq("id", job.id);
    } catch (e: any) {
      await sb.from("notification_outbox").update({
        status: "failed",
        attempts: job.attempts + 1,
        last_error: String(e?.message || e),
        next_retry_at: new Date(Date.now() + 60_000 * (job.attempts + 1)).toISOString()
      }).eq("id", job.id);
    }
  }

  return new Response(JSON.stringify({ processed: pending?.length ?? 0 }), {
    headers: { "content-type": "application/json" }
  });
});