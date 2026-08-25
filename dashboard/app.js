const { createClient } = window.supabase;
const client = createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

const app = document.getElementById("app");
const lastRefreshedEl = document.getElementById("lastRefreshed");
const refreshBtn = document.getElementById("refreshBtn");
const refreshBtnLabel = document.getElementById("refreshBtnLabel");

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

function formatRelativeTime(date) {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function renderError(message) {
  app.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
}

function tagRowHtml(items, tagClass, labelKey) {
  return `<div class="tag-row">${items
    .map(
      (item) =>
        `<a class="source-tag ${tagClass}" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item[labelKey])}</a>`
    )
    .join("")}</div>`;
}

function hasContent(row) {
  return Boolean(row.sources?.length || row.chatter_sources?.length);
}

function officialSectionHtml(row) {
  return `
    <div class="section">
      <p class="section-label"><span class="icon">newspaper</span>Official news</p>
      <p class="summary">${escapeHtml(row.summary)}</p>
      ${row.sources?.length ? tagRowHtml(row.sources, "", "source_name") : ""}
    </div>`;
}

function chatterSectionHtml(row) {
  if (!row.chatter_summary) return "";
  return `
    <div class="section chatter-block">
      <p class="section-label chatter-label"><span class="icon">forum</span>Social chatter · unverified</p>
      <p class="summary chatter-summary">${escapeHtml(row.chatter_summary)}</p>
      ${row.chatter_sources?.length ? tagRowHtml(row.chatter_sources, "chatter-tag", "source_label") : ""}
    </div>`;
}

const CARD_REVEAL_STAGGER_MS = 45;

function renderCompanies(companies, summariesByCompany) {
  app.innerHTML = '<div class="grid"></div>';
  const grid = app.querySelector(".grid");

  for (const [index, company] of companies.entries()) {
    const summaries = summariesByCompany.get(company.id) ?? [];
    const latest = summaries[0];
    const history = summaries.slice(1);
    const notableHistory = history.filter(hasContent);
    const quietCount = history.length - notableHistory.length;

    const card = document.createElement("article");
    card.className = "company-card";

    const footerHtml = notableHistory.length
      ? `<details class="history">
          <summary>
            <span class="icon">history</span>
            ${notableHistory.length} notable day${notableHistory.length === 1 ? "" : "s"} in history
            ${quietCount ? ` · ${quietCount} quiet` : ""}
          </summary>
          <div class="history-body">
            ${notableHistory
              .map(
                (h) => `
              <div class="history-item">
                <time class="date">${formatDate(h.run_date)}</time>
                ${officialSectionHtml(h)}
                ${chatterSectionHtml(h)}
              </div>`
              )
              .join("")}
          </div>
        </details>`
      : history.length
        ? `<p class="quiet-note"><span class="icon">history</span> ${history.length} other day${history.length === 1 ? "" : "s"} had no notable news.</p>`
        : "";

    card.innerHTML = `
      <div class="card-top">
        <div>
          <h2>${escapeHtml(company.name)}</h2>
          ${latest ? `<time class="date">Updated: ${formatDate(latest.run_date)}</time>` : ""}
        </div>
        ${
          latest?.sources?.length
            ? `<span class="count-badge">${latest.sources.length} source${latest.sources.length === 1 ? "" : "s"}</span>`
            : ""
        }
      </div>
      ${
        latest
          ? `${officialSectionHtml(latest)}${chatterSectionHtml(latest)}`
          : `<p class="empty section">No summary yet.</p>`
      }
      ${footerHtml}
    `;

    card.style.transitionDelay = `${index * CARD_REVEAL_STAGGER_MS}ms`;
    grid.appendChild(card);
  }

  requestAnimationFrame(() => {
    for (const card of grid.children) card.classList.add("in");
  });
}

function setRefreshLabel(text, revertAfterMs) {
  refreshBtnLabel.textContent = text;
  if (revertAfterMs) {
    setTimeout(() => {
      refreshBtnLabel.textContent = "Refresh news";
      refreshBtn.disabled = false;
    }, revertAfterMs);
  }
}

async function triggerRefresh() {
  refreshBtn.disabled = true;
  setRefreshLabel("Refreshing…");

  try {
    const res = await fetch(`${window.SUPABASE_CONFIG.url}/functions/v1/refresh-news`, {
      method: "POST",
      headers: {
        apikey: window.SUPABASE_CONFIG.anonKey,
        Authorization: `Bearer ${window.SUPABASE_CONFIG.anonKey}`,
        "Content-Type": "application/json",
      },
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      setRefreshLabel("Triggered ✓ (~1-2 min)", 6000);
    } else if (res.status === 429) {
      const mins = Math.max(1, Math.ceil((data.retryAfterSeconds ?? 0) / 60));
      setRefreshLabel(`Refreshed recently — wait ~${mins}m`, 6000);
    } else {
      setRefreshLabel("Refresh failed", 6000);
    }
  } catch {
    setRefreshLabel("Refresh failed", 6000);
  }
}

refreshBtn.addEventListener("click", triggerRefresh);

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
    .select("company_id, run_date, summary, sources, chatter_summary, chatter_sources, created_at")
    .order("run_date", { ascending: false })
    .limit(200);

  if (summariesError) {
    renderError(`Failed to load summaries: ${summariesError.message}`);
    return;
  }

  if (summaries.length) {
    const latestCreatedAt = summaries.reduce(
      (max, row) => Math.max(max, new Date(row.created_at).getTime()),
      0
    );
    lastRefreshedEl.textContent = `Last refreshed: ${formatRelativeTime(new Date(latestCreatedAt))}`;
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
