// Supabase Edge Function: dish-image (admins only)
// {dish_id} → generates a food photo for the dish in the app's house style, stores it, saves image_url.
// To keep every photo consistent, an existing dish photo is sent along as a style reference.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// The Snack & Burn house style: same camera, plate, background and light for every dish
const HOUSE_STYLE = `Professional food photography for a mobile app menu. Square 1:1.
Camera: straight top-down (flat lay), dish centered, filling about 70% of the frame, nothing cropped.
Serveware: plain matte off-white ceramic bowl or plate (a clear glass for drinks, shot at a slight 30° angle from above).
Background: smooth warm cream surface, color #FFF8EE, no texture, no table edges.
Light: soft natural daylight from the top-left, gentle soft shadow to the bottom-right, bright and appetizing, true-to-life colors.
Props: at most one small relevant garnish beside the dish (e.g. lime wedge, chili, herbs). No hands, no people, no chopsticks pointing at camera.
Absolutely no text, letters, logos, watermarks or borders.`;

async function gemini(model: string, prompt: string, ref?: { mime: string; data: string }) {
  const parts: unknown[] = [];
  if (ref) parts.push({ inline_data: { mime_type: ref.mime, data: ref.data } });
  parts.push({ text: prompt });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } } }),
    signal: AbortSignal.timeout(90000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Image model ${model}: ${r.status} ${t.slice(0, 300)}`);
  const d = JSON.parse(t);
  const img = (d.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: unknown; inline_data?: unknown }) => p.inlineData || p.inline_data);
  const data = img?.inlineData ?? img?.inline_data;
  if (!data?.data) throw new Error(`No image returned (${d.candidates?.[0]?.finishReason ?? "unknown"})`);
  return { mime: data.mimeType ?? data.mime_type ?? "image/png", bytes: Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0)) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
    const { data: u } = await db.auth.getUser(token);
    if (!u?.user) return json({ error: "Sign in first" }, 401);
    const { data: me } = await db.from("profiles").select("is_admin").eq("id", u.user.id).single();
    if (!me?.is_admin) return json({ error: "Admins only" }, 403);
    if (!Deno.env.get("GEMINI_API_KEY")) return json({ error: "Add GEMINI_API_KEY in Supabase first" }, 503);

    const { dish_id } = await req.json();
    const { data: dish } = await db.from("dishes").select("*").eq("id", dish_id).single();
    if (!dish) return json({ error: "Dish not found" }, 404);

    // style reference: the earliest dish that already has a photo (other than this one)
    let ref: { mime: string; data: string } | undefined;
    const { data: refDish } = await db.from("dishes").select("image_url").not("image_url", "is", null).neq("id", dish_id).order("updated_at").limit(1).maybeSingle();
    if (refDish?.image_url) {
      const rr = await fetch(refDish.image_url);
      if (rr.ok) {
        const buf = new Uint8Array(await rr.arrayBuffer());
        let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        ref = { mime: rr.headers.get("content-type") ?? "image/png", data: btoa(bin) };
      }
    }

    const prompt = `${HOUSE_STYLE}
${ref ? "The attached photo is the STYLE REFERENCE from the same menu: match its camera angle, background color, plate style, lighting, color grading and framing exactly. Do not copy its food." : ""}
Dish to photograph: ${dish.name}${dish.description ? ` (${dish.description})` : ""}. Authentic Vietnamese presentation, a typical single portion.`;

    const { data: s } = await db.from("app_settings").select("value").eq("key", "ai_model_image").maybeSingle();
    const model = s?.value || "gemini-2.5-flash-image";
    const img = await gemini(model, prompt, ref);

    const ext = img.mime.includes("jpeg") ? "jpg" : img.mime.includes("webp") ? "webp" : "png";
    const path = `${dish.id}-${Date.now()}.${ext}`;
    const up = await db.storage.from("dish-images").upload(path, img.bytes, { contentType: img.mime, upsert: true, cacheControl: "31536000" });
    if (up.error) throw up.error;
    const url = db.storage.from("dish-images").getPublicUrl(path).data.publicUrl;
    await db.from("dishes").update({ image_url: url, updated_at: new Date().toISOString() }).eq("id", dish.id);
    console.log("image for", dish.name, "→", path, ref ? "(with style ref)" : "(first, sets the style)");
    return json({ image_url: url, styled_from_reference: !!ref });
  } catch (e) {
    console.error("dish-image error", String(e));
    return json({ error: String(e) }, 500);
  }
});
