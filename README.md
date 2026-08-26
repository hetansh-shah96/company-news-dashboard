# Watchlist

Daily summaries for tracked companies, split into two clearly separate kinds:

- **Official news** — from Indian business news sources via NewsData.io.
- **Social chatter (unverified)** — rumors/speculation/sentiment from StockTwits, visually and
  semantically kept apart from the official summary so the two are never confused.

Both are summarized by Claude and shown on a simple browser dashboard. A GitHub Actions cron job
runs the fetch daily at 8:55 AM IST.

## How it fits together

- **`supabase/schema.sql`** — the database schema (`companies`, `news_summaries`). Run once in
  Supabase's SQL editor.
- **`scripts/fetch-news.mjs`** — the daily job. Pulls news from NewsData.io and chatter from
  StockTwits, summarizes both separately with Claude, writes to Supabase, and writes a CSV
  backup to `data/`.
- **`.github/workflows/daily-news.yml`** — runs the script daily at 8:55 AM IST and commits the CSV
  backup to this repo (so you always have an offline copy in git history, even if Supabase has
  an issue).
- **`dashboard/`** — static HTML/JS page that reads from Supabase and displays the latest +
  historical summaries per company, with chatter shown in a distinct "Unverified" box. No build
  step; open `index.html` directly or host it anywhere static (GitHub Pages, Vercel, Netlify).
  Deployed at https://company-news-dashboard-r77x.vercel.app.
- **`supabase/functions/refresh-news`** — Edge Function behind the dashboard's "Refresh news"
  button. Holds the GitHub PAT server-side, enforces a 15-minute cooldown (by checking the
  workflow's own run history), and dispatches `daily-news.yml` via `workflow_dispatch` on demand.
- **`supabase/functions/manage-companies`** — Edge Function behind the "Manage" panel. Holds the
  `service_role` key server-side so the dashboard's anon key stays read-only; adds/deactivates
  companies on request.
- **`supabase/functions/chat`** — Edge Function behind the floating chat button. Holds
  `GROQ_API_KEY` server-side and proxies to Groq's chat completions endpoint.

## Dashboard features

- **Bullet-point summaries.** Both the news and chatter prompts ask Claude for 3-4 short bullets
  instead of a paragraph — easier to scan. Older paragraph-style rows (from before this format)
  still render fine via a fallback in `summaryBlockHtml()`.
- **"Refresh news" button.** Manually triggers the daily job on demand instead of waiting for the
  8:55 AM IST cron. Rate-limited to once per 15 minutes by the Edge Function.
- **"Download PDF" button.** Builds a print-only view (`#printReport` in `index.html`) mirroring
  the dashboard's own cards — brand header, per-company sections, plain-text source citations —
  and calls `window.print()` so "Save as PDF" produces an actual shareable report instead of a
  raw CSV dump. Each company card also has its own small PDF button for a single-company report.
- **"Manage" button.** Add or remove tracked companies from the dashboard itself — no need to
  touch Supabase directly. "Remove" deactivates (`active = false`) rather than deletes, so
  historical summaries for that company are kept; re-adding the same name reactivates it.
  **No login gate** — this is intentional for the current beta (the dashboard link isn't shared
  publicly), but anyone with the link can edit the company list. Revisit before a public launch.
- **Chat button (bottom-right).** An assistant backed by Groq (`openai/gpt-oss-120b`). Each
  message is sent along with a snapshot of the dashboard's currently-loaded data (latest official
  news + chatter per company, built client-side from what's already loaded for the cards — no
  extra query), so it can answer questions like "any major news today?" grounded in what's
  actually on screen. It's a snapshot, not a live feed — stale or off-screen data won't be seen,
  and it says so rather than guessing. Four suggested prompts appear until the first message is
  sent. Also unauthenticated; the Edge Function caps message count/length, context size, and
  `max_tokens` to keep potential abuse cheap rather than gating by login.

## One-time setup

### 1. Supabase (database)
1. Create a free project at supabase.com.
2. Open the SQL editor, paste in `supabase/schema.sql`, run it. This creates the tables, sets
   read-only public access, and seeds Godrej Properties + Biocon.
3. From Project Settings → API, grab:
   - Project URL
   - `anon` public key (safe for the browser)
   - `service_role` key (secret — only used by the GitHub Actions script)

### 2. NewsData.io (news source)
1. Sign up free at newsdata.io — free tier gives 200 credits/day, plenty even at 15+ tracked
   companies (one run costs roughly 1 credit per company).
2. Copy your API key.

### 3. Anthropic (summarization)
1. Create an API key at console.anthropic.com.
2. The job uses `claude-haiku-4-5` (set in `scripts/lib.mjs` as `CLAUDE_MODEL`) — summaries are
   short and don't need a bigger model. At 9 companies this runs about $0.60/month; see
   **Cost** below.

