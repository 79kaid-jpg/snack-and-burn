// Supabase Edge Function: send-reminders
// - Called hourly by pg_cron with header x-cron-secret: sends lunch / evening / challenge nudges (Vietnam time).
// - Called by a signed-in user with {"test": true}: sends one test notification to that user.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APP_URL = "https://79kaid-jpg.github.io/snack-and-burn/";

async function secrets() {
  const { data } = await db.from("server_secrets").select("key,value");
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

type Msg = { title: string; body: string; url?: string; tag?: string };

async function sendTo(userId: string, msg: Msg) {
  const { data: subs } = await db.from("push_subs").select("*").eq("user_id", userId);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ ...msg, url: msg.url ?? APP_URL }),
        { TTL: 3600 },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subs").delete().eq("endpoint", s.endpoint); // expired
      else console.error("push failed", code, String(e).slice(0, 200));
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const sec = await secrets();
    webpush.setVapidDetails("mailto:79kaid@gmail.com", sec.vapid_public, sec.vapid_private);
    const body = await req.json().catch(() => ({}));

    // 1) Test notification for the signed-in user
    if (body.test) {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
      const { data: u } = await db.auth.getUser(token);
      if (!u?.user) return json({ error: "Sign in first" }, 401);
      const n = await sendTo(u.user.id, { title: "Snack & Burn", body: "Thông báo đã bật! Bạn sẽ được nhắc ghi bữa ăn và vận động.", tag: "test" });
      return json({ sent: n });
    }

    // 1b) Kudos push: a signed-in friend just gave kudos on an activity
    if (body.kudos) {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
      const { data: u } = await db.auth.getUser(token);
      if (!u?.user) return json({ error: "Sign in first" }, 401);
      const { data: k } = await db.from("kudos").select("activity_id, activities!inner(user_id,kind,kcal)").eq("activity_id", body.kudos).eq("user_id", u.user.id).maybeSingle();
      if (!k) return json({ sent: 0 });
      const act = (k as unknown as { activities: { user_id: string; kind: string; kcal: number } }).activities;
      const { data: me } = await db.from("profiles").select("display_name").eq("id", u.user.id).single();
      const n = await sendTo(act.user_id, { title: "🔥 Kudos!", body: `${me?.display_name ?? "Một người bạn"} vừa thả kudos cho buổi ${act.kcal} kcal của bạn.`, url: APP_URL + "#friends", tag: "kudos-" + body.kudos });
      return json({ sent: n });
    }

    // 2) Scheduled run
    if (req.headers.get("x-cron-secret") !== sec.cron_secret) return json({ error: "Forbidden" }, 403);
    const now = new Date(Date.now() + 7 * 3600e3); // Vietnam time
    const hour = now.getUTCHours();
    const today = now.toISOString().slice(0, 10);
    const dayStart = new Date(`${today}T00:00:00+07:00`).toISOString();

    const { data: users } = await db.from("push_subs").select("user_id");
    const ids = [...new Set((users ?? []).map((r) => r.user_id))];
    let total = 0;

    for (const id of ids) {
      const { data: p } = await db.from("profiles").select("display_name,notify_meals,notify_burn,notify_challenge,blocked,serious_mode").eq("id", id).single();
      if (!p || p.blocked) continue;

      if (hour === 12 && p.notify_meals) {
        const { count } = await db.from("meals").select("id", { count: "exact", head: true }).eq("user_id", id).gte("eaten_at", dayStart);
        if (!count) total += await sendTo(id, { title: "Bữa trưa thế nào?", body: p.serious_mode ? "Bạn chưa ghi bữa nào hôm nay." : "Chụp một tấm là xong. Đừng để bữa trưa trốn thoát!", url: APP_URL + "#snap", tag: "lunch" });
      }

      if (hour === 19 && p.notify_burn) {
        const { count } = await db.from("activities").select("id", { count: "exact", head: true }).eq("user_id", id).gte("started_at", dayStart);
        if (!count) total += await sendTo(id, { title: "Hôm nay chưa đốt gì nè", body: p.serious_mode ? "Bạn chưa ghi hoạt động nào hôm nay." : "Đi bộ 20 phút cũng tính! Giày của bạn đang nhớ bạn.", url: APP_URL + "#home", tag: "burn" });
      }

      if (hour === 18 && p.notify_challenge) {
        const { data: mine } = await db.from("challenge_members").select("challenge_id, challenges!inner(id,name,metric,starts_at,ends_at)").eq("user_id", id).gt("challenges.ends_at", new Date().toISOString());
        for (const m of mine ?? []) {
          const c = (m as unknown as { challenges: { id: string; name: string; metric: string; starts_at: string; ends_at: string } }).challenges;
          const { data: mem } = await db.from("challenge_members").select("user_id").eq("challenge_id", c.id);
          const scores: { id: string; s: number }[] = [];
          for (const x of mem ?? []) {
            const { data: acts } = await db.from("activities").select("kind,distance_km,kcal").eq("user_id", x.user_id).gte("started_at", c.starts_at).lte("started_at", c.ends_at);
            const s = (acts ?? []).reduce((t, a) => t + (c.metric === "km" ? (a.kind === "run" ? Number(a.distance_km) : 0) : a.kcal), 0);
            scores.push({ id: x.user_id, s });
          }
          scores.sort((a, b) => b.s - a.s);
          const rank = scores.findIndex((x) => x.id === id);
          if (rank > 0) {
            const gap = scores[0].s - scores[rank].s;
            const { data: lead } = await db.from("profiles").select("display_name").eq("id", scores[0].id).single();
            const g = c.metric === "km" ? `${gap.toFixed(1)} km` : `${Math.round(gap)} kcal`;
            total += await sendTo(id, { title: c.name, body: `Còn ${g} nữa là vượt ${lead?.display_name ?? "người dẫn đầu"}!`, url: APP_URL + "#challenges", tag: "ch-" + c.id });
          }
        }
      }
    }
    console.log("hour", hour, "users", ids.length, "sent", total);
    return json({ hour, users: ids.length, sent: total });
  } catch (e) {
    console.error("send-reminders error", String(e));
    return json({ error: String(e) }, 500);
  }
});
