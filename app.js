import { createClient } from "./vendor/supabase-2.118.0.js";

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
// Resting burn: what the body burns doing nothing (Mifflin-St Jeor)
function bmr(p) { return Math.round(10 * p.weight_kg + 6.25 * p.height_cm - 5 * p.age + (p.sex === "female" ? -161 : 5)); }
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

let dishCache = null;
async function loadDishes(force) {
  if (dishCache && !force) return dishCache;
  const { data, error } = await sb.from("dishes").select("name,kcal,image_url").eq("active", true).order("name");
  dishCache = !error && data.length ? data.map((d) => [d.name, d.kcal, d.image_url]) : DISHES;
  return dishCache;
}

// ---------- routing ----------
const VIEWS = { home, snap, challenges, friends, profileView, admin, coach, badges: badgesView, watch: watchGuide };
let snapState = null;

function saveProfile() { try { localStorage.setItem("snb_profile", JSON.stringify(profile)); } catch { /* ignore */ } }
async function route() {
  const { data } = await sb.auth.getSession();
  user = data.session?.user ?? null;
  if (!user) { tabs.hidden = true; return login(); }
  if (!profile || profile.id !== user.id) {
    const PCOLS = "id,display_name,sex,age,height_cm,weight_kg,activity,budget_kcal,visibility,serious_mode,invite_code,onboarded,is_admin,blocked,notify_meals,notify_burn,notify_challenge,birthday";
    const fresh = sb.from("profiles").select(PCOLS).eq("id", user.id).single();
    let cached = null; try { cached = JSON.parse(localStorage.getItem("snb_profile") || "null"); } catch { /* ignore */ }
    if (cached && cached.id === user.id) {
      // open instantly with the saved profile, refresh it in the background
      profile = cached;
      fresh.then(({ data: p }) => {
        if (!p) return;
        const changed = Object.keys(p).some((k) => String(p[k]) !== String(profile[k]));
        profile = p; saveProfile();
        if (changed) { const y = window.scrollY; route().then(() => window.scrollTo(0, y)); }
      });
    } else {
      const { data: p, error } = await fresh;
      if (error) return fail(error);
      profile = p; saveProfile();
    }
    redeemInvite();
    refreshSeason();
  }
  if (profile.blocked) {
    tabs.hidden = true;
    app.innerHTML = `<h1>Account paused</h1><div class="card stack"><p>Your account has been paused by the Snack &amp; Burn team.</p><p class="muted">If you think this is a mistake, contact the app admin.</p></div><button class="outline block" id="out">Sign out</button>`;
    $("#out").onclick = async () => { await sb.auth.signOut(); };
    return;
  }
  if (!profile.onboarded) { tabs.hidden = true; return onboarding(); }
  tabs.hidden = false;
  const [name, query] = (location.hash.slice(1) || "home").split("?");
  const key = name === "profile" ? "profileView" : name;
  const view = VIEWS[key] || home;
  tabs.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.tab === name));
  let snap = null; if (key === "home") { try { snap = localStorage.getItem("snb_home"); } catch { /* */ } }
  if (snap) app.innerHTML = `<div class="snapshot" aria-busy="true">${snap}</div>`; else app.innerHTML = `<div class="skel" style="height:36px;width:60%"></div><div class="skel" style="height:170px"></div><div class="skel" style="height:64px"></div><div class="skel" style="height:64px"></div>`;
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
let loginMode = "signin";
function login() {
  const signup = loginMode === "signup";
  app.innerHTML = `
    <div style="height:6vh"></div>
    <img class="app-logo" src="icon-192.png" alt="">
    <h1 style="font-size:40px">Snack <span style="color:var(--burn)">&amp;</span> Burn</h1>
    <p class="muted" style="font-size:16px">Eat it. Snap it. Burn it.</p>
    <div class="seg" role="group" aria-label="Sign in or create account">
      <button type="button" aria-pressed="${!signup}" data-mode="signin">Sign in</button>
      <button type="button" aria-pressed="${signup}" data-mode="signup">Create account</button>
    </div>
    <form id="f" class="card stack">
      <label>Email<input type="email" name="email" required autocomplete="email" autocapitalize="off" placeholder="you@example.com"></label>
      <label>Password<input type="password" name="password" required minlength="6" autocomplete="${signup ? "new-password" : "current-password"}" placeholder="At least 6 characters"></label>
      <button class="primary block">${signup ? "Create account" : "Sign in"}</button>
      ${signup ? "" : `<button type="button" class="outline block" id="forgot">Forgot password?</button>`}
    </form>
    <button type="button" class="outline block" id="magic">Email me a sign-in link instead</button>`;
  $$("[data-mode]").forEach((b) => (b.onclick = () => { loginMode = b.dataset.mode; login(); }));
  const f = $("#f");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const email = f.email.value.trim(), password = f.password.value;
    const btn = f.querySelector(".primary"); btn.disabled = true;
    const { data, error } = signup
      ? await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
      : await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if (error) {
      if (/invalid login/i.test(error.message)) return toast("Wrong email or password. New here? Tap Create account.");
      if (/already registered/i.test(error.message)) return toast("This email already has an account. Sign in instead.");
      return fail(error);
    }
    if (signup && !data.session) {
      app.innerHTML = `<h1>Confirm your email</h1><div class="card"><p>We sent a confirmation link to <b>${esc(email)}</b>. Open it, then sign in.</p></div>`;
    }
  };
  const forgot = $("#forgot");
  if (forgot) forgot.onclick = async () => {
    const email = f.email.value.trim();
    if (!email) return toast("Type your email first");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname + "#profile?setpw=1" });
    if (error) return fail(/rate limit/i.test(error.message) ? new Error("Too many emails right now. Try again in an hour.") : error);
    toast("Check your email for a reset link");
  };
  $("#magic").onclick = async () => {
    const email = f.email.value.trim();
    if (!email) return toast("Type your email first");
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) return fail(/rate limit/i.test(error.message) ? new Error("Too many emails right now. Try again in an hour, or use a password.") : error);
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
function wireStats(onDone, root = app) {
  const f = root.querySelector("#stats");
  const read = () => {
    const d = Object.fromEntries(new FormData(f));
    return { display_name: d.display_name.trim(), sex: d.sex, age: +d.age, height_cm: +d.height_cm, weight_kg: +d.weight_kg, activity: +d.activity };
  };
  f.oninput = () => { const v = read(); if (v.age && v.height_cm && v.weight_kg) root.querySelector("#budget").textContent = n0(tdee(v)); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = read();
    const patch = { ...v, budget_kcal: tdee(v), onboarded: true };
    const { error } = await sb.from("profiles").update(patch).eq("id", user.id);
    if (error) return fail(error);
    Object.assign(profile, patch); saveProfile();
    const day = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    await sb.from("weights").upsert({ day, kg: v.weight_kg }, { onConflict: "user_id,day" });
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
  const wk0 = new Date(); wk0.setHours(0, 0, 0, 0); wk0.setDate(wk0.getDate() - 6);
  const d60 = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  // everything Home needs, fetched in parallel (one round trip instead of several)
  const [, wRes, meals, acts, streak, wkMeals, wkActs, chs, wat] = await Promise.all([
    loadDishes(),
    sb.from("weights").select("day,kg").gte("day", d60).order("day"),
    sb.from("meals").select("*").gte("eaten_at", since).order("eaten_at"),
    sb.from("activities").select("*").gte("started_at", since).order("started_at"),
    rpc("my_streak"),
    sb.from("meals").select("kcal,eaten_at").gte("eaten_at", wk0.toISOString()),
    sb.from("activities").select("kcal,distance_km,kind,started_at").gte("started_at", wk0.toISOString()),
    sb.from("challenges").select("id,name,metric,ends_at,official").gt("ends_at", new Date().toISOString()).order("ends_at").limit(5),
    sb.from("water_logs").select("glasses").eq("day", vnToday()).maybeSingle(),
  ]);
  const water = wat.data?.glasses ?? 0;
  const wts = wRes.data || [];
  // this week, per day
  const days = [...Array(7)].map((_, i) => { const d = new Date(wk0); d.setDate(d.getDate() + i); return { d, eat: 0, burn: 0 }; });
  const dayIdx = (iso) => Math.floor((new Date(iso) - wk0) / 864e5);
  (wkMeals.data || []).forEach((m) => { const i = dayIdx(m.eaten_at); if (days[i]) days[i].eat += m.kcal; });
  (wkActs.data || []).forEach((a) => { const i = dayIdx(a.started_at); if (days[i]) days[i].burn += a.kcal; });
  const wkKm = (wkActs.data || []).filter((a) => a.kind === "run").reduce((t, a) => t + Number(a.distance_km), 0);
  const onTarget = days.filter((x) => x.eat > 0 && x.eat - x.burn <= profile.budget_kcal).length;
  // my live challenge: the first one I am in
  let myCh = null;
  const boards = await Promise.all((chs.data || []).map((c) => rpc("challenge_leaderboard", { cid: c.id }).catch(() => [])));
  (chs.data || []).some((c, k) => {
    const rows = boards[k]; const i = rows.findIndex((x) => x.user_id === user.id);
    if (i >= 0) { myCh = { c, rank: i + 1, of: rows.length, score: rows[i].score, lead: rows[0] }; return true; }
    return false;
  });
  if (meals.error) throw meals.error;
  if (acts.error) throw acts.error;
  const eaten = meals.data.reduce((s, m) => s + m.kcal, 0);
  const burned = acts.data.reduce((s, a) => s + a.kcal, 0);
  // If real steps are logged today, use the "mostly sitting" base so walking isn't counted twice
  const hasSteps = acts.data.some((a) => a.steps > 0);
  const restDay = bmr(profile);
  const budget = hasSteps ? Math.round((restDay * 1.2) / 10) * 10 : profile.budget_kcal;
  const nowH = new Date().getHours() + new Date().getMinutes() / 60;
  const restSoFar = Math.round(restDay * (nowH / 24));
  const left = budget + burned - eaten;
  const total = Math.max(budget + burned, eaten, 1);
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  app.innerHTML = `
  ${seasonBanner()}
  <div class="row">
    <div><p class="muted">${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}</p><h1>Hi, ${esc(profile.display_name)}</h1></div>
    <span class="badge">${streak}-day streak</span>
  </div>
  <section class="hero" aria-label="Today's balance">
    <div class="ring-wrap">
      <div class="ring-center">
        <svg class="ring" viewBox="0 0 132 132" role="img" aria-label="Snacked ${n0(eaten)} of ${n0(budget + burned)} kcal, burned ${n0(burned)} of ${BURN_GOAL} kcal goal">
          <circle cx="66" cy="66" r="58" stroke="var(--hero-track)"/>
          <circle cx="66" cy="66" r="58" stroke="var(--snack)" stroke-dasharray="${2 * Math.PI * 58}" stroke-dashoffset="${2 * Math.PI * 58 * (1 - Math.min(1, eaten / Math.max(1, budget + burned)))}"/>
          <circle cx="66" cy="66" r="42" stroke="var(--hero-track)"/>
          <circle cx="66" cy="66" r="42" stroke="var(--burn-2)" stroke-dasharray="${2 * Math.PI * 42}" stroke-dashoffset="${2 * Math.PI * 42 * (1 - Math.min(1, burned / BURN_GOAL))}"/>
        </svg>
        <div class="label"><b>${n0(Math.abs(left))}</b><span class="muted">${left >= 0 ? "kcal left" : "kcal over"}</span></div>
      </div>
      <div class="legend">
        <div><span class="dot" style="background:var(--snack)"></span><div><div class="muted">Snacked</div><b>${n0(eaten)}</b></div></div>
        <div><span class="dot" style="background:var(--burn-2)"></span><div><div class="muted">Burned</div><b>${n0(burned)}</b> <span class="muted">/ ${BURN_GOAL}</span></div></div>
        <div><span class="dot" style="background:var(--border)"></span><div><div class="muted">Budget</div><b>${n0(budget)}</b></div></div>
      </div>
    </div>
    <button class="body-burn" id="bodyBurn" aria-label="How your body burns calories">
      <span class="bb-bar" aria-hidden="true"><span style="width:${(nowH / 24) * 100}%"></span></span>
      <span class="bb-row"><span>Body burned so far <b>~${n0(restSoFar)}</b> of ${n0(restDay)} kcal at rest</span><span class="bb-i" aria-hidden="true">i</span></span>
    </button>
  </section>
  ${left < 0 ? `<div class="card"><p><b class="danger">≈ ${n0(-left / 7.7)} g fat</b> if you don’t burn the extra ${n0(-left)} kcal.</p><p class="muted">Run ${n1(burnFor(-left).runKm)} km or walk ${n1(burnFor(-left).walkKm)} km to balance today.</p></div>` : ""}

  <div class="grid g2">
    <a class="quick" href="#snap"><span class="q-ic" style="background:var(--tint-snack)"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4h-5L7.5 6.5H4a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1h-3.5z"/><circle cx="12" cy="13" r="3.5"/></svg></span><span><b>Snap a meal</b><span class="muted">Photo → kcal</span></span></a>
    <button class="quick" id="quickBurn"><span class="q-ic" style="background:var(--tint-burn)"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.5 2 3 0-3 0-5 1-8.5z"/></svg></span><span><b>Log a burn</b><span class="muted">Run, walk…</span></span></button>
  </div>

  ${waterCard(water)}
  ${new Date(Date.now() + 252e5).getUTCDate() <= 5 ? `<button class="month-promo" id="monthPromo">${sv('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>')}<span><b>Your month in review is ready</b><span class="muted">A card to share with friends</span></span>${sv('<path d="M9 6l6 6-6 6"/>')}</button>` : ""}
  <a class="coach-card" href="#coach">
    <span class="coach-av" aria-hidden="true">${COACH_FACE}</span>
    <span style="min-width:0;flex:1"><b>Coach</b><span class="muted coach-tip" id="coachTip">${esc(cachedTip() || "Your weekly check-in is ready. Tap to read.")}</span></span>
    ${sv('<path d="M9 6l6 6-6 6"/>')}
  </a>

  <div class="row"><h2>Snacks today</h2><a class="btn outline small" href="#snap">+ Add</a></div>
  ${meals.data.length ? `<div class="list">${meals.data.map((m) => { const pic = (dishCache || []).find((d) => d[2] && m.name.toLowerCase().startsWith(d[0].toLowerCase().replace(/\s*\(.*$/, "")))?.[2]; return `
    <div class="row"><div class="row" style="justify-content:flex-start;gap:12px">${pic ? `<img class="meal-thumb" src="${esc(pic)}" alt="">` : `<span class="meal-thumb ph">${sv(FORK)}</span>`}<div><div>${esc(m.name)}</div><div class="muted">${time(m.eaten_at)}</div></div></div>
    <div class="row"><b>${n0(m.kcal)}</b><button class="icon-btn" data-del-meal="${m.id}" aria-label="Remove ${esc(m.name)}"><svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div></div>`; }).join("")}</div>`
    : `<a class="empty" href="#snap"><span>No meals yet today</span><b>Snap one →</b></a>`}

  <div class="row"><h2>Burns today</h2><div class="row" style="gap:8px">${isIOS() ? `<button class="outline small" id="syncSteps" aria-label="Sync steps from Apple Health">${ACT.steps.icon}<span>Sync</span></button>` : ""}<button class="primary small" id="showLog">+ Log a burn</button></div></div>
  ${acts.data.length ? `<div class="list" style="background:var(--tint-burn)">${acts.data.map((a) => `
    <div class="row"><div class="row" style="justify-content:flex-start;gap:12px"><span class="act-ic">${ACT[a.steps > 0 ? "steps" : a.kind].icon}</span><div><div>${a.steps > 0 ? `${n0(a.steps)} steps` : esc(ACT[a.kind].label)}${a.distance_km ? ` · ${n1(a.distance_km)} km` : ""}${a.minutes ? ` · ${a.minutes} min` : ""}</div><div class="muted">${time(a.started_at)} · ${esc(a.source)}</div></div></div>
    <div class="row"><b class="danger">−${n0(a.kcal)}</b><button class="icon-btn" data-del-act="${a.id}" aria-label="Remove activity"><svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div></div>`).join("")}</div>`
    : `<button class="empty" id="emptyBurn"><span>No burns yet today</span><b>Log one →</b></button>`}

  ${weightCard(wts)}

  <section class="card stack" aria-label="This week">
    <div class="row"><b>This week</b><span class="muted">${onTarget}/7 days on budget · ${n1(wkKm)} km run</span></div>
    <div class="week" role="img" aria-label="Calories eaten and burned over the last 7 days">
      ${days.map((x) => { const max = Math.max(profile.budget_kcal * 1.3, ...days.map((y) => y.eat)); const net = x.eat - x.burn; const over = net > profile.budget_kcal;
        return `<div class="wcol"><div class="wbar"><span class="weat" style="height:${(x.eat / max) * 100}%;background:${over ? "var(--burn)" : "var(--snack)"}"></span><span class="wburn" style="height:${(x.burn / max) * 100}%"></span><i style="bottom:${(profile.budget_kcal / max) * 100}%"></i></div><span class="muted">${x.d.toLocaleDateString("en-GB", { weekday: "narrow" })}</span></div>`; }).join("")}
    </div>
    <div class="row muted" style="justify-content:flex-start;gap:14px;font-size:12px"><span><span class="dot" style="background:var(--snack);display:inline-block"></span> Eaten</span><span><span class="dot" style="background:var(--burn-2);display:inline-block"></span> Burned</span><span>— Budget</span></div>
  </section>

  ${myCh ? `<a class="card row" href="#challenges" style="text-decoration:none;color:inherit">
      <div><div class="muted">${myCh.c.official ? "Official event" : "Your challenge"} · ends in ${Math.max(0, Math.ceil((new Date(myCh.c.ends_at) - Date.now()) / 864e5))} days</div><b>${esc(myCh.c.name)}</b>
      <div class="muted">${myCh.rank === 1 ? "You’re leading!" : `${myCh.c.metric === "km" ? n1(myCh.lead.score - myCh.score) + " km" : n0(myCh.lead.score - myCh.score) + " kcal"} behind ${esc(myCh.lead.display_name)}`}</div></div>
      <span class="rank">#${myCh.rank}<small>/${myCh.of}</small></span></a>`
    : `<a class="card row" href="#challenges" style="text-decoration:none;color:inherit"><div><b>Race a friend</b><div class="muted">Start a weekly km or kcal challenge</div></div><span class="rank" style="font-size:22px">→</span></a>`}
  ${quip(["Every snack has a price. It’s paid in kilometres.", "Your shoes miss you.", "Balance is a verb. Go do it."])}`;

  $("#showLog").onclick = () => openBurnSheet();
  $("#quickBurn").onclick = () => openBurnSheet();
  wireWater(water);
  const mp = $("#monthPromo"); if (mp) mp.onclick = openMonthReport;
  $("#bodyBurn").onclick = () => openSheet("How your body burns calories", `
    <div class="burn-split">
      <div><b>${n0(restDay)}</b><span>Resting (BMR)</span><p class="muted">Breathing, heartbeat, staying warm. Burned even if you stay in bed all day.</p></div>
      <div><b>${n0(budget - restDay)}</b><span>Daily life</span><p class="muted">${hasSteps ? "Light everyday moving. Your synced steps are added on top, so they’re not counted twice." : "Everyday moving, from the activity level in your Profile."}</p></div>
      <div><b>${n0(burned)}</b><span>Workouts & steps</span><p class="muted">What you logged today. Added to your budget.</p></div>
    </div>
    <p class="muted">Today you can eat about <b>${n0(budget + burned)}</b> kcal and stay level. Right now your body has used ~${n0(restSoFar)} kcal at rest.</p>`);
  $("#logWeight").onclick = () => openWeightSheet(wts);
  const ss = $("#syncSteps");
  if (ss) ss.onclick = () => runStepShortcut();
  const eb = $("#emptyBurn"); if (eb) eb.onclick = () => openBurnSheet();
  loadCoachTip();
  checkBadges();
  try { localStorage.setItem("snb_home", app.innerHTML); } catch { /* ignore */ }
  if (q.get("log")) { history.replaceState(null, "", "#home"); openBurnSheet({ kind: "run", km: +q.get("km") || 0 }); }
  $$("[data-del-meal]").forEach((b) => (b.onclick = async () => { await sb.from("meals").delete().eq("id", b.dataset.delMeal); route(); }));
  $$("[data-del-act]").forEach((b) => (b.onclick = async () => { await sb.from("activities").delete().eq("id", b.dataset.delAct); route(); }));
}

// ---------- PUSH NOTIFICATIONS ----------
const VAPID_PUBLIC = "BJCK__cmtVQqDzfZX3wNBc7LMLXq3NERwk6iuH3F2br1PPiek99Xbvl_l28vV99bRvhZ6G42xc_vvC99L4ROQ5U";
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function pushState() {
  if (!pushSupported()) return isIOS() && !isStandalone() ? "Add to Home Screen first" : "Not supported";
  return { granted: `<span class="ok">On</span>`, denied: "Blocked", default: "Off" }[Notification.permission];
}
function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications were not allowed");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC) });
  const j = sub.toJSON();
  const { error } = await sb.from("push_subs").upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
  if (error) throw error;
}
function openNotifSheet() {
  if (!pushSupported()) {
    if (isIOS() && !isStandalone()) { toast("Add Snack & Burn to your Home Screen first, then open it from there"); return showInstallGuide(true); }
    return toast("This browser can’t show notifications");
  }
  const on = Notification.permission === "granted";
  const t = (k, label, desc) => `<div class="set-row"><span class="set-t">${label}<span class="muted" style="display:block;font-size:12px">${desc}</span></span>
    <button class="switch" data-pref="${k}" aria-label="${label}" aria-pressed="${!!profile[k]}"></button></div>`;
  const s = openSheet("Notifications", `
    ${on ? "" : `<p class="muted">Get a nudge when you forget to log, and when a friend is beating you.</p>
      <button class="primary block" id="pushOn">${Notification.permission === "denied" ? "Blocked in Settings" : "Turn on notifications"}</button>
      ${Notification.permission === "denied" ? `<p class="muted">Turn them back on in iPhone Settings → Notifications → Snack &amp; Burn.</p>` : ""}`}
    <div class="set-group">
      ${t("notify_meals", "Lunch reminder", "12:00 if you haven’t logged a meal")}
      ${t("notify_challenge", "Challenge updates", "18:00 how far you are from the lead")}
      ${t("notify_burn", "Evening burn nudge", "19:00 if you haven’t moved today")}
    </div>
    ${on ? `<button class="outline block" id="pushTest">Send a test notification</button>` : ""}`);
  const btn = s.el.querySelector("#pushOn");
  if (btn) btn.onclick = async () => {
    if (Notification.permission === "denied") return;
    btn.disabled = true; btn.textContent = "Turning on…";
    try { await enablePush(); s.close(); toast("Notifications on"); route(); openNotifSheet(); }
    catch (e) { btn.disabled = false; btn.textContent = "Turn on notifications"; fail(e); }
  };
  s.el.querySelectorAll("[data-pref]").forEach((b) => (b.onclick = async () => {
    const k = b.dataset.pref; const v = !profile[k];
    const { error } = await sb.from("profiles").update({ [k]: v }).eq("id", user.id);
    if (error) return fail(error);
    profile[k] = v; b.setAttribute("aria-pressed", v);
  }));
  const tb = s.el.querySelector("#pushTest");
  if (tb) tb.onclick = async () => {
    tb.disabled = true;
    try {
      await enablePush(); // refresh this device's subscription
      const { data, error } = await sb.functions.invoke("send-reminders", { body: { test: true } });
      if (error) throw error;
      toast(data.sent ? "Sent! Check your notifications" : "No device registered yet");
    } catch (e) { fail(e); } finally { tb.disabled = false; }
  };
}

// ---------- BADGES ----------
const BADGE_IC = {
  fork: '<path d="M7 3v8a3 3 0 0 0 3 3v7M10 3v6M13 3v8a3 3 0 0 1-3 3M17 3c-1.5 2-2 4-2 7h3v11"/>',
  flame: '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.5 2 3 0-3 0-5 1-8.5z"/>',
  camera: '<path d="M14.5 4h-5L7.5 6.5H4a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1h-3.5z"/><circle cx="12" cy="13" r="3.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  shoe: '<path d="M3 16l2-8 4 2 3-1 2 3 6 2a2 2 0 0 1 1 2v1H3zM3 19h18"/>',
  steps: '<path d="M7 15c-1.5 0-2.5-1.5-2.5-4S5.5 5 7.5 5 10 7 10 9.5 9 15 7 15zM5 18h4M17 19c-2 0-3-5.5-3-8S15 5 16.5 5 19.5 6.5 19.5 9s-1 4-2.5 4M15 22h4"/>',
  scale: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9a4 4 0 0 1 8 0M12 9l1.5-2"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  crown: '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  bowl: '<path d="M3 11h18a9 9 0 0 1-18 0zM8 7c0-1.5 1-2 1-3M12 7c0-1.5 1-2 1-3M16 7c0-1.5 1-2 1-3"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/>',
};
const badgeSvg = (b, size = 30) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BADGE_IC[b.icon] || BADGE_IC.star}</svg>`;
const badgeTile = (b, i) => `<button class="badge-tile${b.earned_at ? "" : " locked"}" data-badge="${i}" aria-label="${esc(b.name)}${b.earned_at ? "" : " (locked)"}">
  <span class="badge-coin" style="background:${b.earned_at ? b.color : "var(--surface-2)"}">${badgeSvg(b)}</span>
  <span class="badge-name">${esc(b.name)}</span></button>`;
function wireBadgeTiles(list, root = app) {
  root.querySelectorAll("[data-badge]").forEach((el) => (el.onclick = () => {
    const b = list[+el.dataset.badge];
    openSheet(b.name, `<div class="center stack" style="align-items:center">
      <span class="badge-coin big" style="background:${b.earned_at ? b.color : "var(--surface-2)"}">${badgeSvg(b, 56)}</span>
      <p>${esc(b.description)}</p>
      ${b.note ? `<p class="quip">“${esc(b.note)}”</p>` : ""}
      <p class="muted">${b.earned_at ? `Earned ${new Date(b.earned_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : b.kind === "gift" ? "A gift from the Snack & Burn team" : "Not earned yet. Keep going!"}</p>
    </div>`);
  }));
}
async function badgesView() {
  const list = await rpc("my_badge_list");
  const got = list.filter((b) => b.earned_at).length;
  app.innerHTML = `
    <div class="row"><h1>Badges</h1><span class="badge">${got} / ${list.filter((b) => b.kind !== "gift").length}</span></div>
    <p class="muted">Earn them by logging, moving and racing friends. The ??? ones are secret: you’ll find out when you earn them.</p>
    <div class="badge-grid">${list.map(badgeTile).join("")}</div>`;
  wireBadgeTiles(list);
}
// Award new badges, then celebrate any unseen ones (one sheet each)
let badgeCheckBusy = false;
async function checkBadges() {
  if (badgeCheckBusy) return; badgeCheckBusy = true;
  try {
    await rpc("check_all_badges");
    const unseen = await rpc("unseen_badges");
    for (const b of unseen) {
      await new Promise((res) => {
        const s = openSheet(b.note ? "You got a gift!" : "New badge!", `<div class="center stack" style="align-items:center">
          <span class="badge-coin big pop" style="background:${b.color}">${badgeSvg(b, 64)}</span>
          <h1 style="font-size:26px">${esc(b.name)}</h1>
          <p>${esc(b.description)}</p>
          ${b.note ? `<p class="quip">“${esc(b.note)}”</p>` : ""}
          <button class="primary block" data-ok>${profile.serious_mode ? "OK" : "Nice!"}</button></div>`);
        const done = () => { s.close(); res(); };
        s.el.querySelector("[data-ok]").onclick = done;
        s.el.querySelector("[data-close]").onclick = done;
      });
      await sb.from("user_badges").update({ seen: true }).eq("user_id", user.id).eq("code", b.code);
    }
  } catch (e) { console.warn("badges", e); } finally { badgeCheckBusy = false; }
}
async function openGiftSheet(uid, name) {
  const { data: cat } = await sb.from("badge_catalog").select("*").order("sort");
  const s = openSheet(`Gift a badge to ${name}`, `
    <label>Badge<select id="gCode">${(cat || []).map((b) => `<option value="${esc(b.code)}">${esc(b.name)}${b.kind === "gift" ? " ★" : ""}</option>`).join("")}</select></label>
    <label>Message (optional)<input id="gNote" maxlength="140" placeholder="Great week, keep it up!"></label>
    <button class="primary block" id="gGo">Send badge</button>
    <p class="muted">★ = special gift badges. They’ll see a celebration next time they open Home.</p>`);
  s.el.querySelector("#gGo").onclick = async () => {
    try { await rpc("admin_gift_badge", { uid, p_code: s.el.querySelector("#gCode").value, p_note: s.el.querySelector("#gNote").value.trim() || null }); s.close(); toast("Badge sent"); }
    catch (e) { fail(e); }
  };
}

// ---------- AI COACH ----------
const COACH_FACE = `<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#1A1A1A"/><path d="M20 7c1.4 4.2 7 7 7 13.5a7 7 0 0 1-14 0c0-2.8 1.4-4.9 2.8-6.3.4 2.1 1.4 3.5 2.8 4.2 0-4.2 0-7 1.4-11.4z" fill="#D93A1E"/><circle cx="17.5" cy="22" r="1.4" fill="#FFF8EE"/><circle cx="22.5" cy="22" r="1.4" fill="#FFF8EE"/><path d="M17.5 25.5q2.5 2 5 0" stroke="#FFF8EE" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`;
const tipDay = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
function cachedTip() {
  try { const t = JSON.parse(localStorage.getItem("snb_tip") || "null"); return t && t.user === user?.id ? t.text : ""; } catch { return ""; }
}
let tipLoading = false;
async function loadCoachTip() {
  // the tip only changes once a day: skip the AI call if today's is already saved
  try { const t = JSON.parse(localStorage.getItem("snb_tip") || "null"); if (t && t.user === user.id && t.day === tipDay()) return; } catch { /* fetch */ }
  if (tipLoading) return; tipLoading = true;
  try {
    const { data } = await sb.functions.invoke("coach", { body: { mode: "weekly" } });
    const lines = (data?.report || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const tip = lines.find((l) => /^Mẹo hôm nay/i.test(l)) || lines[0];
    if (!tip) return;
    try { localStorage.setItem("snb_tip", JSON.stringify({ user: user.id, day: tipDay(), text: tip })); } catch { /* ignore */ }
    const el = document.getElementById("coachTip");
    if (el && el.textContent !== tip) {
      el.classList.add("fade"); // soft cross-fade instead of a jump
      setTimeout(() => { el.textContent = tip; el.classList.remove("fade"); try { localStorage.setItem("snb_home", app.innerHTML); } catch { /* */ } }, 180);
    }
  } catch { /* keep current text */ } finally { tipLoading = false; }
}
let coachHistory = [];
try { coachHistory = JSON.parse(sessionStorage.getItem("snb_coach") || "[]"); } catch { coachHistory = []; }
async function coach() {
  const chips = ["Tối nay nên ăn gì?", "Tuần này mình làm tốt chưa?", "Làm sao giảm 2 kg trong 1 tháng?", "Nên chạy bao nhiêu km mỗi tuần?"];
  app.innerHTML = `
    <div class="row" style="justify-content:flex-start;gap:12px"><a class="icon-btn" href="#home" aria-label="Back">${sv('<path d="M15 6l-6 6 6 6"/>')}</a>
      <span class="coach-av">${COACH_FACE}</span><div><h1 style="font-size:24px">Coach</h1><p class="muted">Your AI coach · not medical advice</p></div></div>
    <section class="card stack" aria-label="Weekly check-in">
      <div class="row"><b>This week’s check-in</b><button class="outline small" id="refreshRep">Refresh</button></div>
      <div id="report"><div class="skel" style="height:18px;width:90%"></div><div class="skel" style="height:18px;width:75%;margin-top:8px"></div><div class="skel" style="height:18px;width:82%;margin-top:8px"></div></div>
    </section>
    <h2>Ask Coach</h2>
    <div id="chat" class="stack" aria-live="polite">${coachHistory.map(bubble).join("")}</div>
    <div class="chips">${chips.map((c) => `<button class="chip" data-q="${esc(c)}">${esc(c)}</button>`).join("")}</div>
    <form id="askF" class="say-row">
      <textarea id="askT" rows="1" placeholder="Hỏi Coach bất cứ điều gì…" aria-label="Ask Coach"></textarea>
      <button class="mic" aria-label="Send">${sv('<path d="M4 12l16-8-6 16-2-6z"/>')}</button>
    </form>
    ${coachHistory.length ? `<button class="outline small" id="clearChat" style="align-self:center">Clear chat</button>` : ""}`;
  const loadRep = async (refresh) => {
    $("#report").innerHTML = `<div class="skel" style="height:18px;width:90%"></div><div class="skel" style="height:18px;width:75%;margin-top:8px"></div>`;
    try {
      const { data, error } = await sb.functions.invoke("coach", { body: { mode: "weekly", refresh } });
      if (error || data.error) throw new Error(data?.error || error.message);
      $("#report").innerHTML = `<p class="report">${esc(data.report)}</p>`;
    } catch (e) { $("#report").innerHTML = `<p class="muted">Coach couldn’t write the report right now. Try Refresh in a minute.</p>`; console.warn(e); }
  };
  loadRep(false);
  $("#refreshRep").onclick = () => loadRep(true);
  const send = async (q) => {
    q = q.trim(); if (!q) return;
    coachHistory.push({ role: "user", text: q });
    $("#chat").insertAdjacentHTML("beforeend", bubble({ role: "user", text: q }) + `<div class="bubble coach" id="typing"><span class="dots"><i></i><i></i><i></i></span></div>`);
    $("#askT").value = ""; $("#typing").scrollIntoView({ block: "end", behavior: "smooth" });
    try {
      const { data, error } = await sb.functions.invoke("coach", { body: { mode: "chat", question: q, history: coachHistory.slice(-7, -1) } });
      if (error || data.error) throw new Error(data?.error || error.message);
      coachHistory.push({ role: "coach", text: data.answer });
    } catch (e) { coachHistory.push({ role: "coach", text: "Xin lỗi, mình đang bận một chút. Bạn hỏi lại sau ít phút nhé." }); console.warn(e); }
    try { sessionStorage.setItem("snb_coach", JSON.stringify(coachHistory.slice(-20))); } catch { /* ignore */ }
    $("#typing").outerHTML = bubble(coachHistory[coachHistory.length - 1]);
    $("#chat").lastElementChild.scrollIntoView({ block: "end", behavior: "smooth" });
  };
  $("#askF").onsubmit = (e) => { e.preventDefault(); send($("#askT").value); };
  $("#askT").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send($("#askT").value); } };
  $$("[data-q]").forEach((b) => (b.onclick = () => send(b.dataset.q)));
  const cc = $("#clearChat"); if (cc) cc.onclick = () => { coachHistory = []; sessionStorage.removeItem("snb_coach"); route(); };
}
const bubble = (m) => `<div class="bubble ${m.role === "coach" ? "coach" : "me"}">${esc(m.text)}</div>`;

// ---------- WEIGHT ----------
function weightCard(wts) {
  const last = wts[wts.length - 1];
  const first = wts[0];
  const diff = last && first ? Number(last.kg) - Number(first.kg) : 0;
  let spark = "";
  if (wts.length >= 2) {
    const ks = wts.map((x) => Number(x.kg)); const mn = Math.min(...ks) - 0.5, mx = Math.max(...ks) + 0.5;
    const t0 = new Date(first.day).getTime(), t1 = Math.max(new Date(last.day).getTime(), t0 + 864e5);
    const pts = wts.map((x) => `${((new Date(x.day).getTime() - t0) / (t1 - t0)) * 300},${70 - ((Number(x.kg) - mn) / (mx - mn)) * 60}`).join(" ");
    spark = `<svg viewBox="-6 0 312 76" class="spark" role="img" aria-label="Weight over the last ${wts.length} entries, from ${n1(first.kg)} to ${n1(last.kg)} kg">
      <polyline points="${pts}" fill="none" stroke="var(--burn)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      ${wts.map((x, i) => i === wts.length - 1 ? `<circle cx="${pts.split(" ")[i].split(",")[0]}" cy="${pts.split(" ")[i].split(",")[1]}" r="5" fill="var(--burn)"/>` : "").join("")}
    </svg>`;
  }
  return `<section class="card stack" aria-label="Weight">
    <div class="row"><div><b>Weight</b><div class="muted">${last ? `Last: ${new Date(last.day).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "Track it weekly"}</div></div>
      <button class="outline small" id="logWeight">+ Log weight</button></div>
    ${last ? `<div class="row" style="justify-content:flex-start;gap:12px;align-items:baseline">
      <span class="big-k" style="font-size:34px">${n1(last.kg)} <small>kg</small></span>
      ${wts.length >= 2 ? `<span class="${diff <= 0 ? "ok" : "danger"}" style="font-weight:600">${diff <= 0 ? "▼" : "▲"} ${n1(Math.abs(diff))} kg</span><span class="muted">in ${Math.max(1, Math.round((new Date(last.day) - new Date(first.day)) / 864e5))} days</span>` : ""}
    </div>${spark}` : `<p class="muted">Log your weight to see your trend. Your daily budget updates automatically.</p>`}
  </section>`;
}

function openWeightSheet(wts) {
  const last = wts[wts.length - 1];
  let kg = Number(last?.kg || profile.weight_kg) || 65;
  const s = openSheet("Log weight", `
    <div class="stepper">
      <button type="button" class="step-btn" data-w="-0.1" aria-label="Minus 0.1 kg">${sv('<path d="M5 12h14"/>')}</button>
      <input id="wVal" type="number" inputmode="decimal" step="0.1" min="30" max="300" value="${n1(kg)}" aria-label="Weight in kg">
      <button type="button" class="step-btn" data-w="0.1" aria-label="Plus 0.1 kg">${sv('<path d="M12 5v14M5 12h14"/>')}</button>
    </div>
    <p class="muted center">kg · today. Best weighed in the morning, before breakfast.</p>
    <p class="muted center" id="wBudget"></p>
    <button class="primary block" id="wSave">Save weight</button>`);
  const v = s.el.querySelector("#wVal");
  const upd = () => { const nb = tdee({ ...profile, weight_kg: +v.value || kg }); s.el.querySelector("#wBudget").textContent = `New daily budget: ${n0(nb)} kcal`; };
  s.el.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => { v.value = (Math.round(((+v.value || kg) + +b.dataset.w) * 10) / 10).toFixed(1); upd(); }));
  v.oninput = upd; upd();
  s.el.querySelector("#wSave").onclick = async () => {
    const w = Math.round((+v.value) * 10) / 10;
    if (!(w >= 30 && w <= 300)) return toast("Enter a weight between 30 and 300 kg");
    const day = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    const { error } = await sb.from("weights").upsert({ day, kg: w }, { onConflict: "user_id,day" });
    if (error) return fail(error);
    const budget = tdee({ ...profile, weight_kg: w });
    const r2 = await sb.from("profiles").update({ weight_kg: w, budget_kcal: budget }).eq("id", user.id);
    if (r2.error) return fail(r2.error);
    profile.weight_kg = w; profile.budget_kcal = budget;
    s.close(); toast(`${n1(w)} kg saved. Budget: ${n0(budget)} kcal`); route();
  };
}

// ---------- STEP SYNC: run the user's Apple Shortcut, then come back ----------
const stepShortcutName = () => { try { return localStorage.getItem("snb_shortcut") || "Lấy số bước chân"; } catch { return "Lấy số bước chân"; } };
function runStepShortcut() {
  sessionStorage.setItem("snb_syncing", String(Date.now()));
  // No return link: iPhone would reopen it in Safari instead of the installed app.
  // The user comes back with the "◀ Snack & Burn" button at the top-left; Home then refreshes itself.
  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(stepShortcutName())}`;
  if (!sessionStorage.getItem("snb_sync_tip")) { sessionStorage.setItem("snb_sync_tip", "1"); toast("After it runs, tap ◀ Snack & Burn at the top-left to come back"); }
}
// when the user comes back from Shortcuts, refresh Home to show the new steps
document.addEventListener("visibilitychange", () => {
  const t = +sessionStorage.getItem("snb_syncing") || 0;
  if (document.visibilityState === "visible" && t && Date.now() - t < 5 * 60 * 1000) {
    sessionStorage.removeItem("snb_syncing");
    setTimeout(() => { if (location.hash.startsWith("#home") || !location.hash) route(); }, 1500);
  }
});

// ---------- LOG A BURN (bottom sheet) ----------
const sv = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ACT = {
  steps: { label: "Steps",     by: "steps", met: null, icon: sv('<path d="M7 15c-1.5 0-2.5-1.5-2.5-4S5.5 5 7.5 5 10 7 10 9.5 9 15 7 15zM5 18h4M17 19c-2 0-3-5.5-3-8S15 5 16.5 5 19.5 6.5 19.5 9s-1 4-2.5 4M15 22h4"/>') },
  run:   { label: "Run",       by: "km",  met: null, icon: sv('<circle cx="14" cy="4.5" r="2"/><path d="M8 21l3-6 3 3v4M6 12l3-4 4 1 3 4 3 1M11 15l-1-4"/>') },
  walk:  { label: "Walk",      by: "km",  met: null, icon: sv('<circle cx="12" cy="4.5" r="2"/><path d="M10 21l2-7 3 3v4M8 12l2-4h3l2 4M12 14v-6"/>') },
  rope:  { label: "Jump rope", by: "min", met: 12,   icon: sv('<path d="M5 4v6M19 4v6M5 10c0 8 14 8 14 0"/><circle cx="12" cy="6" r="2"/>') },
  cycle: { label: "Cycle",     by: "min", met: 7,    icon: sv('<circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M6 17l4-8h5l3 8M10 9l2 8M14 5h2"/>') },
  other: { label: "Workout",   by: "min", met: 6,    icon: sv('<path d="M3 10v4M6 8v8M18 8v8M21 10v4M6 12h12"/>') },
};
const PRESETS = { km: [2, 3, 5, 10], min: [15, 30, 45, 60], steps: [3000, 5000, 8000, 10000] };
const stepsKm = (n) => (n * (Number(profile?.height_cm) || 170) * 0.00414) / 1000;

function openBurnSheet(init = {}) {
  const st = { kind: init.kind || localStorage.getItem("snb_last_kind") || "run", km: init.km || 0, min: 0, steps: 0, kcal: null, when: "" };
  const w = weight();
  const calc = () => {
    if (st.kcal != null) return st.kcal;
    const a = ACT[st.kind];
    if (st.kind === "steps") return Math.round(stepsKm(st.steps) * 0.5 * w);
    if (st.kind === "run") return Math.round(st.km * w);
    if (st.kind === "walk") return Math.round(st.km * 0.5 * w);
    return Math.round((st.min * a.met * w) / 60);
  };
  const wrap = document.createElement("div");
  wrap.className = "sheet-backdrop";
  document.body.appendChild(wrap);
  const prevFocus = document.activeElement;
  const close = () => { wrap.remove(); prevFocus?.focus?.(); };

  const render = () => {
    const a = ACT[st.kind];
    const main = a.by;
    const val = main === "km" ? st.km : main === "steps" ? st.steps : st.min;
    const k = calc();
    const pace = st.kind === "run" && st.km > 0 && st.min > 0 ? (() => { const p = st.min / st.km; return `${Math.floor(p)}:${String(Math.round((p % 1) * 60)).padStart(2, "0")} /km`; })() : "";
    wrap.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="burnTitle">
      <div class="row"><h1 id="burnTitle" style="font-size:24px">Log a burn</h1>
        <button class="icon-btn" id="closeSheet" aria-label="Close">${sv('<path d="M6 6l12 12M18 6L6 18"/>')}</button></div>

      <div class="act-grid" role="radiogroup" aria-label="Activity">
        ${Object.entries(ACT).map(([key, x]) => `<button type="button" role="radio" aria-checked="${st.kind === key}" class="act-tile" data-kind="${key}">${x.icon}<span>${x.label}</span></button>`).join("")}
      </div>

      <div class="card stack">
        <div class="row"><b>${{ km: "Distance", min: "Duration", steps: "Steps today" }[main]}</b><span class="muted">${main === "steps" && st.steps ? `≈ ${n1(stepsKm(st.steps))} km` : { km: "kilometres", min: "minutes", steps: "from your Health app" }[main]}</span></div>
        <div class="stepper">
          <button type="button" class="step-btn" data-step="-1" aria-label="Less">${sv('<path d="M5 12h14"/>')}</button>
          <input id="mainVal" type="number" inputmode="decimal" min="0" step="${main === "km" ? 0.1 : 1}" value="${val || ""}" placeholder="0" aria-label="${{ km: "Distance in km", min: "Minutes", steps: "Steps" }[main]}">
          <button type="button" class="step-btn" data-step="1" aria-label="More">${sv('<path d="M12 5v14M5 12h14"/>')}</button>
        </div>
        <div class="chips" style="justify-content:space-between">${PRESETS[main].map((v) => `<button type="button" class="chip${v === val ? " on" : ""}" data-preset="${v}">${main === "steps" ? (v / 1000) + "k" : v + " " + main}</button>`).join("")}</div>
        ${main === "km" ? `<label>Time taken (optional, minutes)<input id="minVal" type="number" inputmode="numeric" min="0" value="${st.min || ""}" placeholder="e.g. 30"></label>` : ""}
      </div>

      <div class="burn-total" aria-live="polite">
        <div><span class="muted">You burned about</span><div class="big-k">${k ? n0(k) : "–"} <small>kcal</small></div>
          <span class="muted">${pace ? `Pace ${pace} · ` : ""}${k ? `≈ ${n1(k / 7.7)} g of fat` : "Pick a distance or time"}</span></div>
        <button type="button" class="outline small" id="editK">${st.kcal != null ? "Auto" : "Edit"}</button>
      </div>
      ${st.kcal != null ? `<label>kcal from your watch<input id="kVal" type="number" inputmode="numeric" min="1" value="${st.kcal || ""}"></label>` : ""}

      ${main === "steps" ? `<p class="muted">Steps replace today’s step total. Set up auto sync in Profile → Step sync.</p>` : `<label>When<input id="whenVal" type="time" value="${st.when || new Date().toTimeString().slice(0, 5)}"></label>`}
      <button class="primary block" id="saveBurn" ${k ? "" : "disabled"}>Save ${k ? n0(k) + " kcal burn" : "burn"}</button>
    </div>`;

    wrap.querySelector("#closeSheet").onclick = close;
    wrap.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => { st.kind = b.dataset.kind; st.kcal = null; render(); }));
    const mv = wrap.querySelector("#mainVal");
    const val0 = () => (main === "km" ? st.km : main === "steps" ? st.steps : st.min);
    const setMain = (v) => { v = Math.max(0, Math.round(v * 10) / 10); if (main === "km") st.km = v; else if (main === "steps") st.steps = Math.round(v); else st.min = Math.round(v); };
    mv.oninput = () => { setMain(+mv.value || 0); refresh(); };
    wrap.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => { setMain(val0() + (+b.dataset.step) * ({ km: 0.5, min: 5, steps: 500 }[main])); render(); }));
    wrap.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => { setMain(+b.dataset.preset); render(); }));
    const mn = wrap.querySelector("#minVal"); if (mn) mn.oninput = () => { st.min = +mn.value || 0; refresh(); };
    const kv = wrap.querySelector("#kVal"); if (kv) kv.oninput = () => { st.kcal = +kv.value || 0; refresh(); };
    const wv = wrap.querySelector("#whenVal"); if (wv) wv.onchange = (e) => { st.when = e.target.value; };
    wrap.querySelector("#editK").onclick = () => { st.kcal = st.kcal != null ? null : calc(); render(); wrap.querySelector("#kVal")?.focus(); };
    wrap.querySelector("#saveBurn").onclick = save;
  };
  // update the numbers without rebuilding the inputs (keeps the keyboard open)
  const refresh = () => {
    const k = calc();
    const box = wrap.querySelector(".burn-total .big-k"); if (box) box.innerHTML = `${k ? n0(k) : "–"} <small>kcal</small>`;
    const btn = wrap.querySelector("#saveBurn"); btn.disabled = !k; btn.textContent = `Save ${k ? n0(k) + " kcal burn" : "burn"}`;
    const sub = wrap.querySelector(".burn-total .muted:last-child");
    if (sub) sub.textContent = k ? `≈ ${n1(k / 7.7)} g of fat` : "Pick a distance or time";
    wrap.querySelectorAll("[data-preset]").forEach((c) => c.classList.toggle("on", +c.dataset.preset === ({ km: st.km, min: st.min, steps: st.steps }[ACT[st.kind].by])));
  };
  const save = async () => {
    const k = calc(); if (!k) return;
    const btn = wrap.querySelector("#saveBurn"); btn.disabled = true; btn.textContent = "Saving…";
    if (st.kind === "steps") {
      try {
        const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
        await rpc("record_steps", { p_token: null, p_steps: st.steps, p_day: today, p_source: "manual" });
      } catch (err) { btn.disabled = false; return fail(err); }
      localStorage.setItem("snb_last_kind", "steps"); close();
      toast(`${n0(st.steps)} steps saved`); location.hash = "#home"; return route();
    }
    const when = new Date(); const t = wrap.querySelector("#whenVal")?.value;
    if (t) { const [h, m] = t.split(":"); when.setHours(+h, +m, 0, 0); }
    const { error } = await sb.from("activities").insert({ kind: st.kind, distance_km: ACT[st.kind].by === "km" ? st.km : 0, minutes: st.min || 0, kcal: k, started_at: when.toISOString() });
    if (error) { btn.disabled = false; return fail(error); }
    localStorage.setItem("snb_last_kind", st.kind);
    close();
    toast(profile.serious_mode ? "Saved" : `−${n0(k)} kcal. Flames everywhere.`);
    location.hash = "#home"; route();
  };
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  render();
  wrap.querySelector("#mainVal").focus({ preventScroll: true });
}

// ---------- SNAP ----------
const MULT = { S: 0.7, M: 1, L: 1.3 };
const BURN_GOAL = 400; // daily burn ring target (kcal)
async function snap() {
  if (!snapState) snapState = { step: "camera", photo: null, items: [] };
  const s = snapState;

  if (s.step === "camera") {
    const { data: hist } = await sb.from("meals").select("name,kcal,items").order("eaten_at", { ascending: false }).limit(30);
    const seen = new Set();
    const recent = (hist || []).filter((m) => !seen.has(m.name) && seen.add(m.name)).slice(0, 6);
    app.innerHTML = `
      <div class="row"><h1>Snap your meal</h1><span class="muted">Step 1 of 3</span></div>
      <label class="drop" for="cam">
        <span class="display" style="font-size:22px">Tap to take a photo</span>
        <span class="muted" style="color:var(--on-hero-muted)">Shoot from above, in good light</span>
      </label>
      <input id="cam" type="file" accept="image/*" capture="environment" hidden>
      <div class="row" style="justify-content:center"><label for="cam" class="shutter" aria-label="Take photo" role="button" tabindex="0"></label></div>
      <form class="card stack" id="sayForm">
        <label for="sayText"><b style="color:var(--ink);font-size:15px">Or just say it</b></label>
        <div class="say-row">
          <textarea id="sayText" rows="2" placeholder="Trưa nay ăn 1 tô phở bò với ly trà đá…" aria-label="Describe what you ate"></textarea>
          <button type="button" class="mic" id="micBtn" aria-label="Speak your meal">${sv('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>')}</button>
        </div>
        <button class="primary block" id="sayGo">Count the kcal</button>
        <p class="muted" id="sayHint">Tap the mic, or use the 🎤 on your keyboard.</p>
      </form>
      <button class="outline block" id="manual">Pick dishes from the list</button>
      ${recent.length ? `<h2>Eat it again</h2><div class="chips">${recent.map((m, i) => `<button class="chip" data-recent="${i}">${esc(m.name)} · ${n0(m.kcal)}</button>`).join("")}</div>` : ""}`;
    $$("[data-recent]").forEach((b) => (b.onclick = () => {
      const m = recent[+b.dataset.recent];
      s.step = "detect"; s.photo = null;
      s.items = (m.items && m.items.length ? m.items : [{ name: m.name, kcal: m.kcal }]).map((i) => ({ name: i.name, kcal: Math.round(i.kcal / (MULT[i.size] || 1)), size: i.size || "M" }));
      route();
    }));
    $("#cam").onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      s.photo = await downscale(file);
      s.step = "detect"; s.items = []; route();
      analyze();
    };
    $("#manual").onclick = () => { s.step = "detect"; s.photo = null; s.items = []; route(); };
    $("#sayForm").onsubmit = (e) => {
      e.preventDefault();
      const t = $("#sayText").value.trim();
      if (t.length < 3) return toast("Tell me what you ate first");
      s.step = "detect"; s.photo = null; s.items = []; s.said = t; route();
      analyze(t);
    };
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = $("#micBtn");
    if (!SR) { mic.hidden = true; $("#sayHint").textContent = "Tip: tap the 🎤 on your keyboard to speak."; }
    else mic.onclick = () => {
      const rec = new SR(); rec.lang = "vi-VN"; rec.interimResults = true; rec.continuous = false;
      const box = $("#sayText"); const before = box.value ? box.value + " " : "";
      mic.classList.add("on"); $("#sayHint").textContent = "Listening… speak now";
      rec.onresult = (ev) => { box.value = before + [...ev.results].map((x) => x[0].transcript).join(" "); };
      rec.onerror = () => toast("Couldn’t hear you. Try the keyboard 🎤 instead.");
      rec.onend = () => { mic.classList.remove("on"); $("#sayHint").textContent = "Check the text, then tap Count the kcal."; };
      rec.start();
    };
    return;
  }

  if (s.step === "detect") {
    const dl0 = await loadDishes();
    const total = s.items.reduce((t, i) => t + Math.round(i.kcal * MULT[i.size]), 0);
    app.innerHTML = `
      <div class="row"><h1>${s.analyzing ? "Looking at your meal…" : s.items.length ? `We spotted ${s.items.length}` : "What did you eat?"}</h1><span class="muted">Step 2 of 3</span></div>
      ${s.photo ? `<img class="photo" src="data:image/jpeg;base64,${s.photo}" alt="Your meal">` : ""}
      ${!s.photo && s.said ? `<div class="card"><span class="muted">You said</span><p>“${esc(s.said)}”</p></div>` : ""}
      ${s.items.length ? `<p class="muted">Adjust the portions. Photos can’t see oil and sugar.</p>` : ""}
      ${s.items.map((it, idx) => `
        <div class="card stack">
          <div class="row"><b>${esc(it.name)}</b><div class="row"><span class="display" style="font-size:20px">${n0(it.kcal * MULT[it.size])} kcal</span><button class="icon-btn" data-rm="${idx}" aria-label="Remove ${esc(it.name)}"><svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div></div>
          <div class="pills">${["S", "M", "L"].map((z) => `<button type="button" data-i="${idx}" data-z="${z}" aria-pressed="${it.size === z}">${{ S: "Small", M: "Medium", L: "Large" }[z]}</button>`).join("")}</div>
        </div>`).join("")}
      <div class="row"><h2>Pick from the menu</h2><span class="muted">tap to add</span></div>
      <div class="menu-strip">${dl0.map(([n, k, img], i) => `<button class="menu-item" data-menu="${i}">
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : `<span class="menu-ph">${sv(FORK)}</span>`}
        <b>${esc(n)}</b><span>${n0(k)} kcal</span></button>`).join("")}</div>
      <form id="add" class="card stack" novalidate>
        <label>Add a dish<input id="addName" list="dishes" placeholder="e.g. Phở bò" autocomplete="off" enterkeyhint="done"></label>
        <datalist id="dishes">${(await loadDishes()).map(([d]) => `<option value="${esc(d)}">`).join("")}</datalist>
        <div class="row"><label style="flex:1">kcal (medium portion)<input id="addKcal" type="number" inputmode="numeric" min="0" placeholder="Leave empty, AI will estimate"></label><button type="submit" class="primary small" id="addBtn" style="align-self:flex-end">Add</button></div>
      </form>
      <p class="muted">AI estimate, ±20%${s.provider ? ` · read by ${s.provider === "claude" ? "Claude" : "Gemini"}` : ""}</p>
      <button class="outline block" id="retake">Start over</button>
      <div class="save-bar" ${s.items.length ? "" : "hidden"}>
        <div><span class="muted">${s.items.length} item${s.items.length === 1 ? "" : "s"}</span><b>${n0(total)} kcal</b></div>
        <button class="primary" id="calc">Save meal</button>
      </div>`;
    $$("[data-z]").forEach((b) => (b.onclick = () => { s.items[b.dataset.i].size = b.dataset.z; route(); }));
    $$("[data-rm]").forEach((b) => (b.onclick = () => { s.items.splice(+b.dataset.rm, 1); route(); }));
    const add = $("#add"), nameIn = $("#addName"), kcalIn = $("#addKcal");
    // re-render in place without jumping to the top
    const rerender = () => { const y = window.scrollY; route().then(() => window.scrollTo(0, y)); };
    $$("[data-menu]").forEach((b) => (b.onclick = () => { const [n, k] = dl0[+b.dataset.menu]; s.items.push({ name: n, kcal: k, size: "M" }); toast(`${n} added`); route(); }));
    const fill = () => { const hit = dl0.find(([d]) => d.toLowerCase() === nameIn.value.trim().toLowerCase()); if (hit) kcalIn.value = hit[1]; };
    nameIn.oninput = fill; nameIn.onchange = fill;
    add.onsubmit = async (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) { nameIn.focus(); return toast("Type a dish name first"); }
      fill();
      let kcal = kcalIn.value === "" ? NaN : +kcalIn.value;
      const btn = $("#addBtn");
      if (!(kcal >= 0)) {
        // no kcal typed: ask the AI to estimate this one dish
        btn.disabled = true; btn.textContent = "…";
        try {
          const { data, error } = await sb.functions.invoke("analyze-meal", { body: { text: name } });
          if (error || data.error) throw new Error(data?.error || error.message);
          const found = data.items || [];
          if (!found.length) throw new Error("none");
          found.forEach((i) => s.items.push({ name: i.name, kcal: i.kcal, size: "M" }));
          toast(`${found.map((i) => i.name).join(", ")} added`);
          return rerender();
        } catch {
          btn.disabled = false; btn.textContent = "Add";
          kcalIn.focus(); return toast("Couldn’t estimate it. Type the kcal and tap Add.");
        }
      }
      s.items.push({ name, kcal, size: "M" });
      toast(`${name} added`);
      rerender();
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

async function analyze(text) {
  const s = snapState; s.analyzing = true; route();
  try {
    const { data, error } = await sb.functions.invoke("analyze-meal", { body: text ? { text } : { image: s.photo, media_type: "image/jpeg" } });
    if (error) throw error;
    if (data.error) throw new Error(data.error);
    s.items = (data.items || []).map((i) => ({ name: i.name, kcal: i.kcal, size: "M" })); s.provider = data.provider;
    if (!s.items.length) toast(text ? "Couldn’t find food in that. Try naming the dishes." : "No food spotted. Add dishes by hand.");
  } catch (e) {
    console.error(e);
    let msg = e.message || "";
    try { if (e.context?.json) msg = (await e.context.json()).error || msg; } catch { /* keep message */ }
    toast(/402|429|quota|credit/i.test(msg) ? "AI is taking a break (out of credit). Pick from the menu or add dishes by hand." : `AI couldn’t read that (${msg.slice(0, 80)}). Add dishes by hand.`);
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
const CROWN = '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>';
async function challenges(q) {
  const [{ data: list, error }, friendsList] = await Promise.all([
    sb.from("challenges").select("*").gte("ends_at", new Date(Date.now() - 7 * 864e5).toISOString()).order("ends_at"),
    rpc("friends_week"),
  ]);
  if (error) throw error;
  const now = Date.now();
  const shown = list.filter((c) => c.metric === challengeMetric)
    .sort((a, b) => (new Date(a.ends_at) < now) - (new Date(b.ends_at) < now) || (b.official ? 1 : 0) - (a.official ? 1 : 0));
  const boards = await Promise.all(shown.map((c) => rpc("challenge_leaderboard", { cid: c.id })));
  const counts = { km: list.filter((c) => c.metric === "km" && new Date(c.ends_at) > now).length, kcal: list.filter((c) => c.metric === "kcal" && new Date(c.ends_at) > now).length };
  const unitOf = (c) => (c.metric === "km" ? "km" : "kcal");
  const fmtOf = (c) => (v) => (c.metric === "km" ? n1(v) : n0(v));
  const leftTxt = (c) => { const ms = new Date(c.ends_at) - now; if (ms <= 0) return "Finished"; const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24; return d ? `${d}d ${h}h left` : `${h}h left`; };
  const av = (r, i, cls = "") => `<span class="avatar ${cls}" style="background:${COLORS[i % 5]}">${initial(r.display_name)}</span>`;
  const nm = (r) => (r.user_id === user.id ? "You" : esc(r.display_name));

  const card = (c, rows) => {
    const fmt = fmtOf(c), unit = unitOf(c);
    const st = new Date(c.starts_at).getTime(), en = new Date(c.ends_at).getTime();
    const ended = en < now, pct = Math.max(0, Math.min(100, ((now - st) / (en - st)) * 100));
    const me = rows.findIndex((r) => r.user_id === user.id), lead = rows[0], top = Math.max(1, lead?.score || 0);
    const status = me < 0 ? `${rows.length} taking part`
      : ended ? (me === 0 ? "You won this one!" : `You finished #${me + 1}`)
      : me === 0 ? (rows[1] ? `You lead by ${fmt(lead.score - rows[1].score)} ${unit}` : "You’re leading. Keep it up!")
      : `${fmt(lead.score - rows[me].score)} ${unit} to take the lead`;
    const pod = rows.slice(0, 3);
    const order = [1, 0, 2].filter((i) => pod[i]);
    return `<article class="ch-card ${c.official ? "official" : ""} ${ended ? "ended" : ""}">
      <header class="ch-head">
        <div class="ch-tags"><span class="ch-tag">${c.official ? `${sv(CROWN)} Official event` : (en - st) / 864e5 <= 7.01 ? "Weekly" : "Custom"}</span>
          <span class="ch-tag ${ended ? "" : "live"}">${ended ? "" : '<i class="pulse"></i>'}${leftTxt(c)}</span></div>
        <h2>${esc(c.name)}</h2>
        <p class="ch-status">${me >= 0 ? `<b>#${me + 1}</b> · ` : ""}${status}</p>
        <div class="ch-time" role="img" aria-label="${Math.round(pct)}% of the time has passed"><span style="width:${pct}%"></span></div>
      </header>
      ${rows.length ? `<div class="podium">${order.map((i) => `
        <div class="pod p${i + 1} ${pod[i].user_id === user.id ? "me" : ""}">
          ${i === 0 ? `<span class="pod-crown">${sv(CROWN)}</span>` : ""}
          ${av(pod[i], i, "pod-av")}
          <span class="pod-name">${nm(pod[i])}</span>
          <span class="pod-score">${fmt(pod[i].score)} <small>${unit}</small></span>
          <span class="pod-step"><b>${i + 1}</b></span>
        </div>`).join("")}</div>` : `<p class="muted center" style="padding:12px">Nobody has scored yet. Be first!</p>`}
      ${rows.length > 3 ? `<ol class="ch-rest" start="4">${rows.slice(3, 10).map((r, j) => `
        <li class="${r.user_id === user.id ? "me" : ""}"><span class="rk">${j + 4}</span>${av(r, j + 3)}<span class="nm">${nm(r)}</span>
          <span class="bar"><span style="width:${(r.score / top) * 100}%"></span></span><b>${fmt(r.score)}</b></li>`).join("")}</ol>` : ""}
      ${me > 9 ? `<p class="muted center">You: #${me + 1} · ${fmt(rows[me].score)} ${unit}</p>` : ""}
      ${me < 0 && c.official && !ended ? `<button class="primary block" data-join="${c.id}">Join event</button>` : ""}
    </article>`;
  };

  app.innerHTML = `
    <div class="row"><h1>Challenges</h1><button class="primary small" id="new">${sv('<path d="M12 5v14M5 12h14"/>')} New</button></div>
    <div class="seg ch-seg" role="group" aria-label="Challenge type">
      <button aria-pressed="${challengeMetric === "km"}" data-m="km">${sv('<path d="M3 16l2-8 4 2 3-1 2 3 6 2a2 2 0 0 1 1 2v1H3zM3 19h18"/>')} Km run${counts.km ? ` <span class="cnt">${counts.km}</span>` : ""}</button>
      <button aria-pressed="${challengeMetric === "kcal"}" data-m="kcal">${sv('<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.5 2 3 0-3 0-5 1-8.5z"/>')} Kcal burned${counts.kcal ? ` <span class="cnt">${counts.kcal}</span>` : ""}</button>
    </div>
    ${shown.length ? shown.map((c, i) => card(c, boards[i])).join("") : `
      <div class="ch-empty">
        <span class="ch-empty-ic">${sv(challengeMetric === "km" ? '<path d="M3 16l2-8 4 2 3-1 2 3 6 2a2 2 0 0 1 1 2v1H3zM3 19h18"/>' : '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.5 2 3 0-3 0-5 1-8.5z"/>')}</span>
        <b>No ${challengeMetric === "km" ? "running" : "calorie"} challenges yet</b>
        <p class="muted">Pick a few friends and race for a week. Losers buy the bánh mì.</p>
        <button class="primary" id="new2">Start a challenge</button>
      </div>`}
    <div class="row"><h2>Your badges</h2><a class="btn outline small" href="#badges">See all</a></div>
    <div class="badge-grid" id="chBadges"><div class="skel" style="height:96px;grid-column:1/-1"></div></div>`;
  rpc("my_badge_list").then((l) => { const el = $("#chBadges"); if (el) el.innerHTML = l.slice(0, 8).map(badgeTile).join(""); wireBadgeTiles(l); }).catch(() => {});

  $$("[data-m]").forEach((b) => (b.onclick = () => { challengeMetric = b.dataset.m; route(); }));
  $$("[data-join]").forEach((b) => (b.onclick = async () => {
    try { await rpc("join_challenge", { cid: b.dataset.join }); toast("You're in! Go get it."); route(); } catch (e) { fail(e); }
  }));
  const open = () => newChallengeSheet(friendsList, q.get("with"));
  $("#new").onclick = open; const n2 = $("#new2"); if (n2) n2.onclick = open;
  if (q.get("with")) { history.replaceState(null, "", "#challenges"); open(); }
}

function newChallengeSheet(friendsList, preselect) {
  let metric = challengeMetric, len = 7;
  const picked = new Set(preselect ? [preselect] : []);
  const s = openSheet("New challenge", `
    <label>Name<input id="cName" maxlength="60" placeholder="Saigon Sunday Runners"></label>
    <div class="seg" role="radiogroup" aria-label="Type">
      <button type="button" data-cm="km" aria-pressed="${metric === "km"}">Most km run</button>
      <button type="button" data-cm="kcal" aria-pressed="${metric === "kcal"}">Most kcal burned</button>
    </div>
    <div><p class="muted" style="margin:0 0 6px">How long</p><div class="chips">
      ${[[3, "3 days"], [7, "1 week"], [14, "2 weeks"], [30, "1 month"]].map(([d, t]) => `<button type="button" class="chip" data-cl="${d}" aria-pressed="${d === 7}">${t}</button>`).join("")}
    </div></div>
    <div><p class="muted" style="margin:0 0 6px">Invite friends <span id="pCount"></span></p>
      ${friendsList.length ? `<div class="friend-pick">${friendsList.map((f, i) => `
        <button type="button" class="fp" data-fp="${f.id}" aria-pressed="${picked.has(f.id)}"><span class="avatar" style="background:${COLORS[i % 5]}">${initial(f.display_name)}</span><span>${esc(f.display_name)}</span><i>${sv('<path d="M5 12l5 5 9-10"/>')}</i></button>`).join("")}</div>`
        : `<p class="muted">Add friends first on the Friends tab.</p>`}
    </div>
    <button class="primary block" id="cGo">Start challenge</button>`);
  const E = s.el;
  const cnt = () => { E.querySelector("#pCount").textContent = picked.size ? `· ${picked.size} picked` : ""; };
  cnt();
  E.querySelectorAll("[data-cm]").forEach((b) => (b.onclick = () => { metric = b.dataset.cm; E.querySelectorAll("[data-cm]").forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
  E.querySelectorAll("[data-cl]").forEach((b) => (b.onclick = () => { len = +b.dataset.cl; E.querySelectorAll("[data-cl]").forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
  E.querySelectorAll("[data-fp]").forEach((b) => (b.onclick = () => { const id = b.dataset.fp; picked.has(id) ? picked.delete(id) : picked.add(id); b.setAttribute("aria-pressed", picked.has(id)); cnt(); }));
  E.querySelector("#cGo").onclick = async () => {
    const name = E.querySelector("#cName").value.trim();
    if (!name) return toast("Give your challenge a name");
    if (!picked.size) return toast("Pick at least one friend");
    const starts = new Date(), ends = new Date(Date.now() + len * 864e5);
    try {
      await rpc("create_challenge", { p_name: name, p_metric: metric, p_starts: starts.toISOString(), p_ends: ends.toISOString(), p_members: [...picked] });
      challengeMetric = metric; s.close(); toast("Challenge on! May the fastest snacker win."); route();
    } catch (err) { fail(err); }
  };
}

// ---------- APPLE WATCH + HEALTH GUIDE (interactive) ----------
let watchStep = 0;
const WATCH_DONE_KEY = "snb_watch_done";
const watchDone = () => { try { return JSON.parse(localStorage.getItem(WATCH_DONE_KEY) || "[]"); } catch { return []; } };
async function watchGuide() {
  tabs.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.tab === "profile"));
  const [code, tok] = await Promise.all([rpc("my_step_token", { regenerate: false }).catch(() => ""), sb.from("step_tokens").select("last_sync").maybeSingle()]);
  const url = `${cfg.SUPABASE_URL}/functions/v1/sync-steps`;
  const lastSync = tok.data?.last_sync;
  const path = (items) => `<div class="g-path">${items.map((t, i) => `${i ? `<span class="g-sep">›</span>` : ""}<span class="g-crumb">${t}</span>`).join("")}</div>`;
  const STEPS = [
    { t: "Đeo Apple Watch là đủ", short: "Watch → Health",
      art: `<div class="g-flow"><div class="g-watch"><div class="g-watch-face"><b>8,240</b><span>bước</span></div></div><div class="g-dots"><i></i><i></i><i></i></div><div class="g-health">${sv('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>')}</div><div class="g-dots"><i></i><i></i><i></i></div><div class="g-app"><img src="icon-192.png" alt=""></div></div>`,
      body: `<p>Apple Watch tự gửi bước chân và bài tập vào app <b>Sức khỏe</b> (Health) trên iPhone. Snack &amp; Burn đọc số bước từ đó.</p>
        <p class="muted">Kiểm tra: mở <b>Sức khỏe</b>, rồi vào:</p>${path(["Duyệt", "Hoạt động", "Bước", "Nguồn dữ liệu & Truy cập"])}
        <p class="muted">Thấy tên Apple Watch là được. Bấm <b>Sửa</b> và kéo Watch lên đầu để số bước chính xác nhất.</p>` },
    { t: "Bật theo dõi thể chất", short: "Fitness Tracking",
      art: `<div class="g-phone"><div class="g-screen"><div class="g-nav">Chuyển động &amp; thể chất</div><button class="g-toggle-row" id="gToggle" aria-pressed="false"><span>Theo dõi thể chất</span><span class="switch" aria-hidden="true"></span></button><p class="g-hint">Thử chạm công tắc</p></div></div>`,
      body: `<p>Để iPhone và Watch được đếm bước, mở <b>Cài đặt</b>:</p>${path(["Quyền riêng tư & Bảo mật", "Chuyển động & thể chất"])}
        <p>Bật <b>Theo dõi thể chất</b> và bật cho <b>Sức khỏe</b>.</p>` },
    { t: "Tạo phím tắt đồng bộ", short: "Shortcut",
      art: `<div class="g-blocks">
        <button class="g-block b1" data-gb="1"><span class="gb-ic">${sv('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>')}</span><span><b>Tìm mẫu sức khỏe</b><small>Loại: Bước · Ngày bắt đầu: Hôm nay · Nhóm theo: Ngày</small></span></button>
        <button class="g-block b2" data-gb="2"><span class="gb-ic">${sv('<path d="M4 20h16M7 16V9M12 16V5M17 16v-4"/>')}</span><span><b>Tính toán thống kê</b><small>Tổng của Mẫu sức khỏe</small></span></button>
        <button class="g-block b3" data-gb="3"><span class="gb-ic">${sv('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>')}</span><span><b>Nhận nội dung của URL</b><small>POST · JSON: code, steps</small></span></button></div>`,
      body: `<p>Mở app <b>Phím tắt</b> (Shortcuts), bấm <b>+</b> và thêm đúng 3 khối như hình. Chạm từng khối để xem cách điền.</p>
        <div class="g-detail" id="gDetail"><p class="muted">Chạm một khối ở trên.</p></div>
        <div class="grid g2"><button class="outline small" data-copy="${esc(url)}">${sv('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>')} Địa chỉ web</button><button class="outline small" data-copy="${esc(code)}">${sv('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>')} Mã đồng bộ</button></div>
        <p class="muted" style="font-size:13px">Mã đồng bộ là của riêng bạn, đừng gửi cho ai.</p>
        <label>Tên phím tắt của bạn<input id="scName2" value="${esc(stepShortcutName())}" autocapitalize="off"></label>` },
    { t: "Cho phép đọc Sức khỏe", short: "Allow Health",
      art: `<div class="g-phone"><div class="g-screen g-dim"><div class="g-alert"><b>“${esc(stepShortcutName())}” muốn truy cập dữ liệu Sức khỏe</b><span>Bước</span><button class="g-allow" id="gAllow">Cho phép</button><button class="g-deny" tabindex="-1">Không cho phép</button></div></div></div>`,
      body: `<p>Bấm ▶ để chạy phím tắt lần đầu. iPhone sẽ hỏi quyền: chọn <b>Cho phép</b> cho <b>Bước</b>.</p>
        <p class="muted">Lỡ bấm từ chối? Vào <b>Sức khỏe</b> › ảnh đại diện › <b>Ứng dụng</b> › <b>Phím tắt</b> và bật lại Bước.</p>` },
    { t: "Tự động mỗi ngày", short: "Automation",
      art: `<div class="g-clocks"><div class="g-clock"><span class="hand h12"></span><b>12:00</b></div><div class="g-clock"><span class="hand h20"></span><b>20:00</b></div></div>`,
      body: `<p>Trong <b>Phím tắt</b>, mở tab <b>Tự động hóa</b> › <b>+</b> › <b>Thời gian trong ngày</b>.</p>
        <p>Chọn <b>12:00</b>, <b>Hằng ngày</b>, <b>Chạy ngay lập tức</b>, rồi chọn phím tắt vừa tạo. Làm thêm một cái lúc <b>20:00</b>.</p>
        <p class="muted">Thế là số bước tự về, bạn không cần làm gì nữa.</p>` },
    { t: "Thử ngay", short: "Test",
      art: `<div class="g-result ${lastSync ? "ok" : ""}"><span class="g-res-ic">${sv(lastSync ? '<path d="M5 12l5 5 9-10"/>' : '<path d="M12 3v12M7 10l5 5 5-5M5 20h14"/>')}</span><b>${lastSync ? "Đã kết nối!" : "Chưa có dữ liệu"}</b><span>${lastSync ? `Lần cuối: ${new Date(lastSync).toLocaleString("vi-VN", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}` : "Bấm nút dưới để chạy thử"}</span></div>`,
      body: `<p>Bấm <b>Đồng bộ ngay</b>. iPhone mở Phím tắt, chạy xong thì bấm <b>◀ Snack &amp; Burn</b> ở góc trên bên trái để quay lại.</p>
        <button class="primary block" id="gRun">${sv('<path d="M7 4v16l13-8z"/>')} Đồng bộ ngay</button>
        <a class="btn outline block" href="#home">Xem số bước ở Home</a>` },
  ];
  const done = new Set(watchDone());
  const i = Math.max(0, Math.min(STEPS.length - 1, watchStep)), S = STEPS[i];
  app.innerHTML = `
    <div class="row"><a class="icon-btn" href="#profile" aria-label="Back">${sv('<path d="M15 6l-6 6 6 6"/>')}</a><h1 style="flex:1;font-size:24px">Apple Watch &amp; Health</h1></div>
    <ol class="g-steps" aria-label="Steps">${STEPS.map((x, k) => `<li><button data-go="${k}" class="${k === i ? "cur" : ""} ${done.has(k) ? "done" : ""}" aria-current="${k === i ? "step" : "false"}" aria-label="Step ${k + 1}: ${x.short}">${done.has(k) && k !== i ? sv('<path d="M5 12l5 5 9-10"/>') : k + 1}</button></li>`).join("")}</ol>
    <section class="g-card" id="gCard">
      <div class="g-art">${S.art}</div>
      <div class="g-body"><p class="g-kicker">Bước ${i + 1} / ${STEPS.length}</p><h2>${S.t}</h2>${S.body}</div>
    </section>
    <div class="g-nav-btns">
      <button class="outline" id="gBack" ${i ? "" : "disabled"}>Quay lại</button>
      <button class="primary" id="gNext">${i === STEPS.length - 1 ? "Xong" : "Đã làm, tiếp"}</button>
    </div>`;
  const go = (k) => { watchStep = k; watchGuide(); window.scrollTo(0, 0); };
  $$("[data-go]").forEach((b) => (b.onclick = () => go(+b.dataset.go)));
  $("#gBack").onclick = () => go(i - 1);
  $("#gNext").onclick = () => {
    done.add(i); try { localStorage.setItem(WATCH_DONE_KEY, JSON.stringify([...done])); } catch { /* ignore */ }
    if (i === STEPS.length - 1) { toast("Xong! Số bước sẽ tự về mỗi ngày."); location.hash = "#home"; } else go(i + 1);
  };
  // swipe left/right between steps
  let x0 = null; const card = $("#gCard");
  card.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  card.addEventListener("touchend", (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 60) { if (dx < 0 && i < STEPS.length - 1) go(i + 1); if (dx > 0 && i) go(i - 1); } });
  // step-specific interactions
  const tg = $("#gToggle"); if (tg) tg.onclick = () => { const on = tg.getAttribute("aria-pressed") !== "true"; tg.setAttribute("aria-pressed", on); tg.querySelector(".switch").setAttribute("aria-pressed", on); $(".g-hint").textContent = on ? "Chuẩn rồi! Làm y vậy trong Cài đặt." : "Thử chạm công tắc"; navigator.vibrate?.(10); };
  const DETAIL = {
    1: `<b>Tìm mẫu sức khỏe</b><ul><li>Loại: <b>Bước</b></li><li>Thêm bộ lọc: <b>Ngày bắt đầu</b> là <b>Hôm nay</b></li><li>Nhóm theo: <b>Ngày</b> (để Watch và iPhone không bị cộng trùng)</li></ul>`,
    2: `<b>Tính toán thống kê</b><ul><li>Chọn <b>Tổng</b></li><li>Đầu vào: <b>Mẫu sức khỏe</b> từ khối trên</li></ul>`,
    3: `<b>Nhận nội dung của URL</b><ul><li>URL: dán <b>Địa chỉ web</b></li><li>Phương thức: <b>POST</b></li><li>Nội dung yêu cầu: <b>JSON</b></li><li>Thêm trường <span class="kbd">code</span> = dán <b>Mã đồng bộ</b></li><li>Thêm trường <span class="kbd">steps</span> (Số) = <b>Thống kê</b></li></ul>`,
  };
  $$("[data-gb]").forEach((b) => (b.onclick = () => { $$("[data-gb]").forEach((x) => x.classList.toggle("on", x === b)); $("#gDetail").innerHTML = DETAIL[b.dataset.gb]; }));
  $$("[data-copy]").forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy); toast("Đã sao chép"); }));
  const sc = $("#scName2"); if (sc) sc.onchange = (e) => { try { localStorage.setItem("snb_shortcut", e.target.value.trim()); } catch { /* ignore */ } toast("Đã lưu"); };
  const al = $("#gAllow"); if (al) al.onclick = () => { $(".g-alert").innerHTML = `<span class="g-res-ic ok">${sv('<path d="M5 12l5 5 9-10"/>')}</span><b>Đã cho phép</b><span>Phím tắt giờ đọc được số bước.</span>`; navigator.vibrate?.(10); };
  const run = $("#gRun"); if (run) run.onclick = () => { if (!isIOS()) return toast("Mở Snack & Burn trên iPhone để đồng bộ"); runStepShortcut(); };
}

// ---------- FRIENDS ----------
let friendsTab = "feed";
async function friends() {
  const inviteUrl = `${location.origin}${location.pathname}?invite=${profile.invite_code}`;
  let body = "";
  if (friendsTab === "feed") {
    const feed = await rpc("friend_feed", { p_limit: 40 }).catch(() => []);
    const ACT = { steps: "👟 Steps", run: "🏃 Run", walk: "🚶 Walk", rope: "🪢 Jump rope", cycle: "🚴 Ride", other: "💪 Workout" };
    const ago = (t) => { const m = Math.round((Date.now() - new Date(t)) / 6e4); return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
    body = feed.length ? `<div class="stack">${feed.map((a) => {
      const what = a.steps > 0 ? `${n0(a.steps)} steps` : [a.distance_km ? `${n1(a.distance_km)} km` : "", a.minutes ? `${a.minutes} min` : ""].filter(Boolean).join(" · ");
      return `<div class="card feed-item">
        <div class="row"><div class="row" style="justify-content:flex-start"><span class="avatar" style="background:${COLORS[(a.display_name || "?").charCodeAt(0) % 5]}">${initial(a.display_name)}</span>
        <div><b>${a.is_me ? "You" : esc(a.display_name)}</b><div class="muted">${ACT[a.kind] || ACT.other} · ${ago(a.started_at)} ago</div></div></div>
        <b>${n0(a.kcal)} kcal</b></div>
        ${what ? `<div class="muted">${what}</div>` : ""}
        <div class="row">
          ${a.is_me ? `<span class="muted">${a.kudos_count ? `🔥 ${a.kudos_count} kudos` : "No kudos yet"}</span>`
            : `<button class="kudos ${a.i_kudoed ? "on" : ""}" data-kudo="${a.activity_id}" aria-pressed="${a.i_kudoed}">🔥 <span>${a.kudos_count || ""}</span> Kudos</button>`}
        </div></div>`; }).join("")}</div>`
      : `<div class="card"><p>Your feed is quiet.</p><p class="muted">Add friends and log a burn. Their runs, walks and steps show up here for 7 days.</p></div>`;
  } else if (friendsTab === "friends") {
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
      <button aria-pressed="${friendsTab === "feed"}" data-t="feed">Feed</button>
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
  $$("[data-kudo]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      const on = await rpc("toggle_kudos", { p_activity: b.dataset.kudo });
      const c = b.querySelector("span"); const n = (+c.textContent || 0) + (on ? 1 : -1);
      c.textContent = n || ""; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
      if (on) { navigator.vibrate?.(15); sb.functions.invoke("send-reminders", { body: { kudos: b.dataset.kudo } }).catch(() => {}); }
    } catch (err) { fail(err); }
    b.disabled = false;
  }));
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
const ICON = {
  body: '<path d="M12 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 21l1.5-7L7 9h10l-2.5 5L16 21"/>',
  steps: '<path d="M7 15c-1.5 0-2.5-1.5-2.5-4S5.5 5 7.5 5 10 7 10 9.5 9 15 7 15zM5 18h4M17 19c-2 0-3-5.5-3-8S15 5 16.5 5 19.5 6.5 19.5 9s-1 4-2.5 4M15 22h4"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5s1.2 1.5 3.5 1.5 3.5-1.5 3.5-1.5M9 9.5h.01M15 9.5h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  watch: '<rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 6l1-3h4l1 3M9 18l1 3h4l1-3M12 10v2l1.5 1"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
};
const ic = (k, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

// generic bottom sheet: returns the sheet element; close() removes it
function openSheet(title, html) {
  const wrap = document.createElement("div");
  wrap.className = "sheet-backdrop";
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="row"><h1 style="font-size:22px">${esc(title)}</h1><button class="icon-btn" data-close aria-label="Close">${sv('<path d="M6 6l12 12M18 6L6 18"/>')}</button></div>
    ${html}</div>`;
  document.body.appendChild(wrap);
  const prev = document.activeElement;
  const close = () => { wrap.remove(); prev?.focus?.(); };
  wrap.querySelector("[data-close]").onclick = close;
  wrap.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener("click", () => wrap.remove()));
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  wrap.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  wrap.querySelector("[data-close]").focus();
  return { el: wrap.querySelector(".sheet"), close };
}

async function profileView() {
  const [badges, tokRes] = await Promise.all([
    rpc("my_badges").catch(() => []),
    sb.from("step_tokens").select("last_sync").maybeSingle(),
  ]);
  const bd = badges[0] || { total_km: 0, challenge_wins: 0, streak: 0 };
  const lastSync = tokRes.data?.last_sync;
  const visLabel = { everyone: "Everyone", friends: "Friends only", off: "Hidden" }[profile.visibility];
  const sexLabel = profile.sex === "female" ? "F" : "M";
  const row = (id, icon, tint, title, value, extra = "") => `
    <button class="set-row" id="${id}" ${extra}>
      <span class="set-ic" style="background:${tint}">${ic(icon, "ic-sm")}</span>
      <span class="set-t">${title}</span>
      <span class="set-v">${value}</span>${ic("chev", "ic-sm set-chev")}
    </button>`;

  app.innerHTML = `
    <section class="prof-hero">
      <span class="avatar prof-av">${initial(profile.display_name)}</span>
      <div style="min-width:0">
        <h1 style="overflow-wrap:anywhere">${esc(profile.display_name)}</h1>
        <p class="muted" style="color:var(--on-hero-muted);overflow-wrap:anywhere">${esc(user.email)}${profile.is_admin ? " · Admin" : ""}</p>
      </div>
      <div class="prof-stats">
        <div><b>${bd.streak}</b><span>day streak</span></div>
        <div><b>${n1(bd.total_km)}</b><span>km run</span></div>
        <div><b>${bd.challenge_wins}</b><span>wins</span></div>
      </div>
    </section>

    <button class="budget-card" id="editBody">
      <div><span class="muted">Daily budget</span><div class="big-k">${n0(profile.budget_kcal)} <small>kcal</small></div>
        <span class="muted">${n1(profile.weight_kg)} kg · ${n0(profile.height_cm)} cm · ${profile.age} · ${sexLabel}</span></div>
      <span class="btn outline small" aria-hidden="true">Edit</span>
    </button>

    <h2 class="set-h">Tracking</h2>
    <div class="set-group">
      ${row("rowWatch", "watch", "var(--tint-ok)", "Apple Watch &amp; Health", "Guide")}
      ${row("rowSteps", "steps", "var(--tint-burn)", "Step sync", lastSync ? `<span class="ok">Connected</span>` : "Set up")}
    </div>

    <h2 class="set-h">Reminders</h2>
    <div class="set-group">
      ${row("rowNotif", "bell", "var(--tint-snack)", "Notifications", pushState())}
    </div>

    <h2 class="set-h">Privacy &amp; preferences</h2>
    <div class="set-group">
      ${row("rowNearby", "pin", "var(--tint-info)", "Show me nearby", visLabel)}
      <div class="set-row">
        <span class="set-ic" style="background:var(--tint-snack)">${ic("smile", "ic-sm")}</span>
        <span class="set-t">Serious mode<span class="muted" style="display:block;font-size:12px">${profile.serious_mode ? "No jokes, just numbers" : "Cheeky comments on"}</span></span>
        <button class="switch" id="serious" aria-label="Serious mode" aria-pressed="${profile.serious_mode}"></button>
      </div>
    </div>

    <h2 class="set-h">Account</h2>
    <div class="set-group">
      ${row("rowBadges", "star", "var(--tint-snack)", "Badges", "")}
      ${row("rowMonth", "share", "var(--tint-info)", "Monthly report", "Share")}
      ${row("rowPw", "lock", "var(--surface-2)", "Password", "Change")}
      ${row("rowTheme", "moon", "var(--tint-purple)", "Appearance", { auto: "Auto", light: "Light", dark: "Dark" }[themePref()])}
      ${row("rowInstall", "phone", "var(--tint-ok)", "Add to Home Screen", "")}
      ${profile.is_admin ? row("rowAdmin", "shield", "var(--tint-purple)", "Admin", "") : ""}
    </div>

    <button class="set-row set-out" id="out">${ic("out", "ic-sm")}<span>Sign out</span></button>
    <p class="version">Snack &amp; Burn · version ${esc(APP_VERSION)}</p>`;

  // body & budget sheet
  $("#editBody").onclick = () => {
    const s = openSheet("Body & daily budget", statsForm(profile, "Save"));
    wireStats(() => { s.close(); toast("Saved. New budget: " + n0(profile.budget_kcal) + " kcal"); route(); }, s.el);
  };

  // nearby visibility sheet
  $("#rowNearby").onclick = () => {
    const s = openSheet("Who can see me nearby", `
      <p class="muted">People within about 2 km. Only your rough area is used, never your exact spot.</p>
      <div class="set-group">${[["everyone", "Everyone", "Anyone using Snack & Burn nearby"], ["friends", "Friends only", "Only people you’ve added"], ["off", "Hidden", "Nobody sees you nearby"]]
        .map(([v, t, d]) => `<button class="set-row" data-vis="${v}" role="radio" aria-checked="${profile.visibility === v}"><span class="set-t">${t}<span class="muted" style="display:block;font-size:12px">${d}</span></span>${profile.visibility === v ? `<span class="ok">${sv('<path d="M5 12l5 5 9-10"/>')}</span>` : ""}</button>`).join("")}</div>`);
    s.el.querySelectorAll("[data-vis]").forEach((b) => (b.onclick = async () => {
      const { error } = await sb.from("profiles").update({ visibility: b.dataset.vis }).eq("id", user.id);
      if (error) return fail(error);
      profile.visibility = b.dataset.vis; s.close(); route();
    }));
  };

  // password sheet
  const openPw = () => {
    const s = openSheet("Password", `
      <form id="pw" class="stack">
        <label>New password<input type="password" name="pw" minlength="6" required autocomplete="new-password" placeholder="At least 6 characters"></label>
        <button class="primary block">Save password</button>
        <p class="muted">Sign in with your email and this password. No email link needed.</p>
      </form>`);
    const pw = s.el.querySelector("#pw"); pw.pw.focus();
    pw.onsubmit = async (e) => {
      e.preventDefault();
      const { error } = await sb.auth.updateUser({ password: pw.pw.value });
      if (error) return fail(error);
      s.close(); toast("Password saved");
    };
  };
  $("#rowPw").onclick = openPw;
  if (location.hash.includes("setpw=1")) { history.replaceState(null, "", "#profile"); openPw(); }

  // step sync sheet
  $("#rowWatch").onclick = () => { watchStep = 0; location.hash = "#watch"; };
  $("#rowSteps").onclick = async () => {
    let code;
    try { code = await rpc("my_step_token", { regenerate: false }); } catch (e) { return fail(e); }
    const url = `${cfg.SUPABASE_URL}/functions/v1/sync-steps`;
    const s = openSheet("Step sync", `
      <div class="card stack">
        <div class="row"><b>Status</b>${lastSync ? `<span class="ok">Connected · ${new Date(lastSync).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>` : `<span class="muted">Not set up yet</span>`}</div>
        <p class="muted">An Apple Shortcut reads today’s steps from Apple Health (incl. Apple Watch and Garmin) and sends them here. Tap <b>Sync</b> on Home to run it.</p>
        <a class="btn primary block" href="#watch" data-close-sheet>Step-by-step guide</a>
      </div>
      <div class="step"><span class="num">1</span><div>Copy your two values (keep the code private):
        <div class="grid g2" style="margin-top:8px">
          <button class="outline small" data-copy="${esc(url)}">Web address</button>
          <button class="outline small" data-copy="${esc(code)}">Sync code</button>
        </div></div></div>
      <div class="step"><span class="num">2</span><div>In <b>Shortcuts</b>, make a new shortcut.</div></div>
      <div class="step"><span class="num">3</span><div><b>Find Health Samples</b>: Type <b>Steps</b>, Start Date <b>is today</b>.</div></div>
      <div class="step"><span class="num">4</span><div><b>Calculate Statistics</b>: <b>Sum</b>.</div></div>
      <div class="step"><span class="num">5</span><div><b>Get Contents of URL</b>: the web address, Method <b>POST</b>, Body <b>JSON</b>: <span class="kbd">code</span> = sync code, <span class="kbd">steps</span> = Statistics.</div></div>
      <div class="step"><span class="num">6</span><div>Tap ▶ to test and allow Health access.</div></div>
      <label>Your shortcut’s name (used by the Sync button)<input id="scName" value="${esc(stepShortcutName())}" autocapitalize="off"></label>
      <button class="outline block danger" id="newCode">Make a new sync code</button>`);
    s.el.querySelector("#scName").onchange = (e) => { try { localStorage.setItem("snb_shortcut", e.target.value.trim()); } catch { /* ignore */ } toast("Saved"); };
    s.el.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied"); }));
    s.el.querySelector("#newCode").onclick = async () => {
      if (!confirm("Make a new sync code? You’ll need to paste it into your Shortcut again.")) return;
      try { await rpc("my_step_token", { regenerate: true }); s.close(); toast("New code ready. Open Step sync to copy it."); } catch (e) { fail(e); }
    };
  };

  $("#rowInstall").onclick = () => showInstallGuide(true);
  $("#rowTheme").onclick = () => {
    const cur = themePref();
    const s = openSheet("Appearance", `<div class="set-group">${[["auto", "Auto", "Follow my iPhone (light by day, dark at night)"], ["light", "Light", "Always light"], ["dark", "Dark", "Always dark"]]
      .map(([v, t, d]) => `<button class="set-row" data-theme-pick="${v}" role="radio" aria-checked="${cur === v}"><span class="set-t">${t}<span class="muted" style="display:block;font-size:12px">${d}</span></span>${cur === v ? `<span class="ok">${sv('<path d="M5 12l5 5 9-10"/>')}</span>` : ""}</button>`).join("")}</div>`);
    s.el.insertAdjacentHTML("beforeend", `
      <div class="set-group" style="margin-top:14px">
        <div class="set-row"><span class="set-t">Holiday themes<span class="muted" style="display:block;font-size:12px">Christmas, Tết and your birthday decorations</span></span>
          <button class="switch" id="seasonOn" aria-label="Holiday themes" aria-pressed="${!seasonOff()}"></button></div>
      </div>
      <div class="set-group" style="margin-top:14px">
        <label class="bday-row"><span class="set-ic" style="background:var(--tint-purple)">${sv(SEASONS.birthday.icon)}</span>
          <span class="set-t">Your birthday<span class="muted" style="display:block;font-size:12px" id="bdayTxt">${profile.birthday ? new Date(profile.birthday + "T00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long" }) : "Add it for a little party on the day"}</span></span>
          <span class="bday-edit">${profile.birthday ? "Change" : "Add"}</span>
          <input type="date" id="bday" value="${esc(profile.birthday || "")}" max="${vnToday()}" aria-label="Your birthday"></label>
      </div>`);
    s.el.querySelectorAll("[data-theme-pick]").forEach((b) => (b.onclick = () => { applyTheme(b.dataset.themePick); s.close(); route(); }));
    s.el.querySelector("#seasonOn").onclick = (e) => { const on = e.currentTarget.getAttribute("aria-pressed") !== "true"; e.currentTarget.setAttribute("aria-pressed", on); try { localStorage.setItem("snb_season_off", on ? "" : "1"); } catch { /* ignore */ } applySeason(); };
    s.el.querySelector("#bday").onchange = async (e) => {
      const v = e.target.value || null;
      const { error } = await sb.from("profiles").update({ birthday: v }).eq("id", user.id);
      if (error) return fail(error);
      profile.birthday = v; saveProfile(); toast(v ? "Birthday saved" : "Birthday removed"); refreshSeason();
      s.el.querySelector("#bdayTxt").textContent = v ? new Date(v + "T00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long" }) : "Add it for a little party on the day";
      s.el.querySelector(".bday-edit").textContent = v ? "Change" : "Add";
    };
  };
  $("#rowBadges").onclick = () => { location.hash = "#badges"; };
  $("#rowMonth").onclick = openMonthReport;
  $("#rowNotif").onclick = () => openNotifSheet();
  const ad = $("#rowAdmin"); if (ad) ad.onclick = () => { location.hash = "#admin"; };
  $("#serious").onclick = async () => {
    const v = !profile.serious_mode;
    const { error } = await sb.from("profiles").update({ serious_mode: v }).eq("id", user.id);
    if (error) return fail(error);
    profile.serious_mode = v; route();
  };
  $("#out").onclick = async () => { if (!confirm("Sign out of Snack & Burn?")) return; try { localStorage.removeItem("snb_profile"); localStorage.removeItem("snb_home"); } catch { /* */ } await sb.auth.signOut(); location.hash = ""; };
}

// ---------- ADMIN ----------
let adminTab = "stats", adminMetric = "active";
async function admin() {
  if (!profile.is_admin) { location.hash = "#home"; return; }
  tabs.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.tab === "profile"));
  let body = "";

  if (adminTab === "stats") {
    const days = await rpc("admin_stats", { days: 14 });
    const users = await rpc("admin_users");
    const sum = (k) => days.reduce((t, d) => t + Number(d[k]), 0);
    const M = [
      { k: "active", label: "Active users", sub: "today", val: days.length ? days[days.length - 1].active : 0, fmt: n0, tint: "var(--tint-ok)", col: "var(--ok)", icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>' },
      { k: "signups", label: "New sign-ups", sub: `${users.length} users total`, val: sum("signups"), fmt: n0, tint: "var(--tint-snack)", col: "var(--snack)", icon: '<circle cx="10" cy="8" r="4"/><path d="M3 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>' },
      { k: "meals", label: "Meals logged", sub: "14 days", val: sum("meals"), fmt: n0, tint: "var(--tint-burn)", col: "var(--burn)", icon: '<path d="M14.5 4h-5L7.5 6.5H4a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1h-3.5z"/><circle cx="12" cy="13" r="3.5"/>' },
      { k: "km", label: "Km run", sub: "14 days", val: sum("km"), fmt: n1, tint: "var(--tint-info)", col: "var(--info)", icon: '<path d="M3 16l2-8 4 2 3-1 2 3 6 2a2 2 0 0 1 1 2v1H3zM3 19h18"/>' },
    ];
    const cur = M.find((m) => m.k === adminMetric) || M[0];
    const vals = days.map((d) => Number(d[cur.k]));
    const max = Math.max(1, ...vals);
    const W = 336, H = 120, gap = 4, bw = (W - gap * (days.length - 1)) / days.length;
    const dLbl = (iso) => new Date(iso + "T00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    body = `
      <div class="kpis" role="tablist" aria-label="Pick a metric">
        ${M.map((m) => `<button class="kpi ${m === cur ? "on" : ""}" role="tab" aria-selected="${m === cur}" data-metric="${m.k}" style="--kt:${m.tint};--kc:${m.col}">
          <span class="kpi-ic">${sv(m.icon)}</span><b>${m.fmt(m.val)}</b><span class="kpi-l">${m.label}</span><span class="kpi-s">${m.sub}</span></button>`).join("")}
      </div>
      <section class="card chart-card" aria-label="${cur.label}, last 14 days">
        <div class="row"><div><b>${cur.label}</b><div class="muted" style="font-size:13px">Last 14 days · total ${cur.fmt(vals.reduce((t, v) => t + v, 0))}</div></div>
          <span class="muted" style="font-size:13px">max ${cur.fmt(max)}</span></div>
        <svg viewBox="0 0 ${W} ${H + 22}" width="100%" role="img" aria-label="${cur.label} per day, ${dLbl(days[0].day)} to ${dLbl(days[days.length - 1].day)}">
          <line x1="0" x2="${W}" y1="${H}" y2="${H}" style="stroke:var(--border)" />
          ${days.map((d, i) => { const v = vals[i], x = i * (bw + gap), bh = v ? Math.max(4, (v / max) * (H - 18)) : 0, last = i === days.length - 1;
            return `<rect x="${x}" y="0" width="${bw}" height="${H}" rx="5" style="fill:var(--line)"/>
              ${v ? `<rect x="${x}" y="${H - bh}" width="${bw}" height="${bh}" rx="5" style="fill:${cur.col}" opacity="${last ? 1 : 0.8}"><title>${dLbl(d.day)}: ${cur.fmt(v)}</title></rect>
              <text x="${x + bw / 2}" y="${H - bh - 5}" font-size="10" font-weight="600" text-anchor="middle" style="fill:var(--ink)">${cur.fmt(v)}</text>` : ""}`; }).join("")}
          ${[0, 7, 13].map((i) => `<text x="${i === 0 ? 0 : i === 13 ? W : i * (bw + gap) + bw / 2}" y="${H + 16}" font-size="10" style="fill:var(--muted)" text-anchor="${i === 0 ? "start" : i === 13 ? "end" : "middle"}">${i === 13 ? "Today" : dLbl(days[i].day)}</text>`).join("")}
        </svg>
      </section>`;
  }

  if (adminTab === "users") {
    const users = await rpc("admin_users");
    body = `<p class="muted">${users.length} users</p><div class="list">${users.map((u) => `
      <div class="row" style="align-items:flex-start">
        <div style="min-width:0"><div>${esc(u.display_name)}${u.is_admin ? ` <span class="muted">· admin</span>` : ""}${u.blocked ? ` <b class="danger">· blocked</b>` : ""}</div>
          <div class="muted" style="overflow-wrap:anywhere">${esc(u.email)}</div>
          <div class="muted">Joined ${new Date(u.created_at).toLocaleDateString("en-GB")} · ${u.meals} meals · ${n1(u.km)} km</div></div>
        ${u.id === user.id ? "" : `<div class="stack" style="gap:6px">
          <button class="outline small" data-block="${u.id}" data-b="${!u.blocked}">${u.blocked ? "Unblock" : "Block"}</button>
          <button class="outline small" data-gift="${u.id}" data-name="${esc(u.display_name)}">Gift badge</button>
          <button class="outline small danger" data-delete="${u.id}" data-name="${esc(u.display_name)}">Delete</button></div>`}
      </div>`).join("")}</div>`;
  }

  if (adminTab === "dishes") body = await adminDishesBody();
  if (adminTab === "events") body = await adminEventsBody();
  if (adminTab === "themes") body = await adminThemesBody();

  if (adminTab === "ai") {
    const [{ data: rows, error }, st] = await Promise.all([
      sb.from("app_settings").select("key,value"),
      sb.functions.invoke("analyze-meal", { body: { action: "status" } }),
    ]);
    if (error) throw error;
    const cfg = Object.fromEntries(rows.map((x) => [x.key, x.value]));
    const keys = st.data?.keys || {};
    const prov = cfg.ai_provider || "gemini";
    const keyTag = (ok) => ok ? `<span class="ok">Key added</span>` : `<span class="danger">No key in Supabase</span>`;
    body = `
      <form id="ai" class="card stack">
        <b>Photo AI provider</b>
        <p class="muted">Used to read meal photos. If the chosen provider has no key, the app uses the other one.</p>
        <div class="seg" role="radiogroup" aria-label="AI provider">
          <button type="button" role="radio" aria-pressed="${prov === "gemini"}" aria-checked="${prov === "gemini"}" data-prov="gemini">Gemini</button>
          <button type="button" role="radio" aria-pressed="${prov === "claude"}" aria-checked="${prov === "claude"}" data-prov="claude">Claude</button>
        </div>
        <input type="hidden" name="provider" value="${esc(prov)}">
        <label>Gemini model · ${keyTag(keys.gemini)}<input name="gemini" value="${esc(cfg.ai_model_gemini || "")}" autocapitalize="off" spellcheck="false"></label>
        <label>Claude model · ${keyTag(keys.claude)}<input name="claude" value="${esc(cfg.ai_model_claude || "")}" autocapitalize="off" spellcheck="false"></label>
        <button class="primary block">Save AI settings</button>
        <p class="muted">Keys are added in Supabase → Edge Functions → Secrets as GEMINI_API_KEY and ANTHROPIC_API_KEY.</p>
      </form>`;
  }

  app.innerHTML = `
    <div class="row"><h1>Admin</h1><a class="btn outline small" href="#profile">Done</a></div>
    <div class="seg admin-tabs" role="group" aria-label="Admin section">
      ${[["stats", "Stats"], ["users", "Users"], ["dishes", "Dishes"], ["events", "Events"], ["themes", "Themes"], ["ai", "AI"]].map(([k, t]) => `<button aria-pressed="${adminTab === k}" data-at="${k}">${t}</button>`).join("")}
    </div>
    ${body}`;

  $$("[data-at]").forEach((b) => (b.onclick = () => { adminTab = b.dataset.at; route(); }));
  $(".admin-tabs [aria-pressed=\"true\"]")?.scrollIntoView({ inline: "center", block: "nearest" });
  $$("[data-metric]").forEach((b) => (b.onclick = () => { adminMetric = b.dataset.metric; const y = scrollY; route().then(() => scrollTo(0, y)); }));
  const ai = $("#ai");
  if (ai) {
    $$("[data-prov]").forEach((b) => (b.onclick = () => {
      ai.provider.value = b.dataset.prov;
      $$("[data-prov]").forEach((x) => { const on = x === b; x.setAttribute("aria-pressed", on); x.setAttribute("aria-checked", on); });
    }));
    ai.onsubmit = async (e) => {
      e.preventDefault();
      const now = new Date().toISOString();
      const { error } = await sb.from("app_settings").upsert([
        { key: "ai_provider", value: ai.provider.value, updated_at: now },
        { key: "ai_model_gemini", value: ai.gemini.value.trim() || "gemini-flash-latest", updated_at: now },
        { key: "ai_model_claude", value: ai.claude.value.trim() || "claude-sonnet-5-5", updated_at: now },
      ]);
      if (error) return fail(error);
      toast(`Photo AI now uses ${ai.provider.value === "claude" ? "Claude" : "Gemini"}`);
    };
  }
  $$("[data-block]").forEach((b) => (b.onclick = async () => {
    try { await rpc("admin_set_blocked", { uid: b.dataset.block, b: b.dataset.b === "true" }); route(); } catch (e) { fail(e); }
  }));
  $$("[data-gift]").forEach((b) => (b.onclick = () => openGiftSheet(b.dataset.gift, b.dataset.name)));
  $$("[data-delete]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Delete ${b.dataset.name} and all their data? This cannot be undone.`)) return;
    try { await rpc("admin_delete_user", { uid: b.dataset.delete }); toast("User deleted"); route(); } catch (e) { fail(e); }
  }));
  if (adminTab === "dishes") wireAdminDishes();
  if (adminTab === "events") wireAdminEvents();
  if (adminTab === "themes") wireAdminThemes();
}

// ---------- ADMIN: DISHES ----------
let adminDishes = [];
let dishFilter = "";
const FORK = '<path d="M7 3v8a3 3 0 0 0 3 3v7M10 3v6M13 3v8a3 3 0 0 1-3 3M17 3c-1.5 2-2 4-2 7h3v11"/>';
const dishImg = (d, cls = "") => d.image_url
  ? `<img class="dish-img ${cls}" src="${esc(d.image_url)}" alt="${esc(d.name)}" loading="lazy">`
  : `<span class="dish-img ph ${cls}" aria-hidden="true">${sv(FORK)}</span>`;
async function adminDishesBody() {
  const { data, error } = await sb.from("dishes").select("*").order("name");
  if (error) throw error;
  adminDishes = data;
  const missing = data.filter((d) => !d.image_url).length;
  const q = dishFilter.toLowerCase();
  const shown = data.filter((d) => !q || d.name.toLowerCase().includes(q));
  return `
    <div class="row" style="gap:8px">
      <input id="dishSearch" type="search" placeholder="Search dishes" value="${esc(dishFilter)}" aria-label="Search dishes" style="flex:1">
      <button class="primary small" id="addDish">+ Add</button>
    </div>
    <div class="row"><span class="muted">${data.length} dishes · ${data.length - missing} with photos</span>
      ${missing ? `<button class="outline small" id="genMissing">${sv('<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>')}<span>Photos for ${missing}</span></button>` : ""}</div>
    <div class="dish-grid">${shown.map((d) => `
      <button class="dish-card${d.active ? "" : " off"}" data-dish="${d.id}" aria-label="Edit ${esc(d.name)}">
        ${dishImg(d)}
        ${d.active ? "" : `<span class="dish-hidden">Hidden</span>`}
        <span class="dish-body"><b>${esc(d.name)}</b><span class="dish-desc">${esc(d.description || "")}</span>
        <span class="kcal-pill">${n0(d.kcal)} kcal</span></span>
      </button>`).join("")}</div>
    ${shown.length ? "" : `<p class="muted center">No dish matches “${esc(dishFilter)}”.</p>`}`;
}
async function genDishImage(id) {
  const { data, error } = await sb.functions.invoke("dish-image", { body: { dish_id: id } });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch { /* */ } throw new Error(/429|quota/i.test(m) ? "Google’s free plan doesn’t include image AI. Turn on billing (or redeem the free credits) in Google AI Studio, then try again." : m); }
  if (data.error) throw new Error(/429|quota/i.test(data.error) ? "Google’s free plan doesn’t include image AI. Turn on billing (or redeem the free credits) in Google AI Studio, then try again." : data.error);
  return data.image_url;
}
function dishForm(d = {}) {
  return `
    <div class="dish-hero" id="dHero">${d.id ? dishImg(d, "big") : `<span class="dish-img ph big" aria-hidden="true">${sv(FORK)}</span>`}</div>
    <label>Name<input id="dName" maxlength="80" value="${esc(d.name || "")}" placeholder="Bún mắm" required></label>
    <label>Description <span class="muted">(helps AI draw it right)</span><textarea id="dDesc" rows="2" maxlength="200" placeholder="Fermented fish noodle soup with seafood, eggplant and herbs">${esc(d.description || "")}</textarea></label>
    <label>kcal (medium portion)
      <div class="stepper"><button type="button" class="step-btn" data-k="-10" aria-label="Minus 10">${sv('<path d="M5 12h14"/>')}</button>
      <input id="dKcal" type="number" inputmode="numeric" min="0" value="${d.kcal ?? ""}" placeholder="450" aria-label="kcal">
      <button type="button" class="step-btn" data-k="10" aria-label="Plus 10">${sv('<path d="M12 5v14M5 12h14"/>')}</button></div></label>`;
}
function wireDishForm(el) {
  el.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { const k = el.querySelector("#dKcal"); k.value = Math.max(0, (+k.value || 0) + +b.dataset.k); }));
}
async function paintPhoto(el, id) {
  const hero = el.querySelector("#dHero");
  hero.innerHTML = `<span class="dish-img ph big drawing" aria-hidden="true">${sv('<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/>')}</span><span class="muted center">AI is plating your dish… about 10–20 s</span>`;
  try { const url = await genDishImage(id); hero.innerHTML = `<img class="dish-img big" src="${esc(url)}" alt="">`; return true; }
  catch (e) { hero.innerHTML = `<span class="dish-img ph big">${sv(FORK)}</span><span class="danger center" style="font-size:13px">${esc(e.message.slice(0, 160))}</span>`; return false; }
}
function wireAdminDishes() {
  const sx = $("#dishSearch");
  sx.oninput = () => { dishFilter = sx.value; clearTimeout(sx.t); sx.t = setTimeout(() => route().then(() => { const n = $("#dishSearch"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }), 250); };
  $("#addDish").onclick = () => {
    const s = openSheet("Add a dish", dishForm() + `
      <label class="row" style="flex-direction:row;color:var(--ink);font-size:15px;justify-content:flex-start;gap:10px"><input type="checkbox" id="dAi" checked style="width:22px;min-height:22px"> Create a photo with AI (same style as the menu)</label>
      <button class="primary block" id="dSave">Add dish</button>`);
    wireDishForm(s.el);
    s.el.querySelector("#dName").focus();
    s.el.querySelector("#dSave").onclick = async (ev) => {
      const name = s.el.querySelector("#dName").value.trim(), kcal = +s.el.querySelector("#dKcal").value;
      if (!name || !(kcal > 0)) return toast("Add a name and kcal");
      ev.target.disabled = true;
      const { data, error } = await sb.from("dishes").insert({ name, kcal, description: s.el.querySelector("#dDesc").value.trim() || null }).select().single();
      if (error) { ev.target.disabled = false; return fail(error.code === "23505" ? new Error("That dish already exists") : error); }
      dishCache = null;
      if (s.el.querySelector("#dAi").checked) { ev.target.textContent = "Creating photo…"; await paintPhoto(s.el, data.id); }
      ev.target.textContent = "Done"; ev.target.disabled = false; ev.target.onclick = () => { s.close(); route(); };
      toast(`${name} added`);
    };
  };
  $$("[data-dish]").forEach((b) => (b.onclick = () => {
    const d = adminDishes.find((x) => x.id === b.dataset.dish);
    const s = openSheet("Edit dish", dishForm(d) + `
      <div class="grid g2">
        <button class="outline" id="dRegen">${d.image_url ? "New photo" : "Create photo"}</button>
        <button class="outline" id="dToggle">${d.active ? "Hide from users" : "Show to users"}</button>
      </div>
      <button class="primary block" id="dSave">Save</button>`);
    wireDishForm(s.el);
    s.el.querySelector("#dRegen").onclick = async (ev) => { ev.target.disabled = true; await paintPhoto(s.el, d.id); ev.target.disabled = false; dishCache = null; };
    s.el.querySelector("#dToggle").onclick = async () => {
      const { error } = await sb.from("dishes").update({ active: !d.active }).eq("id", d.id);
      if (error) return fail(error); dishCache = null; s.close(); route();
    };
    s.el.querySelector("#dSave").onclick = async () => {
      const { error } = await sb.from("dishes").update({ name: s.el.querySelector("#dName").value.trim(), description: s.el.querySelector("#dDesc").value.trim() || null, kcal: +s.el.querySelector("#dKcal").value, updated_at: new Date().toISOString() }).eq("id", d.id);
      if (error) return fail(error); dishCache = null; s.close(); toast("Saved"); route();
    };
  }));
  const gm = $("#genMissing");
  if (gm) gm.onclick = async () => {
    const todo = adminDishes.filter((d) => !d.image_url);
    if (!confirm(`Create AI photos for ${todo.length} dishes? This takes about ${Math.ceil(todo.length * 15 / 60)} min. Keep the app open.`)) return;
    gm.disabled = true; let ok = 0;
    for (const [i, d] of todo.entries()) {
      gm.querySelector("span").textContent = `${i + 1}/${todo.length}: ${d.name}`;
      try { await genDishImage(d.id); ok++; } catch (e) { toast(`${d.name}: ${e.message.slice(0, 90)}`); if (/quota|429|403|billing/i.test(e.message)) break; }
    }
    dishCache = null; toast(`${ok} photos created`); route();
  };
}

// ---------- ADMIN: EVENTS ----------
async function adminEventsBody() {
  const { data: evs, error } = await sb.from("challenges").select("*").eq("official", true).order("starts_at", { ascending: false });
  if (error) throw error;
  const boards = await Promise.all(evs.map((e) => rpc("challenge_leaderboard", { cid: e.id }).catch(() => [])));
  const now = Date.now();
  const fmtD = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `
    <div class="row"><span class="muted">${evs.length} official event${evs.length === 1 ? "" : "s"}</span><button class="primary small" id="newEvent">+ New event</button></div>
    ${evs.length ? evs.map((e, i) => {
      const st = new Date(e.starts_at).getTime(), en = new Date(e.ends_at).getTime();
      const status = now < st ? "Upcoming" : now > en ? "Ended" : "Live";
      const pct = Math.max(0, Math.min(100, ((now - st) / (en - st)) * 100));
      const rows = boards[i]; const lead = rows[0];
      const fmt = (v) => (e.metric === "km" ? `${n1(v)} km` : `${n0(v)} kcal`);
      const days = Math.ceil((status === "Upcoming" ? st - now : en - now) / 864e5);
      return `<article class="event-card ${status.toLowerCase()}">
        <div class="ev-top">
          <span class="ev-ic">${sv(e.metric === "km" ? '<path d="M3 16l2-8 4 2 3-1 2 3 6 2a2 2 0 0 1 1 2v1H3zM3 19h18"/>' : '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.5 2 3 0-3 0-5 1-8.5z"/>')}</span>
          <span class="ev-chip ${status.toLowerCase()}">${status === "Live" ? "● " : ""}${status}</span>
        </div>
        <h3>${esc(e.name)}</h3>
        <p class="ev-meta">${e.metric === "km" ? "Most km run" : "Most kcal burned"} · ${fmtD(e.starts_at)} – ${fmtD(e.ends_at)}${status !== "Ended" ? ` · ${days} day${days === 1 ? "" : "s"} ${status === "Upcoming" ? "to start" : "left"}` : ""}</p>
        <div class="ev-bar" role="img" aria-label="${Math.round(pct)}% of the event time has passed"><span style="width:${pct}%"></span></div>
        <div class="ev-stats">
          <div><b>${rows.length}</b><span>joined</span></div>
          <div><b>${lead ? esc(lead.display_name) : "—"}</b><span>${lead ? `leading · ${fmt(lead.score)}` : "no leader yet"}</span></div>
        </div>
        <div class="row" style="justify-content:flex-end"><button class="outline small danger" data-del-ev="${e.id}">Delete</button></div>
      </article>`;
    }).join("") : `<div class="card center stack" style="align-items:center"><span class="ev-ic big">${sv('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>')}</span><b>No events yet</b><p class="muted">Publish a city-wide challenge everyone can join.</p></div>`}`;
}
function wireAdminEvents() {
  $("#newEvent").onclick = () => {
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    const wk = new Date(Date.now() + 6 * 864e5 - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    const s = openSheet("New official event", `
      <label>Name<input id="eName" maxlength="60" placeholder="Saigon Run Week"></label>
      <div class="seg" role="radiogroup" aria-label="Event type">
        <button type="button" role="radio" aria-pressed="true" aria-checked="true" data-m="km">Most km run</button>
        <button type="button" role="radio" aria-pressed="false" aria-checked="false" data-m="kcal">Most kcal burned</button>
      </div>
      <div class="grid g2"><label>Starts<input id="eStart" type="date" value="${today}"></label><label>Ends<input id="eEnd" type="date" value="${wk}"></label></div>
      <div class="chips"><button type="button" class="chip" data-len="7">1 week</button><button type="button" class="chip" data-len="14">2 weeks</button><button type="button" class="chip" data-len="30">30 days</button></div>
      <button class="primary block" id="ePub">Publish event</button>
      <p class="muted">Every user sees it at the top of Challenges with a Join button.</p>`);
    let metric = "km";
    s.el.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { metric = b.dataset.m; s.el.querySelectorAll("[data-m]").forEach((x) => { x.setAttribute("aria-pressed", x === b); x.setAttribute("aria-checked", x === b); }); }));
    s.el.querySelectorAll("[data-len]").forEach((b) => (b.onclick = () => {
      const st = new Date(s.el.querySelector("#eStart").value || today); st.setDate(st.getDate() + +b.dataset.len - 1);
      s.el.querySelector("#eEnd").value = st.toISOString().slice(0, 10);
    }));
    s.el.querySelector("#ePub").onclick = async () => {
      const name = s.el.querySelector("#eName").value.trim();
      const starts = new Date(s.el.querySelector("#eStart").value + "T00:00"), ends = new Date(s.el.querySelector("#eEnd").value + "T23:59");
      if (!name) return toast("Give the event a name");
      if (ends <= starts) return toast("End date must be after start");
      try { await rpc("create_official_challenge", { p_name: name, p_metric: metric, p_starts: starts.toISOString(), p_ends: ends.toISOString() }); s.close(); toast("Event published"); route(); }
      catch (e) { fail(e); }
    };
  };
  $$("[data-del-ev]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this event for everyone?")) return;
    try { await rpc("delete_official_challenge", { cid: b.dataset.delEv }); route(); } catch (e) { fail(e); }
  }));
}

