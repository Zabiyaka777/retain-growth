import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { SLUG_RE, normalizeLandingConfig } from "./_shared/landing-page";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=30" },
    body: JSON.stringify(body),
  };
}

// Public, unauthenticated: GET ?slug=… → the config of a *published* landing
// page. The anonymous visitor on /lp/:slug has no Supabase session, so this
// (service role, same pattern as redirect.ts) is their only way to the row.
// slug is globally unique (UNIQUE(slug)), so it alone finds the row. Links
// shared before that still carry ?org=<uuid>; it is ignored on purpose —
// neither checked nor used — so those links keep working unchanged.
// Nothing beyond template + display fields is returned; name/status/timestamps
// and org_id stay server-side, and the CAPI token lives in Vault behind
// meta_access_token_secret_id, which is why only the boolean `capi` derived
// from it is exposed.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method Not Allowed" });

  const params = event.queryStringParameters ?? {};
  const slug = (params.slug ?? "").toLowerCase();
  if (!SLUG_RE.test(slug)) return jsonResponse(404, { error: "Not found" });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data, error } = await supabase
    .from("landing_pages")
    .select("id, org_id, template_key, config, meta_access_token_secret_id, funnel_id, entry_node_id")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();

  if (error) console.error("landing-page-config: query failed", error);
  if (error || !data) return jsonResponse(404, { error: "Not found" });

  const config = normalizeLandingConfig(data.config);

  return jsonResponse(200, {
    templateKey: data.template_key,
    config,
    // The page routes its own visitors (landing-go.ts) — it only needs to know
    // whether a tunnel is set, never which one.
    routable: !!data.funnel_id && !!data.entry_node_id,
    // Tells the page whether to also report the view server-side; the token
    // itself never leaves the server.
    capi: !!data.meta_access_token_secret_id && !!config.fb_pixel_id,
  });
};
