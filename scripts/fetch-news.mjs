// Daily job: for each active company, pull recent official news from
// NewsData.io plus unverified social chatter from StockTwits, summarize both
// separately with Claude, and store the results in Supabase + a local CSV
// backup.
//
// Required env vars (set as GitHub Actions secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEWSDATA_API_KEY, ANTHROPIC_API_KEY

import { createClient } from "@supabase/supabase-js";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  requireEnv,
  istDateString,
  fetchArticles,
  summarizeNews,
  fetchStockTwitsChatter,
  summarizeChatter,
} from "./lib.mjs";

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);

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

  const csvRows = [
    "run_date,company,summary,source_titles,chatter_summary,chatter_source_titles",
  ];

  let failures = 0;

  for (const company of companies) {
    try {
      console.log(`Fetching news for ${company.name}...`);
      const articles = await fetchArticles(company.name, company.search_query);
      const summary = await summarizeNews(company.name, articles);

      console.log(`Fetching social chatter for ${company.name}...`);
      const chatterPosts = await fetchStockTwitsChatter(company.name);
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
    } catch (err) {
      failures++;
      console.error(`[error] ${company.name} failed: ${err.message ?? err}`);
      if (err.stack) console.error(err.stack);
    }
  }

  const backupDir = path.join(process.cwd(), "data");
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, `${runDate}.csv`), csvRows.join("\n"), "utf8");
  console.log(`Wrote offline backup to data/${runDate}.csv`);

  if (failures === companies.length) {
    throw new Error(`All ${failures} companies failed - see per-company errors above.`);
  }
  if (failures > 0) {
    console.warn(`${failures} of ${companies.length} companies failed - see errors above.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