// ---------- THEME ----------
function themePref() { try { return localStorage.getItem("snb_theme") || "auto"; } catch { return "auto"; } }
function applyTheme(pref) {
  try { localStorage.setItem("snb_theme", pref); } catch { /* ignore */ }
  if (pref === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = pref;
  const dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#14110E" : "#FFF8EE");
}
applyTheme(themePref());
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(themePref()));



// ---------- WATER ----------
const WATER_ML = 250;
const waterGoal = () => Math.max(6, Math.min(12, Math.round((profile.weight_kg * 35) / WATER_ML)));
function waterCard(glasses) {
  const goal = waterGoal(), pct = Math.min(1, glasses / goal), C = 2 * Math.PI * 26;
  return `<section class="water-card card" aria-label="Water today">
    <div class="water-ring">
      <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" class="wr-track"/><circle cx="32" cy="32" r="26" class="wr-fill" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/></svg>
      <span class="wr-ic">${sv('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>')}</span>
    </div>
    <div style="flex:1;min-width:0"><b id="wCount">${glasses} / ${goal} glasses</b>
      <div class="muted" style="font-size:13px" id="wSub">${glasses >= goal ? "Goal reached. Nice!" : `${n0((goal - glasses) * WATER_ML)} ml to go`}</div></div>
    <button class="icon-btn" id="wMinus" aria-label="Remove a glass" ${glasses ? "" : "disabled"}>${sv('<path d="M6 12h12"/>')}</button>
    <button class="water-add" id="wAdd" aria-label="Add a glass of water">${sv('<path d="M12 5v14M5 12h14"/>')}<span>1 glass</span></button>
  </section>`;
}
function wireWater(glasses) {
  const goal = waterGoal();
  const set = (g) => {
    glasses = g; const C = 2 * Math.PI * 26;
    $(".wr-fill").setAttribute("stroke-dashoffset", C * (1 - Math.min(1, g / goal)));
    $("#wCount").textContent = `${g} / ${goal} glasses`;
    $("#wSub").textContent = g >= goal ? "Goal reached. Nice!" : `${n0((goal - g) * WATER_ML)} ml to go`;
    $("#wMinus").disabled = !g;
  };
  const go = async (d) => {
    const before = glasses; set(Math.max(0, glasses + d));
    if (d > 0) { navigator.vibrate?.(10); $(".water-ring").classList.remove("pop"); void $(".water-ring").offsetWidth; $(".water-ring").classList.add("pop"); if (glasses === goal) toast("Water goal done for today!"); }
    try { set(await rpc("add_water", { p_day: vnToday(), p_delta: d })); } catch (e) { set(before); fail(e); }
  };
  $("#wAdd").onclick = () => go(1);
  $("#wMinus").onclick = () => go(-1);
}

