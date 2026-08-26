// Public-facing general-purpose chatbot widget, backed by Groq. Holds
// GROQ_API_KEY server-side so it never reaches the browser. Since this
// endpoint is unauthenticated (anyone with the dashboard link can use it),
// input is capped here to keep cost/abuse bounded - this is a system
// boundary, not a user identity gate.
const GROQ_MODEL = "openai/gpt-oss-120b";
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LEN = 4000;
const MAX_TOKENS = 800;

const SYSTEM_PROMPT =
  "You are a helpful, concise assistant embedded in the Watchlist dashboard, a tool that tracks " +
  "daily news and social chatter for a list of companies. You can help with general questions, " +
  "but you do not have direct access to the dashboard's stored data - if asked about specific " +
  "company summaries, say so and suggest checking the dashboard cards directly.";

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

  const groqApiKey = Deno.env.get("GROQ_API_KEY");
  if (!groqApiKey) {
    return jsonResponse({ error: "Server misconfigured: missing GROQ_API_KEY" }, 500);
  }

  let body: { messages?: { role: string; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const messages = body.messages ?? [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: "messages array is required" }, 400);
  }
  if (messages.length > MAX_MESSAGES) {
    return jsonResponse({ error: `Too many messages (max ${MAX_MESSAGES})` }, 400);
  }
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") {
      return jsonResponse({ error: "Each message role must be 'user' or 'assistant'" }, 400);
    }
    if (typeof m.content !== "string" || !m.content.trim()) {
      return jsonResponse({ error: "Each message must have non-empty text content" }, 400);
    }
    if (m.content.length > MAX_MESSAGE_LEN) {
      return jsonResponse({ error: `Message too long (max ${MAX_MESSAGE_LEN} characters)` }, 400);
    }
  }

  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    }),
  });

  if (!groqRes.ok) {
    const detail = await groqRes.text();
    return jsonResponse({ error: `Groq API error ${groqRes.status}`, detail }, 502);
  }

  const data = await groqRes.json();
  const reply = data.choices?.[0]?.message?.content;
  if (!reply) {
    return jsonResponse({ error: "Groq returned no reply" }, 502);
  }

  return jsonResponse({ ok: true, reply });
});
