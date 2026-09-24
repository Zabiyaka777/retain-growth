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

const CHANNELS = ["telegram", "whatsapp", "fbm"] as const;
type Channel = (typeof CHANNELS)[number];

function textResponse(statusCode: number, body: string) {
  return { statusCode, headers: { "content-type": "text/plain; charset=utf-8" }, body };
}

// Public, unauthenticated redirect endpoint: /r/:refToken?ch=telegram|whatsapp|fbm
// (plus any campaign query params, e.g. utm_source) — routed here via the
// netlify.toml rewrite. Every hit is logged before we know whether the
// channel redirect itself can succeed.
export const handler: Handler = async (event) => {
  const params = event.queryStringParameters ?? {};
  const channel = params.ch as Channel | undefined;

  // The netlify.toml rewrite invokes this function but leaves event.path as
  // the browser's original request (/r/<token>) — see the comment there.
  const refToken = event.path.split("/r/")[1]?.split("/")[0] || undefined;

  if (!refToken) {
    return textResponse(400, "Missing link token");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: link, error: linkError } = await supabase
    .from("lead_gen_links")
    .select("id, org_id, landing_pages ( slug, status )")
    .eq("ref_token", refToken)
    .maybeSingle();

  if (linkError || !link) {
    console.error("redirect: unknown ref_token", refToken, linkError);
    return textResponse(404, "Link not found");
  }

  // Second hop from a landing page: /r/:token?ch=…&click=<id>. The click was
  // already logged on the first hop, and its id is what the /start payload,
  // link_clicks row and meta-capi-send.ts attribution all hang on — so it's
  // reused verbatim, never re-minted. Must belong to this very link, otherwise
  // a guessed id could attach someone else's fbclid to this conversion.
  let clickId: string | null = null;
  if (params.click) {
    const { data: existingClick } = await supabase
      .from("link_clicks")
      .select("click_id")
      .eq("click_id", params.click)
      .eq("link_id", link.id)
      .maybeSingle();
    clickId = existingClick?.click_id ?? null;
  }

  if (!clickId) {
    // Identifies this one visit, not the link itself (ref_token can be clicked
    // many times) — carries its own fbclid/IP/UA so telegram-webhook.ts and
    // meta-capi-send.ts can build Meta's fbc parameter for this specific click.
    // Default nanoid's alphabet (A-Za-z0-9_-) is also what Telegram accepts in
    // a /start deep-link payload.
    clickId = nanoid(16);

    // x-forwarded-for can carry a client-IP,proxy-IP,... chain — the first hop
    // is the visitor. Netlify always sets this, so no other header is checked.
    const forwardedFor = event.headers["x-forwarded-for"] ?? event.headers["X-Forwarded-For"];
    const ip = forwardedFor?.split(",")[0]?.trim() || null;
    const userAgent = event.headers["user-agent"] ?? event.headers["User-Agent"] ?? null;
    const fbclid = params.fbclid ?? null;

    const { error: clickError } = await supabase.from("link_clicks").insert({
      link_id: link.id,
      org_id: link.org_id,
      click_id: clickId,
      captured_params: params,
      fbclid,
      ip,
      user_agent: userAgent,
    });
    if (clickError) console.error("redirect: failed to log click", clickError);
  }

  if (!channel || !CHANNELS.includes(channel)) {
    return textResponse(400, "Invalid or missing channel parameter");
  }

  // Optional warm-up page before the messenger. Only on the first hop (a
  // second hop carries ?click=, or ?lp=1 when the visitor opened the page
  // directly via its shareable link and so never had a click_id to carry —
  // without that flag the button would bounce them straight back onto the
  // page they just clicked from), only when the page is still published — a
  // link whose page went back to draft or was deleted behaves exactly like a
  // link that never had one. The public /lp route takes it from here and
  // sends the visitor back through /r/ with the same click_id.
  const landing = (link as unknown as { landing_pages: { slug: string; status: string } | null }).landing_pages;
  if (!params.click && !params.lp && landing?.status === "published") {
    const q = new URLSearchParams({ click: clickId, ch: channel, ref: refToken });
    // The page reports its own PageView/Lead to Meta and needs the ad click id
    // for fbc — it is otherwise only in link_clicks, which the page can't read.
    if (params.fbclid) q.set("fbclid", params.fbclid);
    return { statusCode: 302, headers: { Location: `/lp/${landing.slug}?${q.toString()}` }, body: "" };
  }

  if (channel !== "telegram") {
    // No phone-number/page-username storage exists for WhatsApp/FBM yet —
    // known limitation, same as the rest of the WhatsApp/FBM backend today.
    return textResponse(200, "Цей канал ще не підключено. Спробуйте, будь ласка, Telegram.");
  }

  const { data: credential, error: credentialError } = await supabase
    .from("channel_credentials")
    .select("bot_token_secret_id")
    .eq("org_id", link.org_id)
    .eq("channel_type", "telegram")
    .maybeSingle();

  if (credentialError || !credential) {
    console.error("redirect: no telegram credential for org", link.org_id, credentialError);
    return textResponse(200, "Telegram цієї організації ще не підключено.");
  }

  const { data: botToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.bot_token_secret_id,
  });

  if (tokenError || !botToken) {
    console.error("redirect: failed to decrypt bot token", tokenError);
    return textResponse(200, "Telegram цієї організації ще не підключено.");
  }

  let botUsername: string | null = null;
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const me = (await meRes.json()) as { result?: { username?: string } };
    botUsername = me.result?.username ?? null;
  } catch (err) {
    console.error("redirect: getMe failed", err);
  }

  if (!botUsername) {
    return textResponse(200, "Не вдалося визначити Telegram-бота цієї організації.");
  }

  return {
    statusCode: 302,
    // The deep-link payload is now the click_id, not the ref_token — see
    // telegram-webhook.ts, which resolves it back to this link_clicks row
    // (and falls back to ref_token matching for old-style copied links).
    headers: { Location: `https://t.me/${botUsername}?start=${encodeURIComponent(clickId)}` },
    body: "",
  };
};
