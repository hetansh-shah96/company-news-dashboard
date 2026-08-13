const { createClient } = window.supabase;
const client = createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

const app = document.getElementById("app");

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function renderError(message) {
  app.innerHTML = `<p class="error">${message}</p>`;
}

function renderCompanies(companies, summariesByCompany) {
  app.innerHTML = "";

  for (const company of companies) {
    const summaries = summariesByCompany.get(company.id) ?? [];
    const card = document.createElement("section");
    card.className = "company-card";

    const latest = summaries[0];
    const history = summaries.slice(1);

    card.innerHTML = `
      <h2>${company.name}</h2>
      ${
        latest
          ? `
        <div class="latest">
          <span class="date">${formatDate(latest.run_date)}</span>
          <p class="summary">${latest.summary}</p>
          <ul class="sources">
            ${latest.sources
              .map(
                (s) =>
                  `<li><a href="${s.url}" target="_blank" rel="noopener">${s.title}</a> <span class="source-name">— ${s.source_name}</span></li>`
              )
              .join("")}
          </ul>
        </div>`
          : `<p class="empty">No summary yet.</p>`
      }
      ${
        history.length
          ? `<details class="history">
              <summary>Previous ${history.length} day(s)</summary>
              ${history
                .map(
                  (h) => `
                <div class="history-item">
                  <span class="date">${formatDate(h.run_date)}</span>
                  <p class="summary">${h.summary}</p>
                </div>`
                )
                .join("")}
            </details>`
          : ""
      }
    `;

    app.appendChild(card);
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
    .select("company_id, run_date, summary, sources")
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
