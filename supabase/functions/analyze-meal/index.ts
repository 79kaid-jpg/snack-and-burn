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

const TEXT_PROMPT = (t: string) => `You are a nutrition estimator for a calorie app used in Vietnam.
The user described what they ate (Vietnamese or English, may be casual or voice-dictated):
"""${t.slice(0, 500)}"""
List each distinct food or drink. Use Vietnamese dish names with diacritics and an English hint in brackets.
Use the quantity they said (e.g. "2 cái", "1 tô lớn", "ly nhỏ"); otherwise assume a typical Vietnamese portion.
Estimate grams and calories including likely oil, fat and sugar. Reply with JSON only:
{"items":[{"name":"...","grams":0,"kcal":0}]}
If nothing edible is mentioned, reply {"items":[]}.`;

type Settings = { provider: string; claudeModel: string; geminiModel: string };

async function loadSettings(): Promise<Settings> {
  const s: Settings = { provider: "gemini", claudeModel: "claude-sonnet-5-5", geminiModel: "gemini-flash-lite-latest" };
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

async function askClaude(model: string, image: string | null, mediaType: string, text?: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 600,
      messages: [{ role: "user", content: image
        ? [{ type: "image", source: { type: "base64", media_type: mediaType, data: image } }, { type: "text", text: PROMPT }]
        : [{ type: "text", text: TEXT_PROMPT(text ?? "") }] }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`Claude: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  return data.content?.find((c: { type: string }) => c.type === "text")?.text ?? "{}";
}

// Paid key first; if it is out of credit (402) or rate-limited (429), use the free backup key.
const KEYS = () => [Deno.env.get("GEMINI_API_KEY"), Deno.env.get("GEMINI_API_KEY_FREE")].filter(Boolean) as string[];
async function askGeminiOnce(model: string, image: string | null, mediaType: string, text: string | undefined, ms: number): Promise<string> {
  let last: unknown;
  for (const key of KEYS()) {
    try { return await askGeminiKey(key, model, image, mediaType, text, ms); }
    catch (e) { last = e; if (!/Gemini: (402|429)/.test(String(e))) throw e; console.warn("key unavailable, trying backup:", String(e).slice(0, 80)); }
  }
  throw last;
}
async function askGeminiKey(key: string, model: string, image: string | null, mediaType: string, text: string | undefined, ms: number): Promise<string> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: image ? [{ inline_data: { mime_type: mediaType, data: image } }, { text: PROMPT }] : [{ text: TEXT_PROMPT(text ?? "") }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4096 },
    }),
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`Gemini: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  console.log("gemini finish:", data.candidates?.[0]?.finishReason, "usage:", JSON.stringify(data.usageMetadata ?? {}));
  return data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "{}";
}

// If the chosen model is slow or failing, retry once with the fast lite model.
const GEMINI_FALLBACK = "gemini-flash-lite-latest";
async function askGemini(model: string, image: string | null, mediaType: string, text?: string): Promise<string> {
  try {
    return await askGeminiOnce(model, image, mediaType, text, model === GEMINI_FALLBACK ? 40000 : 20000);
  } catch (e) {
    if (model === GEMINI_FALLBACK) throw e;
    console.warn(`gemini ${model} failed (${String(e).slice(0, 120)}); retrying with ${GEMINI_FALLBACK}`);
    return await askGeminiOnce(GEMINI_FALLBACK, image, mediaType, text, 30000);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const settings = await loadSettings();
    const hasClaude = !!Deno.env.get("ANTHROPIC_API_KEY");
    const hasGemini = KEYS().length > 0;

    // Admin page asks which keys are configured
    if (body.action === "status") {
      return json({ provider: settings.provider, keys: { claude: hasClaude, gemini: hasGemini } });
    }

    const { media_type } = body;
    const image: string | null = typeof body.image === "string" ? body.image : null;
    const said: string = typeof body.text === "string" ? body.text.trim() : "";
    if (!image && !said) return json({ error: "Send a photo or describe your meal" }, 400);
    if (image && image.length > 7_000_000) return json({ error: "Send a JPEG/PNG photo under 5 MB" }, 400);
    const mediaType = media_type ?? "image/jpeg";

    // Use the chosen provider; fall back to the other one if its key is missing
    let provider = settings.provider;
    if (provider === "claude" && !hasClaude && hasGemini) provider = "gemini";
    if (provider === "gemini" && !hasGemini && hasClaude) provider = "claude";
    if (!(provider === "claude" ? hasClaude : hasGemini)) return json({ error: "AI is not configured yet" }, 503);

    console.log(image ? `photo ${Math.round(image.length / 1024)} KB` : `text: ${said.slice(0, 80)}`, "→ provider", provider);
    const t0 = Date.now();
    const text = provider === "claude"
      ? await askClaude(settings.claudeModel, image, mediaType, said)
      : await askGemini(settings.geminiModel, image, mediaType, said);

    console.log("ai reply in", Date.now() - t0, "ms:", text.slice(0, 300));
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
    console.error("analyze-meal failed:", String(e));
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
