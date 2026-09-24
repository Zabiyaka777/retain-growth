import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { RESERVED_SLUGS, SLUG_RE } from "./_shared/landing-page";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

// Public: GET ?slug=… → { available }. Slugs are global since UNIQUE(slug),
// and landing_pages is RLS-scoped to the caller's own org, so the editor can't
// see another org's slugs itself — this answers the one yes/no it needs while
// typing, like a username check. Deliberately nothing else: not whose it is,
// not whether it's published, not why it's unavailable. Invalid and reserved
// slugs are simply "not available" (the form explains those from its own copy
// of the rules). The editor skips the call for the page's own current slug.
// save-landing-page.ts still enforces all of it; this is only the live hint.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method Not Allowed" });

  const slug = (event.queryStringParameters?.slug ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) return jsonResponse(200, { available: false });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await supabase.from("landing_pages").select("id").eq("slug", slug).limit(1);
  if (error) {
    console.error("check-landing-slug: query failed", error);
    return jsonResponse(500, { error: "Не вдалося перевірити адресу" });
  }
  return jsonResponse(200, { available: data.length === 0 });
};