// ---------- MONTHLY REPORT (shareable card) ----------
async function monthStats(y, m) {
  const a = new Date(Date.UTC(y, m, 1) - 7 * 3600e3), z = new Date(Date.UTC(y, m + 1, 1) - 7 * 3600e3);
  const ds = (d) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
  const [ml, ac, wa] = await Promise.all([
    sb.from("meals").select("kcal,eaten_at").gte("eaten_at", a.toISOString()).lt("eaten_at", z.toISOString()),
    sb.from("activities").select("kind,distance_km,kcal,steps,started_at").gte("started_at", a.toISOString()).lt("started_at", z.toISOString()),
    sb.from("water_logs").select("day,glasses").gte("day", ds(a)).lt("day", ds(z)),
  ]);
  const nDays = new Date(y, m + 1, 0).getDate();
  const days = Array.from({ length: nDays }, () => ({ eat: 0, burn: 0, logged: false }));
  const idx = (iso) => +ds(new Date(iso)).slice(8) - 1;
  for (const x of ml.data ?? []) { const d = days[idx(x.eaten_at)]; if (d) { d.eat += x.kcal; d.logged = true; } }
  for (const x of ac.data ?? []) { const d = days[idx(x.started_at)]; if (d) d.burn += x.kcal; }
  const acts = ac.data ?? [];
  return {
    y, m, days,
    km: acts.filter((x) => x.kind === "run").reduce((t, x) => t + Number(x.distance_km || 0), 0),
    burned: acts.reduce((t, x) => t + x.kcal, 0),
    steps: acts.reduce((t, x) => t + (x.steps || 0), 0),
    meals: (ml.data ?? []).length,
    onBudget: days.filter((d) => d.logged && d.eat - d.burn <= profile.budget_kcal).length,
    logged: days.filter((d) => d.logged).length,
    water: (wa.data ?? []).reduce((t, x) => t + x.glasses, 0),
  };
}
async function drawMonthCard(st) {
  await document.fonts?.load?.('700 80px "Fredoka"').catch(() => {});
  const W = 1080, H = 1350, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#2A1A12"); g.addColorStop(.55, "#1A1A1A"); g.addColorStop(1, "#3A1610");
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  // warm glow
  const gl = c.createRadialGradient(880, 160, 0, 880, 160, 520); gl.addColorStop(0, "rgba(255,106,77,.45)"); gl.addColorStop(1, "rgba(255,106,77,0)");
  c.fillStyle = gl; c.fillRect(0, 0, W, H);
  const F = (w, s) => `${w} ${s}px Fredoka, Inter, system-ui, sans-serif`, I = (w, s) => `${w} ${s}px Inter, system-ui, sans-serif`;
  const month = new Date(st.y, st.m, 1).toLocaleDateString("vi-VN", { month: "long", year: "numeric" });
  c.fillStyle = "#FFB020"; c.font = F(700, 40); c.fillText("SNACK & BURN", 80, 130);
  c.fillStyle = "#FFF8EE"; c.font = F(700, 96); c.fillText(month.replace(/^t/, "T"), 80, 250);
  c.fillStyle = "#E8D9C2"; c.font = I(500, 40); c.fillText(`${profile.display_name} · tổng kết tháng`, 80, 316);
  // tiles
  const tiles = [
    [n1(st.km), "km đã chạy", "#FF6A4D"], [n0(st.burned), "kcal đã đốt", "#FFB020"],
    [`${st.onBudget}/${st.logged || 0}`, "ngày đúng ngân sách", "#5BD08A"], [st.steps ? n0(st.steps) : String(st.meals), st.steps ? "bước chân" : "bữa đã ghi", "#8CC2F2"],
  ];
  tiles.forEach(([v, l, col], i) => {
    const x = 80 + (i % 2) * 470, y = 380 + Math.floor(i / 2) * 270;
    c.fillStyle = "rgba(255,255,255,.07)"; c.beginPath(); c.roundRect(x, y, 440, 245, 36); c.fill();
    c.fillStyle = col; c.beginPath(); c.roundRect(x + 40, y + 44, 56, 10, 5); c.fill();
    c.fillStyle = "#FFF8EE"; c.font = F(700, v.length > 6 ? 84 : 104); c.fillText(v, x + 40, y + 160);
    c.fillStyle = "#E8D9C2"; c.font = I(500, 36); c.fillText(l, x + 40, y + 210);
  });
  // daily strip: green = on budget, red = over, faint = not logged
  const sx = 80, sy = 990, sw = W - 160, bw = sw / st.days.length;
  c.fillStyle = "#E8D9C2"; c.font = I(600, 32); c.fillText("Từng ngày trong tháng", sx, sy - 24);
  st.days.forEach((d, i) => {
    c.fillStyle = !d.logged ? "rgba(255,255,255,.12)" : d.eat - d.burn <= profile.budget_kcal ? "#5BD08A" : "#FF6A4D";
    c.beginPath(); c.roundRect(sx + i * bw + 3, sy, bw - 6, 90, 8); c.fill();
  });
  if (st.water) { c.fillStyle = "#8CC2F2"; c.font = I(600, 34); c.fillText(`${n0(st.water)} ly nước đã uống`, sx, sy + 150); }
  c.fillStyle = "rgba(255,255,255,.1)"; c.fillRect(80, 1220, W - 160, 2);
  c.fillStyle = "#FFF8EE"; c.font = F(700, 40); c.fillText("Ăn vui, đốt đều.", 80, 1290);
  c.fillStyle = "#E8D9C2"; c.font = I(500, 30); c.textAlign = "right"; c.fillText("79kaid-jpg.github.io/snack-and-burn", W - 80, 1290);
  return cv;
}
async function openMonthReport() {
  const now = new Date(Date.now() + 7 * 3600e3);
  // first 5 days of a month: show last month by default
  let y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (now.getUTCDate() <= 5) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const s = openSheet("Monthly report", `<div class="month-nav"><button class="icon-btn" id="mPrev" aria-label="Previous month">${sv('<path d="M15 6l-6 6 6 6"/>')}</button><b id="mLbl"></b><button class="icon-btn" id="mNext" aria-label="Next month">${sv('<path d="M9 6l6 6-6 6"/>')}</button></div>
    <div class="month-prev" id="mImg"><div class="skel" style="height:100%"></div></div>
    <button class="primary block" id="mShare">${sv('<path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>')} Share to Zalo / Facebook</button>`);
  let blob = null;
  const load = async () => {
    s.el.querySelector("#mLbl").textContent = new Date(y, m, 1).toLocaleDateString("vi-VN", { month: "long", year: "numeric" });
    const cur = new Date(Date.now() + 7 * 3600e3); s.el.querySelector("#mNext").disabled = y === cur.getUTCFullYear() && m === cur.getUTCMonth();
    s.el.querySelector("#mImg").innerHTML = `<div class="skel" style="height:100%"></div>`; blob = null;
    const cv = await drawMonthCard(await monthStats(y, m));
    blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    const img = new Image(); img.alt = "Monthly report card"; img.src = URL.createObjectURL(blob);
    s.el.querySelector("#mImg").replaceChildren(img);
  };
  s.el.querySelector("#mPrev").onclick = () => { m -= 1; if (m < 0) { m = 11; y -= 1; } load(); };
  s.el.querySelector("#mNext").onclick = () => { m += 1; if (m > 11) { m = 0; y += 1; } load(); };
  s.el.querySelector("#mShare").onclick = async () => {
    if (!blob) return;
    const file = new File([blob], `snack-and-burn-${y}-${m + 1}.png`, { type: "image/png" });
    const text = "Tháng này của mình trên Snack & Burn. Chơi cùng không?";
    const url = `${location.origin}${location.pathname}?invite=${profile.invite_code}`;
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], text: `${text} ${url}` }); } catch { /* cancelled */ } }
    else { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); toast("Image saved. Post it to Zalo or Facebook!"); }
  };
  load();
}

