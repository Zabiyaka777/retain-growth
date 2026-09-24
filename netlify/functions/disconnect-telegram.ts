import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface TelegramApiResponse {
  ok: boolean;
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

  // org_id is resolved server-side from the caller's session — never trusted
  // from the request (see CLAUDE.md: org_id scoping).
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

  const { data: credential, error: credentialError } = await supabase
    .from("channel_credentials")
    .select("id, bot_token_secret_id, webhook_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", "telegram")
    .maybeSingle();

  if (credentialError || !credential) {
    return jsonResponse(404, { error: "Telegram не підключено" });
  }

  const { data: botToken } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.bot_token_secret_id,
  });

  if (botToken) {
    const deleteWebhookRes = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
      method: "POST",
    });
    const deleteWebhookData = (await deleteWebhookRes.json()) as TelegramApiResponse;
    if (!deleteWebhookRes.ok || !deleteWebhookData.ok) {
      // Not fatal: still remove our own stored credential either way (e.g.
      // the token may already be revoked on Telegram's side).
      console.error("disconnect-telegram: deleteWebhook failed", deleteWebhookData);
    }
  } else {
    console.error("disconnect-telegram: failed to decrypt bot token, skipping deleteWebhook");
  }

  // Same FK lesson as connect-telegram: channel_credentials.*_secret_id
  // references vault.secrets with NO ACTION, so the row must stop pointing
  // at the secrets before those secrets can be deleted.
  const { error: deleteRowError } = await supabase.from("channel_credentials").delete().eq("id", credential.id);

  if (deleteRowError) {
    console.error("disconnect-telegram: channel_credentials delete failed", deleteRowError);
    return jsonResponse(500, { error: "Не вдалося видалити інтеграцію" });
  }

  const { error: botSecretDeleteError } = await supabase.rpc("vault_delete_secret", {
    secret_id: credential.bot_token_secret_id,
  });
  if (botSecretDeleteError) console.error("disconnect-telegram: vault_delete_secret (bot token) failed", botSecretDeleteError);

  if (credential.webhook_secret_id) {
    const { error: webhookSecretDeleteError } = await supabase.rpc("vault_delete_secret", {
      secret_id: credential.webhook_secret_id,
    });
    if (webhookSecretDeleteError) {
      console.error("disconnect-telegram: vault_delete_secret (webhook secret) failed", webhookSecretDeleteError);
    }
  }

  return jsonResponse(200, { ok: true });
};
