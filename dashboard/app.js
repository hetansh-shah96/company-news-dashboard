const { createClient } = window.supabase;
const client = createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

const app = document.getElementById("app");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function renderError(message) {
  app.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
}

function sourceListHtml(sources) {
  return sources
    .map(
      (s) => `
      <li>
        <span class="source-tag">${escapeHtml(s.source_name)}</span>
        <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>
      </li>`
    )
    .join("");
}

function chatterSourceListHtml(posts) {
  return posts
    .map(
      (p) => `
      <li>
        <span class="source-tag chatter-tag">${escapeHtml(p.source_label)}</span>
        <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>
      </li>`
    )
    .join("");
}

function renderCompanies(companies, summariesByCompany) {
  app.innerHTML = '<div class="grid"></div>';
  const grid = app.querySelector(".grid");

  for (const company of companies) {
    const summaries = summariesByCompany.get(company.id) ?? [];
    const latest = summaries[0];
    const history = summaries.slice(1);

    const card = document.createElement("article");
    card.className = "company-card";

    card.innerHTML = `
      <div class="card-top">
        <h2>${escapeHtml(company.name)}</h2>
        ${
          latest?.sources?.length
            ? `<span class="count-badge">${latest.sources.length} source${latest.sources.length === 1 ? "" : "s"}</span>`
            : ""
        }
      </div>
      ${
        latest
          ? `
        <time class="date">${formatDate(latest.run_date)}</time>
        <p class="section-label">Official news</p>
        <p class="summary">${escapeHtml(latest.summary)}</p>
        ${
          latest.sources?.length
            ? `<details class="sources-toggle">
                <summary>Sources</summary>
                <ul class="source-list">${sourceListHtml(latest.sources)}</ul>
              </details>`
            : ""
        }
        ${
          latest.chatter_summary
            ? `<div class="chatter-block">
                <p class="section-label chatter-label">Social chatter <span class="unverified-tag">Unverified</span></p>
                <p class="summary chatter-summary">${escapeHtml(latest.chatter_summary)}</p>
                ${
                  latest.chatter_sources?.length
                    ? `<details class="sources-toggle">
                        <summary>Chatter sources</summary>
                        <ul class="source-list">${chatterSourceListHtml(latest.chatter_sources)}</ul>
                      </details>`
                    : ""
                }
              </div>`
            : ""
        }`
          : `<p class="empty">No summary yet.</p>`
      }
      ${
        history.length
          ? `<details class="history">
              <summary>Previous ${history.length} day${history.length === 1 ? "" : "s"}</summary>
              ${history
                .map(
                  (h) => `
                <div class="history-item">
                  <time class="date">${formatDate(h.run_date)}</time>
                  <p class="section-label">Official news</p>
                  <p class="summary">${escapeHtml(h.summary)}</p>
                  ${
                    h.chatter_summary
                      ? `<p class="section-label chatter-label">Social chatter <span class="unverified-tag">Unverified</span></p>
                         <p class="summary chatter-summary">${escapeHtml(h.chatter_summary)}</p>`
                      : ""
                  }
                </div>`
                )
                .join("")}
            </details>`
          : ""
      }
    `;

    grid.appendChild(card);
  }
}

async function load() {
  const { data: companies, error: companiesError } = await client
    .from("companies")
    .select("id, name")
    .eq("active", true)
    .order("name");

  if (companiesError) {
    renderError(`Failed to load companies: ${companiesError.message}`);
    return;
  }

  const { data: summaries, error: summariesError } = await client
    .from("news_summaries")
    .select("company_id, run_date, summary, sources, chatter_summary, chatter_sources")
    .order("run_date", { ascending: false })
    .limit(200);

  if (summariesError) {
    renderError(`Failed to load summaries: ${summariesError.message}`);
    return;
  }

  const summariesByCompany = new Map();
  for (const row of summaries) {
    if (!summariesByCompany.has(row.company_id)) {
      summariesByCompany.set(row.company_id, []);
    }
    summariesByCompany.get(row.company_id).push(row);
  }

  renderCompanies(companies, summariesByCompany);
}

load();
