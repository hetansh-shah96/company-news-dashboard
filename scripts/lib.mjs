// Shared fetch/summarize helpers used by both the daily job (fetch-news.mjs)
// and the one-off historical backfill (backfill-history.mjs).

import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = "claude-haiku-4-5";

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

// Real headlines rarely spell out a company's full legal name - they drop
// suffixes ("Ltd"/"Limited") and write "&" instead of "and" (e.g. "Godawari
// Power and Ispat" is actually reported as "Godawari Power & Ispat"). Strip
// both before comparing so genuine coverage isn't filtered out.
function normalizeCompanyText(str) {
  return str
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\./g, "")
    .replace(/\b(limited|ltd|corp|corporation|inc|plc|co)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function relevantArticles(companyName, rawResults, seen) {
  const nameLower = normalizeCompanyText(companyName);
  const articles = [];
  for (const a of rawResults) {
    if (seen.has(a.title)) continue;
    const mentionsCompany =
      normalizeCompanyText(a.title ?? "").includes(nameLower) ||
      normalizeCompanyText(a.description ?? "").includes(nameLower);
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

  const prompt = `You are a financial news summarizer. Summarize the news about ${companyName} below as 3-4 concise bullet points for a busy investor, one distinct fact or development per bullet. The title and snippet given for each article below is ALL the information you have access to - there is no link to follow and no fuller article text available, so never ask for the full article text or claim you can't see the content. Only use facts actually present in the titles/snippets below. If a given article's snippet is empty or too thin to extract a real fact from, skip that article rather than commenting on it. If NONE of the articles below contain enough substance to summarize, output a single bullet saying that plainly (e.g. "- No substantive details available for ${companyName} in today's headlines."). If articles are mixed/unrelated, focus on the ones actually about ${companyName}. Treat unverified claims, accusations, or allegations as allegations, not established fact - attribute them (e.g. "an article from X alleges..."), don't state them flatly. Output ONLY the bullet points, one per line, each starting with "- ", with no preamble like "Here is a summary", no closing remarks, no questions back to the user, and no other formatting.\n\n${articleBlock}`;

  const result = await callClaude(prompt);
  const isValidBulletList = result
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .every((line) => line.trim().startsWith("-"));

  if (!isValidBulletList) {
    console.log(`  [warn] Unexpected summary format for ${companyName}, discarding: ${result}`);
    return `No fresh news found for ${companyName} ${dayLabel} from the tracked sources.`;
  }

  return result;
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

  const prompt = `You are monitoring social media (StockTwits) for chatter about ${companyName} - things like rumors, speculation about leadership changes, sentiment, or unconfirmed claims that have NOT been reported by official news outlets. This is explicitly NOT verified news. The posts below are ALL the information you have access to - there is no link to follow and nothing else available, so never ask for more posts or claim you can't see the content. Summarize the chatter as 2-3 concise bullet points. Every bullet must make clear this is unverified social media speculation, not fact (e.g. "StockTwits users are speculating that...", "one post claims, without evidence, that..."). If the posts are generic/unrelated to ${companyName} specifically rather than containing real chatter about it, output a single bullet saying that plainly instead of forcing a summary. Output ONLY the bullet points, one per line, each starting with "- ", with no preamble, no questions back to the user, and no closing remarks.\n\n${postBlock}`;

  const result = await callClaude(prompt);
  const isValidBulletList = result
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .every((line) => line.trim().startsWith("-"));

  if (!isValidBulletList) {
    console.log(`  [warn] Unexpected chatter summary format for ${companyName}, discarding: ${result}`);
    return `No notable social media chatter found for ${companyName} ${dayLabel}.`;
  }

  return result;
}

let anthropicClient;

export async function callClaude(prompt) {
  anthropicClient ??= new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY"), maxRetries: 4 });

  const message = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
