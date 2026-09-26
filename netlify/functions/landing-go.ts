import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import { SLUG_RE } from "./_shared/landing-page";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const CHANNELS = ["telegram", "whatsapp", "fbm"] as const;
type Channel = (typeof CHANNELS)[number];

// Params that steer this endpoint itself; everything else the visitor arrived
// on the landing with (fbclid, utm_*) is kept as the click's captured_params.
const OWN_PARAMS = new Set(["slug", "ch"]);

function textResponse(statusCode: number, body: string) {
  return { statusCode, headers: { "content-type": "text/plain; charset=utf-8" }, body };
}

// Public, unauthenticated: a messenger button on a landing page points here.
// The landing routes its own visitors — it carries its own funnel + entry
// point (landing_pages.funnel_id / entry_node_id) and has nothing to do with
// lead-gen links (/r/). This logs the click, then sends the visitor into the
// org's Telegram bot with the click_id as the /start payload; telegram-webhook
// resolves that id back to this landing and enrolls the lead into its funnel.
export const handler: Handler = async (event) => {
  const params = event.queryStringParameters ?? {};
  const slug = (params.slug ?? "").toLowerCase();
  const channel = params.ch as Channel | undefined;

  if (!SLUG_RE.test(slug)) return textResponse(404, "Landing not found");
  if (!channel || !CHANNELS.includes(channel)) return textResponse(400, "Invalid or missing channel parameter");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: landing, error: landingError } = await supabase
    .from("landing_pages")
    .select("id, org_id")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();

  if (landingError || !landing) {
    if (landingError) console.error("landing-go: landing lookup failed", landingError);
    return textResponse(404, "Landing not found");
  }

  if (channel !== "telegram") {
    // Same known limitation as redirect.ts: no phone-number/page-username
    // storage exists for WhatsApp/FBM yet.
    return textResponse(200, "Цей канал ще не підключено. Спробуйте, будь ласка, Telegram.");
  }

  const { data: credential, error: credentialError } = await supabase
    .from("channel_credentials")
    .select("bot_token_secret_id")
    .eq("org_id", landing.org_id)
    .eq("channel_type", "telegram")
    .maybeSingle();

  if (credentialError || !credential) {
    console.error("landing-go: no telegram credential for org", landing.org_id, credentialError);
    return textResponse(200, "Telegram цієї організації ще не підключено.");
  }

  const { data: botToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.bot_token_secret_id,
  });

  if (tokenError || !botToken) {
    console.error("landing-go: failed to decrypt bot token", tokenError);
    return textResponse(200, "Telegram цієї організації ще не підключено.");
  }

  let botUsername: string | null = null;
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const me = (await meRes.json()) as { result?: { username?: string } };
    botUsername = me.result?.username ?? null;
  } catch (err) {
    console.error("landing-go: getMe failed", err);
  }

  if (!botUsername) return textResponse(200, "Не вдалося визначити Telegram-бота цієї організації.");

  // Default nanoid alphabet (A-Za-z0-9_-) is also what Telegram accepts in a
  // /start deep-link payload.
  const clickId = nanoid(16);

  // x-forwarded-for can carry a client-IP,proxy-IP,... chain — the first hop is the visitor.
  const forwardedFor = event.headers["x-forwarded-for"] ?? event.headers["X-Forwarded-For"];
  const ip = forwardedFor?.split(",")[0]?.trim() || null;
  const userAgent = event.headers["user-agent"] ?? event.headers["User-Agent"] ?? null;
  const captured = Object.fromEntries(Object.entries(params).filter(([k]) => !OWN_PARAMS.has(k)));

  const { error: clickError } = await supabase.from("landing_clicks").insert({
    org_id: landing.org_id,
    landing_page_id: landing.id,
    click_id: clickId,
    captured_params: captured,
    fbclid: typeof captured.fbclid === "string" ? captured.fbclid : null,
    ip,
    user_agent: userAgent,
  });
  // A lost click row only costs attribution — the visitor still gets to the bot.
  if (clickError) console.error("landing-go: failed to log click", clickError);

  return {
    statusCode: 302,
    headers: { Location: `https://t.me/${botUsername}?start=${encodeURIComponent(clickId)}` },
    body: "",
  };
};
