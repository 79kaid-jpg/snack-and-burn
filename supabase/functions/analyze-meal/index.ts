// Supabase Edge Function: analyze-meal
// Receives a meal photo (base64) and returns detected items with estimated grams and kcal.
// Secret needed:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROMPT = `You are a nutrition estimator for a calorie app used in Vietnam.
Identify each distinct food or drink in the photo. Prefer Vietnamese dish names
(with diacritics) and add an English hint in brackets, e.g. "Thịt kho (braised pork belly)".
Estimate the portion in grams and the calories for that portion, including likely
hidden oil, fat and sugar. Reply with JSON only, no prose:
{"items":[{"name":"...","grams":0,"kcal":0}]}
If there is no food in the photo, reply {"items":[]}.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { image, media_type } = await req.json();
    if (!image || typeof image !== "string" || image.length > 7_000_000) {
      return json({ error: "Send a JPEG/PNG photo under 5 MB" }, 400);
    }
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "AI is not configured yet" }, 503);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5",
        max_tokens: 600,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media_type ?? "image/jpeg", data: image } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
    });
    if (!r.ok) return json({ error: "AI request failed", detail: await r.text() }, 502);
    const data = await r.json();
    const text: string = data.content?.find((c: { type: string }) => c.type === "text")?.text ?? "{}";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : { items: [] };
    const items = (parsed.items ?? [])
      .filter((i: Record<string, unknown>) => i && i.name)
      .slice(0, 8)
      .map((i: Record<string, unknown>) => ({
        name: String(i.name).slice(0, 80),
        grams: Math.max(0, Math.round(Number(i.grams) || 0)),
        kcal: Math.max(0, Math.round(Number(i.kcal) || 0)),
      }));
    return json({ items });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