StockTwits chatter needs no key — its public read endpoints are used as-is. If StockTwits ever
changes that policy, the job just logs a warning and treats it as "no chatter" rather than
failing.

### 4. Wire up the dashboard
Edit `dashboard/config.js` and fill in your Supabase URL + anon key.

### 5. Push this repo to GitHub and add secrets
1. Create a new (private is fine) GitHub repo, push this folder to it.
2. In the repo's Settings → Secrets and variables → Actions, add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `NEWSDATA_API_KEY`
   - `ANTHROPIC_API_KEY`
3. The workflow runs automatically every day at 8:55 AM IST. You can also trigger it manually from
   the Actions tab ("Run workflow") to test it immediately.

### 6. Host the dashboard (optional but recommended)
Since it's static files, drag the `dashboard/` folder onto Vercel or Netlify, or enable GitHub
Pages pointed at `dashboard/`. Takes under a minute and gives you a shareable URL.

## Adding more companies

Easiest: use the dashboard's "Manage" button. Or insert a row into the `companies` table in
Supabase directly (via the table editor or SQL):

```sql
insert into companies (name, search_query) values ('Tata Motors', 'Tata Motors');
```

Either way, it's picked up automatically on the next daily run — no code changes needed.

## Deploying the Edge Functions

From the repo root, with the [Supabase CLI](https://supabase.com/docs/guides/cli) (or `npx supabase`):

```
npx supabase functions deploy refresh-news --project-ref <your-project-ref> --no-verify-jwt
npx supabase functions deploy manage-companies --project-ref <your-project-ref> --no-verify-jwt
npx supabase functions deploy chat --project-ref <your-project-ref> --no-verify-jwt
```

`refresh-news` and `manage-companies` read `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, which
Supabase injects into every Edge Function automatically. `refresh-news` also needs a `GITHUB_PAT`
secret (repo `actions` scope), and `chat` needs `GROQ_API_KEY`:

```
npx supabase secrets set GITHUB_PAT=... --project-ref <your-project-ref>
npx supabase secrets set GROQ_API_KEY=... --project-ref <your-project-ref>
```

## Offline backup

Every run also writes `data/YYYY-MM-DD.csv` and commits it back to this repo. That gives you a
plain-text, versioned history independent of Supabase — pull the repo any time for a fully
offline copy of everything collected so far.

## Cost

Two Claude calls per company per day (news summary + chatter summary), skipped entirely when
there's nothing fresh to summarize. On `claude-haiku-4-5` ($1/$5 per 1M input/output tokens):

| Companies | Est. monthly cost |
|---|---|
| 9 (current) | ~$0.60 |
| 15 | ~$1.00 |

NewsData.io's free tier (200 credits/day) is the more likely constraint if the watchlist grows —
each run costs roughly 1 credit per company.

## Gotchas / troubleshooting

- **`output_config.effort` is not supported on Haiku 4.5** (or Sonnet 4.5) — sending it makes
  every `callClaude()` call fail with an error. This isn't obvious from the error alone: because
  `fetch-news.mjs` isolates per-company failures, the symptom looks like "only companies with no
  fresh news/chatter got stored" (they're the only ones that skip the Claude call entirely,
  short-circuiting before ever hitting the bad param) rather than an outright crash. If you ever
  bump the model up to a tier that *does* support `effort` (Sonnet 5, Opus 5, ...), it's safe to
  add back.
- **A single company failing doesn't fail the whole run.** `fetch-news.mjs` wraps each company's
  fetch/summarize/store in try/catch; the job only exits non-zero if *every* company failed. Check
  the Action's log for `[error] <company> failed: ...` lines to see individual failures — the
  GitHub UI's own "Process completed with exit code 1" annotation won't show them.
- **Use the undated `claude-haiku-4-5` model string**, not a dated snapshot like
  `claude-haiku-4-5-20251001` — current guidance is to use the bare id for current-generation
  models; a dated variant was tried briefly here and swapped back before it could be confirmed
  as the cause of anything (the real bug both times was the `effort` param above).
- **Groq's hosted model lineup changes often.** `GROQ_MODEL` in `supabase/functions/chat/index.ts`
  is hardcoded; if the chat widget starts returning `model_not_found` (404), list what's actually
  available with your key and pick a current chat model (not a `whisper-*` speech-to-text model,
  `*-orpheus-*` text-to-speech model, or `*-prompt-guard-*` classifier — those aren't chat models):
  ```powershell
  $key = "gsk_..."
  (Invoke-RestMethod -Uri "https://api.groq.com/openai/v1/models" -Headers @{ Authorization = "Bearer $key" }).data.id
  ```
  Then update `GROQ_MODEL` and redeploy: `npx supabase functions deploy chat --project-ref <ref> --no-verify-jwt`.
