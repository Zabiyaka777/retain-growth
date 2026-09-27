import type { Handler } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { GRAPH_API_VERSION } from "./_shared/instagram";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Deliberately inactive until the Meta Business App exists (ТЗ item 8: "не
// намагатись зареєструвати/верифікувати Meta App самостійно"). Nothing here
// can be exercised without these two — the function fails fast and clearly
// below rather than partially running. Once the app is confirmed, set these
// in Netlify env and the Settings.tsx Instagram card (currently disabled)
// can be turned on.
const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number };
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function graphGet<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`);
  const data = (await res.json().catch(() => null)) as (T & GraphErrorBody) | null;
  if (!res.ok || !data) return { ok: false, error: (data as GraphErrorBody | null)?.error?.message ?? `Graph API ${res.status}` };
  return { ok: true, data: data as T };
}

/**
 * OAuth callback for "Instagram API with Facebook Login" — the page-based
 * flow ТЗ item 7 and the SmartSender reference both describe: the business
 * connects a Facebook Page, and that Page's linked Instagram Business
 * Account is what actually sends/receives DMs. Mirrors connect-telegram.ts's
 * shape (verify → register webhook → Vault → channel_credentials upsert →
 * clean up the old secrets), swapped for Meta's multi-step token exchange.
 *
 * Frontend contract: after redirecting the user through Facebook's OAuth
 * dialog (scope: pages_show_list, pages_manage_metadata, pages_messaging,
 * instagram_basic, instagram_manage_messages, instagram_manage_comments —
 * confirm the exact scope list against the real app tomorrow), this receives
 * `{ code, redirectUri }` — redirectUri must be byte-identical to the one
 * used in the authorize URL, per OAuth spec.
 *
 * Known simplification, worth revisiting once this is actually testable:
 * picks the FIRST Facebook Page that has a linked Instagram Business
 * Account, rather than showing the user a picker when they manage several
 * pages. A multi-page picker is a real UI step SmartSender's flow has and
 * this doesn't yet.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  if (!META_APP_ID || !META_APP_SECRET) {
    console.error("connect-instagram: META_APP_ID/META_APP_SECRET не сконфігуровано");
    return jsonResponse(503, { error: "Instagram ще не підключено на рівні платформи — Meta App не сконфігуровано" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let code: string | undefined;
  let redirectUri: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    code = typeof body.code === "string" ? body.code : undefined;
    redirectUri = typeof body.redirectUri === "string" ? body.redirectUri : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }
  if (!code || !redirectUri) {
    return jsonResponse(400, { error: "code і redirectUri обов'язкові" });
  }

  // Every write below runs against the service role, deliberately never the
  // caller's own token — org_id is resolved server-side from their session,
  // never trusted from the request body (see CLAUDE.md: org_id scoping).
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) {
    return jsonResponse(401, { error: "Недійсна сесія" });
  }

  const { data: profile, error: profileError } = await supabase.from("profiles").select("org_id").eq("id", userData.user.id).single();
  if (profileError || !profile) {
    return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  }
  const orgId = profile.org_id as string;

  // Step 1: authorization code -> short-lived user access token.
  const shortLived = await graphGet<{ access_token?: string }>(
    `oauth/access_token?client_id=${encodeURIComponent(META_APP_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${encodeURIComponent(META_APP_SECRET)}&code=${encodeURIComponent(code)}`,
  );
  if (!shortLived.ok || !shortLived.data.access_token) {
    console.error("connect-instagram: code exchange failed", shortLived);
    return jsonResponse(400, { error: shortLived.ok ? "Facebook не повернув токен" : shortLived.error });
  }

  // Step 2: short-lived -> long-lived user token (~60 days; the Page tokens
  // derived from it in step 3 inherit that lifetime and don't expire while
  // the underlying grant is valid).
  const longLived = await graphGet<{ access_token?: string }>(
    `oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(META_APP_ID)}&client_secret=${encodeURIComponent(META_APP_SECRET)}&fb_exchange_token=${encodeURIComponent(shortLived.data.access_token)}`,
  );
  if (!longLived.ok || !longLived.data.access_token) {
    console.error("connect-instagram: token exchange failed", longLived);
    return jsonResponse(400, { error: longLived.ok ? "Facebook не повернув довгостроковий токен" : longLived.error });
  }
  const userToken = longLived.data.access_token;

  // Step 3: which Pages this user manages, each with its own Page access
  // token (what actually authenticates the send/webhook calls — never the
  // user token itself).
  const pages = await graphGet<{ data?: { id: string; access_token: string; name?: string }[] }>(`me/accounts?access_token=${encodeURIComponent(userToken)}`);
  if (!pages.ok || !pages.data.data?.length) {
    return jsonResponse(400, { error: pages.ok ? "Не знайдено жодної Facebook-сторінки, якою керує цей акаунт" : pages.error });
  }

  // Step 4: first Page with a linked Instagram Business Account (see the
  // "known simplification" note above the handler).
  let pageId: string | null = null;
  let pageAccessToken: string | null = null;
  let igBusinessAccountId: string | null = null;
  for (const page of pages.data.data) {
    const linked = await graphGet<{ instagram_business_account?: { id: string } }>(
      `${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(page.access_token)}`,
    );
    if (linked.ok && linked.data.instagram_business_account?.id) {
      pageId = page.id;
      pageAccessToken = page.access_token;
      igBusinessAccountId = linked.data.instagram_business_account.id;
      break;
    }
  }
  if (!pageId || !pageAccessToken || !igBusinessAccountId) {
    return jsonResponse(400, { error: "Жодна з ваших Facebook-сторінок не має підключеного Instagram Business Account" });
  }

  // Step 5: subscribe the Page to the webhook fields this integration reads
  // (see instagram-webhook.ts: messages/messaging_postbacks for DMs,
  // comments, mentions). Verify this exact field list against the real app
  // tomorrow — Meta's console also requires the app itself to be subscribed
  // to these fields at the product level, which only the App's own admin can
  // do, not this call.
  const subscribeRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,comments,mentions&access_token=${encodeURIComponent(pageAccessToken)}`, {
    method: "POST",
  });
  if (!subscribeRes.ok) {
    const failText = await subscribeRes.text();
    console.error("connect-instagram: subscribed_apps failed", failText);
    return jsonResponse(502, { error: "Не вдалося підписати сторінку на webhook-події" });
  }

  const siteUrl = process.env.URL;
  if (!siteUrl) {
    return jsonResponse(500, { error: "URL сайту не сконфігуровано" });
  }
  // Registered with Meta's own webhook config in the App dashboard (a manual,
  // one-time step per app, not per org — unlike Telegram's setWebhook, Meta
  // has no per-org webhook-URL API call). This verify token is what
  // instagram-webhook.ts's GET handler checks hub.verify_token against.
  const verifyToken = randomBytes(32).toString("hex");
  void `${siteUrl}/.netlify/functions/instagram-webhook/${orgId}`; // the URL to register, for the operator doing that manual step

  const { data: existing } = await supabase
    .from("channel_credentials")
    .select("access_token_secret_id, app_secret_secret_id, webhook_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", "instagram")
    .maybeSingle();

  // vault.secrets.name has a unique index — timestamp suffix only, same
  // reasoning as connect-telegram.ts (lookups always go through
  // channel_credentials.*_secret_id, never by name).
  const nameSuffix = Date.now();

  const { data: accessTokenSecretId, error: accessTokenSecretError } = await supabase.rpc("vault_create_secret", {
    secret: pageAccessToken,
    name: `instagram_page_token_${orgId}_${nameSuffix}`,
    description: "Instagram (Page access token)",
  });
  if (accessTokenSecretError || !accessTokenSecretId) {
    console.error("connect-instagram: vault_create_secret (page token) failed", accessTokenSecretError);
    return jsonResponse(500, { error: "Не вдалося зберегти токен" });
  }

  const { data: appSecretSecretId, error: appSecretError } = await supabase.rpc("vault_create_secret", {
    secret: META_APP_SECRET,
    name: `instagram_app_secret_${orgId}_${nameSuffix}`,
    description: "Instagram (Meta App secret, for webhook signature verification)",
  });
  if (appSecretError || !appSecretSecretId) {
    console.error("connect-instagram: vault_create_secret (app secret) failed", appSecretError);
    return jsonResponse(500, { error: "Не вдалося зберегти app secret" });
  }

  const { data: webhookSecretId, error: webhookSecretError } = await supabase.rpc("vault_create_secret", {
    secret: verifyToken,
    name: `instagram_webhook_verify_${orgId}_${nameSuffix}`,
    description: "Instagram webhook hub.verify_token",
  });
  if (webhookSecretError || !webhookSecretId) {
    console.error("connect-instagram: vault_create_secret (webhook verify token) failed", webhookSecretError);
    return jsonResponse(500, { error: "Не вдалося зберегти webhook-секрет" });
  }

  const { error: upsertError } = await supabase.from("channel_credentials").upsert(
    {
      org_id: orgId,
      channel_type: "instagram",
      access_token_secret_id: accessTokenSecretId,
      app_secret_secret_id: appSecretSecretId,
      webhook_secret_id: webhookSecretId,
      instagram_business_account_id: igBusinessAccountId,
      page_id: pageId,
    },
    { onConflict: "org_id,channel_type" },
  );
  if (upsertError) {
    console.error("connect-instagram: channel_credentials upsert failed", upsertError);
    return jsonResponse(500, { error: "Не вдалося зберегти інтеграцію" });
  }

  // Only now is the old row's reference gone, so deleting it no longer hits
  // the FK's NO ACTION restriction (channel_credentials.*_secret_id ->
  // vault.secrets) — same ordering connect-telegram.ts uses.
  for (const oldId of [existing?.access_token_secret_id, existing?.app_secret_secret_id, existing?.webhook_secret_id]) {
    if (!oldId) continue;
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: oldId });
    if (error) console.error("connect-instagram: vault_delete_secret (old secret) failed", error);
  }

  return jsonResponse(200, { ok: true, pageId, instagramBusinessAccountId: igBusinessAccountId });
};
