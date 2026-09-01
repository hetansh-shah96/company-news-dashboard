-- Run this once in the Supabase SQL editor for your project.

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  search_query text not null,      -- what gets sent to the news API, e.g. "Godrej Properties"
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists news_summaries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  run_date date not null,          -- the day this summary covers (IST date)
  summary text not null,
  sources jsonb not null default '[]',  -- [{title, url, source_name, published_at}, ...]
  -- Unverified social chatter (Reddit), kept separate from the official
  -- news summary above so the two are never visually or semantically mixed.
  chatter_summary text,
  chatter_sources jsonb not null default '[]',  -- [{title, url, subreddit, score, num_comments, permalink}, ...]
  created_at timestamptz not null default now(),
  unique (company_id, run_date)
);

-- Safe to re-run on an existing table: adds the chatter columns if this
-- schema.sql was already run once before they existed.
alter table news_summaries add column if not exists chatter_summary text;
alter table news_summaries add column if not exists chatter_sources jsonb not null default '[]';

-- created_at only reflects the row's first insert, so it doesn't move when
-- a same-day "Refresh news" upserts new content over an existing row.
-- updated_at is explicitly bumped by the fetch script on every write (see
-- fetch-news.mjs) and is what the dashboard's "Last refreshed" label uses.
alter table news_summaries add column if not exists updated_at timestamptz not null default now();
update news_summaries set updated_at = created_at where updated_at is null;

alter table companies enable row level security;
alter table news_summaries enable row level security;

-- Dashboard (browser, anon key) can only read.
create policy "public read companies" on companies
  for select using (true);

create policy "public read news_summaries" on news_summaries
  for select using (true);

-- No insert/update/delete policies for anon: only the service_role key
-- (used by the GitHub Actions script) bypasses RLS and can write.

insert into companies (name, search_query) values
  ('Godrej Properties', 'Godrej Properties'),
  ('Biocon', 'Biocon')
on conflict (name) do nothing;
