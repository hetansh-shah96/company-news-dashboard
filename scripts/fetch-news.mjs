// Daily job: for each active company, pull recent official news from
// NewsData.io plus unverified social chatter from Reddit and StockTwits,
// summarize both separately with Groq, and store the results in Supabase +
// a local CSV backup.
//
// Required env vars (set as GitHub Actions secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEWSDATA_API_KEY, GROQ_API_KEY,
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET

import { createClient } from "@supabase/supabase-js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const GROQ_MODEL = "llama-3.3-70b-versatile";
const REDDIT_USER_AGENT = "web:company-news-dashboard:1.0 (by /u/company-news-dashboard-bot)";

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function istDateString() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function fetchArticles(companyName, query) {
  const url = new URL("https://newsdata.io/api/1/news");
  url.searchParams.set("apikey", requireEnv("NEWSDATA_API_KEY"));
  // Broad match on title+content, no domain restriction: NewsData.io's free
  // tier has too little per-domain coverage for a domainurl filter to be
  // usable, so relevance to the company is enforced client-side below.
  url.searchParams.set("q", query);
  url.searchParams.set("country", "in");
  url.searchParams.set("language", "en");
  url.searchParams.set("category", "business");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NewsData.io error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const nameLower = companyName.toLowerCase();
  const seen = new Set();
  const articles = [];
  for (const a of data.results ?? []) {
    if (seen.has(a.title)) continue;
    const mentionsCompany =
      a.title?.toLowerCase().includes(nameLower) ||
      a.description?.toLowerCase().includes(nameLower);
    if (!mentionsCompany) continue;
    seen.add(a.title);
    articles.push({
      title: a.title,
      url: a.link,
      source_name: a.source_id,
      published_at: a.pubDate,
      snippet: a.description ?? "",
    });
    if (articles.length >= 6) break;
  }
  return articles;
}

async function summarizeNews(companyName, articles) {
  if (articles.length === 0) {
    return `No fresh news found for ${companyName} today from the tracked sources.`;
  }

  const articleBlock = articles
    .map((a, i) => `${i + 1}. ${a.title} (${a.source_name})\n${a.snippet}`)
    .join("\n\n");

  const prompt = `You are a financial news summarizer. Summarize today's news about ${companyName} in 3-4 concise sentences for a busy investor. Only use facts from the articles below. If articles are mixed/unrelated, focus on the ones actually about ${companyName}. Treat unverified claims, accusations, or allegations as allegations, not established fact - attribute them (e.g. "an article from X alleges..."), don't state them flatly. Output only the summary itself, with no preamble like "Here is a summary" and no closing remarks.\n\n${articleBlock}`;

  return callGroq(prompt);
}

async function fetchRedditToken() {
  const auth = Buffer.from(
    `${requireEnv("REDDIT_CLIENT_ID")}:${requireEnv("REDDIT_CLIENT_SECRET")}`
  ).toString("base64");

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) throw new Error(`Reddit auth error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function fetchRedditChatter(companyName, token) {
  const url = new URL("https://oauth.reddit.com/search");
  url.searchParams.set("q", companyName);
  url.searchParams.set("sort", "new");
  url.searchParams.set("t", "week");
  url.searchParams.set("limit", "15");
  url.searchParams.set("raw_json", "1");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": REDDIT_USER_AGENT },
  });
  if (!res.ok) {
    console.log(`  [warn] Reddit search failed for "${companyName}": ${res.status}`);
    return [];
  }

  const data = await res.json();
  const nameLower = companyName.toLowerCase();
  const posts = [];
  for (const child of data.data?.children ?? []) {
    const p = child.data;
    const text = `${p.title} ${p.selftext ?? ""}`.toLowerCase();
    if (!text.includes(nameLower)) continue;
    posts.push({
      title: p.title,
      url: `https://reddit.com${p.permalink}`,
      source_label: p.subreddit_name_prefixed,
      score: p.score,
      num_comments: p.num_comments,
      snippet: (p.selftext ?? "").slice(0, 300),
    });
    if (posts.length >= 6) break;
  }
  return posts;
}

