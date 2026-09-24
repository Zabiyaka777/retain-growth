import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { GRAPH_API_VERSION } from "./_shared/whatsapp";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
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
    .select("id, access_token_secret_id, webhook_secret_id, app_secret_secret_id, phone_number_id")
    .eq("org_id", orgId)
    .eq("channel_type", "whatsapp")
    .maybeSingle();

  if (credentialError || !credential) {
    return jsonResponse(404, { error: "WhatsApp не підключено" });
  }

  const { data: waToken } = credential.access_token_secret_id
    ? await supabase.rpc("vault_read_secret", { secret_id: credential.access_token_secret_id })
    : { data: null };

  if (waToken && credential.phone_number_id) {
    // Mirror of connect's subscribe. Not fatal if it fails — the token may
    // already be revoked on Meta's side, and our own row must go either way.
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${credential.phone_number_id}/subscribed_apps`,
      { method: "DELETE", headers: { authorization: `Bearer ${waToken}` } },
    );
    if (!res.ok) console.error("disconnect-whatsapp: unsubscribe failed", res.status, await res.text());
  } else {
    console.error("disconnect-whatsapp: no usable token, skipping unsubscribe");
  }

  // Same FK lesson as disconnect-telegram: the row must stop pointing at the
  // secrets before those secrets can be deleted.
  const { error: deleteRowError } = await supabase.from("channel_credentials").delete().eq("id", credential.id);
  if (deleteRowError) {
    console.error("disconnect-whatsapp: channel_credentials delete failed", deleteRowError);
    return jsonResponse(500, { error: "Не вдалося видалити інтеграцію" });
  }

  if (credential.access_token_secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: credential.access_token_secret_id });
    if (error) console.error("disconnect-whatsapp: vault_delete_secret (token) failed", error);
  }
  if (credential.webhook_secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: credential.webhook_secret_id });
    if (error) console.error("disconnect-whatsapp: vault_delete_secret (webhook secret) failed", error);
  }
  if (credential.app_secret_secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: credential.app_secret_secret_id });
    if (error) console.error("disconnect-whatsapp: vault_delete_secret (app secret) failed", error);
  }

  return jsonResponse(200, { ok: true });
};
