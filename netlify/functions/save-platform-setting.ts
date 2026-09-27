import type { Handler } from "@netlify/functions";
import { WebSocket as NodeWebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { logAdminAction, requirePlatformAdmin } from "./_shared/platform-admin";

// See connect-telegram.ts for why this polyfill is needed (Node <22 has no
// global WebSocket, which @supabase/supabase-js requires internally).
if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const KNOWN_KEYS = new Set(["netlify_api_token"]);

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Platform-level secrets (currently just the Netlify API token used to
// manage custom-domain aliases) — admin-only, org-independent. Same
// create-then-swap Vault pattern as every per-org credential in this app,
// just keyed by platform_settings.key instead of an org_id row.
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method Not Allowed" });

  const authHeader = event.headers.authorization ?? event.headers.Authorization;
  const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return jsonResponse(401, { error: "Відсутній заголовок авторизації" });

  let key = "";
  let value = "";
  try {
    const body = JSON.parse(event.body || "{}");
    key = typeof body.key === "string" ? body.key.trim() : "";
    value = typeof body.value === "string" ? body.value.trim() : "";
  } catch {
    return jsonResponse(400, { error: "Невалідне тіло запиту" });
  }

  if (!KNOWN_KEYS.has(key)) return jsonResponse(400, { error: "Невідомий ключ налаштування" });
  if (!value) return jsonResponse(400, { error: "Значення обов'язкове" });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const admin = await requirePlatformAdmin(supabase, accessToken);
  if (!admin) return jsonResponse(403, { error: "Доступ лише для адміністраторів платформи" });

  const { data: secretId, error: secretError } = await supabase.rpc("vault_create_secret", {
    secret: value,
    name: `platform_setting_${key}_${Date.now()}`,
    description: `Platform setting: ${key}`,
  });
  if (secretError || !secretId) {
    console.error("save-platform-setting: vault_create_secret failed", secretError);
    return jsonResponse(500, { error: "Не вдалося зберегти секрет" });
  }

  const { data: existing } = await supabase.from("platform_settings").select("secret_id").eq("key", key).maybeSingle();

  const { error: upsertError } = await supabase
    .from("platform_settings")
    .upsert({ key, secret_id: secretId, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (upsertError) {
    console.error("save-platform-setting: upsert failed", upsertError);
    await supabase.rpc("vault_delete_secret", { secret_id: secretId });
    return jsonResponse(500, { error: "Не вдалося зберегти налаштування" });
  }

  // Only after the row points at the new secret is the old one released.
  if (existing?.secret_id) {
    const { error } = await supabase.rpc("vault_delete_secret", { secret_id: existing.secret_id });
    if (error) console.error("save-platform-setting: vault_delete_secret (old) failed", error);
  }

  await logAdminAction(supabase, admin, "platform_setting_saved", { key });

  return jsonResponse(200, { ok: true });
};