// ---------- HOLIDAY THEMES ----------
// Admins schedule periods (table seasonal_themes). Christmas / Tết apply to everyone in the period;
// "birthday" turns on birthday parties in the period, shown to each user on their own birthday.
const SEASONS = {
  christmas: { name: "Christmas", vi: "Giáng sinh", banner: "Giáng sinh vui vẻ! Ăn bánh khúc cây xong nhớ đi bộ nha.",
    icon: '<path d="M12 3l4 5.5h-2.2L17.5 13h-2.3L19 18H5l3.8-5H6.5l3.7-4.5H8z"/><path d="M12 18v3M10 21h4"/>' },
  tet: { name: "Lunar New Year", vi: "Tết", banner: "Chúc mừng năm mới! Bánh chưng nhiều kcal lắm, đi chúc Tết bằng chân nhé.",
    icon: '<path d="M12 4c2 3 2 5 0 8-2-3-2-5 0-8zM4 12c3-2 5-2 8 0-3 2-5 2-8 0zM20 12c-3-2-5-2-8 0 3 2 5 2 8 0zM12 20c-2-3-2-5 0-8 2 3 2 5 0 8z"/><circle cx="12" cy="12" r="1.5"/>' },
  birthday: { name: "Birthday", vi: "Sinh nhật", banner: null,
    icon: '<path d="M4 21h16v-7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2zM4 16c2 1.5 4 1.5 5.3 0 1.4 1.5 4 1.5 5.4 0 1.3 1.5 3.3 1.5 5.3 0M12 12V8M12 5.5c-.8-.7-.8-1.8 0-3 .8 1.2.8 2.3 0 3z"/>' },
};
const vnToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
function seasonOff() { try { return localStorage.getItem("snb_season_off") === "1"; } catch { return false; } }
function currentSeason() { try { const c = JSON.parse(localStorage.getItem("snb_season") || "null"); return c && c.day === vnToday() ? c.theme : null; } catch { return null; } }
function applySeason() {
  const t = seasonOff() ? null : currentSeason();
  const root = document.documentElement;
  if (t) root.dataset.season = t; else root.removeAttribute("data-season");
  let fx = document.getElementById("season-fx");
  if (!t) { fx?._stop?.(); fx?.remove(); return; }
  if (!fx) { fx = document.createElement("div"); fx.id = "season-fx"; fx.setAttribute("aria-hidden", "true"); document.body.appendChild(fx); }
  if (fx.dataset.t !== t) { fx.dataset.t = t; startParticles(fx, t); }
}
// Falling particles on a canvas: real six-armed snowflakes with depth, hoa mai petals for Tết, confetti for birthdays.
function startParticles(fx, t) {
  fx._stop?.();
  fx.innerHTML = "";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = document.createElement("canvas"); fx.appendChild(cv);
  const ctx = cv.getContext("2d");
  const dpr = Math.min(2, devicePixelRatio || 1);
  let W = 0, H = 0;
  const size = () => { W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  size(); addEventListener("resize", size);
  const N = t === "christmas" ? 46 : 26;
  const rnd = (a, b) => a + Math.random() * (b - a);
  // on a light background pure white snow disappears: use icy blue there, white in dark mode
  const darkBg = (() => { const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g); return m ? (+m[0] + +m[1] + +m[2]) / 3 < 100 : false; })();
  const ICE = darkBg ? "255,255,255" : "150,185,225", ICE2 = darkBg ? "255,255,255" : "120,160,210";
  const CONF = ["#7B5CE0", "#E5599F", "#F2B705", "#2FB5A3", "#FF7A5E"];
  const make = (top) => {
    const z = Math.random(); // depth: 0 far … 1 near
    return { x: rnd(0, W), y: top ? rnd(-H, 0) : rnd(0, H), z, r: t === "christmas" ? 1.2 + z * (z > .7 ? 7 : 2.4) : 4 + z * 5,
      vy: .25 + z * .9, ph: rnd(0, 6.28), sw: rnd(.4, 1.2), rot: rnd(0, 6.28), vr: rnd(-.02, .02), c: CONF[(Math.random() * CONF.length) | 0], crystal: z > .7 };
  };
  const P = Array.from({ length: N }, () => make(false));
  const flake = (p) => {
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.strokeStyle = `rgba(${ICE2},.95)`; ctx.lineWidth = 1.5; ctx.lineCap = "round";
    ctx.shadowColor = darkBg ? "rgba(160,200,255,.6)" : "rgba(255,255,255,.9)"; ctx.shadowBlur = 3;
    const r = p.r;
    for (let i = 0; i < 6; i++) {
      ctx.rotate(Math.PI / 3); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -r);
      ctx.moveTo(0, -r * .55); ctx.lineTo(-r * .28, -r * .78); ctx.moveTo(0, -r * .55); ctx.lineTo(r * .28, -r * .78); ctx.stroke();
    }
    ctx.restore();
  };
  const dot = (p) => { ctx.beginPath(); ctx.fillStyle = `rgba(${ICE},${.4 + p.z * .5})`; ctx.shadowColor = darkBg ? "rgba(160,200,255,.5)" : "rgba(255,255,255,.8)"; ctx.shadowBlur = 2; ctx.arc(p.x, p.y, p.r, 0, 6.28); ctx.fill(); };
  const petal = (p) => {
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = "#F7C21B"; ctx.globalAlpha = .55 + p.z * .4;
    for (let i = 0; i < 5; i++) { ctx.rotate(1.2566); ctx.beginPath(); ctx.ellipse(0, -p.r * .6, p.r * .38, p.r * .62, 0, 0, 6.28); ctx.fill(); }
    ctx.fillStyle = "#D9480F"; ctx.beginPath(); ctx.arc(0, 0, p.r * .22, 0, 6.28); ctx.fill(); ctx.restore();
  };
  const confetti = (p) => { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(p.ph * 2)); ctx.fillStyle = p.c; ctx.globalAlpha = .85; ctx.fillRect(-p.r * .35, -p.r * .8, p.r * .7, p.r * 1.6); ctx.restore(); };
  let raf = 0, last = performance.now();
  const tick = (now) => {
    const dt = Math.min(3, (now - last) / 16.7); last = now;
    ctx.clearRect(0, 0, W, H);
    const wind = Math.sin(now / 4000) * .35;
    for (const p of P) {
      p.ph += .012 * dt * p.sw; p.rot += p.vr * dt;
      p.y += p.vy * dt * (t === "birthday" ? 1.4 : 1); p.x += (Math.sin(p.ph) * .5 * p.sw + wind * (.4 + p.z)) * dt;
      if (p.y > H + 20 || p.x < -30 || p.x > W + 30) Object.assign(p, make(true), { y: -20 });
      if (t === "christmas") (p.crystal ? flake : dot)(p); else if (t === "tet") petal(p); else confetti(p);
    }
    raf = requestAnimationFrame(tick);
  };
  const vis = () => { cancelAnimationFrame(raf); if (!document.hidden) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  document.addEventListener("visibilitychange", vis); vis();
  fx._stop = () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", vis); removeEventListener("resize", size); };
}
async function refreshSeason() {
  const day = vnToday();
  const { data } = await sb.from("seasonal_themes").select("theme").lte("starts_on", day).gte("ends_on", day);
  const on = new Set((data ?? []).map((r) => r.theme));
  const bday = profile?.birthday && profile.birthday.slice(5) === day.slice(5);
  const theme = on.has("birthday") && bday ? "birthday" : on.has("tet") ? "tet" : on.has("christmas") ? "christmas" : null;
  const before = currentSeason();
  try { localStorage.setItem("snb_season", JSON.stringify({ day, theme })); } catch { /* ignore */ }
  applySeason();
  if (before !== theme) route();
}
function seasonBanner() {
  const t = seasonOff() ? null : currentSeason();
  if (!t) return "";
  const S = SEASONS[t];
  const text = t === "birthday" ? `Chúc mừng sinh nhật, ${esc(profile.display_name)}! Hôm nay ăn bánh kem thoải mái, mai mình đốt sau.` : S.banner;
  return `<div class="season-banner" role="note"><span class="sb-ic">${sv(S.icon)}</span><span>${text}</span></div>`;
}
applySeason();

