// Shared fetch/summarize helpers used by both the daily job (fetch-news.mjs)
// and the one-off historical backfill (backfill-history.mjs).

export const GROQ_MODEL = "openai/gpt-oss-120b";
export const REDDIT_USER_AGENT =
  "web:company-news-dashboard:1.0 (by /u/company-news-dashboard-bot)";

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function istDateString(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

export function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return istDateString(d);
}

function relevantArticles(companyName, rawResults, seen) {
  const nameLower = companyName.toLowerCase();
  const articles = [];
  for (const a of rawResults) {
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
  }
  return articles;
}

// Single-page fetch used by the daily job: today's news only, capped at 6.
export async function fetchArticles(companyName, query) {
  const url = new URL("https://newsdata.io/api/1/news");
  url.searchParams.set("apikey", requireEnv("NEWSDATA_API_KEY"));
  url.searchParams.set("q", query);
  url.searchParams.set("country", "in");
  url.searchParams.set("language", "en");
  url.searchParams.set("category", "business");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NewsData.io error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  return relevantArticles(companyName, data.results ?? [], new Set()).slice(0, 6);
}

// Multi-page fetch used by the backfill: pages through NewsData.io's
// "nextPage" cursor to gather a wider spread of articles (with real
// pubDate timestamps) so they can be bucketed into daily history.
export async function fetchArticlesMultiPage(companyName, query, maxPages = 4) {
  const seen = new Set();
  const all = [];
  let page;

  for (let i = 0; i < maxPages; i++) {
    const url = new URL("https://newsdata.io/api/1/news");
    url.searchParams.set("apikey", requireEnv("NEWSDATA_API_KEY"));
    url.searchParams.set("q", query);
    url.searchParams.set("country", "in");
    url.searchParams.set("language", "en");
    url.searchParams.set("category", "business");
    if (page) url.searchParams.set("page", page);

    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  [warn] NewsData.io page ${i + 1} failed: ${res.status}`);
      break;
    }
    const data = await res.json();
    all.push(...relevantArticles(companyName, data.results ?? [], seen));

    page = data.nextPage;
    if (!page) break;
  }

  return all;
}

export async function summarizeNews(companyName, articles, dayLabel = "today") {
  if (articles.length === 0) {
    return `No fresh news found for ${companyName} ${dayLabel} from the tracked sources.`;
  }

  const articleBlock = articles
    .map((a, i) => `${i + 1}. ${a.title} (${a.source_name})\n${a.snippet}`)
    .join("\n\n");

  const prompt = `You are a financial news summarizer. Summarize the news about ${companyName} below in 3-4 concise sentences for a busy investor. Only use facts from the articles below. If articles are mixed/unrelated, focus on the ones actually about ${companyName}. Treat unverified claims, accusations, or allegations as allegations, not established fact - attribute them (e.g. "an article from X alleges..."), don't state them flatly. Output only the summary itself, with no preamble like "Here is a summary" and no closing remarks.\n\n${articleBlock}`;

  return callGroq(prompt);
}

export async function fetchRedditToken() {
  // Reddit credentials are optional: if the app registration hasn't been
  // approved yet (Reddit has been gating self-serve app creation behind a
  // support ticket for newer accounts), skip Reddit chatter entirely rather
  // than failing the whole job.
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.log("  [info] Reddit credentials not set, skipping Reddit chatter.");
    return null;
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": REDDIT_USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    console.log(`  [warn] Reddit auth failed: ${res.status}, skipping Reddit chatter.`);
    return null;
  }
  const data = await res.json();
  return data.access_token;
}

export async function fetchRedditChatter(companyName, token) {
  if (!token) return [];

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

export async function fetchStockTwitsChatter(companyName) {
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

export async function summarizeChatter(companyName, posts, dayLabel = "today") {
  if (posts.length === 0) {
    return `No notable social media chatter found for ${companyName} ${dayLabel}.`;
  }

  const postBlock = posts
    .map((p, i) => `${i + 1}. [${p.source_label}] ${p.title}\n${p.snippet}`)
    .join("\n\n");

  const prompt = `You are monitoring social media (Reddit and StockTwits) for chatter about ${companyName} - things like rumors, speculation about leadership changes, sentiment, or unconfirmed claims that have NOT been reported by official news outlets. This is explicitly NOT verified news. Summarize the chatter in 2-3 sentences. Every sentence must make clear this is unverified social media speculation, not fact (e.g. "Reddit users are speculating that...", "one post claims, without evidence, that..."). If the posts are generic/unrelated to ${companyName} specifically rather than containing real chatter about it, say that plainly instead of forcing a summary. Output only the summary itself, with no preamble and no closing remarks.\n\n${postBlock}`;

  return callGroq(prompt);
}

export async function callGroq(prompt) {
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
