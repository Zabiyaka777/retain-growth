import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GRAPH_API_VERSION = "v19.0";

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface MetaCapiRequestBody {
  linkId?: string;
  pixelId?: string;
  channelType?: string | null;
  fbclid?: string | null;
  clickTimestampMs?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  eventSourceUrl?: string | null;
  eventId?: string | null;
  /** Standard ("Lead", "Purchase") or a custom name — Meta accepts both. */
  eventName?: string | null;
  /** Conversion amount; sent with `currency`, which Meta requires alongside it. */
  value?: number | null;
  currency?: string | null;
  /** When the conversion happened. Defaults to now. */
  eventTimeMs?: number | null;
}

// Meta refuses any event older than this, so a stale event_time is dropped
// before the request rather than sent to be rejected.
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Meta requires a currency whenever a value is present. Callers that track
// revenue in another currency pass it explicitly.
const DEFAULT_CURRENCY = "USD";

// Meta's "business_messaging" action_source requires messaging_channel to be
// one of exactly these three — all Meta-owned platforms, confirmed against
// https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging/,
// which is why sending it unconditionally got every event rejected with
// error_subcode 2804063 ("Missing Messaging Channel Parameter"): Telegram
// isn't in that list and never will be, it's not a Meta platform.
//
// whatsapp/fbm map onto it exactly (fbm = Meta's own Messenger). Telegram
// falls back to action_source "chat" — Meta's own general-purpose value for
// "conversion made via a messaging app" — which carries no such per-platform
// requirement, rather than mislabelling it as a Meta channel it isn't.
function actionSourceFor(channelType: string | null | undefined): {
  actionSource: "business_messaging" | "chat";
  messagingChannel?: "messenger" | "whatsapp";
} {
  if (channelType === "whatsapp") return { actionSource: "business_messaging", messagingChannel: "whatsapp" };
  if (channelType === "fbm") return { actionSource: "business_messaging", messagingChannel: "messenger" };
  return { actionSource: "chat" };
}

// fbc = fb.<subdomainIndex>.<creationTimeMs>.<fbclid> — subdomainIndex is
// always 1 for a standard (non-Facebook-subdomain-parked) landing page. See
// https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc
function buildFbc(clickTimestampMs: number, fbclid: string): string {
  return `fb.1.${clickTimestampMs}.${fbclid}`;
}