async function fetchStockTwitsChatter(companyName) {
  // StockTwits' public endpoints are read-only and don't require an API key,
  // but access policy has shifted before and Indian-ticker coverage is thin
  // -- treat any failure or empty result as "no chatter", never fatal.
  try {
    const searchUrl = new URL("https://api.stocktwits.com/api/2/search.json");
    searchUrl.searchParams.set("q", companyName);
    searchUrl.searchParams.set("type", "symbol");
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) {
      console.log(
        `  [warn] StockTwits symbol search failed for "${companyName}": ${searchRes.status}`
      );
      return [];
    }
    const searchData = await searchRes.json();
    const symbol = searchData.results?.[0]?.symbol;
    if (!symbol) return [];

    const streamRes = await fetch(
      `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`
    );
    if (!streamRes.ok) {
      console.log(`  [warn] StockTwits stream failed for ${symbol}: ${streamRes.status}`);
      return [];
    }
    const streamData = await streamRes.json();
    return (streamData.messages ?? []).slice(0, 6).map((m) => ({
      title: m.body,
      url: `https://stocktwits.com/symbol/${symbol}`,
      source_label: `StockTwits $${symbol}`,
      score: m.likes?.total ?? 0,
      num_comments: 0,
      snippet: m.body,
    }));
  } catch (err) {
    console.log(`  [warn] StockTwits fetch errored for "${companyName}": ${err.message}`);
    return [];
  }
}

async function summarizeChatter(companyName, posts) {
  if (posts.length === 0) {
    return `No notable social media chatter found for ${companyName} today.`;
  }

  const postBlock = posts
    .map((p, i) => `${i + 1}. [${p.source_label}] ${p.title}\n${p.snippet}`)
    .join("\n\n");

  const prompt = `You are monitoring social media (Reddit and StockTwits) for chatter about ${companyName} - things like rumors, speculation about leadership changes, sentiment, or unconfirmed claims that have NOT been reported by official news outlets. This is explicitly NOT verified news. Summarize the chatter in 2-3 sentences. Every sentence must make clear this is unverified social media speculation, not fact (e.g. "Reddit users are speculating that...", "one post claims, without evidence, that..."). If the posts are generic/unrelated to ${companyName} specifically rather than containing real chatter about it, say that plainly instead of forcing a summary. Output only the summary itself, with no preamble and no closing remarks.\n\n${postBlock}`;

  return callGroq(prompt);
}

async function callGroq(prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireEnv("GROQ_API_KEY")}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    }),
  });

  if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function toCsvRow(fields) {
  return fields
    .map((f) => `"${String(f ?? "").replace(/"/g, '""')}"`)
    .join(",");
}

async function main() {
  const runDate = istDateString();

  const { data: companies, error } = await supabase
    .from("companies")
    .select("id, name, search_query")
    .eq("active", true);

  if (error) throw error;
  if (!companies?.length) {
    console.log("No active companies configured.");
    return;
  }

  const redditToken = await fetchRedditToken();

  const csvRows = [
    "run_date,company,summary,source_titles,chatter_summary,chatter_source_titles",
  ];

  for (const company of companies) {
    console.log(`Fetching news for ${company.name}...`);
    const articles = await fetchArticles(company.name, company.search_query);
    const summary = await summarizeNews(company.name, articles);

    console.log(`Fetching social chatter for ${company.name}...`);
    const [redditPosts, stockTwitsPosts] = await Promise.all([
      fetchRedditChatter(company.name, redditToken),
      fetchStockTwitsChatter(company.name),
    ]);
    const chatterPosts = [...redditPosts, ...stockTwitsPosts];
    const chatterSummary = await summarizeChatter(company.name, chatterPosts);

    const { error: upsertError } = await supabase
      .from("news_summaries")
      .upsert(
        {
          company_id: company.id,
          run_date: runDate,
          summary,
          sources: articles,
          chatter_summary: chatterSummary,
          chatter_sources: chatterPosts,
        },
        { onConflict: "company_id,run_date" }
      );

    if (upsertError) throw upsertError;

    csvRows.push(
      toCsvRow([
        runDate,
        company.name,
        summary,
        articles.map((a) => a.title).join(" | "),
        chatterSummary,
        chatterPosts.map((p) => p.title).join(" | "),
      ])
    );

    console.log(`Stored summary + chatter for ${company.name}.`);
  }

  const backupDir = path.join(process.cwd(), "data");
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, `${runDate}.csv`), csvRows.join("\n"), "utf8");
  console.log(`Wrote offline backup to data/${runDate}.csv`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
