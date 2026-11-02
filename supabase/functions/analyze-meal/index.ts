// Supabase Edge Function: analyze-meal
// Reads a meal photo and returns detected items with estimated grams and kcal.
// The AI provider (Claude or Gemini) and model are chosen by admins in the app (table app_settings).
// Secrets: ANTHROPIC_API_KEY and/or GEMINI_API_KEY

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

type Settings = { provider: string; claudeModel: string; geminiModel: string };

async function loadSettings(): Promise<Settings> {
  const s: Settings = { provider: "gemini", claudeModel: "claude-sonnet-5-5", geminiModel: "gemini-flash-latest" };
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return s;
    const r = await fetch(`${url}/rest/v1/app_settings?select=key,value`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) return s;
    for (const row of await r.json()) {
      if (row.key === "ai_provider") s.provider = row.value;
      if (row.key === "ai_model_claude") s.claudeModel = row.value;
      if (row.key === "ai_model_gemini") s.geminiModel = row.value;
    }
  } catch { /* use defaults */ }
  return s;
}

async function askClaude(model: string, image: string, mediaType: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 600,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
        { type: "text", text: PROMPT },
      ] }],
    }),
  });
  if (!r.ok) throw new Error(`Claude: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.content?.find((c: { type: string }) => c.type === "text")?.text ?? "{}";
}

async function askGemini(model: string, image: string, mediaType: string): Promise<string> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mediaType, data: image } }, { text: PROMPT }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 800 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "{}";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const settings = await loadSettings();
    const hasClaude = !!Deno.env.get("ANTHROPIC_API_KEY");
    const hasGemini = !!Deno.env.get("GEMINI_API_KEY");

    // Admin page asks which keys are configured
    if (body.action === "status") {
      return json({ provider: settings.provider, keys: { claude: hasClaude, gemini: hasGemini } });
    }

    const { image, media_type } = body;
    if (!image || typeof image !== "string" || image.length > 7_000_000) {
      return json({ error: "Send a JPEG/PNG photo under 5 MB" }, 400);
    }
    const mediaType = media_type ?? "image/jpeg";

    // Use the chosen provider; fall back to the other one if its key is missing
    let provider = settings.provider;
    if (provider === "claude" && !hasClaude && hasGemini) provider = "gemini";
    if (provider === "gemini" && !hasGemini && hasClaude) provider = "claude";
    if (!(provider === "claude" ? hasClaude : hasGemini)) return json({ error: "AI is not configured yet" }, 503);

    const text = provider === "claude"
      ? await askClaude(settings.claudeModel, image, mediaType)
      : await askGemini(settings.geminiModel, image, mediaType);

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
    return json({ items, provider });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
