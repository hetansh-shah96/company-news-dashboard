// Called by Vercel Cron on a schedule (see ../vercel.json). Does exactly what
// the dashboard's "Refresh news" button does client-side: POST to the
// refresh-news Edge Function, which holds the GitHub PAT server-side,
// enforces its own 15-minute cooldown, and dispatches daily-news.yml.
//
// Same anon key as config.js — it's the public, read-only-restricted key
// that's already safe to expose in the browser, so hardcoding it here (a
// server-side file, not shipped to the client) is no less safe.
const SUPABASE_URL = "https://lemvsplirtgkbmduraea.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_nXltXzf1Vs01H_f1kSDaXA_r7RukMPW";

module.exports = async (req, res) => {
  // Optional hardening: if a CRON_SECRET env var is set on the Vercel
  // project, Vercel automatically sends it as this header on cron-triggered
  // requests — reject anything else. Skipped entirely if the env var isn't
  // set, so this works with zero extra config too.
  if (process.env.CRON_SECRET) {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  try {
    const upstream = await fetch(`${SUPABASE_URL}/functions/v1/refresh-news`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
    });
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "Failed to reach refresh-news", detail: String(err) });
  }
};
