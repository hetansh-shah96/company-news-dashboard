// Public-facing "refresh news" trigger. Called anonymously from the dashboard
// button. Holds the GitHub token server-side so it never reaches the browser,
// and enforces a cooldown (by checking the workflow's own run history) so the
// button can't be spammed into burning through the Groq/NewsData quota.
const GITHUB_OWNER = "hetansh-shah96";
const GITHUB_REPO = "company-news-dashboard";
const WORKFLOW_FILE = "daily-news.yml";
const COOLDOWN_MS = 15 * 60 * 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const githubToken = Deno.env.get("GITHUB_PAT");
  if (!githubToken) {
    return jsonResponse({ error: "Server misconfigured: missing GITHUB_PAT" }, 500);
  }

  const githubHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "company-news-dashboard-refresh-fn",
  };

  const runsUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`;
  const runsRes = await fetch(runsUrl, { headers: githubHeaders });
  if (!runsRes.ok) {
    return jsonResponse(
      { error: `Failed to check recent runs: ${runsRes.status}` },
      502
    );
  }
  const runsData = await runsRes.json();
  const lastRun = runsData.workflow_runs?.[0];
  if (lastRun) {
    const lastRunAgeMs = Date.now() - new Date(lastRun.created_at).getTime();
    if (lastRunAgeMs < COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil((COOLDOWN_MS - lastRunAgeMs) / 1000);
      return jsonResponse(
        {
          error: "cooldown",
          message: "News was refreshed recently. Please try again shortly.",
          retryAfterSeconds,
        },
        429
      );
    }
  }

  const dispatchUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const dispatchRes = await fetch(dispatchUrl, {
    method: "POST",
    headers: { ...githubHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });

  if (!dispatchRes.ok) {
    const detail = await dispatchRes.text();
    return jsonResponse(
      { error: `Failed to trigger workflow: ${dispatchRes.status}`, detail },
      502
    );
  }

  return jsonResponse({
    ok: true,
    message: "Refresh triggered. New summaries usually take 1-2 minutes to appear.",
  });
});