async function adminThemesBody() {
  const { data, error } = await sb.from("seasonal_themes").select("*").order("starts_on", { ascending: false });
  if (error) throw error;
  const day = vnToday();
  const fmtD = (d) => new Date(d + "T00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const forever = (r) => r.ends_on >= "2099-01-01";
  const span = (r) => forever(r) ? `From ${fmtD(r.starts_on)} · until turned off` : `${fmtD(r.starts_on)} – ${fmtD(r.ends_on)}`;
  const live = (k) => data.find((r) => r.theme === k && r.starts_on <= day && r.ends_on >= day);
  return `
    <p class="muted">Turn a look on now, or schedule dates and it switches on and off by itself (Vietnam time).</p>
    <div class="stack" style="gap:10px">${Object.entries(SEASONS).map(([k, S]) => { const L = live(k); return `
      <div class="card theme-card tp-${k}">
        <div class="row" style="gap:12px">
          <span class="sb-ic">${sv(S.icon)}</span>
          <div style="flex:1;min-width:0"><b>${S.name}</b><div class="muted" style="font-size:13px">${L ? `<span class="live-dot"></span>On · ${forever(L) ? "until you turn it off" : `until ${fmtD(L.ends_on)}`}` : k === "birthday" ? "Each user, on their own birthday" : "Everyone in the app"}</div></div>
          <button class="switch" data-toggle-theme="${k}" aria-pressed="${!!L}" aria-label="${S.name} on now"></button>
        </div>
        <button class="link-btn" data-new-theme="${k}">${sv('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>')} Schedule dates</button>
      </div>`; }).join("")}</div>
    ${data.length ? `<h3 style="margin-top:8px">Schedule</h3><div class="list">${data.map((r) => {
      const st = day < r.starts_on ? "Upcoming" : day > r.ends_on ? "Ended" : "Live";
      return `<div class="row"><div class="row" style="justify-content:flex-start;gap:12px;min-width:0"><span class="sb-ic sm tp-${r.theme}">${sv(SEASONS[r.theme].icon)}</span>
        <div style="min-width:0"><b>${SEASONS[r.theme].name}</b> <span class="ev-chip ${st.toLowerCase()}">${st}</span><div class="muted" style="font-size:13px">${span(r)}</div></div></div>
        <button class="icon-btn" data-del-theme="${r.id}" aria-label="Delete ${SEASONS[r.theme].name} period">${sv('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>')}</button></div>`;
    }).join("")}</div>` : ""}`;
}
function wireAdminThemes() {
  const day = vnToday(), year = +day.slice(0, 4);
  const addDays = (d, n) => { const x = new Date(d + "T00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const DEFAULTS = { christmas: [`${year}-12-15`, `${year}-12-26`], tet: ["2027-02-01", "2027-02-14"], birthday: [day, `${year}-12-31`] };
  const nice = (d) => d ? new Date(d + "T00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "Pick a date";
  $$("[data-toggle-theme]").forEach((b) => (b.onclick = async () => {
    const k = b.dataset.toggleTheme, on = b.getAttribute("aria-pressed") !== "true";
    b.disabled = true;
    let error;
    if (on) ({ error } = await sb.from("seasonal_themes").insert({ theme: k, starts_on: day, ends_on: "2099-12-31" }));
    else {
      // end every live period: one that started today is deleted, an older one ends yesterday
      ({ error } = await sb.from("seasonal_themes").delete().eq("theme", k).eq("starts_on", day));
      if (!error) ({ error } = await sb.from("seasonal_themes").update({ ends_on: addDays(day, -1) }).eq("theme", k).lt("starts_on", day).gte("ends_on", day));
    }
    if (error) { b.disabled = false; return fail(error); }
    toast(`${SEASONS[k].name} ${on ? "is on" : "is off"}`); refreshSeason(); route();
  }));
  $$("[data-new-theme]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.newTheme, [d1, d2] = DEFAULTS[k];
    const s = openSheet(`Schedule ${SEASONS[k].name}`, `
      <div class="date-range">
        <label class="date-field"><span>From</span><b data-show="a"></b><input type="date" id="tStart" value="${d1}"></label>
        <span class="date-arrow" aria-hidden="true">${sv('<path d="M5 12h14M13 6l6 6-6 6"/>')}</span>
        <label class="date-field"><span>To</span><b data-show="z"></b><input type="date" id="tEnd" value="${d2}"></label>
      </div>
      <div class="chips">
        <button type="button" class="chip" data-len="3">3 days</button><button type="button" class="chip" data-len="7">1 week</button><button type="button" class="chip" data-len="14">2 weeks</button><button type="button" class="chip" data-len="30">1 month</button>
      </div>
      <p class="muted" id="tInfo"></p>
      <button class="primary block" id="tSave">Schedule</button>`);
    const A = s.el.querySelector("#tStart"), Z = s.el.querySelector("#tEnd");
    const sync = () => {
      s.el.querySelector('[data-show="a"]').textContent = nice(A.value);
      s.el.querySelector('[data-show="z"]').textContent = nice(Z.value);
      const n = A.value && Z.value ? Math.round((new Date(Z.value) - new Date(A.value)) / 864e5) + 1 : 0;
      s.el.querySelector("#tInfo").textContent = n > 0 ? `${n} day${n === 1 ? "" : "s"}. ${k === "tet" ? "Tết moves every year: check the lunar calendar." : k === "birthday" ? "Anyone with a birthday in these dates gets the party look on their day." : "Everyone sees the Christmas look."}` : "End date must be on or after the start.";
    };
    A.onchange = () => { if (Z.value < A.value) Z.value = A.value; sync(); }; Z.onchange = sync; sync();
    s.el.querySelectorAll("[data-len]").forEach((c) => (c.onclick = () => { Z.value = addDays(A.value || day, +c.dataset.len - 1); sync(); }));
    s.el.querySelector("#tSave").onclick = async () => {
      if (!A.value || !Z.value || Z.value < A.value) return toast("End date must be on or after the start");
      const { error } = await sb.from("seasonal_themes").insert({ theme: k, starts_on: A.value, ends_on: Z.value });
      if (error) return fail(error);
      s.close(); toast(`${SEASONS[k].name} scheduled`); refreshSeason(); route();
    };
  }));
  $$("[data-del-theme]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this holiday period?")) return;
    const { error } = await sb.from("seasonal_themes").delete().eq("id", b.dataset.delTheme);
    if (error) return fail(error);
    refreshSeason(); route();
  }));
}

