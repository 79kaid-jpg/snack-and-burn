import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const cfg = window.SNB_CONFIG || {};
const app = document.getElementById("app");
const tabs = document.getElementById("tabs");

if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
  app.innerHTML = `<h1>Snack &amp; Burn</h1><div class="card stack"><p><b>Almost there.</b></p>
  <p class="muted">Add your Supabase Project URL and anon key to <code>config.js</code>, then reload.</p></div>`;
  throw new Error("Missing Supabase config");
}

const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
let user = null;
let profile = null;

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n0 = (x) => Math.round(Number(x) || 0).toLocaleString("en-US");
const n1 = (x) => (Number(x) || 0).toFixed(1);
const $ = (sel) => app.querySelector(sel);
const $$ = (sel) => [...app.querySelectorAll(sel)];
const initial = (name) => esc((name || "?").trim().charAt(0).toUpperCase());
const COLORS = ["#FFB020", "#FF8A73", "#7BDC9C", "#9BC4F0", "#E8D9C2"];

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200);
}
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
function weight() { return Number(profile?.weight_kg) || 65; }
function tdee(p) {
  const base = 10 * p.weight_kg + 6.25 * p.height_cm - 5 * p.age + (p.sex === "female" ? -161 : 5);
  return Math.round((base * p.activity) / 10) * 10;
}
function burnFor(kcal) {
  const w = weight();
  return { runKm: kcal / w, walkKm: kcal / (0.5 * w), ropeMin: kcal / ((12 * w) / 60) };
}
function quip(lines) {
  if (profile?.serious_mode) return "";
  return `<p class="quip">“${esc(lines[Math.floor(Math.random() * lines.length)])}”</p>`;
}
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}
function fail(e) { console.error(e); toast(e.message || "Something went wrong"); }

// Common Vietnamese dishes (kcal per typical serving) for quick manual adds
const DISHES = [
  ["Phở bò", 430], ["Bún bò Huế", 480], ["Bún chả", 520], ["Cơm tấm sườn", 620], ["Cơm thịt kho trứng", 950],
  ["Bánh mì thịt", 450], ["Bánh xèo", 400], ["Gỏi cuốn (2 cuốn)", 160], ["Hủ tiếu", 410], ["Mì Quảng", 470],
  ["Xôi mặn", 500], ["Cháo gà", 300], ["Cơm gà", 600], ["Bò kho + bánh mì", 560], ["Bún riêu", 420],
  ["Cà phê sữa đá", 170], ["Bạc xỉu", 200], ["Trà sữa trân châu", 350], ["Nước mía", 180], ["Chè ba màu", 300],
];

// ---------- routing ----------
const VIEWS = { home, snap, challenges, friends, profileView };
let snapState = null;

async function route() {
  const { data } = await sb.auth.getSession();
  user = data.session?.user ?? null;
  if (!user) { tabs.hidden = true; return login(); }
  if (!profile || profile.id !== user.id) {
    const { data: p, error } = await sb.from("profiles")
      .select("id,display_name,sex,age,height_cm,weight_kg,activity,budget_kcal,visibility,serious_mode,invite_code,onboarded")
      .eq("id", user.id).single();
    if (error) return fail(error);
    profile = p;
    await redeemInvite();
  }
  if (!profile.onboarded) { tabs.hidden = true; return onboarding(); }
  tabs.hidden = false;
  const [name, query] = (location.hash.slice(1) || "home").split("?");
  const key = name === "profile" ? "profileView" : name;
  const view = VIEWS[key] || home;
  tabs.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.tab === name));
  app.innerHTML = `<p class="muted">Loading…</p>`;
  try { await view(new URLSearchParams(query || "")); } catch (e) { fail(e); }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
sb.auth.onAuthStateChange((evt) => { if (evt === "SIGNED_IN" || evt === "SIGNED_OUT") { profile = null; route(); } });

// Invite links look like  …/?invite=abcd1234
const inviteParam = new URLSearchParams(location.search).get("invite");
if (inviteParam) { localStorage.setItem("snb_invite", inviteParam); history.replaceState(null, "", location.pathname + location.hash); }
async function redeemInvite() {
  const code = localStorage.getItem("snb_invite");
  if (!code) return;
  localStorage.removeItem("snb_invite");
  if (code === profile.invite_code) return;
  try { await rpc("add_friend_by_code", { code }); toast("You're now friends. Time to race!"); } catch (e) { fail(e); }
}

