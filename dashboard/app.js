const { createClient } = window.supabase;
const client = createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

const app = document.getElementById("app");
const lastRefreshedEl = document.getElementById("lastRefreshed");
const refreshBtn = document.getElementById("refreshBtn");
const refreshBtnLabel = document.getElementById("refreshBtnLabel");
const downloadBtn = document.getElementById("downloadBtn");

const printReportEl = document.getElementById("printReport");

const manageBtn = document.getElementById("manageBtn");
const manageModal = document.getElementById("manageModal");
const manageCloseBtn = document.getElementById("manageCloseBtn");
const addCompanyForm = document.getElementById("addCompanyForm");
const addCompanyName = document.getElementById("addCompanyName");
const addCompanyQuery = document.getElementById("addCompanyQuery");
const manageList = document.getElementById("manageList");
const manageError = document.getElementById("manageError");

const chatToggleBtn = document.getElementById("chatToggleBtn");
const chatPanel = document.getElementById("chatPanel");
const chatCloseBtn = document.getElementById("chatCloseBtn");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

let loadedCompanies = [];
let loadedSummariesByCompany = new Map();

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

// Newer summaries come back as "- point one\n- point two" bullet lines; older
// rows stored before this format still have a single paragraph. Render
// whichever shape the text actually has instead of forcing one or the other.
function summaryBlockHtml(text, className) {
  const lines = (text ?? "")
    .split(/\r?\n+/)
    .map((line) => line.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean);

  if (lines.length > 1) {
    return `<ul class="${className}">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
  }
  return `<p class="${className}">${escapeHtml(text)}</p>`;
}

function officialSectionHtml(row) {
  return `
    <div class="section">
      <p class="section-label"><span class="icon">newspaper</span>Official news</p>
      ${summaryBlockHtml(row.summary, "summary")}
      ${row.sources?.length ? tagRowHtml(row.sources, "", "source_name") : ""}
    </div>`;
}

function chatterSectionHtml(row) {
  if (!row.chatter_summary) return "";
  return `
    <div class="section chatter-block">
      <p class="section-label chatter-label"><span class="icon">forum</span>Social chatter · unverified</p>
      ${summaryBlockHtml(row.chatter_summary, "summary chatter-summary")}
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

    const card = document.createElement("article");
    card.className = "company-card";

    const footerHtml = notableHistory.length
      ? `<details class="history">
          <summary>
            <span class="icon">history</span>
            ${notableHistory.length} notable day${notableHistory.length === 1 ? "" : "s"} in history
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
      : "";

    card.innerHTML = `
      <div class="card-top">
        <div>
          <h2>${escapeHtml(company.name)}</h2>
          ${latest ? `<time class="date">Updated: ${formatDate(latest.run_date)}</time>` : ""}
        </div>
        <div class="card-top-actions">
          ${
            latest?.sources?.length
              ? `<span class="count-badge">${latest.sources.length} source${latest.sources.length === 1 ? "" : "s"}</span>`
              : ""
          }
          <button
            class="card-pdf-btn"
            type="button"
            data-company-id="${company.id}"
            title="Download PDF for ${escapeHtml(company.name)}"
            aria-label="Download PDF for ${escapeHtml(company.name)}"
          >
            <span class="icon">picture_as_pdf</span>
          </button>
        </div>
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

function reportCompanySectionHtml(company, summaries) {
  const latest = summaries[0];
  const history = summaries.slice(1).filter(hasContent);

  if (!latest) {
    return `
      <section class="report-company">
        <h2>${escapeHtml(company.name)}</h2>
        <p class="report-empty">No summary yet.</p>
      </section>`;
  }

  const historyHtml = history.length
    ? `<div class="report-history">
        <p class="report-history-label">Earlier notable days</p>
        ${history
          .map(
            (h) => `
          <div class="report-history-item">
            <time>${formatDate(h.run_date)}</time>
            ${officialSectionHtml(h)}
            ${chatterSectionHtml(h)}
          </div>`
          )
          .join("")}
      </div>`
    : "";

  return `
    <section class="report-company">
      <h2>${escapeHtml(company.name)}<time>Updated ${formatDate(latest.run_date)}</time></h2>
      ${officialSectionHtml(latest)}
      ${chatterSectionHtml(latest)}
      ${historyHtml}
    </section>`;
}

function buildAndPrintReport(companies, subtitle) {
  if (!companies.length) return;

  const generatedAt = new Date().toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  printReportEl.innerHTML = `
    <header class="report-header">
      <h1>Watchlist</h1>
      <p>${subtitle} · Generated ${generatedAt}</p>
    </header>
    ${companies
      .map((company) => reportCompanySectionHtml(company, loadedSummariesByCompany.get(company.id) ?? []))
      .join("")}
  `;

  const titleSuffix = companies.length === 1 ? companies[0].name : "Report";
  document.title = `Watchlist ${titleSuffix} - ${new Date().toISOString().slice(0, 10)}`;
  window.print();
  document.title = "Watchlist";
}

function downloadPdf() {
  buildAndPrintReport(loadedCompanies, "Daily Market Report");
}

function downloadCompanyPdf(companyId) {
  const company = loadedCompanies.find((c) => c.id === companyId);
  if (!company) return;
  buildAndPrintReport([company], `${company.name} Report`);
}

downloadBtn.addEventListener("click", downloadPdf);

app.addEventListener("click", (event) => {
  const btn = event.target.closest(".card-pdf-btn");
  if (!btn) return;
  downloadCompanyPdf(btn.dataset.companyId);
});

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

  loadedCompanies = companies;

  const summariesByCompany = new Map();
  for (const row of summaries) {
    if (!summariesByCompany.has(row.company_id)) {
      summariesByCompany.set(row.company_id, []);
    }
    summariesByCompany.get(row.company_id).push(row);
  }

  loadedSummariesByCompany = summariesByCompany;

  renderCompanies(companies, summariesByCompany);
  renderManageList();
}

function renderManageList() {
  manageList.innerHTML = loadedCompanies
    .map(
      (c) => `
        <li>
          <span>${escapeHtml(c.name)}</span>
          <button class="icon-btn manage-remove-btn" type="button" data-company-id="${c.id}" aria-label="Remove ${escapeHtml(c.name)}">
            <span class="icon">delete</span>
          </button>
        </li>`
    )
    .join("");
}

function showManageError(message) {
  manageError.textContent = message;
  manageError.classList.remove("hidden");
}

function openManageModal() {
  manageError.classList.add("hidden");
  manageModal.classList.remove("hidden");
  addCompanyName.focus();
}

function closeManageModal() {
  manageModal.classList.add("hidden");
}

manageBtn.addEventListener("click", openManageModal);
manageCloseBtn.addEventListener("click", closeManageModal);
manageModal.addEventListener("click", (event) => {
  if (event.target === manageModal) closeManageModal();
});

addCompanyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  manageError.classList.add("hidden");

  const name = addCompanyName.value.trim();
  if (!name) return;

  const submitBtn = addCompanyForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;

  try {
    const res = await fetch(`${window.SUPABASE_CONFIG.url}/functions/v1/manage-companies`, {
      method: "POST",
      headers: {
        apikey: window.SUPABASE_CONFIG.anonKey,
        Authorization: `Bearer ${window.SUPABASE_CONFIG.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "add",
        name,
        search_query: addCompanyQuery.value.trim() || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showManageError(data.error ?? "Failed to add company");
      return;
    }

    addCompanyForm.reset();
    await load();
  } catch {
    showManageError("Failed to add company - check your connection");
  } finally {
    submitBtn.disabled = false;
  }
});

manageList.addEventListener("click", async (event) => {
  const btn = event.target.closest(".manage-remove-btn");
  if (!btn) return;
  btn.disabled = true;

  try {
    const res = await fetch(`${window.SUPABASE_CONFIG.url}/functions/v1/manage-companies`, {
      method: "POST",
      headers: {
        apikey: window.SUPABASE_CONFIG.anonKey,
        Authorization: `Bearer ${window.SUPABASE_CONFIG.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "remove", id: btn.dataset.companyId }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showManageError(data.error ?? "Failed to remove company");
      btn.disabled = false;
      return;
    }

    await load();
  } catch {
    showManageError("Failed to remove company - check your connection");
    btn.disabled = false;
  }
});

let chatHistory = [];

const CHAT_SUGGESTIONS = [
  "Any major news today?",
  "Summarize today's chatter across all companies",
  "Which company has the most unverified rumors right now?",
  "Any risky or notable allegations to flag?",
];

function buildDashboardContext() {
  if (!loadedCompanies.length) return "";

  return loadedCompanies
    .map((company) => {
      const latest = (loadedSummariesByCompany.get(company.id) ?? [])[0];
      if (!latest) return `${company.name}: no summary yet.`;
      return (
        `${company.name} (updated ${latest.run_date}):\n` +
        `  Official news: ${latest.summary}\n` +
        `  Social chatter (unverified): ${latest.chatter_summary ?? "none"}`
      );
    })
    .join("\n\n");
}

// The model is told not to use Markdown, but instruction-following isn't
// airtight - clean up common leftovers defensively rather than trusting it.
// Builds real DOM nodes (never innerHTML with model output) so this can't
// become an injection vector.
function stripMarkdownArtifacts(text) {
  return text
    .split("\n")
    .map((line) => {
      if (/^[\s|:-]+$/.test(line) && line.includes("-")) return ""; // table separator row
      return line
        .replace(/^#{1,6}\s+/, "") // headers
        .replace(/^\s*\|\s?/, "") // leading table pipe
        .replace(/\s?\|\s*$/, "") // trailing table pipe
        .replace(/\s*\|\s*/g, "  "); // inner table pipes
    })
    .join("\n");
}

function renderMessageText(container, text) {
  container.textContent = "";
  const clean = stripMarkdownArtifacts(text);
  const parts = clean.split(/\*\*(.+?)\*\*/g);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      const strong = document.createElement("strong");
      strong.textContent = part;
      container.appendChild(strong);
    } else {
      container.appendChild(document.createTextNode(part));
    }
  });
}

