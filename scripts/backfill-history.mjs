// One-off backfill: for company names passed as CLI args, gather a wider
// spread of NewsData.io articles (multi-page), bucket them by their real
// publish date, and populate the last 15 days of news_summaries rows so a
// newly-added company doesn't start with an empty history.
//
// Usage: node backfill-history.mjs "South Indian Bank" "Karnataka Bank"
//
// Social chatter (StockTwits) only reflects the current moment on this free
// API -- there's no historical chatter endpoint available, so only "today"
// gets a real chatter summary; earlier days get an honest placeholder saying
// chatter tracking starts today.

import { createClient } from "@supabase/supabase-js";
import {
  requireEnv,
  istDateString,
  daysAgo,
  fetchArticlesMultiPage,
  summarizeNews,
  fetchStockTwitsChatter,
  summarizeChatter,
} from "./lib.mjs";

const BACKFILL_DAYS = 15;

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY")
);

async function main() {
  const companyNames = process.argv.slice(2);
  if (companyNames.length === 0) {
    console.error('Usage: node backfill-history.mjs "Company Name" ["Another Company"]');
    process.exit(1);
  }

  for (const name of companyNames) {
    const { data: company, error } = await supabase
      .from("companies")
      .select("id, name, search_query")
      .eq("name", name)
      .single();

    if (error || !company) {
      console.error(`Skipping "${name}": not found in companies table (${error?.message})`);
      continue;
    }

    console.log(`Backfilling ${BACKFILL_DAYS} days for ${company.name}...`);
    const articles = await fetchArticlesMultiPage(company.name, company.search_query, 4);
    console.log(`  Found ${articles.length} relevant articles across all pages.`);

    const byDate = new Map();
    for (const a of articles) {
      const date = istDateString(new Date(a.published_at));
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(a);
    }

    for (let i = 0; i < BACKFILL_DAYS; i++) {
      const date = daysAgo(i);
      const dayArticles = (byDate.get(date) ?? []).slice(0, 6);
      const dayLabel = i === 0 ? "today" : `on ${date}`;
      const summary = await summarizeNews(company.name, dayArticles, dayLabel);

      let chatterSummary;
      let chatterPosts = [];
      if (i === 0) {
        chatterPosts = await fetchStockTwitsChatter(company.name);
        chatterSummary = await summarizeChatter(company.name, chatterPosts, "today");
      } else {
        chatterSummary = `Social chatter tracking for ${company.name} began today; no historical chatter data is available for ${date}.`;
      }

      const { error: upsertError } = await supabase
        .from("news_summaries")
        .upsert(
          {
            company_id: company.id,
            run_date: date,
            summary,
            sources: dayArticles,
            chatter_summary: chatterSummary,
            chatter_sources: chatterPosts,
          },
          { onConflict: "company_id,run_date" }
        );

      if (upsertError) throw upsertError;
      console.log(`  ${date}: ${dayArticles.length} article(s) stored.`);
    }

    console.log(`Done backfilling ${company.name}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
