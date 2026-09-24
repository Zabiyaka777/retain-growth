import type { Handler } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { GRAPH_API_VERSION, type GraphErrorBody } from "./_shared/whatsapp";

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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface PhoneNumberResponse extends GraphErrorBody {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
}

interface WabaResponse extends GraphErrorBody {
  whatsapp_business_account?: { id?: string };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessTokenHeader = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessTokenHeader) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let waToken: string | undefined;
  let phoneNumberId: string | undefined;
  let appSecret: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    waToken = typeof body.accessToken === "string" ? body.accessToken.trim() : undefined;
    phoneNumberId = typeof body.phoneNumberId === "string" ? body.phoneNumberId.trim() : undefined;
    appSecret = typeof body.appSecret === "string" ? body.appSecret.trim() : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  // The app secret is required, not optional: without it no incoming webhook
  // POST can be verified, and an unverifiable webhook would accept forged
  // inbound messages from anyone who knows the org id.
  if (!waToken || !phoneNumberId || !appSecret) {
    return jsonResponse(400, { error: "accessToken, phoneNumberId і appSecret обов'язкові" });
  }

  // org_id is resolved server-side from the caller's session — never trusted
  // from the request body (see CLAUDE.md: org_id scoping).
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(accessTokenHeader);
  if (userError || !userData.user) {
    return jsonResponse(401, { error: "Недійсна сесія" });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile) {
    return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  }

  const orgId = profile.org_id as string;

  // Lightweight validation call — the WhatsApp equivalent of Telegram's
  // getMe: reads the number back, which fails if either the token or the
  // phone number id is wrong, without sending anything to anyone.
  const numberRes = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name`,
    { headers: { authorization: `Bearer ${waToken}` } },
  );
  const numberData = (await numberRes.json().catch(() => null)) as PhoneNumberResponse | null;

  if (!numberRes.ok || !numberData?.id) {
    console.error("whatsapp-connect: phone number lookup failed", numberRes.status, numberData);
    return jsonResponse(400, {
      error: numberData?.error?.message ?? "Не вдалося перевірити номер — перевірте токен і Phone Number ID",
    });
  }

  const displayNumber = numberData.display_phone_number ?? "";
  const verifiedName = numberData.verified_name ?? "";

  // The WABA the number belongs to. Not fatal if it can't be read (the token
  // may be scoped to the number only) — it's stored for template management,
  // which then reports the gap instead of this connection failing.
  let wabaId: string | null = null;
  const wabaRes = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}?fields=whatsapp_business_account`,
    { headers: { authorization: `Bearer ${waToken}` } },
  );
  const wabaData = (await wabaRes.json().catch(() => null)) as WabaResponse | null;
  if (wabaRes.ok && wabaData?.whatsapp_business_account?.id) {
    wabaId = wabaData.whatsapp_business_account.id;
  } else {
    console.error("whatsapp-connect: WABA lookup failed (non-fatal)", wabaRes.status, wabaData);
  }

  const siteUrl = process.env.URL;
  if (!siteUrl) {
    return jsonResponse(500, { error: "URL сайту не сконфігуровано" });
  }

  // Same shape as the Telegram secret: echoed back by Meta on every webhook
  // call so whatsapp-webhook.ts can reject anything that didn't come from
  // them before touching the database.
  const webhookSecret = randomBytes(32).toString("hex");
  const webhookUrl = `${siteUrl}/.netlify/functions/whatsapp-webhook/${orgId}`;

  // Subscribing the number's app to message webhooks. Unlike Telegram's
  // setWebhook, the callback URL and verify token are configured once on the
  // Meta app itself, not per-call — this only tells Meta to start delivering
  // this number's events to the app.
  const subscribeRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/subscribed_apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${waToken}` },
  });
  const subscribeData = (await subscribeRes.json().catch(() => null)) as GraphErrorBody | null;

  if (!subscribeRes.ok) {
    console.error("whatsapp-connect: subscribed_apps failed", subscribeRes.status, subscribeData);
    return jsonResponse(502, {
      error: subscribeData?.error?.message ?? "Не вдалося підписати номер на webhook",
    });
  }

  const { data: existing } = await supabase
    .from("channel_credentials")
    .select("access_token_secret_id, webhook_secret_id, app_secret_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", "whatsapp")
    .maybeSingle();

  // See connect-telegram.ts: vault.secrets.name is uniquely indexed and is
  // only a label, so a timestamp suffix keeps reconnects from colliding with
  // the still-live old secret.
  const nameSuffix = Date.now();

  const { data: tokenSecretId, error: tokenSecretError } = await supabase.rpc("vault_create_secret", {
    secret: waToken,
    name: `whatsapp_access_token_${orgId}_${nameSuffix}`,
    description: "WhatsApp Cloud API access token",
  });

  if (tokenSecretError || !tokenSecretId) {
    console.error("whatsapp-connect: vault_create_secret (access token) failed", tokenSecretError);
    return jsonResponse(500, { error: "Не вдалося зберегти токен" });
  }

  const { data: webhookSecretId, error: webhookSecretError } = await supabase.rpc("vault_create_secret", {
    secret: webhookSecret,
    name: `whatsapp_webhook_secret_${orgId}_${nameSuffix}`,
    description: "WhatsApp webhook verify token",
  });

  if (webhookSecretError || !webhookSecretId) {
    console.error("whatsapp-connect: vault_create_secret (webhook secret) failed", webhookSecretError);
    return jsonResponse(500, { error: "Не вдалося зберегти webhook-секрет" });
  }

  const { data: appSecretId, error: appSecretError } = await supabase.rpc("vault_create_secret", {
    secret: appSecret,
    name: `whatsapp_app_secret_${orgId}_${nameSuffix}`,
    description: "Meta app secret for WhatsApp webhook signature",
  });

  if (appSecretError || !appSecretId) {
    console.error("whatsapp-connect: vault_create_secret (app secret) failed", appSecretError);
    return jsonResponse(500, { error: "Не вдалося зберегти app secret" });
  }

  const { error: upsertError } = await supabase.from("channel_credentials").upsert(
    {
      org_id: orgId,
      channel_type: "whatsapp",
      access_token_secret_id: tokenSecretId,
      webhook_secret_id: webhookSecretId,
      app_secret_secret_id: appSecretId,
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
    },
    { onConflict: "org_id,channel_type" },
  );

  if (upsertError) {
    console.error("whatsapp-connect: channel_credentials upsert failed", upsertError);
    return jsonResponse(500, { error: "Не вдалося зберегти інтеграцію" });
  }

  // Only now is the old row's reference gone, so deleting the previous
  // secrets no longer hits the FK's NO ACTION restriction.
  if (existing?.access_token_secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: existing.access_token_secret_id });
    if (error) console.error("whatsapp-connect: vault_delete_secret (old token) failed", error);
  }
  if (existing?.webhook_secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: existing.webhook_secret_id });
    if (error) console.error("whatsapp-connect: vault_delete_secret (old webhook secret) failed", error);
  }
  if (existing?.app_secret_secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: existing.app_secret_secret_id });
    if (error) console.error("whatsapp-connect: vault_delete_secret (old app secret) failed", error);
  }

  return jsonResponse(200, {
    ok: true,
    displayNumber,
    verifiedName,
    wabaId,
    // Shown in Settings: these two must be pasted into the Meta app's
    // webhook configuration, which can't be set through the API.
    webhookUrl,
    verifyToken: webhookSecret,
  });
};
