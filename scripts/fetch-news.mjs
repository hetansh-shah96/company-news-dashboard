// Daily job: for each active company, pull recent news from NewsData.io,
// summarize with Groq, and store the result in Supabase + a local CSV backup.
//
// Required env vars (set as GitHub Actions secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEWSDATA_API_KEY, GROQ_API_KEY

import { createClient } from "@supabase/supabase-js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const NEWS_SOURCES_DOMAINS = "moneycontrol,economictimes,business-standard,livemint";
const GROQ_MODEL = "llama-3.3-70b-versatile";

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

async function fetchArticles(query) {
  const url = new URL("https://newsdata.io/api/1/news");
  url.searchParams.set("apikey", requireEnv("NEWSDATA_API_KEY"));
  url.searchParams.set("q", query);
  url.searchParams.set("country", "in");
  url.searchParams.set("language", "en");
  url.searchParams.set("category", "business");
  url.searchParams.set("domain", NEWS_SOURCES_DOMAINS);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`NewsData.io error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.results ?? []).slice(0, 6).map((a) => ({
    title: a.title,
    url: a.link,
    source_name: a.source_id,
    published_at: a.pubDate,
    snippet: a.description ?? "",
  }));
}

async function summarize(companyName, articles) {
  if (articles.length === 0) {
    return `No fresh news found for ${companyName} today from the tracked sources.`;
  }

  const articleBlock = articles
    .map((a, i) => `${i + 1}. ${a.title} (${a.source_name})\n${a.snippet}`)
    .join("\n\n");

  const prompt = `You are a financial news summarizer. Summarize today's news about ${companyName} in 3-4 concise sentences for a busy investor. Only use facts from the articles below. If articles are mixed/unrelated, focus on the ones actually about ${companyName}.\n\n${articleBlock}`;

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

  const csvRows = ["run_date,company,summary,source_titles"];

  for (const company of companies) {
    console.log(`Fetching news for ${company.name}...`);
    const articles = await fetchArticles(company.search_query);
    const summary = await summarize(company.name, articles);

    const { error: upsertError } = await supabase
      .from("news_summaries")
      .upsert(
        {
          company_id: company.id,
          run_date: runDate,
          summary,
          sources: articles,
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
      ])
    );

    console.log(`Stored summary for ${company.name}.`);
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
