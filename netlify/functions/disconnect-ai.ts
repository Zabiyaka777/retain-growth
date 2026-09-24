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
    .from("ai_credentials")
    .select("id, api_key_secret_id")
    .eq("org_id", orgId)
    .maybeSingle();

  if (credentialError || !credential) {
    return jsonResponse(404, { error: "AI не підключено" });
  }

  // Same FK lesson as disconnect-telegram: ai_credentials.api_key_secret_id
  // references vault.secrets with NO ACTION, so the row must stop pointing at
  // the secret before the secret itself can be deleted.
  const { error: deleteRowError } = await supabase.from("ai_credentials").delete().eq("id", credential.id);

  if (deleteRowError) {
    console.error("disconnect-ai: ai_credentials delete failed", deleteRowError);
    return jsonResponse(500, { error: "Не вдалося видалити інтеграцію" });
  }

  const { error: secretDeleteError } = await supabase.rpc("vault_delete_secret", { secret_id: credential.api_key_secret_id });
  if (secretDeleteError) console.error("disconnect-ai: vault_delete_secret failed", secretDeleteError);

  return jsonResponse(200, { ok: true });
};
