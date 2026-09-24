import type { Handler } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";

// @supabase/supabase-js always spins up an (unused) Realtime client, which
// requires a global `WebSocket` — only native on Node 22+. Netlify's deployed
// runtime already has it, but local `netlify dev` may run an older local
// Node, so polyfill unconditionally rather than depending on the host's version.
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface TelegramApiResponse {
  ok: boolean;
  result?: { username?: string };
  description?: string;
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method Not Allowed" });
  }

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) {
    return jsonResponse(401, { error: "Відсутній заголовок авторизації" });
  }

  let botToken: string | undefined;
  try {
    const body = JSON.parse(event.body || "{}");
    botToken = typeof body.botToken === "string" ? body.botToken.trim() : undefined;
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!botToken) {
    return jsonResponse(400, { error: "botToken обов'язковий" });
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

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("org_id")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile) {
    return jsonResponse(403, { error: "Організацію не знайдено для цього користувача" });
  }

  const orgId = profile.org_id as string;

  const getMeRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const getMeData = (await getMeRes.json()) as TelegramApiResponse;
  if (!getMeRes.ok || !getMeData.ok) {
    return jsonResponse(400, { error: "Невалідний Telegram Bot Token" });
  }
  const botUsername: string = getMeData.result?.username ?? "";

  const siteUrl = process.env.URL;
  if (!siteUrl) {
    return jsonResponse(500, { error: "URL сайту не сконфігуровано" });
  }
  const webhookUrl = `${siteUrl}/.netlify/functions/telegram-webhook/${orgId}`;

  // Telegram will echo this back on every webhook call as
  // X-Telegram-Bot-Api-Secret-Token — lets telegram-webhook.ts reject
  // requests that didn't actually come from Telegram before doing anything else.
  const secretToken = randomBytes(32).toString("hex");

  const setWebhookRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, secret_token: secretToken }),
  });
  const setWebhookData = (await setWebhookRes.json()) as TelegramApiResponse;
  if (!setWebhookRes.ok || !setWebhookData.ok) {
    console.error("setWebhook failed", { webhookUrl, response: setWebhookData });
    return jsonResponse(502, { error: setWebhookData.description ?? "Не вдалося зареєструвати webhook у Telegram" });
  }

  const { data: existing } = await supabase
    .from("channel_credentials")
    .select("bot_token_secret_id, webhook_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", "telegram")
    .maybeSingle();

  // vault.secrets.name has a unique index. It's only a human-readable label
  // (lookups always go through channel_credentials.*_secret_id, never by
  // name), so a timestamp suffix keeps it traceable per org while making it
  // unique across reconnects — no collision with the still-live old secret.
  const nameSuffix = Date.now();

  const { data: botTokenSecretId, error: botSecretError } = await supabase.rpc("vault_create_secret", {
    secret: botToken,
    name: `telegram_bot_token_${orgId}_${nameSuffix}`,
    description: "Telegram bot token",
  });

  if (botSecretError || !botTokenSecretId) {
    console.error("vault_create_secret (bot token) failed", botSecretError);
    return jsonResponse(500, { error: "Не вдалося зберегти токен" });
  }

  const { data: webhookSecretId, error: webhookSecretError } = await supabase.rpc("vault_create_secret", {
    secret: secretToken,
    name: `telegram_webhook_secret_${orgId}_${nameSuffix}`,
    description: "Telegram webhook secret_token",
  });

  if (webhookSecretError || !webhookSecretId) {
    console.error("vault_create_secret (webhook secret) failed", webhookSecretError);
    return jsonResponse(500, { error: "Не вдалося зберегти webhook-секрет" });
  }

  const { error: upsertError } = await supabase
    .from("channel_credentials")
    .upsert(
      {
        org_id: orgId,
        channel_type: "telegram",
        bot_token_secret_id: botTokenSecretId,
        webhook_secret_id: webhookSecretId,
      },
      { onConflict: "org_id,channel_type" },
    );

  if (upsertError) {
    console.error("channel_credentials upsert failed", upsertError);
    return jsonResponse(500, { error: "Не вдалося зберегти інтеграцію" });
  }

  // Only now is the old row's reference gone, so deleting it no longer hits
  // the FK's NO ACTION restriction (channel_credentials.*_secret_id -> vault.secrets).
  if (existing?.bot_token_secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: existing.bot_token_secret_id });
    if (error) console.error("vault_delete_secret (old bot token) failed", error);
  }
  if (existing?.webhook_secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: existing.webhook_secret_id });
    if (error) console.error("vault_delete_secret (old webhook secret) failed", error);
  }

  return jsonResponse(200, { ok: true, botUsername });
};