function appendChatMessage(role, text) {
  const bubble = document.createElement("div");
  bubble.className = `chat-message chat-message-${role}`;
  renderMessageText(bubble, text);
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

function renderChatSuggestions() {
  const wrap = document.createElement("div");
  wrap.className = "chat-suggestions";
  wrap.innerHTML = CHAT_SUGGESTIONS.map(
    (s) => `<button type="button" class="chat-suggestion-btn">${escapeHtml(s)}</button>`
  ).join("");
  chatMessages.appendChild(wrap);
}

function clearChatSuggestions() {
  chatMessages.querySelector(".chat-suggestions")?.remove();
}

async function sendChatMessage(text) {
  clearChatSuggestions();
  chatInput.disabled = true;
  appendChatMessage("user", text);
  chatHistory.push({ role: "user", content: text });
  const pending = appendChatMessage("assistant", "…");

  try {
    const res = await fetch(`${window.SUPABASE_CONFIG.url}/functions/v1/chat`, {
      method: "POST",
      headers: {
        apikey: window.SUPABASE_CONFIG.anonKey,
        Authorization: `Bearer ${window.SUPABASE_CONFIG.anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: chatHistory.slice(-20), context: buildDashboardContext() }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      renderMessageText(pending, data.error ?? "Something went wrong. Please try again.");
      return;
    }

    renderMessageText(pending, data.reply);
    chatHistory.push({ role: "assistant", content: data.reply });
  } catch {
    renderMessageText(pending, "Couldn't reach the assistant - check your connection.");
  } finally {
    chatInput.disabled = false;
    chatInput.focus();
  }
}

function openChat() {
  chatPanel.classList.remove("hidden");
  if (!chatHistory.length) renderChatSuggestions();
  chatInput.focus();
}

function closeChat() {
  chatPanel.classList.add("hidden");
}

chatToggleBtn.addEventListener("click", () => {
  if (chatPanel.classList.contains("hidden")) openChat();
  else closeChat();
});
chatCloseBtn.addEventListener("click", closeChat);

chatMessages.addEventListener("click", (event) => {
  const btn = event.target.closest(".chat-suggestion-btn");
  if (!btn) return;
  sendChatMessage(btn.textContent);
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  sendChatMessage(text);
});

load();
