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

let dishCache = null;
async function loadDishes(force) {
  if (dishCache && !force) return dishCache;
  const { data, error } = await sb.from("dishes").select("name,kcal").eq("active", true).order("name");
  dishCache = !error && data.length ? data.map((d) => [d.name, d.kcal]) : DISHES;
  return dishCache;
}

// ---------- routing ----------
const VIEWS = { home, snap, challenges, friends, profileView, admin, coach, badges: badgesView };
let snapState = null;

async function route() {
  const { data } = await sb.auth.getSession();
  user = data.session?.user ?? null;
  if (!user) { tabs.hidden = true; return login(); }
  if (!profile || profile.id !== user.id) {
    const { data: p, error } = await sb.from("profiles")
      .select("id,display_name,sex,age,height_cm,weight_kg,activity,budget_kcal,visibility,serious_mode,invite_code,onboarded,is_admin,blocked,notify_meals,notify_burn,notify_challenge")
      .eq("id", user.id).single();
    if (error) return fail(error);
    profile = p;
    await redeemInvite();
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
  app.innerHTML = `<div class="skel" style="height:36px;width:60%"></div><div class="skel" style="height:170px"></div><div class="skel" style="height:64px"></div><div class="skel" style="height:64px"></div>`;
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
    Object.assign(profile, patch);
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
  const wRes = await sb.from("weights").select("day,kg").gte("day", d60).order("day");
  const wts = wRes.data || [];
  const [meals, acts, streak, wkMeals, wkActs, chs] = await Promise.all([
    sb.from("meals").select("*").gte("eaten_at", since).order("eaten_at"),
    sb.from("activities").select("*").gte("started_at", since).order("started_at"),
    rpc("my_streak"),
    sb.from("meals").select("kcal,eaten_at").gte("eaten_at", wk0.toISOString()),
    sb.from("activities").select("kcal,distance_km,kind,started_at").gte("started_at", wk0.toISOString()),
    sb.from("challenges").select("id,name,metric,ends_at,official").gt("ends_at", new Date().toISOString()).order("ends_at").limit(5),
  ]);
  // this week, per day
  const days = [...Array(7)].map((_, i) => { const d = new Date(wk0); d.setDate(d.getDate() + i); return { d, eat: 0, burn: 0 }; });
  const dayIdx = (iso) => Math.floor((new Date(iso) - wk0) / 864e5);
  (wkMeals.data || []).forEach((m) => { const i = dayIdx(m.eaten_at); if (days[i]) days[i].eat += m.kcal; });
  (wkActs.data || []).forEach((a) => { const i = dayIdx(a.started_at); if (days[i]) days[i].burn += a.kcal; });
  const wkKm = (wkActs.data || []).filter((a) => a.kind === "run").reduce((t, a) => t + Number(a.distance_km), 0);
  const onTarget = days.filter((x) => x.eat > 0 && x.eat - x.burn <= profile.budget_kcal).length;
  // my live challenge: the first one I am in
  let myCh = null;
  for (const c of chs.data || []) {
    const rows = await rpc("challenge_leaderboard", { cid: c.id }).catch(() => []);
    const i = rows.findIndex((x) => x.user_id === user.id);
    if (i >= 0) { myCh = { c, rank: i + 1, of: rows.length, score: rows[i].score, lead: rows[0] }; break; }
  }
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
    <div class="ring-wrap">
      <div class="ring-center">
        <svg class="ring" viewBox="0 0 132 132" role="img" aria-label="Snacked ${n0(eaten)} of ${n0(budget + burned)} kcal, burned ${n0(burned)} of ${BURN_GOAL} kcal goal">
          <circle cx="66" cy="66" r="58" stroke="#3A332D"/>
          <circle cx="66" cy="66" r="58" stroke="var(--snack)" stroke-dasharray="${2 * Math.PI * 58}" stroke-dashoffset="${2 * Math.PI * 58 * (1 - Math.min(1, eaten / Math.max(1, budget + burned)))}"/>
          <circle cx="66" cy="66" r="42" stroke="#3A332D"/>
          <circle cx="66" cy="66" r="42" stroke="#FF6A4D" stroke-dasharray="${2 * Math.PI * 42}" stroke-dashoffset="${2 * Math.PI * 42 * (1 - Math.min(1, burned / BURN_GOAL))}"/>
        </svg>
        <div class="label"><b>${n0(Math.abs(left))}</b><span class="muted">${left >= 0 ? "kcal left" : "kcal over"}</span></div>
      </div>
      <div class="legend">
        <div><span class="dot" style="background:var(--snack)"></span><div><div class="muted">Snacked</div><b>${n0(eaten)}</b></div></div>
        <div><span class="dot" style="background:#FF6A4D"></span><div><div class="muted">Burned</div><b>${n0(burned)}</b> <span class="muted">/ ${BURN_GOAL}</span></div></div>
        <div><span class="dot" style="background:#E8D9C2"></span><div><div class="muted">Budget</div><b>${n0(budget)}</b></div></div>
      </div>
    </div>
  </section>
  ${left < 0 ? `<div class="card"><p><b class="danger">≈ ${n0(-left / 7.7)} g fat</b> if you don’t burn the extra ${n0(-left)} kcal.</p><p class="muted">Run ${n1(burnFor(-left).runKm)} km or walk ${n1(burnFor(-left).walkKm)} km to balance today.</p></div>` : ""}

  <div class="grid g2">
    <a class="quick" href="#snap"><span class="q-ic" style="background:var(--tint-snack)"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4h-5L7.5 6.5H4a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1h-3.5z"/><circle cx="12" cy="13" r="3.5"/></svg></span><span><b>Snap a meal</b><span class="muted">Photo → kcal</span></span></a>
    <button class="quick" id="quickBurn"><span class="q-ic" style="background:var(--tint-burn)"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.5 2 3 0-3 0-5 1-8.5z"/></svg></span><span><b>Log a burn</b><span class="muted">Run, walk…</span></span></button>
  </div>

  <a class="coach-card" href="#coach">
    <span class="coach-av" aria-hidden="true">${COACH_FACE}</span>
    <span style="min-width:0;flex:1"><b>Coach</b><span class="muted coach-tip" id="coachTip">Your weekly check-in is ready. Tap to read.</span></span>
    ${sv('<path d="M9 6l6 6-6 6"/>')}
  </a>

  <div class="row"><h2>Snacks today</h2><a class="btn outline small" href="#snap">+ Add</a></div>
  ${meals.data.length ? `<div class="list">${meals.data.map((m) => `
    <div class="row"><div><div>${esc(m.name)}</div><div class="muted">${time(m.eaten_at)}</div></div>
    <div class="row"><b>${n0(m.kcal)}</b><button class="icon-btn" data-del-meal="${m.id}" aria-label="Remove ${esc(m.name)}"><svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div></div>`).join("")}</div>`
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
    <div class="row muted" style="justify-content:flex-start;gap:14px;font-size:12px"><span><span class="dot" style="background:var(--snack);display:inline-block"></span> Eaten</span><span><span class="dot" style="background:#FF6A4D;display:inline-block"></span> Burned</span><span>— Budget</span></div>
  </section>

  ${myCh ? `<a class="card row" href="#challenges" style="text-decoration:none;color:inherit">
      <div><div class="muted">${myCh.c.official ? "Official event" : "Your challenge"} · ends in ${Math.max(0, Math.ceil((new Date(myCh.c.ends_at) - Date.now()) / 864e5))} days</div><b>${esc(myCh.c.name)}</b>
      <div class="muted">${myCh.rank === 1 ? "You’re leading!" : `${myCh.c.metric === "km" ? n1(myCh.lead.score - myCh.score) + " km" : n0(myCh.lead.score - myCh.score) + " kcal"} behind ${esc(myCh.lead.display_name)}`}</div></div>
      <span class="rank">#${myCh.rank}<small>/${myCh.of}</small></span></a>`
    : `<a class="card row" href="#challenges" style="text-decoration:none;color:inherit"><div><b>Race a friend</b><div class="muted">Start a weekly km or kcal challenge</div></div><span class="rank" style="font-size:22px">→</span></a>`}
  ${quip(["Every snack has a price. It’s paid in kilometres.", "Your shoes miss you.", "Balance is a verb. Go do it."])}`;

  $("#showLog").onclick = () => openBurnSheet();
  $("#quickBurn").onclick = () => openBurnSheet();
  $("#logWeight").onclick = () => openWeightSheet(wts);
  const ss = $("#syncSteps");
  if (ss) ss.onclick = () => runStepShortcut();
  const eb = $("#emptyBurn"); if (eb) eb.onclick = () => openBurnSheet();
  loadCoachTip();
  checkBadges();
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
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  crown: '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
};
const badgeSvg = (b, size = 30) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BADGE_IC[b.icon] || BADGE_IC.star}</svg>`;
const badgeTile = (b, i) => `<button class="badge-tile${b.earned_at ? "" : " locked"}" data-badge="${i}" aria-label="${esc(b.name)}${b.earned_at ? "" : " (locked)"}">
  <span class="badge-coin" style="background:${b.earned_at ? b.color : "#EDE9E3"}">${badgeSvg(b)}</span>
  <span class="badge-name">${esc(b.name)}</span></button>`;
function wireBadgeTiles(list, root = app) {
  root.querySelectorAll("[data-badge]").forEach((el) => (el.onclick = () => {
    const b = list[+el.dataset.badge];
    openSheet(b.name, `<div class="center stack" style="align-items:center">
      <span class="badge-coin big" style="background:${b.earned_at ? b.color : "#EDE9E3"}">${badgeSvg(b, 56)}</span>
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
    <div class="row"><h1>Badges</h1><span class="badge">${got} / ${list.filter((b) => b.kind === "auto").length}</span></div>
    <p class="muted">Earn them by logging, moving and racing friends. Some are special gifts from the team.</p>
    <div class="badge-grid">${list.map(badgeTile).join("")}</div>`;
  wireBadgeTiles(list);
}
// Award new badges, then celebrate any unseen ones (one sheet each)
let badgeCheckBusy = false;
async function checkBadges() {
  if (badgeCheckBusy) return; badgeCheckBusy = true;
  try {
    await rpc("award_badges");
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
async function loadCoachTip() {
  try {
    const { data } = await sb.functions.invoke("coach", { body: { mode: "weekly" } });
    const tip = (data?.report || "").split("\n").find((l) => /^Mẹo hôm nay/i.test(l.trim())) || (data?.report || "").split("\n")[0];
    const el = document.getElementById("coachTip");
    if (el && tip) el.textContent = tip.trim();
  } catch { /* keep default text */ }
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
        <span class="muted" style="color:#E8D9C2">Shoot from above, in good light</span>
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
      <form id="add" class="card stack">
        <label>Add a dish<input name="name" list="dishes" placeholder="e.g. Phở bò" autocomplete="off"></label>
        <datalist id="dishes">${(await loadDishes()).map(([d]) => `<option value="${esc(d)}">`).join("")}</datalist>
        <div class="row"><label style="flex:1">kcal (medium portion)<input name="kcal" type="number" inputmode="numeric" min="0"></label><button class="outline small" style="align-self:flex-end">Add</button></div>
      </form>
      <div class="row"><span>Meal total</span><b>${n0(total)} kcal</b></div>
      <p class="muted">AI estimate, ±20%${s.provider ? ` · read by ${s.provider === "claude" ? "Claude" : "Gemini"}` : ""}</p>
      <button class="primary block" id="calc" ${s.items.length ? "" : "disabled"}>Calculate my burn</button>
      <button class="outline block" id="retake">Start over</button>`;
    $$("[data-z]").forEach((b) => (b.onclick = () => { s.items[b.dataset.i].size = b.dataset.z; route(); }));
    $$("[data-rm]").forEach((b) => (b.onclick = () => { s.items.splice(+b.dataset.rm, 1); route(); }));
    const add = $("#add");
    const dl = await loadDishes();
    add.name.oninput = () => { const hit = dl.find(([d]) => d === add.name.value); if (hit) add.kcal.value = hit[1]; };
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
    toast(`AI couldn’t read that (${msg.slice(0, 80)}). Add dishes by hand.`);
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
  const shown = list.filter((c) => c.metric === challengeMetric).sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0));
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
        <span class="muted">${c.official ? "Official event" : (new Date(c.ends_at) - new Date(c.starts_at)) / 864e5 === 7 ? "Weekly" : "Custom"} · ${ended ? "finished" : `ends in ${daysLeft(c)} day${daysLeft(c) === 1 ? "" : "s"}`}</span>
        <span class="display" style="font-size:24px;font-weight:500">${esc(c.name)}</span>
        <span class="muted">${meIdx >= 0 ? `You’re #${meIdx + 1}. ` : ""}${gap}${meIdx < 0 ? `${rows.length} taking part.` : ""}</span>
        ${meIdx < 0 && c.official && !ended ? `<button class="primary" style="margin-top:8px" data-join="${c.id}">Join event</button>` : ""}
      </section>
      <div class="list">${rows.slice(0, 10).map((r, j) => `
        <div class="row" style="${r.user_id === user.id ? "font-weight:700" : ""}">
          <div class="row" style="justify-content:flex-start"><span class="display" style="width:24px;color:var(--muted)">${j + 1}</span><span class="avatar" style="background:${COLORS[j % 5]}">${initial(r.display_name)}</span>${r.user_id === user.id ? "You" : esc(r.display_name)}</div>
          <b>${fmt(r.score)} ${unit}</b></div>`).join("")}</div>`;
    }).join("") : `<div class="card"><p>No ${challengeMetric === "km" ? "km" : "kcal"} challenges yet.</p><p class="muted">Tap + New and pick some friends.</p></div>`}

    <div class="row"><h2>Your badges</h2><a class="btn outline small" href="#badges">See all</a></div>
    <div class="badge-grid" id="chBadges"><div class="skel" style="height:96px;grid-column:1/-1"></div></div>`;
  rpc("my_badge_list").then((list) => { const el = $("#chBadges"); if (el) el.innerHTML = list.slice(0, 8).map(badgeTile).join(""); wireBadgeTiles(list); }).catch(() => {});

  $$("[data-m]").forEach((b) => (b.onclick = () => { challengeMetric = b.dataset.m; route(); }));
  $$("[data-join]").forEach((b) => (b.onclick = async () => {
    try { await rpc("join_challenge", { cid: b.dataset.join }); toast("You're in! Go get it."); route(); } catch (e) { fail(e); }
  }));
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
        <p class="muted" style="color:#E8D9C2;overflow-wrap:anywhere">${esc(user.email)}${profile.is_admin ? " · Admin" : ""}</p>
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
      ${row("rowSteps", "steps", "var(--tint-burn)", "Step sync", lastSync ? `<span class="ok">Connected</span>` : "Set up")}
    </div>

    <h2 class="set-h">Reminders</h2>
    <div class="set-group">
      ${row("rowNotif", "bell", "#FFF1D2", "Notifications", pushState())}
    </div>

    <h2 class="set-h">Privacy &amp; preferences</h2>
    <div class="set-group">
      ${row("rowNearby", "pin", "#E7F1FB", "Show me nearby", visLabel)}
      <div class="set-row">
        <span class="set-ic" style="background:var(--tint-snack)">${ic("smile", "ic-sm")}</span>
        <span class="set-t">Serious mode<span class="muted" style="display:block;font-size:12px">${profile.serious_mode ? "No jokes, just numbers" : "Cheeky comments on"}</span></span>
        <button class="switch" id="serious" aria-label="Serious mode" aria-pressed="${profile.serious_mode}"></button>
      </div>
    </div>

    <h2 class="set-h">Account</h2>
    <div class="set-group">
      ${row("rowBadges", "star", "#FFF1D2", "Badges", "")}
      ${row("rowPw", "lock", "#EDE9E3", "Password", "Change")}
      ${row("rowInstall", "phone", "var(--tint-ok)", "Add to Home Screen", "")}
      ${profile.is_admin ? row("rowAdmin", "shield", "#EFEDFF", "Admin", "") : ""}
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
  $("#rowSteps").onclick = async () => {
    let code;
    try { code = await rpc("my_step_token", { regenerate: false }); } catch (e) { return fail(e); }
    const url = `${cfg.SUPABASE_URL}/functions/v1/sync-steps`;
    const s = openSheet("Step sync", `
      <div class="card stack">
        <div class="row"><b>Status</b>${lastSync ? `<span class="ok">Connected · ${new Date(lastSync).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>` : `<span class="muted">Not set up yet</span>`}</div>
        <p class="muted">An Apple Shortcut reads today’s steps from Apple Health (incl. Apple Watch and Garmin) and sends them here. Tap <b>Sync</b> on Home to run it.</p>
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
  $("#rowBadges").onclick = () => { location.hash = "#badges"; };
  $("#rowNotif").onclick = () => openNotifSheet();
  const ad = $("#rowAdmin"); if (ad) ad.onclick = () => { location.hash = "#admin"; };
  $("#serious").onclick = async () => {
    const v = !profile.serious_mode;
    const { error } = await sb.from("profiles").update({ serious_mode: v }).eq("id", user.id);
    if (error) return fail(error);
    profile.serious_mode = v; route();
  };
  $("#out").onclick = async () => { if (!confirm("Sign out of Snack & Burn?")) return; await sb.auth.signOut(); location.hash = ""; };
}

// ---------- ADMIN ----------
let adminTab = "stats";
async function admin() {
  if (!profile.is_admin) { location.hash = "#home"; return; }
  tabs.querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.tab === "profile"));
  let body = "";

  if (adminTab === "stats") {
    const days = await rpc("admin_stats", { days: 14 });
    const users = await rpc("admin_users");
    const sum = (k) => days.reduce((t, d) => t + Number(d[k]), 0);
    const chart = (key, color, label, fmt = n0) => {
      const max = Math.max(1, ...days.map((d) => Number(d[key])));
      const w = 320, h = 90, bw = w / days.length;
      return `<div class="card stack"><div class="row"><b>${label}</b><span class="muted">14 days · ${fmt(sum(key))}</span></div>
        <svg viewBox="0 0 ${w} ${h + 16}" width="100%" role="img" aria-label="${label} per day">
          ${days.map((d, i) => { const v = Number(d[key]); const bh = (v / max) * h;
            return `<rect x="${i * bw + 2}" y="${h - bh}" width="${bw - 4}" height="${Math.max(bh, v ? 2 : 0)}" rx="3" fill="${color}"><title>${d.day}: ${fmt(v)}</title></rect>`; }).join("")}
          <text x="0" y="${h + 14}" font-size="10" fill="#5C5348">${days[0].day.slice(5)}</text>
          <text x="${w}" y="${h + 14}" font-size="10" fill="#5C5348" text-anchor="end">${days[days.length - 1].day.slice(5)}</text>
        </svg></div>`;
    };
    body = `
      <div class="grid g2">
        <div class="tile" style="background:var(--tint-snack)"><b>${users.length}</b>Total users</div>
        <div class="tile" style="background:var(--tint-ok)"><b>${days.length ? days[days.length - 1].active : 0}</b>Active today</div>
        <div class="tile" style="background:var(--tint-burn)"><b>${n0(sum("meals"))}</b>Meals · 14 days</div>
        <div class="tile" style="background:#E7F1FB"><b>${n1(sum("km"))}</b>km run · 14 days</div>
      </div>
      ${chart("active", "#1D7A43", "Active users")}
      ${chart("signups", "#FFB020", "New sign-ups")}
      ${chart("meals", "#D93A1E", "Meals logged")}
      ${chart("km", "#2F6FB0", "Km run", n1)}`;
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

  if (adminTab === "dishes") {
    const { data: dishes, error } = await sb.from("dishes").select("*").order("name");
    if (error) throw error;
    body = `
      <form id="dish" class="card stack">
        <b>Add a dish</b>
        <div class="grid g2"><label>Name<input name="name" required maxlength="80" placeholder="Bún mắm"></label>
        <label>kcal (medium portion)<input name="kcal" type="number" inputmode="numeric" min="0" required></label></div>
        <button class="primary">Add dish</button>
      </form>
      <p class="muted">${dishes.length} dishes. Edit kcal and tap Save. Hidden dishes don’t show to users.</p>
      <div class="list">${dishes.map((d) => `
        <div class="row">
          <div style="flex:1;min-width:0"><div style="${d.active ? "" : "color:var(--muted);text-decoration:line-through"}">${esc(d.name)}</div></div>
          <input aria-label="kcal for ${esc(d.name)}" type="number" min="0" value="${d.kcal}" data-kcal="${d.id}" style="width:84px">
          <button class="outline small" data-save="${d.id}">Save</button>
          <button class="outline small" data-toggle="${d.id}" data-active="${d.active}">${d.active ? "Hide" : "Show"}</button>
        </div>`).join("")}</div>`;
  }

  if (adminTab === "events") {
    const { data: evs, error } = await sb.from("challenges").select("*").eq("official", true).order("starts_at", { ascending: false });
    if (error) throw error;
    const counts = await Promise.all(evs.map((e) => rpc("challenge_leaderboard", { cid: e.id })));
    body = `
      <form id="event" class="card stack">
        <b>New official event</b>
        <label>Name<input name="name" required maxlength="60" placeholder="Saigon Run Week"></label>
        <div class="grid g2">
          <label>Type<select name="metric"><option value="km">Most km run</option><option value="kcal">Most kcal burned</option></select></label>
          <label>Starts<input name="start" type="date" required></label>
          <label>Ends<input name="end" type="date" required></label>
        </div>
        <button class="primary">Publish event</button>
        <p class="muted">Every user sees it on Challenges and can join.</p>
      </form>
      ${evs.length ? `<div class="list">${evs.map((e, i) => `
        <div class="row"><div><div>${esc(e.name)}</div>
          <div class="muted">${e.metric === "km" ? "Most km" : "Most kcal"} · ${new Date(e.starts_at).toLocaleDateString("en-GB")}–${new Date(e.ends_at).toLocaleDateString("en-GB")} · ${counts[i].length} joined</div></div>
          <button class="outline small danger" data-del-ev="${e.id}">Delete</button></div>`).join("")}</div>`
        : `<p class="muted">No official events yet.</p>`}`;
  }

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
    <div class="seg" role="group" aria-label="Admin section">
      ${[["stats", "Stats"], ["users", "Users"], ["dishes", "Dishes"], ["events", "Events"], ["ai", "AI"]].map(([k, t]) => `<button aria-pressed="${adminTab === k}" data-at="${k}">${t}</button>`).join("")}
    </div>
    ${body}`;

  $$("[data-at]").forEach((b) => (b.onclick = () => { adminTab = b.dataset.at; route(); }));
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
  const dish = $("#dish");
  if (dish) dish.onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.from("dishes").insert({ name: dish.name.value.trim(), kcal: +dish.kcal.value });
    if (error) return fail(error.code === "23505" ? new Error("That dish already exists") : error);
    dishCache = null; toast("Dish added"); route();
  };
  $$("[data-save]").forEach((b) => (b.onclick = async () => {
    const v = +app.querySelector(`[data-kcal="${b.dataset.save}"]`).value;
    const { error } = await sb.from("dishes").update({ kcal: v, updated_at: new Date().toISOString() }).eq("id", b.dataset.save);
    if (error) return fail(error);
    dishCache = null; toast("Saved");
  }));
  $$("[data-toggle]").forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from("dishes").update({ active: b.dataset.active !== "true" }).eq("id", b.dataset.toggle);
    if (error) return fail(error);
    dishCache = null; route();
  }));
  const ev = $("#event");
  if (ev) ev.onsubmit = async (e) => {
    e.preventDefault();
    const starts = new Date(ev.start.value + "T00:00"); const ends = new Date(ev.end.value + "T23:59");
    if (ends <= starts) return toast("End date must be after start");
    try {
      await rpc("create_official_challenge", { p_name: ev.name.value.trim(), p_metric: ev.metric.value, p_starts: starts.toISOString(), p_ends: ends.toISOString() });
      toast("Event published"); route();
    } catch (err) { fail(err); }
  };
  $$("[data-del-ev]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this event for everyone?")) return;
    try { await rpc("delete_official_challenge", { cid: b.dataset.delEv }); route(); } catch (e) { fail(e); }
  }));
}

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
  APP_VERSION = (await fetchVersion()) || "dev";
  await route();
  setTimeout(() => { if (user) showInstallGuide(false); }, 1500);
})();