// Internal, service-to-service endpoint — called by funnel-graph.ts (never
// by the browser), same trust model as funnel-advance.ts: no bearer auth.
// Every credential lookup is scoped to one lead_gen_links row (linkId), not
// an org — each link carries its own independent System User token, so two
// links in the same org never share (or leak into) each other's requests.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  let body: MetaCapiRequestBody;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  const linkId = typeof body.linkId === "string" ? body.linkId : undefined;
  const pixelId = typeof body.pixelId === "string" ? body.pixelId : undefined;
  if (!linkId || !pixelId) {
    return jsonResponse(400, { error: "linkId і pixelId обов'язкові" });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: link, error: linkError } = await supabase
    .from("lead_gen_links")
    .select("org_id, meta_access_token_secret_id, meta_test_event_code")
    .eq("id", linkId)
    .maybeSingle();

  if (linkError || !link || !link.meta_access_token_secret_id) {
    // The caller (funnel-graph.ts) already checked this before invoking us —
    // reaching here regardless means the token was cleared in the gap
    // between that check and this call. Not worth its own event: the caller
    // logs meta_capi_skipped for the "no token" case already.
    console.error("meta-capi-send: no meta token on lead_gen_links row", linkId, linkError);
    return jsonResponse(200, { ok: false, reason: "no_token" });
  }

  const orgId = link.org_id as string;

  const { data: accessToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: link.meta_access_token_secret_id,
  });

  if (tokenError || !accessToken) {
    console.error("meta-capi-send: failed to decrypt System User token", tokenError);
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "meta_capi_failed",
      level: "error",
      payload: { reason: "token_decrypt_failed", link_id: linkId, pixel_id: pixelId },
    });
    if (eventError) console.error("meta-capi-send: events insert failed", eventError);
    return jsonResponse(200, { ok: false, reason: "token_decrypt_failed" });
  }

  const eventId = body.eventId || nanoid();
  const eventTimeMs = typeof body.eventTimeMs === "number" && Number.isFinite(body.eventTimeMs) ? body.eventTimeMs : Date.now();
  if (Date.now() - eventTimeMs > MAX_EVENT_AGE_MS) {
    console.error("meta-capi-send: event_time outside Meta's 7-day window, not sending", { eventTimeMs, linkId });
    return jsonResponse(200, { ok: false, reason: "event_time_too_old" });
  }
  const eventTimeSeconds = Math.floor(eventTimeMs / 1000);
  const eventName = typeof body.eventName === "string" && body.eventName.trim() ? body.eventName.trim() : "Lead";

  const { actionSource, messagingChannel } = actionSourceFor(body.channelType);

  const userData: Record<string, string> = {};
  // Discovered while verifying the messaging_channel fix live: Meta rejects
  // Lead events under business_messaging that carry fbc/client_ip_address/
  // client_user_agent at all (error_subcode 2804064, "remove all invalid
  // arguments ... fbc client_ip_address client_user_agent") — those are web-
  // event signals, and business_messaging events are matched by the actual
  // Messenger/WhatsApp thread identity instead. "chat" (Telegram) has no
  // such restriction, so it's the only action_source these are attached for.
  if (actionSource === "chat") {
    if (body.fbclid && body.clickTimestampMs) {
      userData.fbc = buildFbc(body.clickTimestampMs, body.fbclid);
    }
    if (body.ip) userData.client_ip_address = body.ip;
    if (body.userAgent) userData.client_user_agent = body.userAgent;
  }

  const eventPayload: Record<string, unknown> = {
    event_name: eventName,
    event_time: eventTimeSeconds,
    event_id: eventId,
    action_source: actionSource,
    user_data: userData,
  };
  if (messagingChannel) eventPayload.messaging_channel = messagingChannel;
  if (body.eventSourceUrl) eventPayload.event_source_url = body.eventSourceUrl;
  // custom_data carries the money. Meta requires a currency on value-bearing
  // event types even when no amount is known — a Purchase sent without one is
  // rejected outright (error_subcode 2804010), so currency always rides along
  // and `value` is added only when there actually is an amount.
  const customData: Record<string, unknown> = {
    currency: (typeof body.currency === "string" && body.currency.trim()) || DEFAULT_CURRENCY,
  };
  if (typeof body.value === "number" && Number.isFinite(body.value)) customData.value = body.value;
  eventPayload.custom_data = customData;

  const graphPayload: Record<string, unknown> = { data: [eventPayload], access_token: accessToken };
  // Meta only routes to Test Events (visible immediately in Events Manager,
  // instead of waiting for normal aggregation) when this is present — set
  // per link, since different campaigns are often tested independently.
  if (link.meta_test_event_code) graphPayload.test_event_code = link.meta_test_event_code;

  const graphUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pixelId}/events`;

  // test_event_code must be a top-level sibling of `data`, not nested inside
  // it — logged here (token redacted) specifically so that's checkable from
  // the raw request, not just inferred from behavior.
  // JSON.stringify, not a plain object — console.log's default inspect depth
  // collapses nested objects/arrays (data: [ [Object] ]) after 2 levels, which
  // hid exactly the fields (event_name, action_source, messaging_channel,
  // user_data, test_event_code placement) this log exists to show.
  console.log(
    "meta-capi-send: outgoing request",
    JSON.stringify({ url: graphUrl, payload: { ...graphPayload, access_token: "[redacted]" } }, null, 2),
  );

  try {
    const res = await fetch(graphUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(graphPayload),
    });

    const responseBody = await res.json().catch(() => null);

    // Logged unconditionally — a 200 can still be worth inspecting
    // (events_received, test_events_result, fbtrace_id), and previously only
    // failures ever reached the log at all.
    console.log("meta-capi-send: Graph API response", { status: res.status, ok: res.ok, body: responseBody });

    if (!res.ok) {
      console.error("meta-capi-send: Graph API rejected event", res.status, responseBody);
      const { error: eventError } = await supabase.from("events").insert({
        org_id: orgId,
        type: "meta_capi_failed",
        level: "error",
        payload: { status: res.status, response: responseBody, link_id: linkId, pixel_id: pixelId, event_id: eventId },
      });
      if (eventError) console.error("meta-capi-send: events insert failed", eventError);
      return jsonResponse(200, { ok: false, reason: "graph_api_error", status: res.status });
    }

    return jsonResponse(200, { ok: true, eventId, response: responseBody });
  } catch (err) {
    console.error("meta-capi-send: fetch to Graph API failed", err);
    const { error: eventError } = await supabase.from("events").insert({
      org_id: orgId,
      type: "meta_capi_failed",
      level: "error",
      payload: { reason: "network_error", link_id: linkId, pixel_id: pixelId, event_id: eventId },
    });
    if (eventError) console.error("meta-capi-send: events insert failed", eventError);
    return jsonResponse(200, { ok: false, reason: "network_error" });
  }
};
