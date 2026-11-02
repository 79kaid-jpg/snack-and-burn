# Snack & Burn

Eat it. Snap it. Burn it. A playful calorie app: photograph your meal, see how much fat it adds if you don't burn it, and race friends to burn it off.

Built as an installable web app (PWA) for iPhone, with **Supabase** (database, sign-in, AI function) and **GitHub Pages** (hosting).

## Features

- **Snap & Burn:** take a meal photo; AI lists the dishes (Vietnamese names first) with calories; adjust portions S/M/L; get your Burn-It card (fat if unburned + km running, km walking, minutes of jump rope).
- **Home:** daily Balance Meter (budget, snacked, burned, net), today's meals and burns, streak.
- **Challenges:** most km run or most kcal burned, weekly or custom dates, leaderboard, badges.
- **Friends:** invite via share sheet (Zalo, Messenger…), add by code, find people within 2 km, choose who sees you (Everyone / Friends only / Off).
- **Profile:** body stats → daily budget (Mifflin-St Jeor × activity), serious mode (no jokes).

## Setup (about 15 minutes)

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste `supabase/schema.sql` → **Run**.
3. **Authentication → URL Configuration**: set **Site URL** to your GitHub Pages address, e.g. `https://YOUR-NAME.github.io/snack-and-burn/`, and add it to **Redirect URLs**.
4. **Project Settings → API**: copy the **Project URL** and **anon public** key.

### 2. AI meal recognition (Edge Function)
Uses the Claude API to read meal photos. The key stays on Supabase, never in the website.

```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase functions deploy analyze-meal
```
Without this step the app still works: users add dishes by hand from the Vietnamese dish list.

### 3. GitHub Pages
1. Repository **Settings → Secrets and variables → Actions → Variables**: add `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
2. **Settings → Pages → Source: GitHub Actions**.
3. Push to `main`. The workflow publishes the site.

### 4. Install on iPhone
Open the site in Safari → **Share → Add to Home Screen**.

## Notes and limits
- Calories from photos are estimates (±20%); the app labels them that way.
- Web apps cannot read Apple Health, so Apple Watch / Garmin sync needs the future native iOS app. Runs are logged manually for now.
- Location is rounded to about 100 m and hidden from other users; only distance is shown, and only to people the user allows.
- The Supabase anon key is safe to publish; Row Level Security protects all data.

## Project structure
```
index.html, styles.css, app.js   the app (no build step)
config.js                        Supabase URL + anon key (overwritten by the deploy workflow)
sw.js, manifest.webmanifest      installable PWA
supabase/schema.sql              tables, security rules, functions
supabase/functions/analyze-meal  AI photo → dishes + kcal
.github/workflows/pages.yml      deploy to GitHub Pages
```
