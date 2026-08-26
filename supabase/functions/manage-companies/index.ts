// Public-facing company list editor. Called anonymously from the dashboard's
// "Manage companies" panel. Holds the service_role key server-side so the
// browser's anon key stays read-only, per supabase/schema.sql.
//
// "Remove" deactivates rather than deletes, so historical news_summaries for
// that company (linked by company_id) are preserved and re-adding the same
// name reactivates it instead of erroring on the unique constraint.
import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_NAME_LEN = 80;
const MAX_ACTIVE_COMPANIES = 40;

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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server misconfigured: missing Supabase credentials" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  let body: { action?: string; id?: string; name?: string; search_query?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (body.action === "add") {
    const name = body.name?.trim();
    if (!name) return jsonResponse({ error: "Company name is required" }, 400);
    if (name.length > MAX_NAME_LEN) {
      return jsonResponse({ error: `Name must be under ${MAX_NAME_LEN} characters` }, 400);
    }
    const searchQuery = body.search_query?.trim() || name;

    const { count, error: countError } = await supabase
      .from("companies")
      .select("id", { count: "exact", head: true })
      .eq("active", true);
    if (countError) return jsonResponse({ error: countError.message }, 500);
    if ((count ?? 0) >= MAX_ACTIVE_COMPANIES) {
      return jsonResponse(
        { error: `Limit of ${MAX_ACTIVE_COMPANIES} tracked companies reached` },
        400
      );
    }

    const { data, error } = await supabase
      .from("companies")
      .upsert(
        { name, search_query: searchQuery, active: true },
        { onConflict: "name" }
      )
      .select("id, name, search_query, active")
      .single();

    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ ok: true, company: data });
  }

  if (body.action === "remove") {
    if (!body.id) return jsonResponse({ error: "Company id is required" }, 400);

    const { data, error } = await supabase
      .from("companies")
      .update({ active: false })
      .eq("id", body.id)
      .select("id, name")
      .single();

    if (error) return jsonResponse({ error: error.message }, 500);
    return jsonResponse({ ok: true, company: data });
  }

  return jsonResponse({ error: 'action must be "add" or "remove"' }, 400);
});