// ---------- login ----------
function login() {
  app.innerHTML = `
    <div style="height:8vh"></div>
    <h1 style="font-size:40px">Snack <span style="color:var(--burn)">&amp;</span> Burn</h1>
    <p class="muted" style="font-size:16px">Eat it. Snap it. Burn it.</p>
    <form id="f" class="card stack">
      <label>Email<input type="email" name="email" required autocomplete="email" placeholder="you@example.com"></label>
      <button class="primary block">Send me a sign-in link</button>
      <p class="muted">No password. We email you a magic link.</p>
    </form>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    const email = new FormData(e.target).get("email");
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) return fail(error);
    app.innerHTML = `<h1>Check your email</h1><div class="card"><p>We sent a sign-in link to <b>${esc(email)}</b>. Open it on this phone.</p></div>`;
  };
}

// ---------- onboarding / profile form ----------
function statsForm(p, submitLabel) {
  return `
  <form id="stats" class="card stack">
    <label>Name<input name="display_name" required maxlength="40" value="${esc(p.display_name)}"></label>
    <div class="grid g2">
      <label>Sex<select name="sex"><option value="male" ${p.sex === "male" ? "selected" : ""}>Male</option><option value="female" ${p.sex === "female" ? "selected" : ""}>Female</option></select></label>
      <label>Age<input name="age" type="number" inputmode="numeric" min="10" max="100" required value="${esc(p.age)}"></label>
      <label>Height (cm)<input name="height_cm" type="number" inputmode="decimal" min="100" max="250" required value="${esc(p.height_cm)}"></label>
      <label>Weight (kg)<input name="weight_kg" type="number" inputmode="decimal" step="0.1" min="30" max="300" required value="${esc(p.weight_kg)}"></label>
    </div>
    <label>How active are you?
      <select name="activity">
        ${[[1.2, "Mostly sitting"], [1.375, "Light: exercise 1–3 days/week"], [1.55, "Moderate: 3–5 days/week"], [1.725, "Very active: 6–7 days/week"]]
          .map(([v, t]) => `<option value="${v}" ${Number(p.activity) === v ? "selected" : ""}>${t}</option>`).join("")}
      </select></label>
    <p class="muted">Your daily budget: <b id="budget">${n0(tdee(p))}</b> kcal</p>
    <button class="primary block">${submitLabel}</button>
  </form>`;
}
function wireStats(onDone) {
  const f = $("#stats");
  const read = () => {
    const d = Object.fromEntries(new FormData(f));
    return { display_name: d.display_name.trim(), sex: d.sex, age: +d.age, height_cm: +d.height_cm, weight_kg: +d.weight_kg, activity: +d.activity };
  };
  f.oninput = () => { const v = read(); if (v.age && v.height_cm && v.weight_kg) $("#budget").textContent = n0(tdee(v)); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = read();
    const patch = { ...v, budget_kcal: tdee(v), onboarded: true };
    const { error } = await sb.from("profiles").update(patch).eq("id", user.id);
    if (error) return fail(error);
    Object.assign(profile, patch);
    onDone();
  };
}
function onboarding() {
  app.innerHTML = `<h1>Welcome, let’s set your budget</h1>
    <p class="muted">We use this to work out how many calories you burn each day.</p>${statsForm(profile, "Let’s go")}`;
  wireStats(() => { location.hash = "#home"; route(); });
}

// ---------- HOME ----------
async function home(q) {
  const since = startOfToday();
  const [meals, acts, streak] = await Promise.all([
    sb.from("meals").select("*").gte("eaten_at", since).order("eaten_at"),
    sb.from("activities").select("*").gte("started_at", since).order("started_at"),
    rpc("my_streak"),
  ]);
  if (meals.error) throw meals.error;
  if (acts.error) throw acts.error;
  const eaten = meals.data.reduce((s, m) => s + m.kcal, 0);
  const burned = acts.data.reduce((s, a) => s + a.kcal, 0);
  const budget = profile.budget_kcal;
  const left = budget + burned - eaten;
  const total = Math.max(budget + burned, eaten, 1);
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  app.innerHTML = `
  <div class="row">
    <div><p class="muted">${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}</p><h1>Hi, ${esc(profile.display_name)}</h1></div>
    <span class="badge">${streak}-day streak</span>
  </div>
  <section class="hero" aria-label="Today's balance">
    <div class="row"><span class="muted">${left >= 0 ? "Left today" : "Over budget"}</span><span class="muted">Budget ${n0(budget)} kcal</span></div>
    <div class="big">${n0(Math.abs(left))} <small>kcal</small></div>
    <div class="bar" role="img" aria-label="Snacked ${n0(eaten)}, burned ${n0(burned)}"><span style="width:${(eaten / total) * 100}%"></span><span style="width:${(burned / total) * 100}%"></span></div>
    <div class="grid g3">
      <div><div class="muted" style="color:var(--snack)">Snacked</div><b>${n0(eaten)}</b></div>
      <div><div class="muted" style="color:#FF8A73">Burned</div><b>${n0(burned)}</b></div>
      <div><div class="muted" style="color:#7BDC9C">Net</div><b>${n0(eaten - burned)}</b></div>
    </div>
  </section>
  ${left < 0 ? `<div class="card"><p><b class="danger">≈ ${n0(-left / 7.7)} g fat</b> if you don’t burn the extra ${n0(-left)} kcal.</p><p class="muted">Run ${n1(burnFor(-left).runKm)} km or walk ${n1(burnFor(-left).walkKm)} km to balance today.</p></div>` : ""}

  <div class="row"><h2>Snacks today</h2><a class="btn outline small" href="#snap">+ Add</a></div>
  ${meals.data.length ? `<div class="list">${meals.data.map((m) => `
    <div class="row"><div><div>${esc(m.name)}</div><div class="muted">${time(m.eaten_at)}</div></div>
    <div class="row"><b>${n0(m.kcal)}</b><button class="outline small" data-del-meal="${m.id}" aria-label="Remove ${esc(m.name)}">✕</button></div></div>`).join("")}</div>`
    : `<p class="muted">Nothing yet. Tap Snap to photograph your meal.</p>`}

  <div class="row"><h2>Burns today</h2><button class="outline small" id="showLog">+ Log a burn</button></div>
  <form id="log" class="card stack" ${q.get("log") ? "" : "hidden"}>
    <div class="grid g2">
      <label>Activity<select name="kind"><option value="run">Running</option><option value="walk">Walking</option><option value="rope">Jump rope</option><option value="cycle">Cycling</option><option value="other">Other</option></select></label>
      <label>Distance (km)<input name="km" type="number" inputmode="decimal" step="0.1" min="0" value="${esc(q.get("km") || "")}"></label>
      <label>Minutes<input name="min" type="number" inputmode="numeric" min="0"></label>
      <label>kcal (auto)<input name="kcal" type="number" inputmode="numeric" min="0"></label>
    </div>
    <button class="primary block">Save burn</button>
  </form>
  ${acts.data.length ? `<div class="list" style="background:var(--tint-burn)">${acts.data.map((a) => `
    <div class="row"><div><div>${esc({ run: "Run", walk: "Walk", rope: "Jump rope", cycle: "Ride", other: "Workout" }[a.kind])}${a.distance_km ? ` · ${n1(a.distance_km)} km` : ""}${a.minutes ? ` · ${a.minutes} min` : ""}</div><div class="muted">${time(a.started_at)} · ${esc(a.source)}</div></div>
    <div class="row"><b class="danger">−${n0(a.kcal)}</b><button class="outline small" data-del-act="${a.id}" aria-label="Remove activity">✕</button></div></div>`).join("")}</div>`
    : `<p class="muted">No burns yet today.</p>`}
  ${quip(["Every snack has a price. It’s paid in kilometres.", "Your shoes miss you.", "Balance is a verb. Go do it."])}`;

  const log = $("#log");
  $("#showLog").onclick = () => { log.hidden = !log.hidden; };
  const est = () => {
    const d = Object.fromEntries(new FormData(log)); const w = weight(); const km = +d.km || 0; const min = +d.min || 0;
    const k = { run: km * w, walk: km * 0.5 * w, rope: (min * 12 * w) / 60, cycle: (min * 7 * w) / 60, other: (min * 6 * w) / 60 }[d.kind];
    if (k) log.kcal.value = Math.round(k);
  };
  log.kind.onchange = est; log.km.oninput = est; log.min.oninput = est; est();
  log.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(log));
    if (!(+d.kcal > 0)) return toast("Add distance or minutes first");
    const { error } = await sb.from("activities").insert({ kind: d.kind, distance_km: +d.km || 0, minutes: +d.min || 0, kcal: Math.round(+d.kcal) });
    if (error) return fail(error);
    toast(profile.serious_mode ? "Saved" : "Burn logged. Flames everywhere.");
    location.hash = "#home"; route();
  };
  $$("[data-del-meal]").forEach((b) => (b.onclick = async () => { await sb.from("meals").delete().eq("id", b.dataset.delMeal); route(); }));
  $$("[data-del-act]").forEach((b) => (b.onclick = async () => { await sb.from("activities").delete().eq("id", b.dataset.delAct); route(); }));
}

// ---------- SNAP ----------
const MULT = { S: 0.7, M: 1, L: 1.3 };
async function snap() {
  if (!snapState) snapState = { step: "camera", photo: null, items: [] };
  const s = snapState;

  if (s.step === "camera") {
    app.innerHTML = `
      <div class="row"><h1>Snap your meal</h1><span class="muted">Step 1 of 3</span></div>
      <label class="drop" for="cam">
        <span class="display" style="font-size:22px">Tap to take a photo</span>
        <span class="muted" style="color:#E8D9C2">Shoot from above, in good light</span>
      </label>
      <input id="cam" type="file" accept="image/*" capture="environment" hidden>
      <div class="row" style="justify-content:center"><label for="cam" class="shutter" aria-label="Take photo" role="button" tabindex="0"></label></div>
      <button class="outline block" id="manual">Skip photo, add dishes by hand</button>`;
    $("#cam").onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      s.photo = await downscale(file);
      s.step = "detect"; s.items = []; route();
      analyze();
    };
    $("#manual").onclick = () => { s.step = "detect"; s.photo = null; s.items = []; route(); };
    return;
  }

  if (s.step === "detect") {
    const total = s.items.reduce((t, i) => t + Math.round(i.kcal * MULT[i.size]), 0);
    app.innerHTML = `
      <div class="row"><h1>${s.analyzing ? "Looking at your meal…" : s.items.length ? `We spotted ${s.items.length}` : "What did you eat?"}</h1><span class="muted">Step 2 of 3</span></div>
      ${s.photo ? `<img class="photo" src="data:image/jpeg;base64,${s.photo}" alt="Your meal">` : ""}
      ${s.items.length ? `<p class="muted">Adjust the portions. Photos can’t see oil and sugar.</p>` : ""}
      ${s.items.map((it, idx) => `
        <div class="card stack">
          <div class="row"><b>${esc(it.name)}</b><div class="row"><span class="display" style="font-size:20px">${n0(it.kcal * MULT[it.size])} kcal</span><button class="outline small" data-rm="${idx}" aria-label="Remove ${esc(it.name)}">✕</button></div></div>
          <div class="pills">${["S", "M", "L"].map((z) => `<button type="button" data-i="${idx}" data-z="${z}" aria-pressed="${it.size === z}">${{ S: "Small", M: "Medium", L: "Large" }[z]}</button>`).join("")}</div>
        </div>`).join("")}
      <form id="add" class="card stack">
        <label>Add a dish<input name="name" list="dishes" placeholder="e.g. Phở bò" autocomplete="off"></label>
        <datalist id="dishes">${DISHES.map(([d]) => `<option value="${esc(d)}">`).join("")}</datalist>
        <div class="row"><label style="flex:1">kcal (medium portion)<input name="kcal" type="number" inputmode="numeric" min="0"></label><button class="outline small" style="align-self:flex-end">Add</button></div>
      </form>
      <div class="row"><span>Meal total</span><b>${n0(total)} kcal</b></div>
      <p class="muted">AI estimate, ±20%</p>
      <button class="primary block" id="calc" ${s.items.length ? "" : "disabled"}>Calculate my burn</button>
      <button class="outline block" id="retake">Start over</button>`;
    $$("[data-z]").forEach((b) => (b.onclick = () => { s.items[b.dataset.i].size = b.dataset.z; route(); }));
    $$("[data-rm]").forEach((b) => (b.onclick = () => { s.items.splice(+b.dataset.rm, 1); route(); }));
    const add = $("#add");
    add.name.oninput = () => { const hit = DISHES.find(([d]) => d === add.name.value); if (hit) add.kcal.value = hit[1]; };
    add.onsubmit = (e) => {
      e.preventDefault();
      const name = add.name.value.trim(); const kcal = +add.kcal.value;
      if (!name || !(kcal >= 0)) return toast("Add a dish name and its kcal");
      s.items.push({ name, kcal, size: "M" }); route();
    };
    $("#retake").onclick = () => { snapState = null; route(); };
    $("#calc").onclick = async () => {
      const items = s.items.map((i) => ({ name: i.name, size: i.size, kcal: Math.round(i.kcal * MULT[i.size]) }));
      const kcal = items.reduce((t, i) => t + i.kcal, 0);
      const name = items.map((i) => i.name.replace(/\s*\(.*\)$/, "")).join(" + ").slice(0, 120);
      const { error } = await sb.from("meals").insert({ name, kcal, items });
      if (error) return fail(error);
      s.step = "result"; s.saved = { name, kcal }; route();
    };
    return;
  }

  // result
  const since = startOfToday();
  const [meals, acts] = await Promise.all([
    sb.from("meals").select("kcal").gte("eaten_at", since),
    sb.from("activities").select("kcal").gte("started_at", since),
  ]);
  const eaten = (meals.data || []).reduce((t, m) => t + m.kcal, 0);
  const burned = (acts.data || []).reduce((t, a) => t + a.kcal, 0);
  const before = eaten - s.saved.kcal;
  const surplus = Math.max(0, eaten - burned - profile.budget_kcal);
  const toBurn = surplus || s.saved.kcal;
  const b = burnFor(toBurn);
  app.innerHTML = `
    <div class="row"><h1>Your Burn-It card</h1><span class="muted">Step 3 of 3</span></div>
    <section class="hero">
      <span class="muted">${esc(s.saved.name)}</span>
      <div class="big">${n0(s.saved.kcal)} <small>kcal</small></div>
      <span class="muted">Eaten earlier today: ${n0(before)} of your ${n0(profile.budget_kcal)} kcal budget</span>
    </section>
    <div class="card row">
      <div><div class="muted">${surplus ? "Over today’s budget" : "Still within budget"}</div><b style="font-size:18px">${surplus ? `${n0(surplus)} kcal` : "Nice"}</b></div>
      <div style="text-align:right"><div class="muted">Fat if unburned</div><b style="font-size:18px" class="${surplus ? "danger" : "ok"}">≈ ${n0(surplus / 7.7)} g</b></div>
    </div>
    <h2>${surplus ? "Burn the extra with any one:" : "To burn this meal itself:"}</h2>
    <div class="grid g3">
      <div class="tile" style="background:var(--tint-burn)"><b>${n1(b.runKm)}</b>km running</div>
      <div class="tile" style="background:var(--tint-snack)"><b>${n1(b.walkKm)}</b>km walking</div>
      <div class="tile" style="background:var(--tint-ok)"><b>${n0(b.ropeMin)}</b>min jump rope</div>
    </div>
    ${quip(["Worth it? Probably. Now lace up.", "That meal just challenged you to a race.", "Delicious. Now let’s pay the bill in sweat."])}
    <a class="btn primary block" href="#home?log=1&km=${n1(b.runKm)}">Log the run</a>
    <button class="outline block" id="again">Snap another meal</button>`;
  $("#again").onclick = () => { snapState = null; route(); };
  snapState = { step: "camera", items: [] };
  // keep the card on screen; next visit to Snap starts fresh
}

async function analyze() {
  const s = snapState; s.analyzing = true; route();
  try {
    const { data, error } = await sb.functions.invoke("analyze-meal", { body: { image: s.photo, media_type: "image/jpeg" } });
    if (error) throw error;
    if (data.error) throw new Error(data.error);
    s.items = (data.items || []).map((i) => ({ name: i.name, kcal: i.kcal, size: "M" }));
    if (!s.items.length) toast("No food spotted. Add dishes by hand.");
  } catch (e) {
    console.error(e); toast("AI couldn’t read the photo. Add dishes by hand.");
  } finally { s.analyzing = false; if (snapState === s && s.step === "detect") route(); }
}

function downscale(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const max = 1280; const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.8).split(",")[1]); URL.revokeObjectURL(img.src);
    };
    img.onerror = reject; img.src = URL.createObjectURL(file);
  });
}

// ---------- CHALLENGES ----------
let challengeMetric = "km";
async function challenges(q) {
  const [{ data: list, error }, badges, friendsList] = await Promise.all([
    sb.from("challenges").select("*").gte("ends_at", new Date(Date.now() - 7 * 864e5).toISOString()).order("ends_at"),
    rpc("my_badges"),
    rpc("friends_week"),
  ]);
  if (error) throw error;
  const shown = list.filter((c) => c.metric === challengeMetric);
  const boards = await Promise.all(shown.map((c) => rpc("challenge_leaderboard", { cid: c.id })));
  const bd = badges[0] || { total_km: 0, challenge_wins: 0, streak: 0 };
  const preselect = q.get("with");
  const daysLeft = (c) => Math.max(0, Math.ceil((new Date(c.ends_at) - Date.now()) / 864e5));

  app.innerHTML = `
    <div class="row"><h1>Challenges</h1><button class="primary small" id="new">+ New</button></div>
    <div class="seg" role="group" aria-label="Challenge type">
      <button aria-pressed="${challengeMetric === "km"}" data-m="km">Most km run</button>
      <button aria-pressed="${challengeMetric === "kcal"}" data-m="kcal">Most kcal burned</button>
    </div>

    <form id="create" class="card stack" ${preselect ? "" : "hidden"}>
      <label>Challenge name<input name="name" required maxlength="60" placeholder="Saigon Sunday Runners"></label>
      <div class="grid g2">
        <label>Type<select name="metric"><option value="km" ${challengeMetric === "km" ? "selected" : ""}>Most km run</option><option value="kcal" ${challengeMetric === "kcal" ? "selected" : ""}>Most kcal burned</option></select></label>
        <label>Length<select name="len"><option value="week">Weekly (7 days)</option><option value="custom">Custom</option></select></label>
      </div>
      <div class="grid g2" id="custom" hidden>
        <label>Starts<input name="start" type="date"></label>
        <label>Ends<input name="end" type="date"></label>
      </div>
      <fieldset style="border:0;padding:0;margin:0" class="stack">
        <legend class="muted" style="margin-bottom:6px">Invite friends</legend>
        ${friendsList.length ? friendsList.map((f) => `<label style="flex-direction:row;align-items:center;color:var(--ink);font-size:15px"><input type="checkbox" name="m" value="${f.id}" style="width:22px;min-height:22px" ${f.id === preselect ? "checked" : ""}> ${esc(f.display_name)}</label>`).join("")
          : `<p class="muted">Add friends first on the Friends tab.</p>`}
      </fieldset>
      <button class="primary block">Start challenge</button>
    </form>

    ${shown.length ? shown.map((c, i) => {
      const rows = boards[i]; const meIdx = rows.findIndex((r) => r.user_id === user.id);
      const unit = c.metric === "km" ? "km" : "kcal";
      const fmt = (v) => (c.metric === "km" ? n1(v) : n0(v));
      const lead = rows[0]; const ended = new Date(c.ends_at) < new Date();
      const gap = meIdx > 0 ? `${fmt(lead.score - rows[meIdx].score)} ${unit} to take the lead.` : meIdx === 0 ? "You’re leading. Keep it up!" : "";
      return `
      <section class="hero" style="gap:4px">
        <span class="muted">${(new Date(c.ends_at) - new Date(c.starts_at)) / 864e5 === 7 ? "Weekly" : "Custom"} · ${ended ? "finished" : `ends in ${daysLeft(c)} day${daysLeft(c) === 1 ? "" : "s"}`}</span>
        <span class="display" style="font-size:24px;font-weight:500">${esc(c.name)}</span>
        <span class="muted">${meIdx >= 0 ? `You’re #${meIdx + 1}. ` : ""}${gap}</span>
      </section>
      <div class="list">${rows.map((r, j) => `
        <div class="row" style="${r.user_id === user.id ? "font-weight:700" : ""}">
          <div class="row" style="justify-content:flex-start"><span class="display" style="width:24px;color:var(--muted)">${j + 1}</span><span class="avatar" style="background:${COLORS[j % 5]}">${initial(r.display_name)}</span>${r.user_id === user.id ? "You" : esc(r.display_name)}</div>
          <b>${fmt(r.score)} ${unit}</b></div>`).join("")}</div>`;
    }).join("") : `<div class="card"><p>No ${challengeMetric === "km" ? "km" : "kcal"} challenges yet.</p><p class="muted">Tap + New and pick some friends.</p></div>`}

    <h2>Your badges</h2>
    <div class="grid g4">
      <div class="tile" style="background:var(--tint-snack)"><b>${bd.streak}</b>Day streak</div>
      <div class="tile" style="background:var(--tint-burn)"><b>${bd.challenge_wins}×</b>Wins</div>
      <div class="tile" style="background:${bd.total_km >= 100 ? "var(--tint-ok)" : "#EDE9E3"}"><b>${n0(bd.total_km)}</b>${bd.total_km >= 100 ? "km club" : "/100 km"}</div>
      <div class="tile" style="background:${bd.streak >= 30 ? "var(--tint-ok)" : "#EDE9E3"}"><b>${bd.streak >= 30 ? "30" : "?"}</b>${bd.streak >= 30 ? "Iron month" : "Locked"}</div>
    </div>`;

  $$("[data-m]").forEach((b) => (b.onclick = () => { challengeMetric = b.dataset.m; route(); }));
  const f = $("#create");
  $("#new").onclick = () => { f.hidden = !f.hidden; };
  f.len.onchange = () => { $("#custom").hidden = f.len.value !== "custom"; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    let starts = new Date(); let ends = new Date(Date.now() + 7 * 864e5);
    if (f.len.value === "custom") {
      if (!f.start.value || !f.end.value) return toast("Pick start and end dates");
      starts = new Date(f.start.value + "T00:00"); ends = new Date(f.end.value + "T23:59");
      if (ends <= starts) return toast("End date must be after start");
    }
    const members = $$('input[name="m"]:checked').map((i) => i.value);
    try {
      await rpc("create_challenge", { p_name: f.name.value.trim(), p_metric: f.metric.value, p_starts: starts.toISOString(), p_ends: ends.toISOString(), p_members: members });
      challengeMetric = f.metric.value; toast("Challenge on! May the fastest snacker win.");
      location.hash = "#challenges"; route();
    } catch (err) { fail(err); }
  };
}

// ---------- FRIENDS ----------
let friendsTab = "friends";
async function friends() {
  const inviteUrl = `${location.origin}${location.pathname}?invite=${profile.invite_code}`;
  let body = "";
  if (friendsTab === "friends") {
    const list = await rpc("friends_week");
    body = list.length ? `<div class="list">${list.map((f, i) => `
      <div class="row"><div class="row" style="justify-content:flex-start"><span class="avatar" style="background:${COLORS[i % 5]}">${initial(f.display_name)}</span>
      <div><div>${esc(f.display_name)}</div><div class="muted">${n1(f.km)} km · ${n0(f.kcal)} kcal this week</div></div></div>
      <a class="btn outline small" href="#challenges?with=${f.id}">Challenge</a></div>`).join("")}</div>`
      : `<div class="card"><p>No friends yet.</p><p class="muted">Invite someone, or add them with their code.</p></div>`;
  } else {
    body = `
      <div class="card stack">
        <div class="row"><b>Who can see me nearby</b><span class="muted">Approximate area only</span></div>
        <div class="seg" role="group" aria-label="Nearby visibility">
          ${[["everyone", "Everyone"], ["friends", "Friends only"], ["off", "Off"]].map(([v, t]) => `<button aria-pressed="${profile.visibility === v}" data-vis="${v}">${t}</button>`).join("")}
        </div>
      </div>
      <button class="outline block" id="locate">Find people within 2 km</button>
      <div id="nearby"></div>`;
  }
  app.innerHTML = `
    <div class="row"><h1>Friends</h1><button class="primary small" id="invite">Invite</button></div>
    <div class="seg" role="group" aria-label="Friends view">
      <button aria-pressed="${friendsTab === "friends"}" data-t="friends">My friends</button>
      <button aria-pressed="${friendsTab === "nearby"}" data-t="nearby">Nearby · 2 km</button>
    </div>
    ${body}
    <form id="code" class="card stack">
      <label>Add a friend by code<input name="code" placeholder="e.g. a1b2c3d4" autocomplete="off" autocapitalize="off"></label>
      <button class="outline small">Add friend</button>
      <p class="muted">Your code: <b>${esc(profile.invite_code)}</b></p>
    </form>`;

  $$("[data-t]").forEach((b) => (b.onclick = () => { friendsTab = b.dataset.t; route(); }));
  $("#invite").onclick = async () => {
    const text = `Join me on Snack & Burn. Snap your meals, burn them off, and race me!`;
    if (navigator.share) { try { await navigator.share({ title: "Snack & Burn", text, url: inviteUrl }); } catch { /* cancelled */ } }
    else { await navigator.clipboard.writeText(`${text} ${inviteUrl}`); toast("Invite link copied. Paste it in Zalo!"); }
  };
  $("#code").onsubmit = async (e) => {
    e.preventDefault();
    try { await rpc("add_friend_by_code", { code: e.target.code.value }); toast("Friend added!"); route(); } catch (err) { fail(err); }
  };
  $$("[data-vis]").forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from("profiles").update({ visibility: b.dataset.vis }).eq("id", user.id);
    if (error) return fail(error);
    profile.visibility = b.dataset.vis; route();
  }));
  const loc = $("#locate");
  if (loc) loc.onclick = () => {
    if (!navigator.geolocation) return toast("Location isn’t available on this device");
    loc.textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        await rpc("update_location", { p_lat: pos.coords.latitude, p_lng: pos.coords.longitude });
        const people = await rpc("nearby_users", { radius_km: 2 });
        loc.textContent = "Refresh nearby";
        $("#nearby").innerHTML = people.length ? `<div class="list">${people.map((p, i) => `
          <div class="row"><div class="row" style="justify-content:flex-start"><span class="avatar" style="background:${COLORS[i % 5]}">${initial(p.display_name)}</span>
          <div><div>${esc(p.display_name)}</div><div class="muted">${n1(p.distance_km)} km away${p.is_friend ? " · friend" : ""}</div></div></div>
          ${p.is_friend ? `<a class="btn outline small" href="#challenges?with=${p.id}">Challenge</a>` : `<button class="outline small" data-add="${p.id}">Add</button>`}</div>`).join("")}</div>`
          : `<p class="muted center">Nobody visible within 2 km yet. Invite your running crew!</p>`;
        $$("[data-add]").forEach((b) => (b.onclick = async () => { try { await rpc("add_friend", { fid: b.dataset.add }); toast("Friend added!"); loc.click(); } catch (err) { fail(err); } }));
      } catch (err) { fail(err); loc.textContent = "Find people within 2 km"; }
    }, () => { toast("Allow location in Settings to find nearby runners"); loc.textContent = "Find people within 2 km"; }, { enableHighAccuracy: false, timeout: 10000 });
  };
}

