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
const GRAPH_API_VERSION = "v19.0";
const FBC_RE = /^fb\.\d\.\d{10,13}\.[\w-]{1,500}$/;
const FBP_RE = /^fb\.\d\.\d{10,13}\.\d{1,20}$/;

// Server-side PageView / Lead for a landing page's *own* pixel — the landing
// page's conversion pipeline, independent of any lead-gen link. Deliberately
// separate from meta-capi-send.ts: that one is keyed to a lead_gen_links row
// (its token, its test code) and takes the pixel id from its caller, which is
// fine for funnel-graph.ts on the server but would let any browser fire events
// into any pixel with a link's token. Here the pixel id and the token both
// come from the published page's own row, so the browser can only ever report
// "this page was viewed / its button was clicked".
//   PageView — on load, mirroring the browser pixel's PageView.
//   Lead     — on a CTA click, mirroring the browser pixel's Lead.
// Both share their event_id with the browser event so Meta deduplicates. Public and unauthenticated (the visitor has no
// session), and it can only ever fire for a published page that has both a
// pixel id in its config and a token in Vault.
//
// Always answers 200: a reporting failure must never look like a broken page.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };

  let body: { slug?: string; eventName?: string; eventId?: string; fbclid?: string; fbp?: string; fbc?: string; url?: string };
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 200, body: "{}" };
  }

  const eventName = body.eventName === "Lead" ? "Lead" : "PageView";
  // slug is globally unique; an `org` sent by an older cached page is ignored.
  const slug = (body.slug ?? "").toLowerCase();
  if (!SLUG_RE.test(slug)) return { statusCode: 200, body: "{}" };

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: page } = await supabase
    .from("landing_pages")
    .select("config, meta_access_token_secret_id")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();

  if (!page?.meta_access_token_secret_id) return { statusCode: 200, body: "{}" };

  const config = normalizeLandingConfig(page.config);
  if (!config.fb_pixel_id) return { statusCode: 200, body: "{}" };

  const { data: token } = await supabase.rpc("vault_read_secret", { secret_id: page.meta_access_token_secret_id });
  if (!token) return { statusCode: 200, body: "{}" };

  // x-forwarded-for can carry a client-IP,proxy-IP,... chain — the first hop
  // is the visitor (same handling as redirect.ts).
  const forwardedFor = event.headers["x-forwarded-for"] ?? event.headers["X-Forwarded-For"];
  const userData: Record<string, unknown> = {
    client_ip_address: forwardedFor?.split(",")[0]?.trim() || undefined,
    client_user_agent: event.headers["user-agent"] ?? event.headers["User-Agent"] ?? undefined,
  };
  // fbc = fb.<subdomainIndex>.<creationTimeMs>.<fbclid>, see
  // https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc
  // The _fbc cookie wins: it carries the time of the original ad click, which
  // a value rebuilt from fbclid here would replace with "now".
  const fbc = typeof body.fbc === "string" && FBC_RE.test(body.fbc) ? body.fbc : "";
  const fbclid = typeof body.fbclid === "string" ? body.fbclid.slice(0, 500) : "";
  if (fbc) userData.fbc = fbc;
  else if (fbclid) userData.fbc = `fb.1.${Date.now()}.${fbclid}`;
  if (typeof body.fbp === "string" && FBP_RE.test(body.fbp)) userData.fbp = body.fbp;

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        // Shared with the browser pixel's own PageView so Meta deduplicates
        // the two reports of the same view instead of double-counting.
        event_id: typeof body.eventId === "string" ? body.eventId.slice(0, 64) : undefined,
        event_source_url: typeof body.url === "string" ? body.url.slice(0, 1024) : undefined,
        action_source: "website",
        user_data: userData,
      },
    ],
  };

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${config.fb_pixel_id}/events?access_token=${encodeURIComponent(String(token))}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error("landing-page-view: CAPI rejected", res.status, await res.text());
  } catch (err) {
    console.error("landing-page-view: CAPI request failed", err);
  }

  return { statusCode: 200, body: "{}" };
};
