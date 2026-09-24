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
  result?: {
    username?: string;
    url?: string;
    pending_update_count?: number;
  };
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
    .select("bot_token_secret_id")
    .eq("org_id", orgId)
    .eq("channel_type", "telegram")
    .maybeSingle();

  if (credentialError || !credential) {
    return jsonResponse(404, { error: "Telegram не підключено" });
  }

  const { data: botToken, error: tokenError } = await supabase.rpc("vault_read_secret", {
    secret_id: credential.bot_token_secret_id,
  });

  if (tokenError || !botToken) {
    console.error("check-telegram-connection: vault_read_secret failed", tokenError);
    return jsonResponse(500, { error: "Не вдалося розшифрувати токен" });
  }

  const [getMeRes, getWebhookInfoRes] = await Promise.all([
    fetch(`https://api.telegram.org/bot${botToken}/getMe`),
    fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`),
  ]);
  const getMeData = (await getMeRes.json()) as TelegramApiResponse;
  const getWebhookInfoData = (await getWebhookInfoRes.json()) as TelegramApiResponse;

  if (!getMeRes.ok || !getMeData.ok) {
    console.error("check-telegram-connection: getMe failed", getMeData);
    return jsonResponse(200, { ok: false, error: getMeData.description ?? "Бот недоступний" });
  }

  return jsonResponse(200, {
    ok: true,
    botUsername: getMeData.result?.username ?? "",
    webhookUrl: getWebhookInfoData.result?.url ?? "",
    pendingUpdateCount: getWebhookInfoData.result?.pending_update_count ?? 0,
  });
};