// ---------- PROFILE ----------
async function profileView() {
  app.innerHTML = `
    <div class="row" style="justify-content:flex-start"><span class="avatar" style="width:56px;height:56px;font-size:24px">${initial(profile.display_name)}</span>
      <div><h1>${esc(profile.display_name)}</h1><p class="muted">${esc(user.email)}</p></div></div>
    <h2>Body &amp; daily budget</h2>
    ${statsForm(profile, "Save")}
    <h2>Privacy &amp; preferences</h2>
    <div class="list">
      <div class="row"><div><div>Serious mode</div><div class="muted">${profile.serious_mode ? "On · no jokes, just numbers" : "Off · cheeky comments on"}</div></div>
        <button class="switch" id="serious" aria-label="Serious mode" aria-pressed="${profile.serious_mode}"></button></div>
      <div class="row"><div><div>Show me nearby</div><div class="muted">${{ everyone: "Everyone within 2 km", friends: "Friends only", off: "Hidden" }[profile.visibility]}</div></div>
        <a class="btn outline small" href="#friends" id="toNearby">Change</a></div>
    </div>
    <h2>Connected devices</h2>
    <div class="card stack">
      <p><b>Apple Health, Apple Watch &amp; Garmin</b></p>
      <p class="muted">Web apps can’t read Apple Health directly. Automatic sync arrives with the native iOS app. For now, log runs from Home in a few taps.</p>
    </div>
    <button class="outline block" id="out">Sign out</button>`;
  wireStats(() => { toast("Saved. New budget: " + n0(profile.budget_kcal) + " kcal"); route(); });
  $("#serious").onclick = async () => {
    const v = !profile.serious_mode;
    const { error } = await sb.from("profiles").update({ serious_mode: v }).eq("id", user.id);
    if (error) return fail(error);
    profile.serious_mode = v; route();
  };
  $("#toNearby").onclick = () => { friendsTab = "nearby"; };
  $("#out").onclick = async () => { await sb.auth.signOut(); location.hash = ""; };
}

// ---------- PWA ----------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
route();