// ---------- SHOW / HIDE PASSWORD ----------
// Adds an eye button to every password field (sign-in, create account, change password).
const EYE = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>';
function addPasswordToggles(root) {
  root.querySelectorAll('input[type="password"]:not([data-eye])').forEach((inp) => {
    inp.dataset.eye = "1";
    const wrap = document.createElement("span");
    wrap.className = "pw-wrap";
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-eye";
    btn.setAttribute("aria-label", "Show password");
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = sv(EYE);
    btn.onclick = () => {
      const show = inp.type === "password";
      const pos = inp.selectionStart;
      inp.type = show ? "text" : "password";
      btn.innerHTML = sv(show ? EYE_OFF : EYE);
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      btn.setAttribute("aria-pressed", String(show));
      inp.focus(); try { inp.setSelectionRange(pos, pos); } catch { /* ignore */ }
    };
    wrap.appendChild(btn);
  });
}
new MutationObserver(() => addPasswordToggles(document.body)).observe(document.body, { childList: true, subtree: true });

// ---------- PWA ----------
let APP_VERSION = "dev";
let swReg = null;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").then((r) => (swReg = r)).catch(() => {});

// ---------- AUTO UPDATE ----------
// Each deploy writes version.json. The app checks it on open, on return to the app, and every 30 min.
async function fetchVersion() {
  try { const r = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" }); return r.ok ? (await r.json()).version : null; } catch { return null; }
}
async function checkForUpdate() {
  const latest = await fetchVersion();
  if (!latest || APP_VERSION === "dev" || latest === APP_VERSION) return;
  const busy = location.hash.startsWith("#snap") && snapState && snapState.step !== "camera";
  if (!busy && document.visibilityState === "visible" && !sessionStorage.getItem("snb_updated_" + latest)) {
    sessionStorage.setItem("snb_updated_" + latest, "1");
    return applyUpdate();
  }
  const bar = document.getElementById("update");
  bar.innerHTML = `<span>New version ready</span><button id="doUpdate">Update</button>`;
  bar.hidden = false;
  document.getElementById("doUpdate").onclick = applyUpdate;
}
async function applyUpdate() {
  try { await swReg?.update(); const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch { /* ignore */ }
  location.reload();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
setInterval(checkForUpdate, 30 * 60 * 1000);

// ---------- ADD TO HOME SCREEN ----------
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isIOSSafari = () => isIOS() && !/crios|fxios|edgios|opios/i.test(navigator.userAgent);
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; });

const SHARE_IC = '<svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
const PLUS_IC = '<svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';

function showInstallGuide(force) {
  if (isStandalone()) { if (force) toast("Already on your Home Screen"); return; }
  if (!force && localStorage.getItem("snb_install_dismissed")) return;
  let steps;
  if (isIOS() && !isIOSSafari()) {
    steps = `<div class="step"><span class="num">1</span><div>Copy this page’s link and open it in <b>Safari</b>. iPhone only installs apps from Safari.</div></div>
      <button class="primary block" id="copyLink">Copy link</button>`;
  } else if (isIOS()) {
    steps = `<div class="step"><span class="num">1</span><div>Tap <span class="kbd">${SHARE_IC} Share</span> at the bottom of Safari</div></div>
      <div class="step"><span class="num">2</span><div>Scroll and tap <span class="kbd">${PLUS_IC} Add to Home Screen</span></div></div>
      <div class="step"><span class="num">3</span><div>Tap <b>Add</b>. Snack &amp; Burn opens full-screen like a real app.</div></div>`;
  } else if (deferredPrompt) {
    steps = `<button class="primary block" id="nativeInstall">Install Snack &amp; Burn</button>`;
  } else {
    steps = `<div class="step"><span class="num">1</span><div>Open your browser menu <span class="kbd">⋮</span></div></div>
      <div class="step"><span class="num">2</span><div>Tap <b>Add to Home screen</b> or <b>Install app</b></div></div>`;
  }
  const wrap = document.createElement("div");
  wrap.className = "sheet-backdrop";
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="installTitle">
    <div class="row" style="justify-content:flex-start;gap:14px">
      <img class="app-logo" src="icon-192.png" alt="">
      <div><h1 id="installTitle" style="font-size:22px">Add Snack &amp; Burn to your Home Screen</h1>
      <p class="muted">One tap to snap, full-screen, always up to date.</p></div>
    </div>
    ${steps}
    <button class="outline block" id="laterInstall">Maybe later</button>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => { localStorage.setItem("snb_install_dismissed", "1"); wrap.remove(); };
  wrap.querySelector("#laterInstall").onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  wrap.querySelector("#laterInstall").focus();
  const copy = wrap.querySelector("#copyLink");
  if (copy) copy.onclick = async () => { await navigator.clipboard.writeText(location.origin + location.pathname); toast("Link copied. Paste it in Safari."); };
  const nat = wrap.querySelector("#nativeInstall");
  if (nat) nat.onclick = async () => { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; wrap.remove(); };
}

(async () => {
  fetchVersion().then((v) => { APP_VERSION = v || "dev"; });
  await route();
  document.getElementById("splash")?.remove();
  setTimeout(() => { if (user) showInstallGuide(false); }, 1500);
})();
