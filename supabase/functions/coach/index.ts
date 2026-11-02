// Supabase Edge Function: coach
// {mode:"weekly", refresh?:bool} → weekly report for the signed-in user (cached per week)
// {mode:"chat", question, history?:[{role:"user"|"coach", text}]} → short answer using the user's own data
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const RULES = `You are "Coach", the friendly AI coach inside Snack & Burn, a calorie + running app used in Vietnam.
Style: warm, upbeat, a little cheeky (unless serious mode), short sentences, concrete numbers from the data, practical Vietnamese food and activity ideas.
Safety: you are not a doctor. Never suggest eating under 1,200 kcal/day (women) or 1,500 (men), skipping meals, purging, or exercising through pain.
Never shame. If the user mentions an eating disorder, injury, pregnancy, chest pain or a medical condition, be kind and suggest seeing a doctor.
Reply in the user's language (default Vietnamese). Plain text, no markdown headings, no tables.`;

async function settings() {
  const { data } = await db.from("app_settings").select("key,value");
  const s = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  return { provider: s.ai_provider ?? "gemini", claude: s.ai_model_claude ?? "claude-sonnet-5-5", gemini: s.ai_model_gemini ?? "gemini-flash-lite-latest" };
}

async function gemini(model: string, prompt: string, ms: number) {
  const keys = [Deno.env.get("GEMINI_API_KEY"), Deno.env.get("GEMINI_API_KEY_FREE")].filter(Boolean) as string[];
  let last: unknown;
  for (const key of keys) {
    try { return await geminiKey(key, model, prompt, ms); }
    catch (e) { last = e; if (!/Gemini (402|429)/.test(String(e))) throw e; }
  }
  throw last;
}
async function geminiKey(key: string, model: string, prompt: string, ms: number) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 2048 } }),
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("").trim();
}
async function claude(model: string, prompt: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`Claude ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("").trim();
}
async function ask(prompt: string) {
  const s = await settings();
  const hasC = !!Deno.env.get("ANTHROPIC_API_KEY"), hasG = !!(Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GEMINI_API_KEY_FREE"));
  let p = s.provider;
  if (p === "claude" && !hasC && hasG) p = "gemini";
  if (p === "gemini" && !hasG && hasC) p = "claude";
  if (p === "claude") return await claude(s.claude, prompt);
  if (!hasG) throw new Error("AI is not configured yet");
  try { return await gemini(s.gemini, prompt, s.gemini === "gemini-flash-lite-latest" ? 40000 : 20000); }
  catch (e) { if (s.gemini === "gemini-flash-lite-latest") throw e; return await gemini("gemini-flash-lite-latest", prompt, 30000); }
}

// Last 7 days of the user's data, summarised as plain text for the model
async function context(uid: string) {
  const vn = (d: Date) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [p, m, a, w, t] = await Promise.all([
    db.from("profiles").select("display_name,sex,age,height_cm,weight_kg,budget_kcal,serious_mode").eq("id", uid).single(),
    db.from("meals").select("name,kcal,eaten_at").eq("user_id", uid).gte("eaten_at", since).order("eaten_at"),
    db.from("activities").select("kind,distance_km,minutes,steps,kcal,started_at").eq("user_id", uid).gte("started_at", since).order("started_at"),
    db.from("weights").select("day,kg").eq("user_id", uid).order("day", { ascending: false }).limit(8),
    db.from("user_badges").select("code").eq("user_id", uid),
  ]);
  const prof = p.data!;
  const days: Record<string, { eat: number; burn: number; meals: string[]; acts: string[] }> = {};
  for (let i = 6; i >= 0; i--) days[vn(new Date(Date.now() - i * 864e5))] = { eat: 0, burn: 0, meals: [], acts: [] };
  for (const x of m.data ?? []) {
    const d = days[vn(new Date(x.eaten_at))]; if (!d) continue;
    const h = new Date(new Date(x.eaten_at).getTime() + 7 * 3600e3).getUTCHours();
    d.eat += x.kcal; d.meals.push(`${x.name} ${x.kcal}kcal @${h}h`);
  }
  for (const x of a.data ?? []) {
    const d = days[vn(new Date(x.started_at))]; if (!d) continue;
    d.burn += x.kcal;
    d.acts.push(x.steps > 0 ? `${x.steps} steps ${x.kcal}kcal` : `${x.kind} ${x.distance_km ? x.distance_km + "km " : ""}${x.minutes ? x.minutes + "min " : ""}${x.kcal}kcal`);
  }
  const lines = Object.entries(days).map(([d, v]) => `${d}: ate ${v.eat} kcal [${v.meals.join("; ") || "nothing logged"}], burned ${v.burn} kcal [${v.acts.join("; ") || "none"}], net ${v.eat - v.burn} vs budget ${prof.budget_kcal}`);
  return {
    serious: prof.serious_mode,
    name: prof.display_name,
    text: `User: ${prof.display_name}, ${prof.sex}, ${prof.age}y, ${prof.height_cm}cm, ${prof.weight_kg}kg, daily budget ${prof.budget_kcal} kcal.
Weights (newest first): ${(w.data ?? []).map((x) => `${x.day} ${x.kg}kg`).join(", ") || "none"}.
Badges: ${(t.data ?? []).map((x) => x.code).join(", ") || "none"}.
Last 7 days (Vietnam time):
${lines.join("\n")}`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
    const { data: u } = await db.auth.getUser(token);
    if (!u?.user) return json({ error: "Sign in first" }, 401);
    const uid = u.user.id;
    const body = await req.json().catch(() => ({}));

    if (body.mode === "weekly") {
      const now = new Date(Date.now() + 7 * 3600e3);
      const monday = new Date(now); monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
      const week = monday.toISOString().slice(0, 10);
      if (!body.refresh) {
        const { data: c } = await db.from("coach_reports").select("report,created_at").eq("user_id", uid).eq("week", week).maybeSingle();
        // reuse a report made in the last 12 hours
        if (c && Date.now() - new Date(c.created_at).getTime() < 12 * 3600e3) return json({ report: c.report, cached: true });
      }
      const ctx = await context(uid);
      const report = await ask(`${RULES}
${ctx.serious ? "Serious mode is ON: no jokes." : ""}
Write ${ctx.name}'s weekly check-in from the data below, in Vietnamese, under 160 words, in exactly this shape:
Line 1: one-sentence verdict on the week (with an emoji-free friendly tone).
Then 3 short lines starting with "• ": one win, one pattern to fix (name the day/time/food), one specific action for the next 7 days with a number.
Last line: "Mẹo hôm nay: " + one tip they can do today.
If there is almost no data, encourage them to log meals and burns for a few days instead.

DATA:
${ctx.text}`);
      await db.from("coach_reports").upsert({ user_id: uid, week, report, created_at: new Date().toISOString() });
      return json({ report });
    }

    if (body.mode === "chat") {
      const q = String(body.question ?? "").trim().slice(0, 500);
      if (!q) return json({ error: "Ask a question" }, 400);
      const hist = Array.isArray(body.history) ? body.history.slice(-6) : [];
      const ctx = await context(uid);
      const answer = await ask(`${RULES}
${ctx.serious ? "Serious mode is ON: no jokes." : ""}
Answer the user's question in under 120 words, using their data when relevant.

DATA:
${ctx.text}

CONVERSATION SO FAR:
${hist.map((h: { role: string; text: string }) => `${h.role === "coach" ? "Coach" : "User"}: ${String(h.text).slice(0, 400)}`).join("\n")}
User: ${q}
Coach:`);
      return json({ answer });
    }
    return json({ error: "Unknown mode" }, 400);
  } catch (e) {
    console.error("coach error", String(e));
    return json({ error: String(e) }, 500);
  }
});
